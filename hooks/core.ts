import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ModelMode, ProbeResult, RouterDecision } from '../types'
import { chainFor, configPath, loadConfig, migrateModel, onlyDetected, parseModelList, saveConfig, validate } from './config'
import type { Config } from './config'
import { crossedLevel, quotaText, remindText } from './saver'
import { configVersion, parseLog, sessionArms } from './stats'
import type { Arm, LogRecord, SessionTags } from './stats'

// register.tsx 和 panel.tsx 共用的运行时：配置读写、会话分组、日志、pi 工具注册。

// 同一 plugin/key 的 atom 在用到它的每个文件里各声明一份：引擎扫描要求 atom 写在读写它的文件里
const configRev = atom({ plugin: 'auto-router', key: 'configRev' } as const, 0)
const piModels = atom({ plugin: 'auto-router', key: 'piModels' } as const, [], { shape: 'models-1' })

// ---------- 状态 ----------

/** 会话级运行时变量；rt.isWindows、rt.sessionCwd 在 session.start 时设置，firstRun 表示配置文件是这次刚生成的（/auto-router 先打开外派模型页） */
export const rt = { isWindows: true, sessionCwd: '.', firstRun: false }
let toolDescription = ''

export function config($: EngineInterface): Promise<Config> {
  return loadConfig($, rt.isWindows)
}

// ---------- 会话分组与省额度状态 ----------

/** 拦过一次的目标，窗口内再请求放行 */
export const guardSeen = new Map<string, number>()
/** 本会话已提醒过的上下文档位 */
export const reminded = new Set<number>()
let quotaWarned = false
let tagsCache: Promise<SessionTags> | undefined

/**
 * 本会话的实验分组；按会话 id 算，重载后不变。没开实验时 sv 跟着 saver.enabled。
 * 实验打开前就开着的会话不入组：它的日志里已经有不带实验标记的记录，中途入组会让前后两段混在一起。
 */
export function sessionTags($: EngineInterface): Promise<SessionTags> {
  tagsCache ??= (async () => {
    const cfg = await config($)
    const sid = (await $.session.id()).slice(0, 8)
    const plain = { sid, sv: cfg.saver.enabled ? ('on' as const) : ('off' as const) }
    // 不按 isInteractive 剔除：桌面 app 和 /reload-plugins 后它会误报 false，把正常会话踢出实验。
    // claude -p、定时任务这类会话只有一两轮，报告里“不到 3 轮不算”会把它们去掉
    if (cfg.experiment === 'off') return plain
    if (await startedOutside($, sid)) return { ...plain, late: true }
    const arms = sessionArms(sid, cfg.experiment)
    return { sid, ex: cfg.experiment, ra: arms.ra, sv: arms.sv ?? plain.sv }
  })().catch(() => {
    tagsCache = undefined
    return { sv: 'on' as const }
  })
  return tagsCache
}

/** 这个会话在实验外已经记过日志（第一条记录没有实验标记） */
export async function startedOutside($: EngineInterface, sid: string): Promise<boolean> {
  const dir = await logDir($)
  if (!(await $.fs.exists(dir))) return false
  const mine = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith(`_${sid}.jsonl`)).sort((a, b) => (a.name < b.name ? -1 : 1))
  if (!mine.length) return false
  const first = parseLog(await $.fs.read(`${dir}${sep()}${(mine[0] as { name: string }).name}`).catch(() => ''))[0]
  return first !== undefined && !first.ex
}

/** 面板和报告里显示的本会话分组 */
export function armLabel(t: SessionTags & { late?: boolean }): string {
  if (t.late) return '本会话在实验打开前就开着，不入组（新开的会话才分组）'
  if (!t.ex) return '对照实验没开'
  const parts = [t.ra && (t.ra === 'auto' ? '切换组' : '不切换组'), t.sv && (t.ex === 'saver' || t.ex === 'both') && (t.sv === 'on' ? '省额度开' : '省额度关')]
  return `本会话：${parts.filter(Boolean).join(' · ')}`
}

export async function saverOn($: EngineInterface): Promise<boolean> {
  return (await sessionTags($)).sv === 'on'
}

export function imgCheck($: EngineInterface): string {
  return `python "${$.plugin.root.replace(/\\/g, '/')}/scripts/img_check.py"`
}

/** 上下文越过提醒档位、7 天额度越过阈值时，各在用户消息旁附一句（每会话每档一次） */
export async function saverHints($: EngineInterface, cfg: Config): Promise<string[]> {
  if (!(await saverOn($))) return []
  const usage = await $.session.usage().catch(() => undefined)
  const hints: string[] = []
  const ctx = usage?.context.tokens ?? 0
  const level = crossedLevel(ctx, cfg.saver.remindAt, reminded)
  if (level) hints.push(remindText(ctx, level))
  const wk = usage?.rateLimits.find(r => r.kind === 'seven_day')?.percentUsed
  if (!quotaWarned && wk !== undefined && wk >= cfg.saver.quotaPct && cfg.saver.bigRead === 'auto') {
    quotaWarned = true
    hints.push(quotaText(Math.round(wk)))
  }
  return hints
}

export function clock(ms: number): string {
  const d = new Date(ms + 8 * 3600_000)
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** 改配置：校验通过才保存，并刷新面板和工具说明；返回问题列表 */
export async function editConfig($: EngineInterface, fn: (cfg: Config) => Config): Promise<string[]> {
  const next = fn(await config($))
  const errs = validate(next)
  if (errs.length) return errs
  await saveConfig($, rt.isWindows, next)
  await update($, configRev, n => n + 1)
  await registerTools($, next)
  return []
}

// ---------- 效果记录 ----------

export const sep = () => (rt.isWindows ? '\\' : '/')
let logFile: string | undefined
let logLines: string[] = []
/** 一个日志文件最多这么多行，满了换 日期_会话id-2.jsonl、-3……：$.fs 没有追加，每条都要整份重写，文件不能太大 */
export const LOG_SEGMENT = 400
let logSeg = 1
let logBase = ''
let logChain: Promise<void> = Promise.resolve()

/** 日志和报告的根目录：配置里 dataDir 没设就是 ~/.claude/auto-router */
export async function dataRoot($: EngineInterface, cfg?: Config): Promise<string> {
  const dir = (cfg ?? (await config($))).dataDir.trim().replace(/[\\/]+$/, '')
  return dir || (await configPath($, rt.isWindows)).replace(/\.json$/, '')
}

export async function logDir($: EngineInterface): Promise<string> {
  return `${await dataRoot($)}${sep()}log`
}

export async function reportDir($: EngineInterface): Promise<string> {
  return `${await dataRoot($)}${sep()}report`
}

/** 当前配置版本，写进每条日志；报告按它分组（不含插件版本，见 LOGIC_VERSION） */
export async function currentVersion($: EngineInterface, cfg?: Config): Promise<string> {
  return configVersion(cfg ?? (await config($)))
}

/**
 * dataDir 改过后，把默认目录（~/.claude/auto-router/log）里的日志搬过去：同名文件按行合并去重，
 * 读回核对每一行都在了才删旧文件。每次会话开始都跑一遍，还开着的旧版本会话后来又写的也会搬过去。返回搬了几个文件
 */
export async function moveLogs($: EngineInterface): Promise<number> {
  const from = (await configPath($, rt.isWindows)).replace(/\.json$/, `${sep()}log`)
  const to = await logDir($)
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').toLowerCase()
  if (norm(from) === norm(to) || !(await $.fs.exists(from))) return 0
  let moved = 0
  for (const f of await $.fs.list(from)) {
    if (f.kind !== 'file' || !f.name.endsWith('.jsonl')) continue
    const src = `${from}${sep()}${f.name}`
    const dest = `${to}${sep()}${f.name}`
    const lines = (await $.fs.read(src)).split('\n').filter(Boolean)
    const have = (await $.fs.exists(dest)) ? (await $.fs.read(dest)).split('\n').filter(Boolean) : []
    const seen = new Set(have)
    const merged = [...have, ...lines.filter(l => !seen.has(l))]
    const ts = (l: string) => Number(/"ts":(\d+)/.exec(l)?.[1] ?? 0)
    await $.fs.write(dest, merged.sort((a, b) => ts(a) - ts(b)).join('\n') + '\n')
    const back = new Set((await $.fs.read(dest)).split('\n'))
    if (!lines.every(l => back.has(l))) continue
    const rm = rt.isWindows ? ['cmd', '/d', '/c', 'del', '/f', '/q', src] : ['rm', '-f', src]
    if ((await $.process.run(rm)).exitCode === 0) moved++
  }
  return moved
}

const segmentFile = (base: string, n: number) => `${base}${n > 1 ? `-${n}` : ''}.jsonl`
/** 文件名里的段号：没带 -n 的是第 1 段 */
export const segmentOf = (name: string) => Number(/-(\d+)\.jsonl$/.exec(name)?.[1] ?? 1)

/** 记一行；按会话分段整份重写（每段最多 LOG_SEGMENT 行），写入串行，插件重载后接着最后一段写 */
export function logRecord($: EngineInterface, r: LogRecord): Promise<void> {
  logChain = logChain
    .then(async () => {
      if (!logFile) {
        const id = (await $.session.id()).slice(0, 8)
        const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
        const dir = await logDir($)
        logBase = `${dir}${sep()}${day}_${id}`
        // 插件重载后接着最后一段写
        const names = (await $.fs.exists(dir)) ? (await $.fs.list(dir)).map(f => f.name) : []
        const segs = names.flatMap(n => (n.startsWith(`${day}_${id}`) ? [segmentOf(n)] : []))
        logSeg = Math.max(1, ...segs)
        logFile = segmentFile(logBase, logSeg)
        if (await $.fs.exists(logFile)) logLines = (await $.fs.read(logFile)).split('\n').filter(Boolean)
      }
      if (logLines.length >= LOG_SEGMENT) {
        logFile = segmentFile(logBase, ++logSeg)
        logLines = []
      }
      const { late: _late, ...tags } = (await sessionTags($)) as SessionTags & { late?: boolean }
      // 版本每条现算：会话中途改了配置，后面的记录就带新版本，报告据此把这个会话算作跨版本
      logLines.push(JSON.stringify({ ...r, ...tags, cv: await currentVersion($) }))
      await $.fs.write(logFile, logLines.join('\n') + '\n')
    })
    .catch(() => undefined)
  return logChain
}

export async function readLogs($: EngineInterface, from: number): Promise<LogRecord[]> {
  const dir = await logDir($)
  if (!(await $.fs.exists(dir))) return []
  const files = (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.jsonl') && f.mtimeMs >= from)
  const texts = await Promise.all(files.map(f => $.fs.read(`${dir}${sep()}${f.name}`).catch(() => '')))
  // 文件名是 日期_会话id前8位.jsonl（分段的带 -2、-3），旧记录没写 sid 的按文件名补
  return texts.flatMap((t, i) => {
    const sid = /_([^_]+?)(?:-\d+)?\.jsonl$/.exec(files[i]?.name ?? '')?.[1]
    return parseLog(t).map(r => upgradeRecord(r.sid || !sid ? r : { ...r, sid }))
  })
}

/** 0.5 之前的外派记录：模型名换成新写法（opencode/<x> → magpie/opencode-zen-free/<x>），按模型的统计和返工排序才接得上 */
export function upgradeRecord(r: LogRecord): LogRecord {
  if (r.t !== 'pi') return r
  const model = migrateModel(r.model) ?? r.model
  const redo = r.redo && (migrateModel(r.redo) ?? r.redo)
  return model === r.model && redo === r.redo ? r : { ...r, model, redo }
}

export function armOf(mode: ModelMode, d: RouterDecision | null): Arm {
  if (mode === 'off') return 'off'
  if (mode !== 'auto') return 'fixed'
  return d?.control ? 'control' : 'auto'
}

// ---------- 启动外派命令 ----------

const launchers = new Map<string, Promise<string[]>>()

/**
 * 外派命令的启动前缀。Windows 上 npm 装的 pi 是 .cmd 外壳：经 cmd /c 起的话，超时只杀得掉 cmd，
 * 真正干活的 node 成了孤儿，管道不关，任务一直挂着（实测）。所以从外壳里读出真正的程序直接起，
 * 读不出来才退回 cmd /d /c。
 * 缓存的路径每次用前确认还在：升级可能换了安装位置，旧路径一失效，任务就报“系统找不到指定的路径”
 */
export async function launcher($: EngineInterface, name: string): Promise<string[]> {
  if (!rt.isWindows) return [name]
  const cached = launchers.get(name)
  if (cached) {
    const argv = await cached
    const program = argv[argv.length - 1] ?? ''
    if (argv[0] === 'cmd' || (await $.fs.exists(program).catch(() => false))) return argv
  }
  const found = findLauncher($, name)
  launchers.set(name, found)
  return found
}

async function findLauncher($: EngineInterface, name: string): Promise<string[]> {
  const fallback = ['cmd', '/d', '/c', name]
  const where = await $.process.run(['where', `${name}.cmd`], { timeoutMs: 10_000 }).catch(() => undefined)
  const shim = where?.exitCode === 0 ? where.stdout.split(/\r?\n/).map(s => s.trim()).find(s => /\.cmd$/i.test(s)) : undefined
  if (!shim) return fallback
  const target = parseShim(shim, await $.fs.read(shim).catch(() => ''))
  if (!target) return fallback
  if (!(await $.fs.exists(target.path).catch(() => false))) return fallback
  if (!target.node) return [target.path]
  const node = target.node === 'node' ? 'node' : (await $.fs.exists(target.node).catch(() => false)) ? target.node : 'node'
  return [node, target.path]
}

/** 从 npm 生成的 .cmd 外壳里读出真正的程序：.exe 直接起，.js 交给外壳旁边的 node.exe（没有就用 PATH 里的 node） */
export function parseShim(shim: string, text: string): { path: string; node?: string } | undefined {
  const dir = shim.replace(/[\\/][^\\/]*$/, '')
  const targets = [...text.matchAll(/"%dp0%\\([^"%]+\.(exe|c?js|mjs))"/gi)].filter(m => !/^node\.exe$/i.test(m[1] ?? ''))
  const last = targets[targets.length - 1]
  if (!last?.[1]) return undefined
  const path = `${dir}\\${last[1]}`
  if (/\.exe$/i.test(last[1])) return { path }
  return { path, node: /%dp0%\\node\.exe/i.test(text) ? `${dir}\\node.exe` : 'node' }
}

/** 用户目录（~），从配置文件位置推出来 */
async function homeDir($: EngineInterface): Promise<string> {
  return (await configPath($, rt.isWindows)).replace(/[\\/]\.claude[\\/]auto-router\.json$/, '')
}

// ---------- pi ----------

export async function piCommand($: EngineInterface, args: string[]): Promise<string[]> {
  // 任务走 stdin，不进命令行，免去转义
  return [...(await launcher($, 'pi')), ...args]
}

/**
 * 不加载用户装的扩展、MCP、技能和提示词模板：实测默认会带上 subagent、电脑操控、浏览器、联网搜索和知识库 MCP，
 * 只读任务也能借子代理写文件、借 MCP 写知识库。pi.keepExtensions 里的扩展（默认只拦危险命令的 cc-safety-net）照样加载
 */
export async function piIsolation($: EngineInterface, keep: string[]): Promise<string[]> {
  const args = ['--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates']
  const s = sep()
  const root = `${await homeDir($)}${s}.pi${s}agent${s}npm${s}node_modules`
  for (const name of keep) {
    const dir = `${root}${s}${name.split('/').join(s)}`
    const pkg = await $.fs.read(`${dir}${s}package.json`).catch(() => '')
    let entries: string[] = []
    try {
      entries = (JSON.parse(pkg) as { pi?: { extensions?: string[] } }).pi?.extensions ?? []
    } catch {
      continue
    }
    for (const e of entries) args.push('-e', `${dir}${s}${e.replace(/^\.[\\/]/, '').split('/').join(s)}`)
  }
  return args
}

export async function piArgv($: EngineInterface, model: string, readOnly: boolean, keep: string[]): Promise<string[]> {
  const args = ['-p', '--no-session', '--model', model, ...(await piIsolation($, keep))]
  if (readOnly) args.push('--exclude-tools', 'edit,write,bash')
  return piCommand($, args)
}

/**
 * 面板“测一下”：给模型派一句“回复 OK”的只读任务，看此刻能不能用。
 * 不进任务列表、不写日志（免得把检测算进效果统计），失败时带上报错原文
 */
export async function probeModel($: EngineInterface, cfg: Config, model: string): Promise<ProbeResult> {
  const t0 = Date.now()
  try {
    const argv = await piArgv($, model, true, cfg.pi.keepExtensions)
    const run = await $.process.run(argv, { cwd: await homeDir($), env: await userEnv($), stdin: 'Reply with the single word OK.', timeoutMs: 90_000 })
    const text = run.stdout.trim()
    const done = { ms: Date.now() - t0, at: Date.now() }
    if (run.exitCode === 0 && text) return { ok: true, ...done }
    const why = run.stderr.trim().split('\n').find(l => l.trim()) ?? `退出码 ${run.exitCode}`
    return { ok: false, ...done, why: why.slice(0, 120) }
  } catch (err) {
    const why = /still running/.test(String(err)) ? '90 秒没回应' : String(err).slice(0, 120)
    return { ok: false, ms: Date.now() - t0, at: Date.now(), why }
  }
}

// Windows 上 Claude 应用启动后才新设的用户环境变量（如 pi 的 $AGNES_PI_API_KEY）不会传给子进程，
// 这里直接读注册表 HKCU\Environment 补上；PATH 这类要和系统级合并的不碰
export const SKIP_ENV = /^(path|pathext|temp|tmp|psmodulepath)$/i
let userEnvCache: Promise<Record<string, string>> | undefined

export function userEnv($: EngineInterface): Promise<Record<string, string>> {
  if (!rt.isWindows) return Promise.resolve({})
  userEnvCache ??= $.process
    .run(['reg', 'query', 'HKCU\\Environment'])
    .then(({ stdout }) => {
      const env: Record<string, string> = {}
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^\s+(\S+)\s+REG_SZ\s+(.*)$/.exec(line)
        if (m?.[1] && m[2] !== undefined && !SKIP_ENV.test(m[1])) env[m[1]] = m[2].trimEnd()
      }
      return env
    })
    .catch(() => ({}))
  return userEnvCache
}

/** pi 里有 key、能用的模型；面板“添加模型”和 router_config 都用它 */
export async function refreshPiModels($: EngineInterface): Promise<string[]> {
  const run = await $.process.run(await piCommand($, ['--list-models']), { env: await userEnv($), timeoutMs: 30_000 }).catch(() => undefined)
  const list = run && run.exitCode === 0 ? parseModelList(run.stdout) : []
  if (list.length) await update($, piModels, () => list)
  return list
}

export function describeTool(cfg: Config): string {
  const roles = Object.entries(cfg.pi.roles)
    .map(([name, role]) => [name, role, chainFor(cfg, name)] as const)
    .filter(([, , chain]) => chain.length > 0)
    .map(([name, role, chain]) => `- ${name}${role.readOnly ? ' [read-only]' : ''}: ${role.description} (models: ${chain.join(' -> ')})`)
  const guard = cfg.pi.guard.requireCleanGit
    ? 'A job that may write files (any role not marked read-only) is refused unless its directory is a git repository with a clean working tree and no other writing job runs there; commit or stash first. ' +
      'Do not edit those files yourself while it runs. Its result lists the files the agent changed, uncommitted: review them with git diff and keep or revert each before going on. '
    : ''
  return (
    'Hand a self-contained task to the pi coding agent on non-Claude models, which runs headless in a terminal with its own read/bash/edit/write tools in the given directory. ' +
    'Use it to offload work that can be fully specified and checked afterwards (bulk edits, large reading, independent side tasks, a second-opinion review) so the Claude session keeps its context; ' +
    'keep judgment, design and acceptance in Claude, and verify what comes back. The agent sees nothing of this conversation. ' +
    'Pick the role that fits; each tries its models in order and skips providers that are off or in peak hours, models paused after an auth, quota, rate-limit or connection error, and models no longer listed by pi; when none is left it uses the fallback models' +
    (cfg.pi.fallback.length ? ` (${cfg.pi.fallback.join(' -> ')})` : '') +
    ', and only if those are unusable too is the job queued until off-peak. ' +
    guard +
    'background=true returns a job id at once; fetch the output later with pi_result.\nRoles:\n' +
    roles.join('\n')
  )
}

/** 本机有没有 pi，跨会话记在 store 里：会话开始时先按上次的结果定要不要注册外派工具，后台再检测一遍 */
type Channels = { pi: boolean; at: number }
const CHANNELS = 'channels'
/** 上次检测 pi 没装 */
let noChannels = false

export async function initChannels($: EngineInterface): Promise<void> {
  const known = (await $.store.get(CHANNELS).catch(() => undefined)) as Channels | undefined
  noChannels = !!known && !known.pi
}

/**
 * 后台检测本机的 pi：列不出模型就算没装，外派工具改成“不可用”（引擎不能撤掉已注册的工具），下个会话起不注册。
 * 装了的一天查一次；没装的每个会话都查（没装时命令立刻失败，不费事），装上后当场注册。
 * firstRun（配置文件刚生成）时只开着检测到的提供商，按档位重排角色
 */
export async function detectChannels($: EngineInterface, firstRun: boolean): Promise<void> {
  const known = (await $.store.get(CHANNELS).catch(() => undefined)) as Channels | undefined
  if (!firstRun && known?.pi && Date.now() - known.at < 86_400_000) return
  const pi = await refreshPiModels($)
  const found: Channels = { pi: pi.length > 0, at: Date.now() }
  await $.store.set(CHANNELS, found).catch(() => undefined)
  noChannels = !found.pi
  if (firstRun && !noChannels) {
    const errs = await editConfig($, cfg => onlyDetected(cfg, pi))
    if (!errs.length) return
  }
  await registerTools($, await config($))
}

/** 外派工具此刻能不能用：装了 pi，且至少一个角色排得出模型 */
export function canDelegate(cfg: Config): boolean {
  return !noChannels && Object.keys(cfg.pi.roles).some(r => chainFor(cfg, r).length > 0)
}

const NO_DELEGATE =
  'Not available: the pi coding agent is not installed on this machine, or no delegate model is set up. Do not call this tool; do the work yourself. ' +
  'The user can install pi and pick models in /auto-router (the delegate models tab).'
export async function registerTools($: EngineInterface, cfg: Config): Promise<void> {
  const usable = canDelegate(cfg)
  // 本会话还没注册过、又用不了：不注册，模型看不到它，系统提示里的规则也就不提外派
  if (!usable && !toolDescription) return
  const description = usable ? describeTool(cfg) : NO_DELEGATE
  if (description === toolDescription) return
  const first = !toolDescription
  toolDescription = description
  if (first)
    await $.tool.register({
      name: 'pi_result',
      isDeferred: false,
      description: 'Get the status and output of a job started by pi_dispatch with background=true, or one queued for off-peak hours.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    })
  await $.tool.register({
    name: 'pi_dispatch',
    isDeferred: false,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete instructions for the agent, including file paths and what done looks like.' },
        role: { type: 'string', enum: Object.keys(cfg.pi.roles), description: `Role, default ${cfg.pi.defaultRole}.` },
        model: { type: 'string', description: 'Exact model id (provider/id, as pi --list-models shows it), overriding role.' },
        cwd: { type: 'string', description: 'Working directory for the agent, default the session directory.' },
        readOnly: { type: 'boolean', description: 'Disable edit, write and bash; read-only roles always are. Skips the git checks.' },
        background: { type: 'boolean', description: 'Return immediately with a job id.' },
      },
      required: ['task'],
    },
  })
}

/** 新会话开始：清掉上个会话的状态 */
export function resetSession(cwd: string) {
  rt.isWindows = /^[A-Za-z]:[\\/]/.test(cwd)
  rt.sessionCwd = cwd
  toolDescription = ''
  logFile = undefined
  logLines = []
  logSeg = 1
  tagsCache = undefined
  reminded.clear()
  quotaWarned = false
  launchers.clear()
}
