import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ModelMode, RouterDecision } from '../types'
import { chainFor, configPath, loadConfig, parseModelList, parseOpencodeModels, saveConfig, tagged, validate } from './config'
import type { Config } from './config'
import { crossedLevel, quotaText, remindText } from './saver'
import { parseLog, sessionArms } from './stats'
import type { Arm, LogRecord, SessionTags } from './stats'

// register.tsx 和 panel.tsx 共用的运行时：配置读写、会话分组、日志、pi 工具注册。

// 同一 plugin/key 的 atom 在用到它的每个文件里各声明一份：引擎扫描要求 atom 写在读写它的文件里
const configRev = atom({ plugin: 'auto-router', key: 'configRev' } as const, 0)
const piModels = atom({ plugin: 'auto-router', key: 'piModels' } as const, [], { shape: 'models-1' })
const ocModels = atom({ plugin: 'auto-router', key: 'ocModels' } as const, [], { shape: 'models-1' })

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
let logChain: Promise<void> = Promise.resolve()

export async function logDir($: EngineInterface): Promise<string> {
  return (await configPath($, rt.isWindows)).replace(/auto-router\.json$/, `auto-router${sep()}log`)
}

/** 记一行；按会话一个文件整份重写，写入串行，插件重载后接着原文件写 */
export function logRecord($: EngineInterface, r: LogRecord): Promise<void> {
  logChain = logChain
    .then(async () => {
      if (!logFile) {
        const id = (await $.session.id()).slice(0, 8)
        const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
        logFile = `${await logDir($)}${sep()}${day}_${id}.jsonl`
        if (await $.fs.exists(logFile)) logLines = (await $.fs.read(logFile)).split('\n').filter(Boolean)
      }
      const { late: _late, ...tags } = (await sessionTags($)) as SessionTags & { late?: boolean }
      logLines.push(JSON.stringify({ ...r, ...tags }))
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
  // 文件名是 日期_会话id前8位.jsonl，旧记录没写 sid 的按文件名补
  return texts.flatMap((t, i) => {
    const sid = /_([^_]+)\.jsonl$/.exec(files[i]?.name ?? '')?.[1]
    return parseLog(t).map(r => (r.sid || !sid ? r : { ...r, sid }))
  })
}

export function armOf(mode: ModelMode, d: RouterDecision | null): Arm {
  if (mode === 'off') return 'off'
  if (mode !== 'auto') return 'fixed'
  return d?.control ? 'control' : 'auto'
}

// ---------- 启动外派命令 ----------

const launchers = new Map<string, Promise<string[]>>()

/**
 * 外派命令的启动前缀。Windows 上 npm 装的 pi / opencode 是 .cmd 外壳：经 cmd /c 起的话，超时只杀得掉 cmd，
 * 真正干活的 node / opencode.exe 成了孤儿，管道不关，任务一直挂着（实测）。所以从外壳里读出真正的程序直接起，
 * 读不出来才退回 cmd /d /c。
 * 缓存的路径每次用前确认还在：opencode 会自己升级，实测 2.x 把安装位置从 opencode-ai 挪到了 @opencode/cli，
 * 旧路径一失效，任务就报“系统找不到指定的路径”
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

// ---------- opencode ----------

export async function opencodeCommand($: EngineInterface, args: string[]): Promise<string[]> {
  return [...(await launcher($, 'opencode')), ...args]
}

/** 经 OPENCODE_CONFIG_CONTENT 临时注入的两个代理，不改用户的 opencode 配置 */
export const OC_READONLY_AGENT = 'auto-router-readonly'
export const OC_WRITE_AGENT = 'auto-router-write'

const ocMajors = new Map<string, Promise<number>>()

/** opencode 的大版本，按程序路径缓存（升级换了位置就重新查）；查不出按 2 */
async function opencodeMajor($: EngineInterface): Promise<number> {
  const argv = await launcher($, 'opencode')
  const key = argv.join(' ')
  let major = ocMajors.get(key)
  if (!major) {
    major = $.process
      .run([...argv, '--version'], { timeoutMs: 30_000 })
      .then(r => Number(/(\d+)\.\d+/.exec(r.stdout)?.[1] ?? 2))
      .catch(() => 2)
    ocMajors.set(key, major)
  }
  return major
}

/**
 * 2.x 起 opencode 默认连常驻的后台服务，我们注入的环境变量（隔离目录、两个代理）到不了它，
 * 实测报 Agent not found；所以加 --standalone 起私有服务。2.x 也去掉了 --dir，目录靠 cwd
 */
export async function opencodeArgv($: EngineInterface, model: string, readOnly: boolean, dir: string): Promise<string[]> {
  const agent = readOnly ? OC_READONLY_AGENT : OC_WRITE_AGENT
  if ((await opencodeMajor($)) < 2) return opencodeCommand($, ['run', '-m', model, '--format', 'json', '--dir', dir, '--agent', agent])
  return opencodeCommand($, ['run', '-m', model, '--format', 'json', '--agent', agent, '--standalone'])
}

/** 隔离用的 opencode 配置目录：不读用户全局的 opencode.json（里面的 MCP、插件、全局 AGENTS.md） */
export async function opencodeHome($: EngineInterface): Promise<string> {
  return (await configPath($, rt.isWindows)).replace(/auto-router\.json$/, `auto-router${sep()}opencode`)
}

const OC_BASH_DENY = [
  'git commit*',
  'git push*',
  'git reset*',
  'git clean*',
  'rm -r*',
  'rm -fr*',
  'Remove-Item*-Recurse*',
  'rd /s*',
  'rmdir /s*',
  'del /s*',
  'Format-Volume*',
]

const OC_READ = { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*.env.example': 'allow' }

/**
 * opencode 的环境变量。实测：
 * - 自带的 plan 代理只禁 edit，bash 照样能写文件，所以只读用自己的代理；
 * - 用户全局配置里的 MCP（如知识库）、插件、全局 AGENTS.md 和 ~/.claude 下的技能都会带进来，
 *   所以把 XDG_CONFIG_HOME 指到插件自己的空目录、关掉 Claude Code 兼容，权限先全部 deny 再逐个放开；
 * - 用户配置里 bash 是 "ask" 时，opencode run 没人点允许会一直卡着，所以可写代理把 bash 明确设成 allow，
 *   只拦提交、推送和 reset（改动留给 Claude 审阅）
 */
export function opencodeEnv(home: string): Record<string, string> {
  const base = { '*': 'deny', read: OC_READ, grep: 'allow', glob: 'allow', list: 'allow' }
  const agent = (description: string, permission: Record<string, unknown>) => ({ mode: 'primary', description, permission })
  return {
    XDG_CONFIG_HOME: home,
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    // 外派的任务里不自己升级：升级要下几百 MB，期间任务卡住，升级完旧路径也没了（实测）
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      agent: {
        [OC_READONLY_AGENT]: agent('auto-router read-only: read, grep, glob, list only', base),
        [OC_WRITE_AGENT]: agent('auto-router write: edit and bash in the work dir, no commit or push', {
          ...base,
          edit: 'allow',
          todowrite: 'allow',
          // 后写的规则优先：先全部放开，再拦提交、推送、回退和递归删除（bash 能碰到工作目录外面）
          bash: { '*': 'allow', ...Object.fromEntries(OC_BASH_DENY.map(p => [p, 'deny'])) },
        }),
      },
    }),
  }
}

/**
 * 解析 `opencode run --format json` 的事件流（一行一个 JSON）：
 * 结果取最后一步的文字（前面几步多是“我先看看某文件”），最后一步没字时取全部文字；error 事件的消息单独返回
 */
export function parseOpencodeRun(stdout: string): { text: string; error?: string; freeLimit?: boolean; retryAfterMs?: number } {
  const steps: string[][] = [[]]
  let error: string | undefined
  let freeLimit: boolean | undefined
  let retryAfterMs: number | undefined
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '').trim()
    if (!line.startsWith('{')) continue
    // 1.x：error.name + error.data.message；2.x：error.type + error.message + retryAfterMs
    let ev: {
      type?: string
      part?: { text?: string }
      error?: { name?: string; type?: string; message?: string; retryAfterMs?: number; data?: { message?: string } }
    }
    try {
      ev = JSON.parse(line)
    } catch {
      continue
    }
    if (ev.type === 'step_start') steps.push([])
    else if (ev.type === 'text' && ev.part?.text?.trim()) steps[steps.length - 1]?.push(ev.part.text)
    else if (ev.type === 'error') {
      error = ev.error?.data?.message ?? ev.error?.message ?? ev.error?.name ?? ev.error?.type ?? 'error'
      // 免费额度按模型算（实测 glm 用完时 flint 照样能用），并告诉你多久后恢复
      if (ev.error?.type === 'provider.free-limit') freeLimit = true
      if (typeof ev.error?.retryAfterMs === 'number') retryAfterMs = ev.error.retryAfterMs
    }
  }
  const last = steps[steps.length - 1] ?? []
  const text = (last.length ? last : steps.flat()).join('\n\n').trim()
  return freeLimit || retryAfterMs ? { text, error, freeLimit, retryAfterMs } : { text, error }
}

/** opencode 里此刻还在的免费模型；空列表表示没取到（没装 opencode 或命令失败），这时不按下架处理 */
export async function refreshOpencodeModels($: EngineInterface): Promise<string[]> {
  // 2.x 的 models 不再接提供商参数（给了只打印帮助），列全部再筛 opencode/ 开头的
  const args = (await opencodeMajor($)) < 2 ? ['models', 'opencode'] : ['models', '--standalone']
  const run = await $.process.run(await opencodeCommand($, args), { env: { ...(await userEnv($)), ...opencodeEnv(await opencodeHome($)) }, timeoutMs: 120_000 }).catch(() => undefined)
  const list = run && run.exitCode === 0 ? parseOpencodeModels(run.stdout) : []
  if (list.length) await update($, ocModels, () => list)
  return list
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
    .map(([name, role, chain]) => `- ${name}${role.readOnly ? ' [read-only]' : ''}: ${role.description} (models: ${chain.map(tagged).join(' -> ')})`)
  const guard = cfg.pi.guard.requireCleanGit
    ? 'A job that may write files (any role not marked read-only) is refused unless its directory is a git repository with a clean working tree and no other writing job runs there; commit or stash first. ' +
      'Do not edit those files yourself while it runs. Its result lists the files the agent changed, uncommitted: review them with git diff and keep or revert each before going on. '
    : ''
  return (
    'Hand a self-contained task to a headless coding agent on non-Claude models, which runs in a terminal with its own read/bash/edit/write tools in the given directory. ' +
    'Each model names its channel: [pi] models run on the pi coding agent, [opencode] models (opencode/...) run on `opencode run` (free models; some log usage, so those are only used in directories the user allowed). ' +
    'Use it to offload work that can be fully specified and checked afterwards (bulk edits, large reading, independent side tasks, a second-opinion review) so the Claude session keeps its context; ' +
    'keep judgment, design and acceptance in Claude, and verify what comes back. The agent sees nothing of this conversation. ' +
    'Pick the role that fits; each tries its models in order and skips providers that are off, in peak hours, or paused after an auth/quota error, and free models that were withdrawn or are not allowed for the directory; when none is left it uses the fallback models' +
    (cfg.pi.fallback.length ? ` (${cfg.pi.fallback.map(tagged).join(' -> ')})` : '') +
    ', and only if those are unusable too is the job queued until off-peak. ' +
    guard +
    'background=true returns a job id at once; fetch the output later with pi_result.\nRoles:\n' +
    roles.join('\n')
  )
}

export async function registerTools($: EngineInterface, cfg: Config): Promise<void> {
  const description = describeTool(cfg)
  if (description === toolDescription) return
  toolDescription = description
  await $.tool.register({
    name: 'pi_dispatch',
    isDeferred: false,
    description,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete instructions for the agent, including file paths and what done looks like.' },
        role: { type: 'string', enum: Object.keys(cfg.pi.roles), description: `Role, default ${cfg.pi.defaultRole}.` },
        model: { type: 'string', description: 'Exact model id (provider/id), overriding role; opencode/... runs on opencode, anything else on pi.' },
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
  tagsCache = undefined
  reminded.clear()
  quotaWarned = false
  launchers.clear()
  ocMajors.clear()
}
