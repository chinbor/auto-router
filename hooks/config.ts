import type { EngineInterface } from 'claude-code'
import type { BigRead } from './saver'

// 路由配置：~/.claude/auto-router.json，首次运行写入默认值。
// 每次分类和派任务前都重新读，改完文件立即生效，不用重启。

export type Category = {
  /** 给 classify 的英文描述，小模型对英文更稳 */
  label: string
  /** 状态栏显示的中文名 */
  name: string
  /** Claude 模型别名；不写则保持会话原模型 */
  model?: 'haiku' | 'sonnet' | 'opus'
  /** 建议外派的 pi 角色 */
  piRole?: string
}

/** 高峰时段：此时不启动该提供商的模型 */
export type PeakSchedule = {
  /** 时区偏移（小时），北京时间为 8 */
  utcOffset: number
  /** 哪几天有高峰，0 = 周日 … 6 = 周六 */
  weekdays: number[]
  /** 高峰时间段，"HH:MM-HH:MM" */
  hours: string[]
  /** 当天全天按空闲算的日期（法定节假日），"YYYY-MM-DD" */
  holidays: string[]
}

export type Provider = {
  enabled: boolean
  /** subscription 订阅 / token 按量付费，只作说明和展示 */
  billing: 'subscription' | 'token'
  /** 有值时，高峰时段跳过该提供商 */
  peak?: PeakSchedule
  note?: string
}

export type Role = {
  /** 什么样的任务用这个角色，会写进 pi_dispatch 的工具说明 */
  description: string
  /** 依次尝试的模型（provider/id），被关掉或正处高峰的提供商自动跳过 */
  models: string[]
  /** true 时强制禁用 pi 的 edit / write / bash，Claude 传参也改不了 */
  readOnly?: boolean
}

/** 模型档位：strong 强、mid 中、light 轻；面板 pi 模型页按档位排各角色的模型顺序 */
export type Tier = 'strong' | 'mid' | 'light'

export type Config = {
  claude: {
    /** 降档要连续多少轮都判为更轻的类别；升档立即生效 */
    downgradeAfter: number
    /** 上下文超过这么多 token 时不降档（换模型要整段重写缓存，越长越亏）；0 表示不限 */
    keepAboveTokens: number
    /** 用户在纠正上一轮（不对、重做…）时升一档 */
    upgradeOnCorrection: boolean
    categories: Category[]
  }
  pi: {
    timeoutMinutes: number
    defaultRole: string
    providers: Record<string, Provider>
    roles: Record<string, Role>
    guard: {
      /** 会写文件的任务：工作目录要是 git 仓库且工作区干净，同一仓库不并发写，跑完附 diff 摘要 */
      requireCleanGit: boolean
    }
    /** 角色链上的模型此刻都用不了（关掉、高峰、熔断）时的兜底，按顺序试；兜底也用不了才排队 */
    fallback: string[]
    /** 提供商报鉴权 / 额度类错误后暂停多少分钟 */
    pauseMinutes: number
    /** 模型档位，同一档里排在前面的更强；pi 模型页据此排角色 */
    tiers: Record<string, Tier>
  }
  saver: {
    /** 总开关：关掉后不拦、不提醒、不写规则，scout / executor 子代理也不出现 */
    enabled: boolean
    /** 拦下读大文件、大图、整页网页、刷屏命令（同一目标只拦一次） */
    guard: boolean
    /** 上下文超过这些 token 数时各提醒一次交接或压缩；[] 不提醒 */
    remindAt: number[]
    /** 大量阅读交给谁：auto 按规则在 scout 和 pi longctx 之间选 */
    bigRead: BigRead
    /** 7 天额度用到这个百分比后，大量阅读优先派给 pi longctx */
    quotaPct: number
  }
  /** 对照实验：每个新会话按会话 id 固定分组。route 只测模型切换，saver 只测省额度，both 两个一起（2×2） */
  experiment: Experiment
}

export type Experiment = 'off' | 'route' | 'saver' | 'both'

const SOL = 'openai/gpt-6.1-sol'
const TERRA = 'openai/gpt-6.1-terra'
const DS_FLASH = 'cc-switch-deep-seek/deepseek-flash'
const AG3 = 'agnes/agnes-3.0-flash'
const AG25 = 'agnes/agnes-2.5-flash'

// 原则：订阅（gpt、agnes）优先，按量付费的 deepseek 只作兜底，且只在空闲时段用；
// 只有要 1M 长上下文时才首选 deepseek-flash。deepseek-v4-pro 比 flash 贵，默认不用。
// 强度 gpt > deepseek > agnes；terra 比 sol 快、便宜，看图和操作电脑更强，sol 推理更强。
export const DEFAULT_CONFIG: Config = {
  claude: {
    downgradeAfter: 2,
    keepAboveTokens: 150_000,
    upgradeOnCorrection: true,
    categories: [
      { label: 'greeting, small talk or a quick factual question', name: '闲聊/简答', model: 'haiku' },
      { label: 'translating, summarizing, proofreading or rewriting text', name: '文本处理', model: 'sonnet', piRole: 'text' },
      { label: 'a small code edit, running a command or looking something up in files', name: '小改动/查找', model: 'sonnet' },
      { label: 'a coding task: building a feature, refactoring or debugging', name: '编码', model: 'sonnet' },
      { label: 'a hard problem needing deep reasoning, architecture or design decisions', name: '难题/设计', model: 'opus' },
      { label: 'reviewing code or a diff, or investigating the root cause of a bug', name: '评审/查根因', model: 'opus', piRole: 'review' },
      { label: 'bulk mechanical work: batch edits across many files, migrations, generating many files', name: '批量修改', model: 'sonnet', piRole: 'bulk' },
      { label: 'reading or summarizing a large amount of code, logs or documents', name: '大量阅读', model: 'sonnet', piRole: 'longctx' },
      { label: 'other', name: '其他' },
    ],
  },
  pi: {
    timeoutMinutes: 10,
    defaultRole: 'code',
    providers: {
      openai: { enabled: true, billing: 'subscription', note: 'GPT 订阅，可能退订：关掉后各角色自动跳过 gpt' },
      agnes: { enabled: true, billing: 'subscription' },
      'cc-switch-deep-seek': {
        enabled: true,
        billing: 'token',
        note: '高峰时段价格翻倍，只在空闲时段启动',
        peak: {
          utcOffset: 8,
          weekdays: [1, 2, 3, 4, 5],
          hours: ['09:00-12:00', '14:00-18:00'],
          holidays: [],
        },
      },
    },
    roles: {
      review: {
        description: 'independent code review, root-cause diagnosis, tricky algorithms; a second opinion to check Claude against',
        models: [SOL, TERRA, DS_FLASH],
        readOnly: true,
      },
      code: {
        description: 'well-specified coding: implement a module, add tests, refactor to a given plan',
        models: [TERRA, SOL, DS_FLASH],
      },
      vision: {
        description: 'tasks that need to look at screenshots or images, UI work',
        models: [TERRA, SOL, DS_FLASH],
      },
      bulk: {
        description: 'mechanical edits across many files: renames, migrations, applying one pattern everywhere',
        models: [TERRA, AG3, DS_FLASH],
      },
      longctx: {
        description: 'reading a very large amount of code or documents (beyond ~200K tokens) and summarizing it',
        models: [DS_FLASH, TERRA],
        readOnly: true,
      },
      quick: {
        description: 'simple scripted chores: analyse logs, run tests and report, convert formats, search and tabulate',
        models: [AG3, TERRA, DS_FLASH],
      },
      text: {
        description: 'pure text: translate, summarize, rewrite, write commit messages, name things',
        models: [AG3, AG25, DS_FLASH],
        readOnly: true,
      },
      trivial: {
        description: 'trivial extraction or formatting: pull fields out, reshape into JSON, simple classification',
        models: [AG25, AG3, DS_FLASH],
        readOnly: true,
      },
    },
    guard: { requireCleanGit: true },
    // gpt 退订、deepseek 高峰时，各角色最后靠 agnes-3.0-flash 顶上
    fallback: [AG3, AG25],
    pauseMinutes: 30,
    tiers: { [SOL]: 'strong', [TERRA]: 'strong', [DS_FLASH]: 'mid', [AG3]: 'light', [AG25]: 'light' },
  },
  saver: {
    enabled: true,
    guard: true,
    remindAt: [300_000, 600_000],
    bigRead: 'auto',
    quotaPct: 70,
  },
  experiment: 'off',
}

let pathCache: string | undefined

export async function configPath($: EngineInterface, isWindows: boolean): Promise<string> {
  if (pathCache) return pathCache
  // 插件装在 ~/.claude 下时直接从路径推；否则问 shell
  const m = /^(.*?[\\/]\.claude)[\\/]/.exec($.plugin.root)
  let dir = m?.[1]
  if (!dir) {
    const run = isWindows
      ? await $.process.run(['cmd', '/d', '/c', 'echo %USERPROFILE%'])
      : await $.process.run(['sh', '-c', 'printf %s "$HOME"'])
    dir = `${run.stdout.trim()}${isWindows ? '\\' : '/'}.claude`
  }
  pathCache = `${dir}${isWindows ? '\\' : '/'}auto-router.json`
  return pathCache
}

let warned = false
let created = false

/** 这次运行里配置文件是不是刚生成的（新用户，面板先打开 pi 模型页）；读一次后清零 */
export function consumeCreated(): boolean {
  const was = created
  created = false
  return was
}

/** 读配置，缺的字段用默认值补；文件不存在就写一份默认的 */
export async function loadConfig($: EngineInterface, isWindows: boolean): Promise<Config> {
  const path = await configPath($, isWindows)
  if (!(await $.fs.exists(path))) {
    await $.fs.write(path, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n').catch(() => undefined)
    created = true
    return DEFAULT_CONFIG
  }
  try {
    const raw = JSON.parse(await $.fs.read(path)) as Partial<Config>
    // 旧版的 claude.abTest（单双号日对照）换成按会话分组的 route 实验
    const legacyAb = (raw.claude as { abTest?: boolean } | undefined)?.abTest === true
    const { abTest: _ab, ...claude } = (raw.claude ?? {}) as Partial<Config['claude']> & { abTest?: boolean }
    const cfg: Config = {
      claude: { ...DEFAULT_CONFIG.claude, ...claude },
      pi: { ...DEFAULT_CONFIG.pi, ...raw.pi },
      saver: { ...DEFAULT_CONFIG.saver, ...raw.saver },
      experiment: raw.experiment ?? (legacyAb ? 'route' : DEFAULT_CONFIG.experiment),
    }
    const errs = validate(cfg)
    if (errs.length) throw new Error(errs.slice(0, 3).join('；'))
    warned = false
    return cfg
  } catch (err) {
    if (!warned) $.ui.toast(`auto-router 配置读取失败，先用默认值：${String(err).slice(0, 120)}`)
    warned = true
    return DEFAULT_CONFIG
  }
}

export async function saveConfig($: EngineInterface, isWindows: boolean, config: Config): Promise<void> {
  await $.fs.write(await configPath($, isWindows), JSON.stringify(config, null, 2) + '\n')
}

// ---------- 校验与修改（设置面板和 router_config 工具共用） ----------

const CLAUDE_MODELS = ['haiku', 'sonnet', 'opus']
const TIERS: string[] = ['strong', 'mid', 'light']
const HHMM_RANGE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-4]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** 返回问题列表；空表示可以保存 */
export function validate(cfg: Config): string[] {
  const errs: string[] = []
  const c = cfg.claude
  if (!Number.isInteger(c?.downgradeAfter) || c.downgradeAfter < 1) errs.push('claude.downgradeAfter 要是 ≥1 的整数')
  if (!Number.isFinite(c?.keepAboveTokens) || c.keepAboveTokens < 0) errs.push('claude.keepAboveTokens 要是 ≥0 的数字')
  if (typeof c?.upgradeOnCorrection !== 'boolean') errs.push('claude.upgradeOnCorrection 要是 true / false')
  if (!Array.isArray(c?.categories) || c.categories.length === 0) errs.push('claude.categories 不能为空')
  const providers = cfg.pi?.providers ?? {}
  const roles = cfg.pi?.roles ?? {}
  c?.categories?.forEach((cat, i) => {
    if (!cat?.label || !cat.name) errs.push(`claude.categories[${i}] 缺 label 或 name`)
    if (cat?.model !== undefined && !CLAUDE_MODELS.includes(cat.model)) errs.push(`claude.categories[${i}].model 只能是 ${CLAUDE_MODELS.join(' / ')} 或不写`)
    if (cat?.piRole !== undefined && !roles[cat.piRole]) errs.push(`claude.categories[${i}].piRole「${cat.piRole}」不是已有角色`)
  })
  if (!Number.isFinite(cfg.pi?.timeoutMinutes) || cfg.pi.timeoutMinutes <= 0 || cfg.pi.timeoutMinutes > 10) errs.push('pi.timeoutMinutes 要在 0–10 之间')
  if (!roles[cfg.pi?.defaultRole]) errs.push(`pi.defaultRole「${cfg.pi?.defaultRole}」不是已有角色`)
  if (typeof cfg.pi?.guard?.requireCleanGit !== 'boolean') errs.push('pi.guard.requireCleanGit 要是 true / false')
  if (!Number.isFinite(cfg.pi?.pauseMinutes) || cfg.pi.pauseMinutes < 0) errs.push('pi.pauseMinutes 要是 ≥0 的数字')
  if (!Array.isArray(cfg.pi?.fallback)) errs.push('pi.fallback 要是模型列表，可以为空 []')
  else
    cfg.pi.fallback.forEach(m => {
      if (typeof m !== 'string' || !m.includes('/')) errs.push(`pi.fallback 里的「${m}」要写成 provider/模型`)
      else if (!providers[providerOf(m)]) errs.push(`pi.fallback 里的「${m}」的提供商 ${providerOf(m)} 不在 pi.providers 里`)
    })
  for (const [m, t] of Object.entries(cfg.pi?.tiers ?? {})) {
    if (!TIERS.includes(t)) errs.push(`pi.tiers 里「${m}」的档位只能是 ${TIERS.join(' / ')}`)
  }
  for (const [name, p] of Object.entries(providers)) {
    if (typeof p?.enabled !== 'boolean') errs.push(`pi.providers.${name}.enabled 要是 true / false`)
    if (p?.billing !== 'subscription' && p?.billing !== 'token') errs.push(`pi.providers.${name}.billing 只能是 subscription / token`)
    if (p?.peak) {
      if (!Array.isArray(p.peak.hours) || !p.peak.hours.every(h => HHMM_RANGE.test(h))) errs.push(`pi.providers.${name}.peak.hours 每项要像 "09:00-12:00"`)
      if (!Array.isArray(p.peak.weekdays) || !p.peak.weekdays.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) errs.push(`pi.providers.${name}.peak.weekdays 是 0–6 的数字，0 = 周日`)
      if (!Array.isArray(p.peak.holidays) || !p.peak.holidays.every(d => DATE.test(d))) errs.push(`pi.providers.${name}.peak.holidays 每项要像 "2027-01-01"`)
      if (typeof p.peak.utcOffset !== 'number') errs.push(`pi.providers.${name}.peak.utcOffset 要是数字`)
    }
  }
  const sv = cfg.saver
  if (typeof sv?.enabled !== 'boolean') errs.push('saver.enabled 要是 true / false')
  if (typeof sv?.guard !== 'boolean') errs.push('saver.guard 要是 true / false')
  if (!Array.isArray(sv?.remindAt) || !sv.remindAt.every(n => Number.isFinite(n) && n > 0)) errs.push('saver.remindAt 要是正数列表，可以为空 []')
  if (!['auto', 'scout', 'pi'].includes(sv?.bigRead)) errs.push('saver.bigRead 只能是 auto / scout / pi')
  if (!Number.isFinite(sv?.quotaPct) || sv.quotaPct < 0 || sv.quotaPct > 100) errs.push('saver.quotaPct 要在 0–100 之间')
  if (!['off', 'route', 'saver', 'both'].includes(cfg.experiment)) errs.push('experiment 只能是 off / route / saver / both')
  for (const [name, r] of Object.entries(roles)) {
    if (!r?.description) errs.push(`pi.roles.${name}.description 不能为空`)
    if (!Array.isArray(r?.models) || r.models.length === 0) errs.push(`pi.roles.${name}.models 至少要有一个模型`)
    if (r?.readOnly !== undefined && typeof r.readOnly !== 'boolean') errs.push(`pi.roles.${name}.readOnly 要是 true / false`)
    r?.models?.forEach(m => {
      if (typeof m !== 'string' || !m.includes('/')) errs.push(`pi.roles.${name}.models 里的「${m}」要写成 provider/模型`)
      else if (!providers[providerOf(m)]) errs.push(`pi.roles.${name}.models 里的「${m}」的提供商 ${providerOf(m)} 不在 pi.providers 里`)
    })
  }
  return errs
}

/** 按 "pi.roles.code.models" 这样的路径设值（返回新对象）；value 为 undefined 时删除该项 */
export function setPath(cfg: Config, path: string, value: unknown): Config {
  const keys = path.split('.').filter(Boolean)
  if (keys.length === 0) throw new Error('path 不能为空')
  const root = JSON.parse(JSON.stringify(cfg)) as Record<string, unknown>
  let node: Record<string, unknown> = root
  for (const key of keys.slice(0, -1)) {
    const child = node[key]
    if (child === null || typeof child !== 'object') throw new Error(`路径 ${path} 里的 ${key} 不存在`)
    node = child as Record<string, unknown>
  }
  const last = keys[keys.length - 1] as string
  if (value === undefined) {
    if (Array.isArray(node)) node.splice(Number(last), 1)
    else delete node[last]
  } else node[last] = value
  return root as unknown as Config
}

/** 解析 `pi --list-models` 的输出，得到 provider/id 列表 */
export function parseModelList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .slice(1)
    .map(line => line.trim().split(/\s+/))
    .filter(cols => cols.length >= 2 && cols[0] && cols[1])
    .map(cols => `${cols[0]}/${cols[1]}`)
}

const RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 }

/** 升档立即生效；降档要连续 downgradeAfter 轮都想降才降；分类不给模型时保持不变 */
export function sticky(
  prev: { model?: string; lighterStreak: number } | null,
  wanted: string | undefined,
  downgradeAfter: number,
): { model?: string; lighterStreak: number } {
  const current = prev?.model
  if (!wanted) return { model: current, lighterStreak: 0 }
  if (!current || (RANK[wanted] ?? 0) >= (RANK[current] ?? 0)) return { model: wanted, lighterStreak: 0 }
  const streak = (prev?.lighterStreak ?? 0) + 1
  return streak >= downgradeAfter ? { model: wanted, lighterStreak: 0 } : { model: current, lighterStreak: streak }
}

export function providerOf(model: string): string {
  return model.split('/')[0] ?? model
}

function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/** 某时刻是否处在该时间表的高峰 */
export function isPeak(peak: PeakSchedule | undefined, now: number): boolean {
  if (!peak) return false
  const local = new Date(now + peak.utcOffset * 3600_000)
  const day = local.toISOString().slice(0, 10)
  if (peak.holidays.includes(day) || !peak.weekdays.includes(local.getUTCDay())) return false
  const t = local.getUTCHours() * 60 + local.getUTCMinutes()
  return peak.hours.some(range => {
    const [from, to] = range.split('-')
    return from !== undefined && to !== undefined && t >= minutes(from) && t < minutes(to)
  })
}

/** 下一个空闲时刻（按 5 分钟步进找，最多看 7 天） */
export function nextOffPeak(peak: PeakSchedule | undefined, now: number): number {
  let t = now
  const step = 5 * 60_000
  for (let i = 0; i < (7 * 24 * 60) / 5 && isPeak(peak, t); i++) t = Math.floor(t / step) * step + step
  return t
}

/** 角色的模型链：去掉关掉的提供商；now 给出时再去掉正处高峰的 */
export function chainFor(config: Config, role: string, now?: number): string[] {
  const models = config.pi.roles[role]?.models ?? []
  return models.filter(m => {
    const p = config.pi.providers[providerOf(m)]
    if (p?.enabled === false) return false
    return now === undefined || !isPeak(p?.peak, now)
  })
}

/**
 * 此刻真正要试的模型：角色链去掉关掉、高峰、熔断（isDown）的；
 * 一个都不剩时改用兜底列表（同样过滤），isFallback 标出来
 */
export function liveChain(
  cfg: Config,
  role: string,
  now: number,
  isDown: (provider: string) => boolean = () => false,
): { models: string[]; isFallback: boolean } {
  const ok = (m: string) => !isDown(providerOf(m))
  const primary = chainFor(cfg, role, now).filter(ok)
  if (primary.length) return { models: primary, isFallback: false }
  const usable = (m: string) => {
    const p = cfg.pi.providers[providerOf(m)]
    return p?.enabled !== false && !isPeak(p?.peak, now) && ok(m)
  }
  return { models: cfg.pi.fallback.filter(usable), isFallback: true }
}

/** 链上模型现在都在高峰时，最早能跑的时刻 */
export function earliestRun(config: Config, chain: string[], now: number): number {
  return Math.min(...chain.map(m => nextOffPeak(config.pi.providers[providerOf(m)]?.peak, now)))
}

// ---------- 按档位生成角色（pi 模型页改档位时调用） ----------

type RoleTemplate = {
  /** 依次从哪些档位取几个模型 */
  pick: [Tier, number][]
  /** 这些档位里倒过来取（同档排在后面的更快更便宜） */
  cheaper?: Tier[]
  readOnly?: boolean
}

// 和默认配置的取舍一致：评审要最强，编码、看图、批量取强档里快的，文本类用轻档；同档里订阅排在按量付费前面
export const ROLE_TEMPLATES: Record<string, RoleTemplate> = {
  review: { pick: [['strong', 2], ['mid', 1]], readOnly: true },
  code: { pick: [['strong', 2], ['mid', 1]], cheaper: ['strong'] },
  vision: { pick: [['strong', 2], ['mid', 1]], cheaper: ['strong'] },
  bulk: { pick: [['strong', 1], ['light', 1], ['mid', 1]], cheaper: ['strong'] },
  longctx: { pick: [['mid', 1], ['strong', 1]], cheaper: ['strong'], readOnly: true },
  quick: { pick: [['light', 1], ['strong', 1], ['mid', 1]], cheaper: ['strong'] },
  text: { pick: [['light', 2], ['mid', 1]], readOnly: true },
  trivial: { pick: [['light', 2], ['mid', 1]], cheaper: ['light'], readOnly: true },
}

/** 某档里能用的模型：提供商开着，订阅在前、按量在后，各自保持 tiers 里的先后 */
function tierModels(cfg: Config, tier: Tier, cheaper: boolean): string[] {
  const list = Object.entries(cfg.pi.tiers)
    .filter(([m, t]) => t === tier && cfg.pi.providers[providerOf(m)]?.enabled !== false)
    .map(([m]) => m)
  if (cheaper) list.reverse()
  const sub = list.filter(m => cfg.pi.providers[providerOf(m)]?.billing !== 'token')
  return [...sub, ...list.filter(m => !sub.includes(m))]
}

/**
 * 按档位重建内置角色和兜底；角色原来的说明和只读设置保留，自己加的角色不动。
 * 某档没有模型就跳过；一个角色一个都取不到时，用任意一个有档位的模型顶上。
 */
export function buildRoles(cfg: Config): Config {
  const roles: Record<string, Role> = {}
  const any = (['strong', 'mid', 'light'] as Tier[]).flatMap(t => tierModels(cfg, t, false))
  for (const [name, tpl] of Object.entries(ROLE_TEMPLATES)) {
    const models: string[] = []
    for (const [tier, n] of tpl.pick) {
      tierModels(cfg, tier, tpl.cheaper?.includes(tier) === true)
        .filter(m => !models.includes(m))
        .slice(0, n)
        .forEach(m => models.push(m))
    }
    if (models.length === 0 && any[0]) models.push(any[0])
    if (models.length === 0) continue
    const old = cfg.pi.roles[name] ?? DEFAULT_CONFIG.pi.roles[name]
    roles[name] = { description: old?.description ?? name, models, readOnly: cfg.pi.roles[name]?.readOnly ?? tpl.readOnly }
  }
  for (const [name, r] of Object.entries(cfg.pi.roles)) if (!roles[name] && !ROLE_TEMPLATES[name]) roles[name] = r
  const light = tierModels(cfg, 'light', false).filter(m => cfg.pi.providers[providerOf(m)]?.billing !== 'token')
  const fallback = light.length ? light.slice(0, 2) : tierModels(cfg, 'mid', false).slice(0, 1)
  const names = Object.keys(roles)
  const defaultRole = roles[cfg.pi.defaultRole] ? cfg.pi.defaultRole : (names[0] ?? cfg.pi.defaultRole)
  const categories = cfg.claude.categories.map(c => (c.piRole && !roles[c.piRole] ? { ...c, piRole: undefined } : c))
  return { ...cfg, claude: { ...cfg.claude, categories }, pi: { ...cfg.pi, roles, fallback, defaultRole } }
}
