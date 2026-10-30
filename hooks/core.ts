import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ModelMode, RouterDecision } from '../types'
import { chainFor, configPath, loadConfig, parseModelList, saveConfig, validate } from './config'
import type { Config } from './config'
import { crossedLevel, quotaText, remindText } from './saver'
import { parseLog, sessionArms } from './stats'
import type { Arm, LogRecord, SessionTags } from './stats'

// register.tsx 和 panel.tsx 共用的运行时：配置读写、会话分组、日志、pi 工具注册。

// 同一 plugin/key 的 atom 在用到它的每个文件里各声明一份：引擎扫描要求 atom 写在读写它的文件里
const configRev = atom({ plugin: 'auto-router', key: 'configRev' } as const, 0)
const piModels = atom({ plugin: 'auto-router', key: 'piModels' } as const, [], { shape: 'models-1' })

// ---------- 状态 ----------

/** 会话级运行时变量；rt.isWindows、rt.sessionCwd 在 session.start 时设置，firstRun 表示配置文件是这次刚生成的（/auto-router 先打开 pi 模型页） */
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
    if (cfg.experiment === 'off' || (await startedOutside($, sid))) return { ...plain, late: cfg.experiment !== 'off' || undefined }
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

// ---------- pi ----------

export function piCommand(args: string[]): string[] {
  // Windows 上 pi 是 pi.cmd，不经 shell 起不来；任务走 stdin，不进命令行，免去转义
  return rt.isWindows ? ['cmd', '/d', '/c', 'pi', ...args] : ['pi', ...args]
}

export function piArgv(model: string, readOnly: boolean): string[] {
  const args = ['-p', '--no-session', '--model', model]
  if (readOnly) args.push('--exclude-tools', 'edit,write,bash')
  return piCommand(args)
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
  const run = await $.process.run(piCommand(['--list-models']), { env: await userEnv($), timeoutMs: 30_000 }).catch(() => undefined)
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
    ? 'A job that may write files (any role not marked read-only) is refused unless its directory is a git repository with a clean working tree and no other writing pi job runs there; commit or stash first. ' +
      'Do not edit those files yourself while it runs. Its result lists the files pi changed, uncommitted: review them with git diff and keep or revert each before going on. '
    : ''
  return (
    'Hand a self-contained task to the pi coding agent, which runs headless in a terminal with its own read/bash/edit/write tools in the given directory, on non-Claude models. ' +
    'Use it to offload work that can be fully specified and checked afterwards (bulk edits, large reading, independent side tasks, a second-opinion review) so the Claude session keeps its context; ' +
    'keep judgment, design and acceptance in Claude, and verify what pi returns. pi sees nothing of this conversation. ' +
    'Pick the role that fits; each tries its models in order and skips providers that are off, in peak hours, or paused after an auth/quota error; when none is left it uses the fallback models' +
    (cfg.pi.fallback.length ? ` (${cfg.pi.fallback.join(' -> ')})` : '') +
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
        task: { type: 'string', description: 'Complete instructions for pi, including file paths and what done looks like.' },
        role: { type: 'string', enum: Object.keys(cfg.pi.roles), description: `Role, default ${cfg.pi.defaultRole}.` },
        model: { type: 'string', description: 'Exact pi model id (provider/id), overriding role.' },
        cwd: { type: 'string', description: 'Working directory for pi, default the session directory.' },
        readOnly: { type: 'boolean', description: 'Disable edit, write and bash for pi; read-only roles always are. Skips the git checks.' },
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
}
