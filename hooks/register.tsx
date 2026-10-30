import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ModelMode, PiJob, RouterDecision, SettingsTab } from '../types'
import {
  chainFor,
  configPath,
  consumeCreated,
  DEFAULT_CONFIG,
  earliestRun,
  isPeak,
  liveChain,
  providerOf,
  setPath,
  } from './config'
import type { BigRead } from './saver'
import type { Config } from './config'
import { checkTool, firstTime, rulesText } from './saver'
import { experimentReport, family, reportText } from './stats'
import { decide, probeClassifier } from './classify'
import { renderPane } from './panel'
import { piStatus, routeStatus } from './statusline'
import { armLabel, armOf, clock, config, editConfig, guardSeen, imgCheck, logDir, logRecord, piArgv, readLogs, refreshPiModels, registerTools, resetSession, rt, saverHints, saverOn, sessionTags, userEnv } from './core'

// auto-router 的入口：把各模块接到引擎事件上。
// 1. 模型切换：每次提交问题时分类（classify.ts），按类别把本轮主对话的 Claude 模型换成 haiku / sonnet / opus；
//    升档立即生效，降档要连续几轮都判为更轻才降（换模型会让提示词缓存失效）
// 2. pi 外派：注册 pi_dispatch 工具，Claude 按角色把任务派给 pi agent 在终端跑；分类判断适合外派时，给 Claude 附一句建议
// 3. 省额度（saver.ts）：拦大读取、上下文过大时提醒交接、把省额度规则写进系统提示，scout / executor 子代理在 agents/
// 4. 对照实验：按会话 id 把新会话分到「切换 / 不切换」×「省额度 开 / 关」，/auto-router eval 出报告（stats.ts）
// 共用的运行时状态、日志、配置读写在 core.ts，atom 在 state.ts，设置面板在 panel.tsx。
// 配置在 ~/.claude/auto-router.json（见 config.ts），用 /auto-router 面板或让 Claude 调 router_config 修改。

// 同一 plugin/key 的 atom 在用到它的每个文件里各声明一份：引擎扫描要求 atom 写在读写它的文件里
const jobs = atom({ plugin: 'auto-router', key: 'jobs' } as const, [], { shape: 'jobs-2' })
const modelMode = atom({ plugin: 'auto-router', key: 'modelMode' } as const, 'auto' as ModelMode)
const piAuto = atom({ plugin: 'auto-router', key: 'piAuto' } as const, true)
const lastDecision = atom({ plugin: 'auto-router', key: 'last' } as const, null, { shape: 'last-3' })
const tab = atom({ plugin: 'auto-router', key: 'tab' } as const, 'claude' as SettingsTab)
const piModels = atom({ plugin: 'auto-router', key: 'piModels' } as const, [], { shape: 'models-1' })
const paused = atom({ plugin: 'auto-router', key: 'paused' } as const, {}, { shape: 'paused-1' })
const PANE = 'auto-router'

// ---------- 状态 ----------

// 完整输出只留在模块里（重载会丢，pane 里有末尾）
const outputs = new Map<string, string>()
// 正有会写文件的 pi 任务在跑的仓库根目录：同一仓库不并发写
const writing = new Set<string>()
let seq = 0
let lastCost: number | undefined
let lastMainModel: string | undefined


type DispatchInput = { task: string; role?: string; model?: string; cwd?: string; readOnly?: boolean }

// 订阅失效、没 key、额度用完、限流：这类错误换个时间重试也没用，先把整家提供商暂停
const AUTH_ERROR = /no api key|api key|unauthori[sz]ed|\b401\b|\b403\b|forbidden|subscription|quota|insufficient|billing|payment|\b429\b|rate.?limit|expired|not_ready|log ?in/i

async function pausedCheck($: EngineInterface): Promise<(provider: string) => boolean> {
  const now = Date.now()
  const map = await read($, paused)
  return provider => (map[provider]?.until ?? 0) > now
}

async function pauseProvider($: EngineInterface, cfg: Config, provider: string, reason: string) {
  if (cfg.pi.pauseMinutes <= 0) return
  const until = Date.now() + cfg.pi.pauseMinutes * 60_000
  await update($, paused, map => ({ ...map, [provider]: { until, reason } }))
  $.ui.toast(`${provider} 报鉴权/额度错误，暂停到 ${clock(until)}。如果已经退订，到 /auto-router 提供商页关掉它。`)
}

async function saveJob($: EngineInterface, job: PiJob) {
  await update($, jobs, list => [...list.filter(j => j.id !== job.id), job].slice(-30))
  if (job.status === 'done' || job.status === 'failed') {
    const files = Number(/改动了 (\d+) 个文件/.exec(job.changes ?? '')?.[1] ?? 0)
    void logRecord($, {
      t: 'pi',
      ts: Date.now(),
      role: job.role,
      model: job.model,
      ok: job.status === 'done',
      ms: (job.endedAt ?? Date.now()) - job.startedAt,
      ro: job.readOnly,
      files,
    })
  }
}

function resolveCwd(cwd: string | undefined): string {
  if (!cwd) return rt.sessionCwd
  if (/^([A-Za-z]:)?[\\/]/.test(cwd)) return cwd
  return `${rt.sessionCwd}${rt.isWindows ? '\\' : '/'}${cwd}`
}

/** 会写文件的任务开跑前的检查：通过时返回仓库根目录，否则返回不能派的原因 */
async function gitGuard($: EngineInterface, cwd: string): Promise<{ root: string } | { refused: string }> {
  const top = await $.process.run(['git', '-C', cwd, 'rev-parse', '--show-toplevel']).catch(() => undefined)
  if (!top || top.exitCode !== 0) {
    return { refused: `${cwd} 不是 git 仓库，pi 改了什么事后没法审阅。改用只读角色（readOnly），或先 git init 并提交一次再派。` }
  }
  const root = top.stdout.trim()
  if (writing.has(root)) return { refused: '这个仓库里已经有一个会写文件的 pi 任务在跑，等它结束再派，免得互相覆盖。' }
  const status = await $.process.run(['git', '-C', root, 'status', '--porcelain'])
  const dirty = status.stdout.split(/\r?\n/).filter(l => l.trim())
  if (dirty.length) {
    return { refused: `工作区有 ${dirty.length} 个未提交的改动，pi 的改动会和它们混在一起分不清。先提交或 stash，再派。` }
  }
  return { root }
}

/** 跑完后的改动摘要；没改动返回 undefined */
async function gitChanges($: EngineInterface, root: string): Promise<string | undefined> {
  const status = await $.process.run(['git', '-C', root, 'status', '--porcelain']).catch(() => undefined)
  const files = status?.stdout.split(/\r?\n/).filter(l => l.trim()) ?? []
  if (files.length === 0) return undefined
  const stat = await $.process.run(['git', '-C', root, 'diff', '--stat']).catch(() => undefined)
  return [
    `仓库 ${root} 里 pi 改动了 ${files.length} 个文件（都还没提交）：`,
    ...files.slice(0, 40),
    files.length > 40 ? `……还有 ${files.length - 40} 个` : '',
    stat?.stdout.trim() ?? '',
    '请用 git diff 逐项审阅：要保留的再提交，不要的用 git checkout -- <文件> / git clean 撤销。',
  ]
    .filter(Boolean)
    .join('\n')
}

async function runJob($: EngineInterface, job: PiJob, input: DispatchInput): Promise<PiJob> {
  const cfg = await config($)
  const notes = [...job.notes]
  let chain = [input.model ?? '']
  if (!input.model) {
    const live = liveChain(cfg, job.role, Date.now(), await pausedCheck($))
    chain = live.models
    if (live.isFallback && chain.length) notes.push(`${job.role} 的模型此刻都用不了，改用兜底 ${chain.join(' → ')}`)
  }

  // 排队等空闲的任务开跑前再查一次：这段时间里工作区可能变了
  let root: string | undefined
  if (!input.readOnly && cfg.pi.guard.requireCleanGit) {
    const guard = await gitGuard($, resolveCwd(input.cwd))
    if ('refused' in guard) {
      notes.push(guard.refused)
      outputs.set(job.id, guard.refused)
      job = { ...job, status: 'failed', startedAt: Date.now(), endedAt: Date.now(), tail: guard.refused, notes }
      await saveJob($, job)
      return job
    }
    root = guard.root
    writing.add(root)
  }
  try {
    return await runChain($, cfg, job, input, chain, notes, root)
  } finally {
    if (root) writing.delete(root)
  }
}

async function runChain(
  $: EngineInterface,
  cfg: Config,
  job: PiJob,
  input: DispatchInput,
  chain: string[],
  notes: string[],
  root: string | undefined,
): Promise<PiJob> {
  job = { ...job, status: 'running', startedAt: Date.now(), model: chain[0] ?? job.model }
  await saveJob($, job)
  $.ui.status(piStatus(job.role, job.model))

  const env = await userEnv($)
  for (const model of chain) {
    // 同一条链里前面的模型刚把这家熔断了，后面同一家的就别再试
    if (!input.model && (await pausedCheck($))(providerOf(model))) {
      notes.push(`${model}: 跳过（${providerOf(model)} 已暂停）`)
      continue
    }
    job = { ...job, model, notes: [...notes] }
    await saveJob($, job)
    try {
      const run = await $.process.run(piArgv(model, input.readOnly === true), {
        cwd: input.cwd,
        env,
        stdin: input.task,
        timeoutMs: Math.min(cfg.pi.timeoutMinutes, 10) * 60_000,
      })
      const out = run.stdout.trim()
      if (run.exitCode === 0 && out) {
        outputs.set(job.id, out)
        const changes = root ? await gitChanges($, root) : undefined
        job = { ...job, status: 'done', endedAt: Date.now(), tail: out.slice(-1500), changes }
        await saveJob($, job)
        $.ui.status(undefined)
        return job
      }
      const why = (run.stderr.trim().split('\n').find(l => l.trim()) ?? `exit ${run.exitCode}`).slice(0, 160)
      notes.push(`${model}: ${why}`)
      if (AUTH_ERROR.test(`${run.stderr}\n${run.stdout}`)) await pauseProvider($, cfg, providerOf(model), why)
    } catch (err) {
      notes.push(`${model}: ${String(err).slice(0, 160)}`)
    }
  }
  if (chain.length === 0) notes.push('没有可用的模型：角色链和兜底列表里的提供商都关掉了、在高峰或已暂停')
  outputs.set(job.id, notes.join('\n'))
  // 失败的模型也可能改了一半
  const changes = root ? await gitChanges($, root) : undefined
  job = { ...job, status: 'failed', endedAt: Date.now(), tail: notes.join('\n').slice(-1500), notes: [...notes], changes }
  await saveJob($, job)
  $.ui.status(undefined)
  return job
}

function report(job: PiJob): string {
  if (job.status === 'waiting') return `[pi ${job.id}] 排队中：能接这个任务的模型都在高峰时段，${clock(job.runAt ?? 0)}（北京时间）开始跑。`
  if (job.status === 'running') return `[pi ${job.id}] 仍在运行（${job.model}）`
  const secs = job.endedAt ? Math.round((job.endedAt - job.startedAt) / 1000) : 0
  const head = `[pi ${job.id}] ${job.status === 'done' ? '完成' : '失败'} · ${job.model} · ${secs}s`
  const fell = job.notes.length ? `\n降级记录:\n- ${job.notes.join('\n- ')}` : ''
  const changes = job.changes ? `\n\n---\n${job.changes}` : job.readOnly ? '' : '\n\n（工作区没有改动）'
  return `${head}${fell}\n\n${outputs.get(job.id) ?? job.tail}${changes}`
}

/** 立即跑，或在能接的模型都处高峰时排队；返回任务（排队的为 waiting 状态） */
async function startJob(
  $: EngineInterface,
  raw: DispatchInput,
  background: boolean,
): Promise<{ job: PiJob; done?: Promise<PiJob> } | { refused: string }> {
  const cfg = await config($)
  const role = raw.model ? 'custom' : raw.role && cfg.pi.roles[raw.role] ? raw.role : cfg.pi.defaultRole
  // 只读角色强制只读；Claude 只能再收紧，不能放开
  const input: DispatchInput = { ...raw, readOnly: cfg.pi.roles[role]?.readOnly === true || raw.readOnly === true }
  if (!input.readOnly && cfg.pi.guard.requireCleanGit) {
    const guard = await gitGuard($, resolveCwd(input.cwd))
    if ('refused' in guard) return guard
  }
  const now = Date.now()
  // all：不看时段时能用的（角色链 + 兜底，去掉关掉的）；usable：此刻能用的
  const enabled = (m: string) => cfg.pi.providers[providerOf(m)]?.enabled !== false
  const all = input.model ? [input.model] : [...chainFor(cfg, role), ...cfg.pi.fallback.filter(enabled)]
  const usable = input.model
    ? all.filter(m => !isPeak(cfg.pi.providers[providerOf(m)]?.peak, now))
    : liveChain(cfg, role, now, await pausedCheck($)).models
  let job: PiJob = {
    id: `p${(++seq).toString(36)}${now.toString(36).slice(-3)}`,
    role,
    model: usable[0] ?? all[0] ?? '?',
    title: input.task.replace(/\s+/g, ' ').slice(0, 120),
    status: 'running',
    startedAt: now,
    tail: '',
    notes: [],
    readOnly: input.readOnly,
  }
  const finish = (p: Promise<PiJob>) =>
    p.then(done => {
      $.ui.toast(`pi ${done.id} ${done.status === 'done' ? '完成' : '失败'}（${done.model}）`)
      return done
    })

  if (usable.length === 0 && all.length > 0) {
    const runAt = earliestRun(cfg, all, now)
    job = { ...job, status: 'waiting', runAt, notes: [`高峰时段，排到 ${clock(runAt)} 再跑`] }
    await saveJob($, job)
    const waiting = job
    const done = new Promise<PiJob>(resolve => {
      $.clock.after(runAt - now + 30_000, () => resolve(runJob($, waiting, input)))
    })
    return { job, done: finish(done) }
  }
  const done = runJob($, job, input)
  return { job, done: background ? finish(done) : done }
}

// ---------- router_config 工具 ----------

type ConfigInput = { action?: 'get' | 'set' | 'reset' | 'probe'; path?: string; value?: unknown; remove?: boolean }

async function configTool($: EngineInterface, input: ConfigInput): Promise<string> {
  const path = await configPath($, rt.isWindows)
  if (input.action === 'probe') return probeClassifier($)
  if (input.action === 'reset') {
    const old = await config($)
    await $.fs.write(`${path}.bak`, JSON.stringify(old, null, 2) + '\n')
    await editConfig($, () => DEFAULT_CONFIG)
    return `已恢复默认配置，旧配置备份在 ${path}.bak`
  }
  if (input.action === 'set') {
    if (!input.path) return '缺 path，例如 "pi.roles.code.models"'
    let errs: string[]
    try {
      errs = await editConfig($, cfg => setPath(cfg, input.path as string, input.remove ? undefined : input.value))
    } catch (err) {
      return `没改：${String(err)}`
    }
    if (errs.length) return `没改，校验不通过：\n- ${errs.join('\n- ')}`
    const known = (await read($, piModels)) ?? []
    const unknown = known.length
      ? Object.values((await config($)).pi.roles).flatMap(r => r.models).filter(m => !known.includes(m))
      : []
    const warn = unknown.length ? `\n注意：pi --list-models 里没有 ${[...new Set(unknown)].join(', ')}（可能没配 key）。` : ''
    return `已保存 ${input.path}，下一个问题起生效。${warn}`
  }
  const cfg = await config($)
  const models = (await read($, piModels))?.length ? await read($, piModels) : await refreshPiModels($)
  return [
    `配置文件：${path}`,
    `pi 里能用的模型：${models.join(', ') || '（没取到）'}`,
    '```json',
    JSON.stringify(cfg, null, 2),
    '```',
  ].join('\n')
}

// ---------- 注册 ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    resetSession(e.cwd)
    lastCost = undefined
    lastMainModel = undefined
    await $.command.register({
      name: 'auto-router',
      description: '模型路由、pi 外派与省额度：打开设置面板；pi 配模型、stats 看效果、eval 出对照实验报告、run 派任务、export / import 分享配置',
      argumentHint: '[pi | stats | eval [天数] | jobs | run [角色] <任务> | export [文件] | import <文件> | path]',
    })
    await registerTools($, await config($))
    if (consumeCreated()) {
      rt.firstRun = true
      $.ui.toast('auto-router 已装好：运行 /auto-router，在「pi 模型」页按你的订阅配一下 pi 用哪些模型')
    }
    await $.tool.register({
      name: 'pi_result',
      isDeferred: false,
      description: 'Get the status and output of a pi job started by pi_dispatch with background=true, or one queued for off-peak hours.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
    await $.tool.register({
      name: 'router_config',
      isDeferred: true,
      description:
        "Read or change the auto-router config (which Claude model each kind of prompt gets, which pi models each role tries in order, providers on/off, peak hours, holidays). Use it when the user asks to change routing in words. " +
        "action=get returns the config JSON and the pi models available; action=set changes one value by a dotted path (e.g. path 'pi.roles.code.models', value ['openai/gpt-6.1-sol','openai/gpt-6.1-terra']; path 'pi.providers.openai.enabled', value false; path 'pi.providers.cc-switch-deep-seek.peak.holidays', value [...dates]); remove=true deletes the key; action=reset restores defaults with a .bak backup; action=probe tries each way of classifying a prompt (classify, complete, fork) and reports which work and how long they take, for when routing seems stuck. " +
        'Every change is validated before it is saved; read first with get, and set whole arrays.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'reset', 'probe'] },
          path: { type: 'string' },
          value: {},
          remove: { type: 'boolean' },
        },
        required: ['action'],
      },
    })
    return next(e)
  })

  // ----- 模型切换：提交时分类，每步改写 model -----

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !e.text.trim()) return next(e)
    const cfg = await config($)
    const hints = await saverHints($, cfg).catch(() => [])
    if (hints.length) e = { ...e, context: [...(e.context ?? []), ...hints] }
    const mode = await read($, modelMode)
    const wantPi = await read($, piAuto)
    if (mode === 'off' && !wantPi) return next(e)

    // 配置文件手改后，工具说明里的角色和模型链跟着更新
    await registerTools($, cfg)
    const decided = await decide($, cfg, e.text, await read($, lastDecision))
    // 对照组只记下本来会选什么，不切换
    const control = mode === 'auto' && (await sessionTags($)).ra === 'control'
    const decision = control ? { ...decided, control: true } : decided
    await update($, lastDecision, () => decision)

    const result = await next(e)
    if (!wantPi || !decision.piRole || result.drop !== undefined) return result
    const hint =
      `[auto-router] 这个请求看起来适合外派：如果它能写成自包含的任务说明，` +
      `可调用 mcp__auto-router__pi_dispatch（role=${decision.piRole}）交给 pi 执行，再验收结果。`
    return { ...result, context: [...(result.context ?? []), hint] }
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    const mode = await read($, modelMode)
    if (mode === 'off') return yield* next(e)

    const decision: RouterDecision | null = mode === 'auto' ? await read($, lastDecision) : { label: '固定', model: mode, lighterStreak: 0 }
    if (decision?.control) {
      if (e.index === 0) $.ui.status(routeStatus(decision, { downgradeAfter: 2, showPi: false }))
      return yield* next(e)
    }
    const model = decision?.model
    if (!decision || !model || !/claude|opus|sonnet|haiku|fable/i.test(e.model)) return yield* next(e)
    if (e.index === 0) {
      const cfg = await config($)
      $.ui.status(routeStatus(decision, { prevModel: lastMainModel, downgradeAfter: cfg.claude.downgradeAfter, showPi: await read($, piAuto) }))
    }
    return yield* next({ ...e, model })
  })

  // ----- 效果记录：每轮结束记下模型、token、花费 -----

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const u = e.usage
    if (!u) return result
    const sub = e.agentId !== undefined
    const mode = await read($, modelMode)
    const d = sub ? null : await read($, lastDecision)
    const usage = await $.session.usage().catch(() => undefined)
    const cost = usage?.cost?.usd
    const usd = cost !== undefined && lastCost !== undefined ? Math.max(0, cost - lastCost) : undefined
    if (cost !== undefined) lastCost = cost
    const switched = !sub && lastMainModel !== undefined && family(lastMainModel) !== family(u.model)
    if (!sub) lastMainModel = u.model
    await logRecord($, {
      t: 'turn',
      ts: Date.now(),
      arm: armOf(mode, d),
      cat: d?.label,
      pick: d?.model,
      model: u.model,
      sub: sub || undefined,
      switched: switched || undefined,
      fix: d?.fix || undefined,
      cf: d?.cf,
      cerr: d?.cerr,
      cms: d?.cms,
      via: d?.via,
      fu: d?.fu,
      ctx: usage?.context.tokens,
      in: u.input_tokens,
      cw: u.cache_creation_input_tokens,
      cr: u.cache_read_input_tokens,
      out: u.output_tokens,
      usd,
      wk: usage?.rateLimits.find(r => r.kind === 'seven_day')?.percentUsed,
    })
    return result
  }).catch(($, e, next) => next(e))

  // ----- 省额度 -----

  // 拦下会把大量内容灌进上下文的调用，同一目标 10 分钟内再请求就放行；出错一律放行
  on('tool.call', async ($, e, next) => {
    if (e.tool.startsWith('mcp__auto-router__')) return next(e)
    const cfg = await config($)
    if (!cfg.saver.guard || !(await saverOn($))) return next(e)
    const hit = await checkTool($, e as unknown as Record<string, unknown> & { tool: string }, imgCheck($))
    if (!hit) return next(e)
    const block = firstTime(guardSeen, hit.key, Date.now())
    void logRecord($, { t: 'guard', ts: Date.now(), kind: hit.kind, again: !block })
    return block ? { deny: hit.reason } : next(e)
  }).catch(($, e, next) => next(e))

  // 省额度规则写进系统提示；只随配置变，不随轮次变，提示词缓存不受影响
  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    if (!(await saverOn($))) return result
    const cfg = await config($)
    const pi = e.tools.includes('mcp__auto-router__pi_dispatch') && 'longctx' in cfg.pi.roles
    const text = rulesText({ imgCheck: imgCheck($), bigRead: cfg.saver.bigRead as BigRead, pi, quotaPct: cfg.saver.quotaPct })
    return { sections: [...result.sections, { id: 'auto-router:saver', text, scope: 'session' as const }] }
  }).catch(($, e, next) => next(e))

  // 省额度关掉的会话里不提供 scout / executor，对照组才干净
  for (const agent of ['auto-router:scout', 'auto-router:executor']) {
    on('agent.offer', { agent }, async ($, e, next) => ((await saverOn($)) ? next(e) : { isOffered: false })).catch(($, e, next) => next(e))
  }

  // ----- 工具 -----

  on('tool.call', { tool: 'mcp__auto-router__pi_dispatch' }, async ($, e) => {
    const input = e as unknown as DispatchInput & { background?: boolean }
    if (typeof input.task !== 'string' || !input.task.trim()) return { deny: 'task 不能为空' }
    const started = await startJob($, input, input.background === true)
    if ('refused' in started) return { result: `没派：${started.refused}` }
    const { job, done } = started
    if (job.status === 'waiting') return { result: `${report(job)} 用 pi_result 取结果（id=${job.id}）。` }
    if (input.background || !done) return { result: `pi 任务已在后台启动，id=${job.id}（${job.model}）。用 pi_result 取结果。` }
    return { result: report(await done) }
  }).catch(($, _e, next) => ({ deny: `pi_dispatch 出错：${next.error?.message ?? '未知'}` }))

  on('tool.call', { tool: 'mcp__auto-router__pi_result' }, async ($, e) => {
    const id = String((e as unknown as { id?: string }).id ?? '')
    const job = (await read($, jobs)).find(j => j.id === id)
    return { result: job ? report(job) : `没有 id 为 ${id} 的 pi 任务` }
  }).catch(() => ({ deny: 'pi_result 出错' }))

  on('tool.call', { tool: 'mcp__auto-router__router_config' }, async ($, e) => {
    return { result: await configTool($, e as unknown as ConfigInput) }
  }).catch(($, _e, next) => ({ deny: `router_config 出错：${next.error?.message ?? '未知'}` }))

  // ----- 斜杠命令 -----

  on('command.run', { command: 'auto-router' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (sub === 'eval') {
      const days = Math.max(1, Math.min(90, Number(rest[0]) || 14))
      const from = Date.now() - days * 86_400_000
      const cfg = await config($)
      const off = cfg.experiment === 'off' ? '对照实验现在是关着的，下面只统计之前开着时的会话。\n' : ''
      const head = `${armLabel(await sessionTags($))}\n${off}\n`
      return { text: head + reportText(experimentReport(await readLogs($, from), from), days) }
    }
    if (sub === 'path') return { text: `配置文件：${await configPath($, rt.isWindows)}\n效果记录：${await logDir($)}` }
    if (sub === 'export') {
      const file = rest.join(' ') || 'auto-router.preset.json'
      await $.fs.write(file, JSON.stringify(await config($), null, 2) + '\n')
      return { text: `已导出到 ${file}。别人装好插件后用 /auto-router import ${file} 导入，再到「pi 模型」页把没有的提供商改成“不用”。` }
    }
    if (sub === 'import') {
      const file = rest.join(' ')
      if (!file) return { text: '用法：/auto-router import <文件路径>' }
      let raw: Partial<Config>
      try {
        raw = JSON.parse(await $.fs.read(file)) as Partial<Config>
      } catch (err) {
        return { text: `读不了 ${file}：${String(err).slice(0, 160)}` }
      }
      const merged: Config = {
        claude: { ...DEFAULT_CONFIG.claude, ...raw.claude },
        pi: { ...DEFAULT_CONFIG.pi, ...raw.pi },
        saver: { ...DEFAULT_CONFIG.saver, ...raw.saver },
        experiment: raw.experiment ?? DEFAULT_CONFIG.experiment,
      }
      const path = await configPath($, rt.isWindows)
      const old = await config($)
      const errs = await editConfig($, () => merged)
      if (errs.length) return { text: `没导入，校验不通过：\n- ${errs.join('\n- ')}` }
      await $.fs.write(`${path}.bak`, JSON.stringify(old, null, 2) + '\n')
      return { text: `已导入 ${file}，旧配置备份在 ${path}.bak。` }
    }
    if (sub === 'run') {
      const cfg = await config($)
      const [first, ...more] = rest
      const isRole = first !== undefined && first in cfg.pi.roles
      const task = (isRole ? more : rest).join(' ')
      if (!task) return { text: `用法：/auto-router run [${Object.keys(cfg.pi.roles).join('|')}] <任务>` }
      const started = await startJob($, { task, role: isRole ? first : undefined }, true)
      if ('refused' in started) return { text: `没派：${started.refused}` }
      const { job } = started
      await update($, tab, () => 'jobs' as SettingsTab)
      void $.ui.open({ id: PANE, title: 'auto-router' })
      return { text: job.status === 'waiting' ? report(job) : `已派给 pi（${job.role} · ${job.model}），id=${job.id}，完成后会提示。` }
    }
    const start: SettingsTab = sub === 'jobs' ? 'jobs' : sub === 'stats' ? 'stats' : sub === 'setup' || sub === 'pi' || rt.firstRun ? 'pi' : 'claude'
    rt.firstRun = false
    await update($, tab, () => start)
    await $.ui.open({ id: PANE, title: 'auto-router' })
    void refreshPiModels($)
    return { text: '设置面板已打开。改动直接写回配置文件，下一个问题起生效；节假日、高峰时段这类可以直接跟 Claude 说。' }
  })

  // ----- 设置面板 -----

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) =>
    renderPane($, e),
  )
}
