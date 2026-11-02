import type { EngineInterface } from 'claude-code'
import type { BigRead } from './saver'

// 路由配置：~/.claude/auto-router.json，首次运行写入默认值。
// 每次分类和派任务前都重新读，改完文件立即生效，不用重启。

export type Category = {
  /** 给 classify 的英文描述，小模型对英文更稳 */
  label: string
  /** 状态栏显示的中文名 */
  name: string
  /** Claude 模型：别名（haiku / sonnet / opus / fable，跟最新版）或完整 id（如 claude-opus-4-8）；不写则保持会话原模型 */
  model?: string
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

/** free 免费 / subscription 订阅 / token 按量付费；同一档里按这个顺序排 */
export type Billing = 'free' | 'subscription' | 'token'

export type Provider = {
  enabled: boolean
  billing: Billing
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

/** 模型档位：strong 强、mid 中、light 轻；面板外派模型页按档位排各角色的模型顺序 */
export type Tier = 'strong' | 'mid' | 'light'

export type Config = {
  claude: {
    /**
     * 什么时候分类、换模型。cold：只在冷点（会话第一条、隔太久缓存已过期、上下文刚被压缩），这时缓存反正要重建，
     * 换模型不多花钱；冷点之间不分类、不降档，只在被纠正或规则判出重活时升档。turn：每轮都分类，旧做法，留作对照
     */
    switchAt: 'cold' | 'turn'
    /** 距上一轮多少分钟算缓存已过期（订阅登录是 1 小时缓存；用 API key、5 分钟缓存的改成 5） */
    coldGapMinutes: number
    /**
     * 主对话最低用到哪一档，类别选了更轻的也按这档。默认 sonnet：实测闲聊轮总共只占花费的 1%，
     * 换到 Haiku 省下的很少，却要多一次缓存重写，还有质量风险
     */
    floor: 'haiku' | 'sonnet'
    /** turn 模式：降档要连续多少轮都判为更轻的类别；升档立即生效 */
    downgradeAfter: number
    /** turn 模式：上下文超过这么多 token 时不降档（换模型要整段重写缓存，越长越亏）；0 表示不限 */
    keepAboveTokens: number
    /** 用户在纠正上一轮（不对、重做…）时升一档 */
    upgradeOnCorrection: boolean
    /**
     * 小模型分类被限流或超时时，改让主对话的模型 fork 一次来分类。fork 要按缓存读价把整段上下文读一遍，
     * 实测长对话里这笔钱比换小模型省下的还多，默认关：分不出来就保持当前模型
     */
    forkFallback: boolean
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
    /** 提供商报鉴权 / 额度 / 限流错误或连不上后暂停多少分钟；按上游组暂停（见 groupOf），不连累同一家的其他组 */
    pauseMinutes: number
    /**
     * 按模型算免费的规则（"*" 匹配任意字符），优先于提供商的 billing：magpie 这类网关一家里混着免费和付费模型。
     * 默认把 magpie/opencode-zen-free/* 算免费
     */
    freeModels: string[]
    /** 模型档位，同一档里排在前面的更强；外派模型页据此排角色 */
    tiers: Record<string, Tier>
    /** 模型擅长的角色（实测得出）：同档同计费方式里，擅长这个角色的排前面，只擅长别的角色的排后面；fallback 表示适合当兜底 */
    strengths: Record<string, string[]>
    /**
     * 外派给 pi 时照样加载的扩展（~/.pi/agent/npm 里的包名）。其余扩展、MCP、技能一律不加载：
     * 实测 pi 会带上 subagent、电脑操控、浏览器和知识库 MCP，只读任务也能借它们写东西或碰到私人数据
     */
    keepExtensions: string[]
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
  /** 日志（log/）和效果报告（report/）放哪；空字符串是 ~/.claude/auto-router。放到别的盘可以躲开清理 ~/.claude 的工具 */
  dataDir: string
}

export type Experiment = 'off' | 'route' | 'saver' | 'both'

const SOL = 'openai/gpt-6.1-sol'
const TERRA = 'openai/gpt-6.1-terra'
const DS_FLASH = 'cc-switch-deep-seek/deepseek-flash'
const AG3 = 'agnes/agnes-3.0-flash'
const AG25 = 'agnes/agnes-2.5-flash'
// OpenCode Zen 的免费模型，经本地网关 magpie 在 pi 里用；输出上限 glm、mimo、deepseek-v4.1 只有 32K
const FREE_GROUP = 'magpie/opencode-zen-free'
const FREE = `${FREE_GROUP}/`
const OC_DS = FREE + 'deepseek-v4.1-flash-free'
const OC_GLM = FREE + 'glm-5.3-flash-free'
const OC_MIMO = FREE + 'mimo-v2.6-flash-free'
const OC_FLINT = FREE + 'flint-40b-free'
const OC_VL = FREE + 'nemotron-3.5-super-vl-free'
const OC_LIGHT = FREE + 'nemotron-3.5-lightning-free'
const OC_BEAM = FREE + 'beam-free'

// 原则：同一档里 免费 → 订阅 → 按量付费。免费模型兜底或打头（长输出的编码、批量不让 32K 上限的排第一），gpt、agnes 订阅留给重要的活，
// 按量付费的 deepseek 尽量靠后，且只在空闲时段用。deepseek-v4-pro 比 flash 贵，默认不用。
// 强度 gpt > deepseek ≈ 免费的中档 > agnes；terra 比 sol 快、便宜，看图和操作电脑更强，sol 推理更强。
export const DEFAULT_CONFIG: Config = {
  claude: {
    switchAt: 'cold',
    coldGapMinutes: 60,
    floor: 'sonnet',
    downgradeAfter: 4,
    keepAboveTokens: 150_000,
    upgradeOnCorrection: true,
    forkFallback: false,
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
      magpie: {
        enabled: true,
        billing: 'token',
        note: '本地网关：opencode-zen-free/ 下的按 freeModels 算免费（随时可能下架），其余按这里的计费方式',
      },
    },
    roles: {
      review: {
        description: 'independent code review, root-cause diagnosis, tricky algorithms; a second opinion to check Claude against',
        models: [SOL, TERRA, OC_DS, DS_FLASH],
        readOnly: true,
      },
      code: {
        description: 'well-specified coding: implement a module, add tests, refactor to a given plan',
        models: [TERRA, SOL, OC_GLM, DS_FLASH],
      },
      vision: {
        description: 'tasks that need to look at screenshots or images, UI work',
        models: [TERRA, OC_VL, SOL],
      },
      bulk: {
        description: 'mechanical edits across many files: renames, migrations, applying one pattern everywhere',
        models: [TERRA, OC_GLM, AG3],
      },
      longctx: {
        description: 'reading a very large amount of code or documents (beyond ~200K tokens) and summarizing it',
        models: [OC_DS, DS_FLASH, TERRA],
        readOnly: true,
      },
      quick: {
        description: 'simple scripted chores: analyse logs, run tests and report, convert formats, search and tabulate',
        models: [OC_MIMO, AG3, TERRA],
      },
      text: {
        description: 'pure text: translate, summarize, rewrite, write commit messages, name things',
        models: [OC_GLM, AG3, AG25],
        readOnly: true,
      },
      trivial: {
        description: 'trivial extraction or formatting: pull fields out, reshape into JSON, simple classification',
        models: [OC_LIGHT, AG25, OC_BEAM],
        readOnly: true,
      },
    },
    guard: { requireCleanGit: true },
    // gpt 退订、deepseek 高峰时，各角色最后靠 agnes 订阅顶上，再不行用免费模型
    fallback: [AG3, AG25, OC_MIMO, OC_FLINT],
    pauseMinutes: 30,
    freeModels: [`${FREE}*`],
    tiers: {
      [SOL]: 'strong',
      [TERRA]: 'strong',
      [DS_FLASH]: 'mid',
      [OC_DS]: 'mid',
      [OC_GLM]: 'mid',
      [OC_MIMO]: 'mid',
      [OC_FLINT]: 'mid',
      [OC_VL]: 'mid',
      [AG3]: 'light',
      [AG25]: 'light',
      [OC_LIGHT]: 'light',
      [OC_BEAM]: 'light',
    },
    strengths: {
      [OC_DS]: ['review', 'longctx'],
      [OC_GLM]: ['code', 'bulk', 'text'],
      [OC_MIMO]: ['quick', 'fallback'],
      [OC_FLINT]: ['fallback'],
      [OC_VL]: ['vision'],
      [OC_LIGHT]: ['trivial'],
    },
    // 只拦危险命令的安全扩展，装了就留着
    keepExtensions: ['cc-safety-net'],
  },
  saver: {
    enabled: true,
    guard: true,
    remindAt: [200_000, 400_000],
    bigRead: 'auto',
    quotaPct: 70,
  },
  experiment: 'off',
  dataDir: '',
}

let pathCache: string | undefined

export async function configPath($: EngineInterface, isWindows: boolean): Promise<string> {
  if (pathCache) return pathCache
  // 插件装在 ~/.claude 下时直接从路径推；否则问 shell：设了 CLAUDE_CONFIG_DIR 用它，没设用 ~/.claude
  const m = /^(.*?[\\/]\.claude)[\\/]/.exec($.plugin.root)
  let dir = m?.[1]
  if (!dir) {
    const run = isWindows
      ? await $.process.run(['cmd', '/d', '/c', 'if defined CLAUDE_CONFIG_DIR (echo %CLAUDE_CONFIG_DIR%) else (echo %USERPROFILE%\\.claude)'])
      : await $.process.run(['sh', '-c', 'printf %s "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"'])
    dir = run.stdout.trim().replace(/[\\/]+$/, '')
  }
  pathCache = `${dir}${isWindows ? '\\' : '/'}auto-router.json`
  return pathCache
}

let warned = false
let created = false

/** 这次运行里配置文件是不是刚生成的（新用户，面板先打开外派模型页）；读一次后清零 */
export function consumeCreated(): boolean {
  const was = created
  created = false
  return was
}

/** 弹提示：按字数留够读完的时间（默认只停 4 秒，长句没读完就没了），每字约 0.25 秒，4–30 秒；指针停在上面不消失，点一下关掉 */
export function say($: EngineInterface, text: string): void {
  $.ui.toast(text, { timeoutMs: Math.min(30_000, Math.max(4_000, text.length * 250)) })
}

/**
 * 0.4.0 前的默认提醒点 30 万 / 60 万：日志里 20–40 万 token 的轮次占了六成花费，提醒得太晚。
 * 文件里还是旧默认值（用户没改过）就按新默认用，改过的照旧
 */
function oldRemind(v: unknown): Partial<Config['saver']> {
  return Array.isArray(v) && v.length === 2 && v[0] === 300_000 && v[1] === 600_000 ? { remindAt: DEFAULT_CONFIG.saver.remindAt } : {}
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
    const merged: Config = {
      claude: { ...DEFAULT_CONFIG.claude, ...claude },
      pi: { ...DEFAULT_CONFIG.pi, ...raw.pi },
      saver: { ...DEFAULT_CONFIG.saver, ...raw.saver, ...oldRemind(raw.saver?.remindAt) },
      experiment: raw.experiment ?? (legacyAb ? 'route' : DEFAULT_CONFIG.experiment),
      dataDir: raw.dataDir ?? DEFAULT_CONFIG.dataDir,
    }
    const repair = raw.pi?.freeModels !== undefined
    const { cfg, note } = needsMigrate(raw) ? migrateFree(merged, repair) : { cfg: merged, note: undefined }
    const errs = validate(cfg)
    if (errs.length) throw new Error(errs.slice(0, 3).join('；'))
    warned = false
    if (note) {
      // 迁移只做一次：写回后文件里就有 freeModels 了；旧文件留一份 .bak。只清旧条目时已有的 .bak（迁移前的原文件）不覆盖
      if (!repair || !(await $.fs.exists(`${path}.bak`).catch(() => false)))
        await $.fs.write(`${path}.bak`, JSON.stringify(raw, null, 2) + '\n').catch(() => undefined)
      await saveConfig($, isWindows, cfg).catch(() => undefined)
      say($, note)
    }
    return cfg
  } catch (err) {
    if (!warned) say($, `auto-router 配置读取失败，先用默认值：${String(err).slice(0, 120)}`)
    warned = true
    return DEFAULT_CONFIG
  }
}

// 0.2.x 的默认角色和兜底：旧配置还是这一套（没手调过）时，迁移时直接按新档位重排
const LEGACY_ROLES: Record<string, string[]> = {
  review: [SOL, TERRA, DS_FLASH],
  code: [TERRA, SOL, DS_FLASH],
  vision: [TERRA, SOL, DS_FLASH],
  bulk: [TERRA, AG3, DS_FLASH],
  longctx: [DS_FLASH, TERRA],
  quick: [AG3, TERRA, DS_FLASH],
  text: [AG3, AG25, DS_FLASH],
  trivial: [AG25, AG3, DS_FLASH],
}
const LEGACY_FALLBACK = [AG3, AG25]

/** 0.5 之前的配置（文件里没有 pi.freeModels）要迁移一次 */
export function needsMigrate(raw: { pi?: Partial<Config['pi']> }): boolean {
  if (!raw.pi) return false
  return raw.pi.freeModels === undefined || hasLegacy(raw.pi)
}

const isLegacyModel = (m: string) => m.startsWith('opencode/') || m.startsWith('oc:')

/**
 * 迁移过、又被还开着的 0.4 会话写回了旧条目：0.4 读配置时补上自己的默认值（opencode 提供商、opencode/ 的档位和擅长）再存回去，
 * 只看 freeModels 判断不出来
 */
function hasLegacy(pi: Partial<Config['pi']>): boolean {
  const models = [...(pi.fallback ?? []), ...Object.values(pi.roles ?? {}).flatMap(r => r?.models ?? [])]
  return (
    Object.keys(pi.providers ?? {}).some(isOcProvider) ||
    [...Object.keys(pi.tiers ?? {}), ...Object.keys(pi.strengths ?? {})].some(isLegacyModel) ||
    models.some(isLegacyModel)
  )
}

/**
 * 旧的模型名换成 0.5 的写法：opencode/<x> 换成 magpie/opencode-zen-free/<x>；
 * oc:（opencode 里配的其他提供商）没有对应的 pi 模型，返回 undefined 表示去掉
 */
export function migrateModel(m: string): string | undefined {
  if (m.startsWith('oc:')) return undefined
  return m.startsWith('opencode/') ? FREE + m.slice('opencode/'.length) : m
}

const isOcProvider = (p: string) => p === 'opencode' || p.startsWith('oc:')

/**
 * 升到 0.5（opencode 通道并进 pi）：角色链、兜底、档位、擅长标签里的模型名换成 magpie 的写法，
 * 删掉 opencode 和 oc: 提供商，加上 magpie 和 freeModels。0.2.x 的配置顺带补上免费模型的档位和擅长标签。
 * 用户自己的提供商、档位、顺序都不动；角色还是 0.2.x 的旧默认时按档位重排。
 * repair：文件里已经有 freeModels（迁移过），只是又被旧版会话写回了旧条目，只清旧条目
 */
export function migrateFree(cfg: Config, repair = false): { cfg: Config; note?: string } {
  const mapList = (list: string[]) => [...new Set(list.map(migrateModel).filter((m): m is string => !!m))]
  // 新旧写法都在时（迁移过又被旧版写回）以新写法的为准：那是 0.5 里设的
  const mapKeys = <T>(rec: Record<string, T>) =>
    Object.fromEntries(
      Object.entries(rec).flatMap(([m, v]) => {
        const to = migrateModel(m)
        return to && (to === m || !(to in rec)) ? [[to, v]] : []
      }),
    )
  const roles = Object.fromEntries(
    Object.entries(cfg.pi.roles).map(([name, r]) => {
      const models = mapList(r.models)
      // 整条链都是 oc: 模型：换成默认角色的链，免得校验不过整份配置作废
      return [name, { ...r, models: models.length ? models : (DEFAULT_CONFIG.pi.roles[name]?.models ?? [OC_MIMO]) }]
    }),
  )
  const providers = Object.fromEntries(Object.entries(cfg.pi.providers).filter(([p]) => !isOcProvider(p)))
  const hadFree = Object.keys(cfg.pi.tiers).some(m => m.startsWith('opencode/'))
  const freeTiers = Object.fromEntries(Object.entries(DEFAULT_CONFIG.pi.tiers).filter(([m]) => m.startsWith(FREE)))
  const next: Config = {
    ...cfg,
    pi: {
      ...cfg.pi,
      providers: { ...providers, magpie: providers.magpie ?? (DEFAULT_CONFIG.pi.providers.magpie as Provider) },
      roles,
      fallback: mapList(cfg.pi.fallback),
      tiers: { ...(hadFree ? {} : freeTiers), ...mapKeys(cfg.pi.tiers) },
      strengths: { ...DEFAULT_CONFIG.pi.strengths, ...mapKeys(cfg.pi.strengths ?? {}) },
      freeModels: cfg.pi.freeModels ?? DEFAULT_CONFIG.pi.freeModels,
    },
  }
  if (repair)
    return { cfg: next, note: 'auto-router 0.5：配置里又出现了 opencode 的旧条目（多半是还开着的旧版会话写回的），已清掉；你在 0.5 里的设置没动' }
  const untouched =
    JSON.stringify(cfg.pi.fallback) === JSON.stringify(LEGACY_FALLBACK) &&
    Object.entries(LEGACY_ROLES).every(([name, models]) => JSON.stringify(cfg.pi.roles[name]?.models) === JSON.stringify(models))
  if (untouched) return { cfg: buildRoles(next), note: 'auto-router 0.5：加上了免费模型（经 magpie 在 pi 里用），各角色已按档位重排（旧配置备份为 .bak）' }
  return {
    cfg: next,
    note: 'auto-router 0.5：opencode 通道并进 pi，免费模型改成 magpie/opencode-zen-free/ 的写法，角色顺序没动（旧配置备份为 .bak）',
  }
}

export async function saveConfig($: EngineInterface, isWindows: boolean, config: Config): Promise<void> {
  await $.fs.write(await configPath($, isWindows), JSON.stringify(config, null, 2) + '\n')
}

// ---------- 校验与修改（设置面板和 router_config 工具共用） ----------

const TIERS: string[] = ['strong', 'mid', 'light']
const BILLINGS: Billing[] = ['free', 'subscription', 'token']
const HHMM_RANGE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-4]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

/** 返回问题列表；空表示可以保存 */
export function validate(cfg: Config): string[] {
  const errs: string[] = []
  const c = cfg.claude
  if (c?.switchAt !== 'cold' && c?.switchAt !== 'turn') errs.push('claude.switchAt 只能是 cold / turn')
  if (!Number.isFinite(c?.coldGapMinutes) || c.coldGapMinutes < 1) errs.push('claude.coldGapMinutes 要是 ≥1 的数字')
  if (c?.floor !== 'haiku' && c?.floor !== 'sonnet') errs.push('claude.floor 只能是 haiku / sonnet')
  if (!Number.isInteger(c?.downgradeAfter) || c.downgradeAfter < 1) errs.push('claude.downgradeAfter 要是 ≥1 的整数')
  if (!Number.isFinite(c?.keepAboveTokens) || c.keepAboveTokens < 0) errs.push('claude.keepAboveTokens 要是 ≥0 的数字')
  if (typeof c?.upgradeOnCorrection !== 'boolean') errs.push('claude.upgradeOnCorrection 要是 true / false')
  if (typeof c?.forkFallback !== 'boolean') errs.push('claude.forkFallback 要是 true / false')
  if (!Array.isArray(c?.categories) || c.categories.length === 0) errs.push('claude.categories 不能为空')
  const providers = cfg.pi?.providers ?? {}
  const roles = cfg.pi?.roles ?? {}
  c?.categories?.forEach((cat, i) => {
    if (!cat?.label || !cat.name) errs.push(`claude.categories[${i}] 缺 label 或 name`)
    if (cat?.model !== undefined && !isClaudeModel(cat.model))
      errs.push(`claude.categories[${i}].model 只能是 ${CLAUDE_ALIASES.join(' / ')}、claude- 开头的完整模型名，或不写`)
    if (cat?.piRole !== undefined && !roles[cat.piRole]) errs.push(`claude.categories[${i}].piRole「${cat.piRole}」不是已有角色`)
  })
  if (!Number.isFinite(cfg.pi?.timeoutMinutes) || cfg.pi.timeoutMinutes <= 0 || cfg.pi.timeoutMinutes > 10) errs.push('pi.timeoutMinutes 要在 0–10 之间')
  if (!roles[cfg.pi?.defaultRole]) errs.push(`pi.defaultRole「${cfg.pi?.defaultRole}」不是已有角色`)
  if (typeof cfg.pi?.guard?.requireCleanGit !== 'boolean') errs.push('pi.guard.requireCleanGit 要是 true / false')
  if (!Number.isFinite(cfg.pi?.pauseMinutes) || cfg.pi.pauseMinutes < 0) errs.push('pi.pauseMinutes 要是 ≥0 的数字')
  if (!Array.isArray(cfg.pi?.freeModels) || !cfg.pi.freeModels.every(x => typeof x === 'string' && x.includes('/')))
    errs.push('pi.freeModels 要是模型规则列表，如 "magpie/opencode-zen-free/*"，可以为空 []')
  if (!Array.isArray(cfg.pi?.fallback)) errs.push('pi.fallback 要是模型列表，可以为空 []')
  else
    cfg.pi.fallback.forEach(m => {
      if (typeof m !== 'string' || !m.includes('/')) errs.push(`pi.fallback 里的「${m}」要写成 provider/模型`)
      else if (!providers[providerOf(m)]) errs.push(`pi.fallback 里的「${m}」的提供商 ${providerOf(m)} 不在 pi.providers 里`)
    })
  for (const [m, t] of Object.entries(cfg.pi?.tiers ?? {})) {
    if (!TIERS.includes(t)) errs.push(`pi.tiers 里「${m}」的档位只能是 ${TIERS.join(' / ')}`)
  }
  if (!Array.isArray(cfg.pi?.keepExtensions) || !cfg.pi.keepExtensions.every(x => typeof x === 'string' && x.trim())) {
    errs.push('pi.keepExtensions 要是扩展包名列表')
  }
  for (const [m, list] of Object.entries(cfg.pi?.strengths ?? {})) {
    if (!Array.isArray(list) || !list.every(r => typeof r === 'string')) errs.push(`pi.strengths 里「${m}」要是角色名列表`)
  }
  for (const [name, p] of Object.entries(providers)) {
    if (typeof p?.enabled !== 'boolean') errs.push(`pi.providers.${name}.enabled 要是 true / false`)
    if (!BILLINGS.includes(p?.billing)) errs.push(`pi.providers.${name}.billing 只能是 ${BILLINGS.join(' / ')}`)
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
  if (typeof cfg.dataDir !== 'string') errs.push('dataDir 要是文件夹路径，空字符串表示 ~/.claude/auto-router')
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

const FAMILY_RANK: [string, number][] = [
  ['haiku', 0],
  ['sonnet', 1],
  ['opus', 2],
  ['fable', 3],
]

/** Claude 模型的档：别名或完整 id 都按系列算（haiku < sonnet < opus < fable）；认不出返回 undefined */
export function rankOf(model?: string): number | undefined {
  const m = (model ?? '').toLowerCase()
  return FAMILY_RANK.find(([k]) => m.includes(k))?.[1]
}

/** 低于最低档的模型按最低档；认不出的、不写的原样返回 */
export function atLeast(model: string | undefined, floor: string): string | undefined {
  const r = rankOf(model)
  return r !== undefined && r < (rankOf(floor) ?? 0) ? floor : model
}

/** Claude 别名：随 Claude Code 指向各系列的最新版 */
export const CLAUDE_ALIASES = ['haiku', 'sonnet', 'opus', 'fable']

/** 分类能选的 Claude 模型：别名，或 claude- 开头的完整 id（如 claude-opus-4-8，固定在这个版本） */
export function isClaudeModel(m: string): boolean {
  return CLAUDE_ALIASES.includes(m) || /^claude-[a-z0-9.-]+$/.test(m)
}

/**
 * 从 pi --list-models 里挑出 Claude 的具体版本（anthropic/claude-*），去掉带日期的快照；
 * 按系列从强到弱、同系列版本从新到旧排
 */
export function claudeModelsFrom(list: string[]): string[] {
  const ver = (m: string) => (/-(\d+)-(\d+)$/.exec(m) ?? /-(\d+)$/.exec(m) ?? []).slice(1).map(Number)
  const ids = list
    .filter(m => m.startsWith('anthropic/claude-'))
    .map(m => m.slice('anthropic/'.length))
    .filter(m => !/-\d{8}$/.test(m) && rankOf(m) !== undefined)
  return [...new Set(ids)].sort((a, b) => {
    const r = (rankOf(b) ?? 0) - (rankOf(a) ?? 0)
    if (r) return r
    const [x, y] = [ver(a), ver(b)]
    return (y[0] ?? 0) - (x[0] ?? 0) || (y[1] ?? 0) - (x[1] ?? 0)
  })
}

/** 升档立即生效；降档要连续 downgradeAfter 轮都想降才降；分类不给模型时保持不变 */
export function sticky(
  prev: { model?: string; lighterStreak: number } | null,
  wanted: string | undefined,
  downgradeAfter: number,
): { model?: string; lighterStreak: number } {
  const current = prev?.model
  if (!wanted) return { model: current, lighterStreak: 0 }
  if (!current || (rankOf(wanted) ?? 0) >= (rankOf(current) ?? 0)) return { model: wanted, lighterStreak: 0 }
  const streak = (prev?.lighterStreak ?? 0) + 1
  return streak >= downgradeAfter ? { model: wanted, lighterStreak: 0 } : { model: current, lighterStreak: streak }
}

export function providerOf(model: string): string {
  return model.split('/')[0] ?? model
}

/**
 * 熔断按上游组算：三段的模型名（magpie/opencode-zen-free/glm-5.3-flash-free）取前两段，
 * 网关里一组限流不连累同一家的其他组；两段的就是提供商
 */
export function groupOf(model: string): string {
  const parts = model.split('/')
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? model)
}

/**
 * 免费额度用完（OpenCode Zen 报 “Free usage limit”）：额度按模型算，只停这一个模型；
 * 要十几个小时才恢复，按 pauseMinutes 每半小时白试一次不划算
 */
export const FREE_LIMIT = /free.?(usage.?)?limit/i
export const FREE_LIMIT_PAUSE_MINUTES = 6 * 60

/** 报错后暂停多少分钟：免费额度用完至少停 6 小时，其余按 pi.pauseMinutes；pauseMinutes 为 0 表示不暂停 */
export function pauseMinutesFor(err: string, pauseMinutes: number): number {
  if (pauseMinutes <= 0) return 0
  return FREE_LIMIT.test(err) ? Math.max(pauseMinutes, FREE_LIMIT_PAUSE_MINUTES) : pauseMinutes
}

/** 暂停时弹的提示。key 是上游组（三段名的前两段）、整家，或免费额度用完的单个模型；conn 表示是连不上，不是鉴权、额度、限流 */
export function pauseText(key: string, err: string, conn: boolean, until: string): string {
  const head = conn ? `${key} 连不上` : FREE_LIMIT.test(err) ? `${key} 免费额度用完了` : `${key} 报鉴权/额度/限流错误`
  const rest = FREE_LIMIT.test(err) && !conn
    ? '其他免费模型照常用（免费额度按模型算）。'
    : key.includes('/')
    ? '同一家的其他模型照常用。'
    : conn
      ? '派活先换别家；检查网络、代理或这家的地址。'
      : '如果已经退订，到 /auto-router「外派模型」页 ① 把这家的计费方式改成“不用”。'
  return `${head}，暂停到 ${until}，${rest}`
}

/** "*" 匹配任意字符的规则 */
function globMatch(pattern: string, s: string): boolean {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${re}$`).test(s)
}

/** 模型的计费方式：先看 freeModels 规则，再看所在提供商；都没写按订阅 */
export function billingOf(cfg: Config, model: string): Billing {
  if ((cfg.pi.freeModels ?? []).some(p => globMatch(p, model))) return 'free'
  return cfg.pi.providers[providerOf(model)]?.billing ?? 'subscription'
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
 * 此刻真正要试的模型：角色链去掉关掉、高峰、熔断（isDown）、被 skip 拦下（已下架）的；
 * 一个都不剩时改用兜底列表（同样过滤），isFallback 标出来
 */
export function liveChain(
  cfg: Config,
  role: string,
  now: number,
  isDown: (providerOrModel: string) => boolean = () => false,
  skip: (model: string) => boolean = () => false,
  demote: Set<string> = new Set(),
): { models: string[]; isFallback: boolean } {
  const primary = chainFor(cfg, role, now).filter(m => !downFor(isDown, m) && !skip(m))
  // 返工多的模型排到链尾，不删掉：别的都用不了时照样能接
  if (primary.length) return { models: [...primary.filter(m => !demote.has(m)), ...primary.filter(m => demote.has(m))], isFallback: false }
  return { models: usableFallback(cfg, now, isDown, skip), isFallback: true }
}

/** 模型有没有被熔断：整家（旧记录）、上游组或这一个模型 */
export function downFor(isDown: (key: string) => boolean, m: string): boolean {
  return isDown(providerOf(m)) || isDown(groupOf(m)) || isDown(m)
}

/** 此刻能用的兜底模型：去掉关掉的、在高峰的、已暂停的、被 skip 拦下的 */
export function usableFallback(
  cfg: Config,
  now: number,
  isDown: (providerOrModel: string) => boolean = () => false,
  skip: (model: string) => boolean = () => false,
): string[] {
  return cfg.pi.fallback.filter(m => {
    const p = cfg.pi.providers[providerOf(m)]
    return p?.enabled !== false && !isPeak(p?.peak, now) && !downFor(isDown, m) && !skip(m)
  })
}

/** 链上模型现在都在高峰时，最早能跑的时刻 */
export function earliestRun(config: Config, chain: string[], now: number): number {
  return Math.min(...chain.map(m => nextOffPeak(config.pi.providers[providerOf(m)]?.peak, now)))
}

// ---------- 按档位生成角色（外派模型页改档位时调用） ----------

/** 只取某种计费方式：free 免费，paid 订阅或按量，sub 只要订阅 */
type BillingPick = 'free' | 'paid' | 'sub'

type RoleTemplate = {
  /**
   * 依次从哪个档位、哪种计费方式取几个模型；不写计费方式表示都行（同档里仍是 免费 → 订阅 → 按量）。
   * 第四项为 true 时只取链里还没有的提供商：同一家的免费模型常一起额度用完，换一家才顶得上
   */
  pick: [Tier, number, BillingPick?, boolean?][]
  /** 这些档位里倒过来取（同档排在后面的更快更便宜） */
  cheaper?: Tier[]
  readOnly?: boolean
}

// 和默认配置的取舍一致：评审要最强，编码、看图、批量取强档里快的，文本类用轻档；
// 免费的中档模型补在 GPT 后面或打头（按擅长标签挑哪一个），按量付费的 deepseek 排在最后
export const ROLE_TEMPLATES: Record<string, RoleTemplate> = {
  review: { pick: [['strong', 2], ['mid', 1, 'free'], ['mid', 1, 'paid']], readOnly: true },
  code: { pick: [['strong', 2], ['mid', 1, 'free'], ['mid', 1, 'paid']], cheaper: ['strong'] },
  vision: { pick: [['strong', 1], ['mid', 1, 'free'], ['strong', 1]], cheaper: ['strong'] },
  bulk: { pick: [['strong', 1], ['mid', 1, 'free'], ['light', 1, 'paid']], cheaper: ['strong'] },
  longctx: { pick: [['mid', 1, 'free'], ['mid', 1, 'paid'], ['strong', 1]], cheaper: ['strong'], readOnly: true },
  quick: { pick: [['mid', 1, 'free'], ['light', 1, 'paid'], ['strong', 1]], cheaper: ['strong'] },
  text: { pick: [['mid', 1, 'free'], ['light', 2, 'paid']], readOnly: true },
  // 另一家的免费轻档（如讯飞赠送额度）排在订阅前面；没有就照旧 免费 › 订阅 › 免费
  trivial: { pick: [['light', 1, 'free'], ['light', 1, 'free', true], ['light', 1, 'paid'], ['light', 1, 'free']], cheaper: ['light'], readOnly: true },
}

const BILLING_RANK: Record<Billing, number> = { free: 0, subscription: 1, token: 2 }

/**
 * 某档里能用的模型：提供商开着；免费 → 订阅 → 按量；同一计费方式里擅长 role 的在前、没标擅长的居中、
 * 只擅长别的角色的在后；再往下保持 tiers 里的先后（cheaper 时倒过来）
 */
function tierModels(cfg: Config, tier: Tier, cheaper: boolean, role?: string, billing?: BillingPick): string[] {
  const bill = (m: string) => billingOf(cfg, m)
  const list = Object.entries(cfg.pi.tiers)
    .filter(([m, t]) => t === tier && cfg.pi.providers[providerOf(m)]?.enabled !== false)
    .map(([m]) => m)
    .filter(m => !billing || (billing === 'free' ? bill(m) === 'free' : billing === 'sub' ? bill(m) === 'subscription' : bill(m) !== 'free'))
  if (cheaper) list.reverse()
  const fit = (m: string) => {
    const s = cfg.pi.strengths?.[m] ?? []
    return role && s.includes(role) ? 0 : s.length === 0 ? 1 : 2
  }
  return list
    .map((m, i) => ({ m, i }))
    .sort((a, b) => BILLING_RANK[bill(a.m)] - BILLING_RANK[bill(b.m)] || fit(a.m) - fit(b.m) || a.i - b.i)
    .map(x => x.m)
}

/**
 * 第一次运行时按本机 pi 里列得出模型的那几家改默认配置：只开着这些提供商，
 * 再按档位重排角色。一个能用的角色都排不出来时只关提供商、角色照旧，外派工具就不注册，等用户在「外派模型」页配好
 */
export function onlyDetected(cfg: Config, piList: string[]): Config {
  const have = new Set(piList.map(providerOf))
  const providers = Object.fromEntries(
    Object.entries(cfg.pi.providers).map(([p, v]) => [p, { ...v, enabled: have.has(p) }]),
  )
  const next = { ...cfg, pi: { ...cfg.pi, providers } }
  const built = buildRoles(next)
  return Object.keys(built.pi.roles).length ? built : next
}

/**
 * 按档位重建内置角色和兜底；角色原来的说明和只读设置保留，自己加的角色不动。
 * 某档或某种计费方式没有模型就跳过；取到的不到 2 个时，从模板用到的档位里不限计费方式补到 2 个；
 * 一个都取不到时，用任意一个有档位的模型顶上。
 */
export function buildRoles(cfg: Config): Config {
  const roles: Record<string, Role> = {}
  const any = (['strong', 'mid', 'light'] as Tier[]).flatMap(t => tierModels(cfg, t, false))
  for (const [name, tpl] of Object.entries(ROLE_TEMPLATES)) {
    const models: string[] = []
    const take = (tier: Tier, n: number, billing?: BillingPick, otherProvider?: boolean) =>
      tierModels(cfg, tier, tpl.cheaper?.includes(tier) === true, name, billing)
        .filter(m => !models.includes(m) && !(otherProvider && models.some(x => providerOf(x) === providerOf(m))))
        .slice(0, n)
        .forEach(m => models.push(m))
    for (const [tier, n, billing, other] of tpl.pick) take(tier, n, billing, other)
    for (const [tier] of tpl.pick) if (models.length < 2) take(tier, 2 - models.length)
    if (models.length === 0 && any[0]) models.push(any[0])
    if (models.length === 0) continue
    const old = cfg.pi.roles[name] ?? DEFAULT_CONFIG.pi.roles[name]
    roles[name] = { description: old?.description ?? name, models, readOnly: cfg.pi.roles[name]?.readOnly ?? tpl.readOnly }
  }
  for (const [name, r] of Object.entries(cfg.pi.roles)) if (!roles[name] && !ROLE_TEMPLATES[name]) roles[name] = r
  // 兜底：轻档的订阅两个，再加两个适合兜底的免费中档；都没有时用一个中档
  const fallback = [...tierModels(cfg, 'light', false, 'fallback', 'sub').slice(0, 2), ...tierModels(cfg, 'mid', false, 'fallback', 'free').slice(0, 2)]
  if (fallback.length === 0) fallback.push(...tierModels(cfg, 'mid', false).slice(0, 1))
  const names = Object.keys(roles)
  const defaultRole = roles[cfg.pi.defaultRole] ? cfg.pi.defaultRole : (names[0] ?? cfg.pi.defaultRole)
  const categories = cfg.claude.categories.map(c => (c.piRole && !roles[c.piRole] ? { ...c, piRole: undefined } : c))
  return { ...cfg, claude: { ...cfg.claude, categories }, pi: { ...cfg.pi, roles, fallback, defaultRole } }
}
