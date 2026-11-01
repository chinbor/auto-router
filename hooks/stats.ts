import type { Config, Experiment } from './config'

// 效果统计：每轮对话、每个 pi 任务记一行 JSON 到 ~/.claude/auto-router/log/，面板「效果」页从这里汇总。
// 一个会话一个文件，整份重写（$.fs 没有追加），多个会话同时开也不会互相覆盖。

/** 这一轮属于哪一组：auto 自动切换；control 对照组（只分类不切换）；off 关闭；fixed 固定模型 */
export type Arm = 'auto' | 'control' | 'off' | 'fixed'

export type TurnRecord = {
  t: 'turn'
  ts: number
  arm: Arm
  /** 分类结果（中文名） */
  cat?: string
  /** 路由选的模型别名；对照组是“本来会选”的 */
  pick?: string
  /** API 报告的实际模型 id */
  model: string
  /** 子代理的轮次 */
  sub?: boolean
  /** 和本会话上一轮主对话的模型不同 */
  switched?: boolean
  /** 用户这句话像是在纠正上一轮（不对、重做…） */
  fix?: boolean
  /** 分类没得到类别的原因：timeout / error / none / skip（换不了模型，没去 fork） */
  cf?: string
  cerr?: string
  /** 分类耗时（毫秒） */
  cms?: number
  via?: 'classify' | 'rule' | 'fork'
  /** fork 分类的 token 用量：输入、缓存读、缓存写、输出 */
  fu?: [number, number, number, number]
  /** 冷点原因（start / gap / compact）：这轮缓存本来就要重建，换模型不算多花 */
  cold?: string
  /** 本地规则判的类别；cat 是小模型分出来的时候，两者对比得出规则一致率 */
  rc?: string
  /** 这轮开始时的上下文 token 数 */
  ctx?: number
  in: number
  cw: number
  cr: number
  out: number
  /** 这轮的花费（美元，引擎按 API 价算，会话累计的差值）；会话第一轮没有 */
  usd?: number
  /** 7 天额度已用百分比 */
  wk?: number
} & SessionTags

/** 对照实验的分组，同一会话的每条记录都带上 */
export type SessionTags = {
  /** 会话 id 前 8 位；旧记录没有，读日志时按文件名补 */
  sid?: string
  /** 记录时开着的实验 */
  ex?: Experiment
  /** 模型切换这一维：auto 切换，control 只分类不切换 */
  ra?: 'auto' | 'control'
  /** 省额度这一维：on 开，off 关 */
  sv?: 'on' | 'off'
  /** 配置版本：插件版本 + 影响切换和省额度的配置的哈希，如 0.3.1-5f3a9c；0.3.1 之前的记录没有 */
  cv?: string
}

/** 省额度拦下一次调用（again=false），或同一目标再请求被放行（again=true） */
export type GuardRecord = { t: 'guard'; ts: number; kind: string; again: boolean } & SessionTags

export type PiRecord = {
  t: 'pi'
  ts: number
  role: string
  model: string
  /** 走哪个通道；0.3 之前的记录没有，用 channelOfRecord 按模型前缀推断 */
  ch?: 'pi' | 'opencode'
  ok: boolean
  ms: number
  ro?: boolean
  /** 改动的文件数 */
  files?: number
  /** 这次是返工：同一会话、同一角色 30 分钟内又派了相似的任务，值是上一次（已完成）用的模型 */
  redo?: string
} & SessionTags

export type LogRecord = TurnRecord | PiRecord | GuardRecord

/** 外派记录的通道：旧记录没有 ch，opencode/ 开头的模型算 opencode，其余算 pi */
export function channelOfRecord(r: Pick<PiRecord, 'ch' | 'model'>): 'pi' | 'opencode' {
  return r.ch ?? (r.model.startsWith('opencode/') || r.model.startsWith('oc:') ? 'opencode' : 'pi')
}

export function parseLog(text: string): LogRecord[] {
  const out: LogRecord[] = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const r = JSON.parse(line) as LogRecord
      if (r && (r.t === 'turn' || r.t === 'pi' || r.t === 'guard') && typeof r.ts === 'number') out.push(r)
    } catch {
      // 半行（写到一半被打断）跳过
    }
  }
  return out
}

type Tokens = Pick<TurnRecord, 'in' | 'cw' | 'cr' | 'out'>

/** 每百万 token 的美元价：输入、输出、缓存读 */
type Price = readonly [number, number, number]

/**
 * Anthropic 官方 API 价（2026-10）。第三项是提示超过 10 万 token 时的价（只有 Haiku 5.5 分档）。
 * 不再从记录里反推单价：每轮 usd 是会话累计花费的差，没单独记的调用（如子代理、压缩）会落进下一轮，
 * 反推出来 Haiku 只比 Opus 便宜 20%，明显不对；按官方价逐轮算，和引擎的数中位误差为 0。
 */
const PRICES: [RegExp, Price, Price?][] = [
  [/fable/, [10, 50, 0.25]],
  [/opus-5-5/, [4, 20, 0.2]],
  [/opus/, [5, 25, 0.5]],
  [/sonnet-5/, [2, 10, 0.2]],
  [/sonnet/, [3, 15, 0.3]],
  [/haiku-5-5/, [0.1, 0.5, 0.01], [0.5, 2.5, 0.05]],
  [/haiku/, [1, 5, 0.1]],
]
/** 缓存写是输入价的倍数：Claude Code 用 1 小时缓存，按 2 倍收（5 分钟缓存是 1.25 倍）；按日志逐轮核对过 */
export const CACHE_WRITE = 2
const LONG_PROMPT = 100_000

/** 按官方价算一组 token 的花费；prompt 是这次请求的提示长度（定 Haiku 5.5 的分档），认不出的模型返回 undefined */
export function tokenUsd(model: string, t: Tokens, prompt = 0): number | undefined {
  const row = PRICES.find(([re]) => re.test(model.toLowerCase()))
  if (!row) return undefined
  const [pin, pout, pread] = (prompt > LONG_PROMPT && row[2]) || row[1]
  return (t.in * pin + t.cw * pin * CACHE_WRITE + t.cr * pread + t.out * pout) / 1e6
}

export function family(model: string): 'opus' | 'sonnet' | 'haiku' | 'other' {
  const m = model.toLowerCase()
  return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : 'other'
}

export type ArmStats = {
  turns: number
  /** 有花费数据的轮数 */
  priced: number
  usd: number
  /** 每个模型系列的轮数 */
  byModel: Record<string, number>
  fixes: number
  switches: number
  /** 其中发生在冷点的（缓存本来就要重建，不算重写的钱） */
  coldSwitches: number
  /** 换模型那一轮缓存要整段重写，比照常读缓存多花的钱（官方价）；冷点上换的不算 */
  switchUsd: number
  /** fork 分类花的钱（官方价，主对话轮） */
  forkUsd: number
}

export type Summary = {
  from: number
  arms: Partial<Record<Arm, ArmStats>>
  /** 拿来比的 Opus（记录里最近用过的，没有就是 Opus 5.5） */
  opus: string
  /**
   * 自动组主对话里用小模型的轮次，换成 Opus 能少花多少（官方价；换模型那轮按“照常读缓存”算，重写的钱记在 switchUsd）。
   * 换模型和分类的代价在 arms.auto.switchUsd、arms.auto.forkUsd，净省 = savedUsd − 两者
   */
  savedUsd?: number
  /** 上面这些小模型轮次按官方价实际花了多少（不含重写） */
  cheapUsd: number
  pi: {
    total: number
    ok: number
    /** 按角色派的任务（不算指定模型的：那多半是在测某个模型能不能用，会拉低成功率） */
    routed: number
    routedOk: number
    byModel: Record<string, number>
    byChannel: Record<string, number>
    files: number
  }
  /** 窗口内 7 天额度百分比的最早、最晚读数 */
  week?: { first: number; last: number; reset: boolean }
}

const emptyArm = (): ArmStats => ({ turns: 0, priced: 0, usd: 0, byModel: {}, fixes: 0, switches: 0, coldSwitches: 0, switchUsd: 0, forkUsd: 0 })

/**
 * fork 分类那次请求的花费（官方价）。引擎的会话花费已经含 fork，这里只用来拆账，不再另加。
 * fork 用上一轮主对话的模型；fu 的顺序是 输入、缓存读、缓存写、输出。
 * fork 写进缓存的那段，主对话接着用同一个模型时会读到，不算白花；只有这轮换了模型才算进去。
 */
export function forkUsd(fu: TurnRecord['fu'], model: string | undefined, switched = false): number {
  if (!fu || !model) return 0
  const prompt = fu[0] + fu[1] + fu[2]
  return tokenUsd(model, { in: fu[0], cr: fu[1], cw: switched ? fu[2] : 0, out: fu[3] }, prompt) ?? 0
}

/** 记录里的子代理轮次 0.3.1 之前一律记成 auto；对照组会话里的改回 control */
function armOfRecord(r: TurnRecord): Arm {
  return r.sub && r.ra === 'control' && r.arm === 'auto' ? 'control' : r.arm
}

export function summarize(records: LogRecord[], from: number): Summary {
  const rows = records.filter(r => r.ts >= from).sort((a, b) => a.ts - b.ts)
  const turns = rows.filter((r): r is TurnRecord => r.t === 'turn')
  const pis = rows.filter((r): r is PiRecord => r.t === 'pi')

  const opus = [...turns].reverse().find(r => family(r.model) === 'opus')?.model ?? 'claude-opus-5-5'

  const arms: Summary['arms'] = {}
  let saved = 0
  let cheapUsd = 0
  const lastMain = new Map<string, string>()
  for (const r of turns) {
    const arm = armOfRecord(r)
    const a = (arms[arm] ??= emptyArm())
    a.turns++
    // 没记下模型的轮次（引擎没报用量）单独算，免得混进“其他”
    const f = r.model ? family(r.model) : 'none'
    a.byModel[f] = (a.byModel[f] ?? 0) + 1
    if (r.fix) a.fixes++
    if (r.usd !== undefined) {
      a.priced++
      a.usd += r.usd
    }
    if (r.sub) continue
    const prev = lastMain.get(r.sid ?? '')
    lastMain.set(r.sid ?? '', r.model)
    const prompt = r.ctx ?? r.in + r.cw + r.cr
    a.forkUsd += forkUsd(r.fu, prev ?? r.model, r.switched)
    // 换模型那轮：缓存整段重写（cw），不换的话这段本来按读缓存算；冷点上缓存本来就要重写，不算换模型的代价
    const paid = r.switched && !r.cold
    const base: Tokens = paid ? { ...r, cw: 0, cr: r.cr + r.cw } : r
    if (r.switched) a.switches++
    if (r.switched && r.cold) a.coldSwitches++
    if (paid) a.switchUsd += Math.max(0, (tokenUsd(r.model, r, prompt) ?? 0) - (tokenUsd(r.model, base, prompt) ?? 0))
    if (arm === 'auto' && (f === 'sonnet' || f === 'haiku')) {
      const mine = tokenUsd(r.model, base, prompt) ?? 0
      cheapUsd += mine
      saved += (tokenUsd(opus, base, prompt) ?? 0) - mine
    }
  }

  const piByModel: Record<string, number> = {}
  const piByChannel: Record<string, number> = {}
  for (const p of pis) {
    piByModel[p.model] = (piByModel[p.model] ?? 0) + 1
    const ch = channelOfRecord(p)
    piByChannel[ch] = (piByChannel[ch] ?? 0) + 1
  }
  const wk = turns.filter(r => r.wk !== undefined)
  return {
    from,
    arms,
    opus,
    savedUsd: saved,
    cheapUsd,
    pi: {
      total: pis.length,
      ok: pis.filter(p => p.ok).length,
      routed: pis.filter(p => p.role !== 'custom').length,
      routedOk: pis.filter(p => p.role !== 'custom' && p.ok).length,
      byModel: piByModel,
      byChannel: piByChannel,
      files: pis.reduce((n, p) => n + (p.files ?? 0), 0),
    },
    // 期间额度窗口重置过（百分比往回掉）时 reset 为 true，面板就不写“从 x% 起”
    week: wk.length
      ? {
          first: wk[0]?.wk as number,
          last: wk[wk.length - 1]?.wk as number,
          reset: wk.some((r, i) => i > 0 && (r.wk as number) < (wk[i - 1]?.wk as number)),
        }
      : undefined,
  }
}

/** 用户在纠正上一轮的说法 */
export const CORRECTION = /不对|错了|有误|重做|重来|重新(做|写|改|来)|还是不行|还是不对|没用|不是这样|搞错|又坏了|没修好|没解决|回退|撤销|wrong|doesn'?t work|still (broken|failing)|redo|revert/i


// ---------- 对照实验（按会话分组） ----------

function fnv(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0
  return h
}

/**
 * 配置版本：插件版本加上会改变切换、省额度做法的配置（claude 整段、saver 整段、experiment）的哈希。
 * 不含外派模型顺序和界面设置：它们常改，又不影响 Claude 这边的花费，算进去会把样本切得太碎
 */
export function configVersion(cfg: Pick<Config, 'claude' | 'saver' | 'experiment'>, pluginVersion: string): string {
  const key = JSON.stringify([cfg.claude, cfg.saver, cfg.experiment])
  return `${pluginVersion}-${fnv(key).toString(16).padStart(8, '0').slice(0, 6)}`
}

/** 会话 id 的 FNV-1a 哈希，第 0 位定模型切换组，第 1 位定省额度组：同一会话重载后分组不变 */
export function sessionArms(sid: string, exp: Experiment): Pick<SessionTags, 'ra' | 'sv'> {
  const h = fnv(sid)
  return {
    ra: exp === 'route' || exp === 'both' ? (h & 1 ? 'control' : 'auto') : undefined,
    sv: exp === 'saver' || exp === 'both' ? (h & 2 ? 'off' : 'on') : undefined,
  }
}

export type SessionStats = {
  sid: string
  /** 配置版本（没记版本的旧记录是空字符串）；会话中途改过配置时 mixed 为 true，不进任何一版的比较 */
  cv: string
  mixed: boolean
  ra?: SessionTags['ra']
  sv?: SessionTags['sv']
  /** 主对话轮数（≈ 用户发了几条消息） */
  turns: number
  /** 主对话加子代理的花费（引擎算的，已含 fork 分类） */
  usd: number
  subUsd: number
  forkUsd: number
  /** 主对话每轮开始时上下文的平均值、最大值 */
  ctxAvg: number
  ctxMax: number
  fixes: number
  /** 主对话轮次里分类没出结果的（小模型限流、超时、出错，本地规则也没判出），这些轮保持原模型 */
  cfails: number
  /** 冷点轮数；换模型的轮次里在冷点的、在冷点之间的（冷点之间只会升档） */
  colds: number
  coldSwitches: number
  midSwitches: number
  /** 小模型分出类别、规则也判出类别的轮数，和其中两者一致的 */
  ruleN: number
  ruleAgree: number
  guards: number
  agains: number
  /** 会话内 7 天额度百分比涨了多少（额度窗口重置的回落不算） */
  wk: number
  /** 第一条、最后一条记录的时间 */
  start: number
  end: number
  /** 和别的会话同时开过：7 天额度是整个账号共用的，这时 wk 里混着别的会话的消耗 */
  overlap: boolean
  /** 外派任务数和总耗时；外派模型的花费不在 usd 里 */
  piJobs: number
  piMs: number
}

export type CellStats = {
  sessions: number
  turns: number
  usd: number
  /** 主指标：每会话花费取对数后的平均值和标准误（会话花费长尾，少数大会话会主导算术平均）；geoUsd 是对应的几何平均 */
  logUsd: number
  logUsdSe: number
  geoUsd: number
  /** 每会话“每轮花费”的平均值和标准误 */
  perTurn: number
  perTurnSe: number
  turnsPerSession: number
  ctxAvg: number
  /** 上下文到过 30 万的会话占比 */
  longShare: number
  fixRate: number
  guards: number
  againRate: number
  wkPerSession: number
  /** 算进 wkPerSession 的会话数（没和别的会话同时开的） */
  wkSessions: number
  piJobs: number
  subShare: number
  /** 花费里 fork 分类的估算占比 */
  forkShare: number
  /** 主对话轮次里分类没出结果的占比 */
  cfailRate: number
  /** 冷点轮次占比；冷点上、冷点之间换模型的次数 */
  coldRate: number
  coldSwitches: number
  midSwitches: number
  /** 规则和小模型分类一致的比例，ruleN 是比过的轮数 */
  ruleAgree: number
  ruleN: number
}

export type Effect = {
  factor: 'route' | 'saver'
  /** 实验组（auto / on）和对照组（control / off） */
  on: CellStats
  off: CellStats
  /** 每会话花费（几何平均）的相对变化，负数是省 */
  change: number
  /** 两组各有 MIN_SESSIONS 个会话，且对数差超过两倍合并标准误 */
  sure: boolean
  /** 辅助参考：每轮花费的相对变化（拦截后用户再请求会多出便宜的轮次，所以不作主指标） */
  perTurnChange: number
}

export type ExperimentReport = {
  sessions: SessionStats[]
  /** 分格，键是 "auto|on" 这样；只测一维时另一维写 "-" */
  cells: Record<string, CellStats>
  effects: Effect[]
  /** 轮数太少、没算进实验的会话数 */
  short: number
  /** 这份报告比较的配置版本（空字符串 = 没记版本的旧记录）；all 表示没按版本筛 */
  version: string
  /** 窗口里各配置版本的会话（够轮数的），按开始时间排；mixed 是中途改过配置、哪版都不算的会话数 */
  versions: VersionRow[]
  mixed: number
}

export type VersionRow = {
  cv: string
  sessions: number
  start: number
  end: number
  /** 这一版里模型切换、省额度两维各组的会话数和每会话花费（几何平均） */
  route?: { on: number; off: number; onUsd: number; offUsd: number }
  saver?: { on: number; off: number; onUsd: number; offUsd: number }
}

/** 每组至少这么多会话才下结论；事先定好，到量前的数只作参考，免得反复看、看到显著就停 */
export const MIN_SESSIONS = 15
/** 少于这么多轮的会话不算：多是试一下就关、或别处起的一次性会话，会把平均值拉偏 */
export const MIN_TURNS = 3
const LONG_CTX = 300_000

export function sessionStats(records: LogRecord[]): SessionStats[] {
  type Acc = SessionStats & { ctxSum: number; ctxN: number; wkLast?: number; lastModel?: string }
  const by = new Map<string, Acc>()
  for (const r of [...records].sort((a, b) => a.ts - b.ts)) {
    if (!r.ex || !r.sid) continue
    let s = by.get(r.sid)
    if (!s) {
      s = {
        sid: r.sid, cv: r.cv ?? '', mixed: false, ra: r.ra, sv: r.sv, turns: 0, usd: 0, subUsd: 0, forkUsd: 0, ctxAvg: 0, ctxMax: 0, ctxSum: 0, ctxN: 0,
        fixes: 0, cfails: 0, colds: 0, coldSwitches: 0, midSwitches: 0, ruleN: 0, ruleAgree: 0, guards: 0, agains: 0, wk: 0, start: r.ts, end: r.ts, overlap: false, piJobs: 0, piMs: 0,
      }
      by.set(r.sid, s)
    }
    s.end = r.ts
    if ((r.cv ?? '') !== s.cv) s.mixed = true
    if (r.t === 'pi') {
      s.piJobs++
      s.piMs += r.ms
      continue
    }
    if (r.t === 'guard') {
      if (r.again) s.agains++
      else s.guards++
      continue
    }
    s.usd += r.usd ?? 0
    if (r.sub) {
      s.subUsd += r.usd ?? 0
      continue
    }
    s.turns++
    const fk = forkUsd(r.fu, s.lastModel ?? r.model, r.switched)
    s.forkUsd += Math.min(fk, r.usd ?? fk)
    s.lastModel = r.model
    if (r.fix) s.fixes++
    if ((r.cf === 'error' || r.cf === 'timeout') && r.via !== 'rule') s.cfails++
    if (r.cold) s.colds++
    if (r.switched && r.cold) s.coldSwitches++
    if (r.switched && !r.cold) s.midSwitches++
    if (r.via === 'classify' && r.cat && r.rc) {
      s.ruleN++
      if (r.rc === r.cat) s.ruleAgree++
    }
    if (r.ctx !== undefined) {
      s.ctxSum += r.ctx
      s.ctxN++
      s.ctxMax = Math.max(s.ctxMax, r.ctx)
    }
    if (r.wk !== undefined) {
      if (s.wkLast !== undefined && r.wk > s.wkLast) s.wk += r.wk - s.wkLast
      s.wkLast = r.wk
    }
  }
  const list = [...by.values()]
    .filter(s => s.turns > 0)
    .map(({ ctxSum, ctxN, wkLast: _w, lastModel: _m, ...s }) => ({ ...s, ctxAvg: ctxN ? ctxSum / ctxN : 0 }))
  // 同时开着的会话（含不在实验里的）：按所有带会话 id 的记录算各会话的起止时间
  const spans = new Map<string, [number, number]>()
  for (const r of records) {
    if (!r.sid) continue
    const sp = spans.get(r.sid)
    spans.set(r.sid, sp ? [Math.min(sp[0], r.ts), Math.max(sp[1], r.ts)] : [r.ts, r.ts])
  }
  for (const s of list) {
    for (const [sid, [a, b]] of spans) if (sid !== s.sid && a <= s.end && b >= s.start) s.overlap = true
  }
  return list
}

export function cellStats(list: SessionStats[]): CellStats {
  const n = list.length
  const sum = (f: (s: SessionStats) => number) => list.reduce((a, s) => a + f(s), 0)
  const turns = sum(s => s.turns)
  const usd = sum(s => s.usd)
  const meanSe = (xs: number[]): [number, number] => {
    const m = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0
    const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)) : 0
    return [m, xs.length > 1 ? sd / Math.sqrt(xs.length) : 0]
  }
  const [perTurn, perTurnSe] = meanSe(list.map(s => s.usd / s.turns))
  // 加一分钱再取对数，免得没花费的会话变成负无穷
  const [logUsd, logUsdSe] = meanSe(list.map(s => Math.log(s.usd + 0.01)))
  const guards = sum(s => s.guards)
  const wkList = list.filter(s => !s.overlap)
  return {
    sessions: n,
    turns,
    usd,
    logUsd,
    logUsdSe,
    geoUsd: n ? Math.exp(logUsd) - 0.01 : 0,
    perTurn,
    perTurnSe,
    turnsPerSession: n ? turns / n : 0,
    ctxAvg: n ? sum(s => s.ctxAvg) / n : 0,
    longShare: n ? list.filter(s => s.ctxMax >= LONG_CTX).length / n : 0,
    fixRate: turns ? sum(s => s.fixes) / turns : 0,
    guards,
    againRate: guards ? sum(s => s.agains) / guards : 0,
    wkPerSession: wkList.length ? wkList.reduce((a, s) => a + s.wk, 0) / wkList.length : 0,
    wkSessions: wkList.length,
    piJobs: sum(s => s.piJobs),
    subShare: usd ? sum(s => s.subUsd) / usd : 0,
    forkShare: usd ? sum(s => s.forkUsd) / usd : 0,
    cfailRate: turns ? sum(s => s.cfails) / turns : 0,
    coldRate: turns ? sum(s => s.colds) / turns : 0,
    coldSwitches: sum(s => s.coldSwitches),
    midSwitches: sum(s => s.midSwitches),
    ruleAgree: sum(s => s.ruleN) ? sum(s => s.ruleAgree) / sum(s => s.ruleN) : 0,
    ruleN: sum(s => s.ruleN),
  }
}

/**
 * 对照实验报告。默认只比最新配置版本的会话：改了切换做法后，新旧两种做法的会话混在一起比，结论会被旧数据拖着走。
 * version 传具体版本只看那一版，传 'all' 不按版本筛
 */
export function experimentReport(records: LogRecord[], from: number, version?: string): ExperimentReport {
  const all = sessionStats(records.filter(r => r.ts >= from))
  const long = all.filter(s => s.turns >= MIN_TURNS)
  const clean = long.filter(s => !s.mixed)
  const latest = [...clean].sort((a, b) => b.end - a.end)[0]?.cv ?? ''
  const chosen = version ?? latest
  const pick = (s: SessionStats) => chosen === 'all' || (!s.mixed && s.cv === chosen)
  const sessions = long.filter(pick)
  const byVersion = new Map<string, SessionStats[]>()
  for (const s of clean) byVersion.set(s.cv, [...(byVersion.get(s.cv) ?? []), s])
  const geo = (list: SessionStats[]) => cellStats(list).geoUsd
  const dim = (list: SessionStats[], isOn: (s: SessionStats) => boolean | undefined) => {
    const on = list.filter(s => isOn(s) === true)
    const off = list.filter(s => isOn(s) === false)
    return on.length || off.length ? { on: on.length, off: off.length, onUsd: geo(on), offUsd: geo(off) } : undefined
  }
  const versions: VersionRow[] = [...byVersion]
    .map(([cv, list]) => ({
      cv,
      sessions: list.length,
      start: Math.min(...list.map(s => s.start)),
      end: Math.max(...list.map(s => s.end)),
      route: dim(list, s => (s.ra === undefined ? undefined : s.ra === 'auto')),
      saver: dim(list, s => (s.sv === undefined ? undefined : s.sv === 'on')),
    }))
    .sort((a, b) => a.start - b.start)
  const groups = new Map<string, SessionStats[]>()
  for (const s of sessions) {
    const key = `${s.ra ?? '-'}|${s.sv ?? '-'}`
    groups.set(key, [...(groups.get(key) ?? []), s])
  }
  const cells: Record<string, CellStats> = {}
  for (const [key, list] of groups) cells[key] = cellStats(list)
  const factors: ['route' | 'saver', (s: SessionStats) => boolean | undefined][] = [
    ['route', s => (s.ra === undefined ? undefined : s.ra === 'auto')],
    ['saver', s => (s.sv === undefined ? undefined : s.sv === 'on')],
  ]
  const effects: Effect[] = []
  for (const [factor, isOn] of factors) {
    const onList = sessions.filter(s => isOn(s) === true)
    const offList = sessions.filter(s => isOn(s) === false)
    if (!onList.length || !offList.length) continue
    const on = cellStats(onList)
    const off = cellStats(offList)
    // 在对数上比：差值就是几何平均之比的对数
    const diff = on.logUsd - off.logUsd
    const se = Math.sqrt(on.logUsdSe ** 2 + off.logUsdSe ** 2)
    effects.push({
      factor,
      on,
      off,
      change: Math.exp(diff) - 1,
      sure: on.sessions >= MIN_SESSIONS && off.sessions >= MIN_SESSIONS && se > 0 && Math.abs(diff) > 2 * se,
      perTurnChange: off.perTurn ? (on.perTurn - off.perTurn) / off.perTurn : 0,
    })
  }
  return {
    sessions,
    cells,
    effects,
    short: all.filter(s => s.turns < MIN_TURNS && pick(s)).length,
    version: chosen,
    versions,
    mixed: long.length - clean.length,
  }
}

export function verdict(e: Effect): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const need = Math.max(MIN_SESSIONS - e.on.sessions, MIN_SESSIONS - e.off.sessions)
  if (need > 0) return `样本还不够：每组要 ${MIN_SESSIONS} 个会话，还差 ${need} 个（现在的数只作参考）`
  if (!e.sure) return '差异在误差范围内，还说不准'
  return e.change < 0 ? `确实省了 ${pct(-e.change)}` : `反而多花 ${pct(e.change)}`
}

/** 文字版报告：/auto-router eval 输出，面板「效果」页也显示同样的数 */
export function reportText(rep: ExperimentReport, days: number): string {
  const money = (n: number) => (n < 0.001 ? '<$0.001' : `$${n.toFixed(n < 1 ? 3 : 2)}`)
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const k = (n: number) => `${Math.round(n / 1000)}k`
  const tail = versionText(rep)
  const ver = rep.version === 'all' ? '不分配置版本' : `配置版本 ${versionName(rep.version)}`
  const others = rep.versions.some(v => v.cv !== rep.version)
  if (!rep.sessions.length && others) return [`${ver} 还没有够 ${MIN_TURNS} 轮的实验会话，结论要等新数据。`, '', ...tail].join('\n')
  if (!rep.sessions.length && rep.short) return `最近 ${days} 天的 ${rep.short} 个实验会话都不到 ${MIN_TURNS} 轮，还没有能算的。`
  if (!rep.sessions.length) return `最近 ${days} 天还没有实验会话。先在 /auto-router 打开“对照实验”，之后新开的会话会自动分组。`
  const NAME: Record<Effect['factor'], [string, string, string]> = {
    route: ['模型切换', '切换', '不切换'],
    saver: ['省额度', '开', '关'],
  }
  const skipped = rep.short ? `，另有 ${rep.short} 个不到 ${MIN_TURNS} 轮的没算` : ''
  const only = others || rep.mixed ? `，只比${ver}` : ''
  const lines = [`对照实验（最近 ${days} 天，${rep.sessions.length} 个会话${skipped}${only}）`, '']
  for (const e of rep.effects) {
    const [title, a, b] = NAME[e.factor]
    lines.push(
      `【${title}】${verdict(e)}`,
      `  会话数     ${a} ${e.on.sessions}，${b} ${e.off.sessions}`,
      `  每会话花费 ${a} ${money(e.on.geoUsd)}，${b} ${money(e.off.geoUsd)}（几何平均，主指标）`,
      `  每会话     ${a} ${e.on.turnsPerSession.toFixed(1)} 轮，${b} ${e.off.turnsPerSession.toFixed(1)} 轮；算术平均 ${money(e.on.usd / e.on.sessions)} / ${money(e.off.usd / e.off.sessions)}`,
      `  每轮花费   ${a} ${money(e.on.perTurn)}±${money(e.on.perTurnSe)}，${b} ${money(e.off.perTurn)}±${money(e.off.perTurnSe)}（参考：拦截后再请求会多出便宜的轮次）`,
      `  上下文     平均 ${k(e.on.ctxAvg)} / ${k(e.off.ctxAvg)}；到过 30 万的会话 ${pct(e.on.longShare)} / ${pct(e.off.longShare)}`,
      e.on.wkSessions && e.off.wkSessions
        ? `  7 天额度   每会话涨 ${e.on.wkPerSession.toFixed(1)} / ${e.off.wkPerSession.toFixed(1)} 个百分点（只算没和别的会话同时开的 ${e.on.wkSessions} / ${e.off.wkSessions} 个）`
        : '  7 天额度   会话都和别的会话同时开过，额度是整个账号共用的，分不出各会话用了多少',
      `  外派       ${e.on.piJobs} / ${e.off.piJobs} 次（外派模型的花费不在上面的数里）`,
      `  质量       纠正率 ${pct(e.on.fixRate)} / ${pct(e.off.fixRate)}`,
    )
    if (e.factor === 'route') {
      lines.push(`  分类花费   fork 分类约占切换组花费的 ${pct(e.on.forkShare)}（已含在每轮花费里）`)
      // 切换组里分类失败的轮次保持原模型，等于没切换：失败多时两组差别会被低估
      const warn = e.on.cfailRate > 0.3 ? '，超过三成：切换组有很多轮其实没切换，效果会被低估' : ''
      lines.push(`  分类失败   切换组 ${pct(e.on.cfailRate)} 的轮次没分出类别（小模型限流、超时，本地规则也没判出），这些轮保持原模型${warn}`)
      if (e.on.coldRate)
        lines.push(
          `  冷点       切换组 ${pct(e.on.coldRate)} 的轮次是冷点（缓存本来就要重建）；冷点上换模型 ${e.on.coldSwitches} 次，冷点之间升档 ${e.on.midSwitches} 次`,
        )
      if (e.on.ruleN)
        lines.push(`  本地规则   和小模型分类一致 ${pct(e.on.ruleAgree)}（比过 ${e.on.ruleN} 轮；低于七成时规则判的类别别太信）`)
    }
    if (e.factor === 'saver')
      lines.push(`  拦截       ${e.on.guards} 次，其中 ${pct(e.on.againRate)} 被原样再请求（可能是误拦）；子代理花费占 ${pct(e.on.subShare)} / ${pct(e.off.subShare)}`)
    lines.push('')
  }
  const keys = Object.keys(rep.cells).sort()
  if (keys.length > 1) {
    lines.push('分格（切换|省额度）：')
    for (const key of keys) {
      const c = rep.cells[key] as CellStats
      lines.push(`  ${key.padEnd(13)} ${c.sessions} 会话  每会话 ${money(c.geoUsd)}  每轮 ${money(c.perTurn)}  纠正 ${pct(c.fixRate)}  上下文 ${k(c.ctxAvg)}`)
    }
    lines.push('')
  }
  lines.push(
    '花费是按 API 价折算的美元，订阅不按它扣额度，但组间比例可以参考；两组做的活不一样时，差异也可能来自任务本身。',
    '面板上看得到自己在哪组，在“不切换”组里手动换模型会让切换的效果被低估。',
  )
  if (tail.length) lines.push('', ...tail)
  return lines.join('\n')
}

/** 没记版本的旧记录显示成这个 */
export function versionName(cv: string): string {
  return cv || '0.3.1 之前（没记版本）'
}

/** 「按版本」一段：窗口里只有一个版本、也没有跨版本的会话时不写 */
function versionText(rep: ExperimentReport): string[] {
  if (rep.versions.length < 2 && !rep.mixed) return []
  const money = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`
  const day = (ts: number) => new Date(ts + 8 * 3600_000).toISOString().slice(5, 10)
  const dim = (name: string, a: string, b: string, d: VersionRow['route']) =>
    d && d.on && d.off ? `；${name ? `${name} ` : ''}${a} ${d.on} 个 ${money(d.onUsd)} / ${b} ${d.off} 个 ${money(d.offUsd)}` : ''
  const lines = ['按配置版本（只作参考：旧版本做法不同，结论只看当前版本）：']
  for (const v of rep.versions) {
    const mark = v.cv === rep.version ? '  ← 当前' : ''
    lines.push(`  ${versionName(v.cv)}  ${day(v.start)}~${day(v.end)}  ${v.sessions} 个会话${dim('', '切换', '不切换', v.route)}${dim('省额度', '开', '关', v.saver)}${mark}`)
  }
  if (rep.mixed) lines.push(`  另有 ${rep.mixed} 个会话中途改过配置或升级了插件，哪一版都不算`)
  return lines
}

// ---------- 按类别 ----------

export type CategoryRow = { cat: string; ra: 'auto' | 'control' | '-'; turns: number; fixes: number; usd: number; models: Partial<Record<string, number>> }

/**
 * 每类问题的轮数、花费、被纠正次数，按模型切换组分开。
 * 纠正记在上一轮的类别上：用户说"不对"是在下一轮，被纠正的是上一轮的回答。
 */
export function categoryStats(records: LogRecord[], from: number): CategoryRow[] {
  const bySid = new Map<string, TurnRecord[]>()
  for (const r of records) {
    if (r.t !== 'turn' || r.sub || r.ts < from) continue
    const k = r.sid ?? ''
    bySid.set(k, [...(bySid.get(k) ?? []), r])
  }
  const rows = new Map<string, CategoryRow>()
  for (const turns of bySid.values()) {
    turns.sort((a, b) => a.ts - b.ts)
    turns.forEach((r, i) => {
      if (!r.cat) return
      const ra = r.ra ?? '-'
      const k = `${r.cat}|${ra}`
      const row = rows.get(k) ?? { cat: r.cat, ra, turns: 0, fixes: 0, usd: 0, models: {} }
      row.turns++
      row.usd += r.usd ?? 0
      const f = family(r.model)
      row.models[f] = (row.models[f] ?? 0) + 1
      if (turns[i + 1]?.fix) row.fixes++
      rows.set(k, row)
    })
  }
  return [...rows.values()].sort((a, b) => b.turns - a.turns)
}

export function categoryText(rows: CategoryRow[]): string {
  if (!rows.length) return '按类别：还没有记录。'
  const lines = rows.map(r => {
    const mix = Object.entries(r.models).map(([m, n]) => `${m} ${n}`).join(' / ')
    const rate = r.turns >= 20 ? `${((r.fixes / r.turns) * 100).toFixed(0)}%` : '样本不足'
    return `| ${r.cat} | ${r.ra} | ${r.turns} | ${r.fixes} | ${rate} | $${r.usd.toFixed(2)} | ${mix} |`
  })
  return ['| 类别 | 切换组 | 轮数 | 被纠正 | 纠正率 | 花费 | 实际模型 |', '|---|---|---|---|---|---|---|', ...lines].join('\n')
}

// ---------- 实际版本 ----------

/** 各档别名最近一次实际用到的模型 id（API 报告的），面板据此显示版本号 */
export function modelVersions(records: LogRecord[]): Partial<Record<'haiku' | 'sonnet' | 'opus', string>> {
  const out: Partial<Record<'haiku' | 'sonnet' | 'opus', { id: string; ts: number }>> = {}
  for (const r of records) {
    if (r.t !== 'turn') continue
    const f = family(r.model)
    if (f === 'other') continue
    if (!out[f] || r.ts > (out[f]?.ts ?? 0)) out[f] = { id: r.model, ts: r.ts }
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v?.id])) as Partial<Record<'haiku' | 'sonnet' | 'opus', string>>
}

/** 'haiku' + 'claude-haiku-5-5' → 'Haiku 5.5'；没见过实际 id 时只显示档名 */
export function versionLabel(alias: string, id?: string): string {
  const name = alias.charAt(0).toUpperCase() + alias.slice(1)
  const m = id ? /-(\d+)-(\d+)(?:-|$|\[)/.exec(id) : null
  return m ? `${name} ${m[1]}.${m[2]}` : name
}

// ---------- 外派返工 ----------

/** 任务文本的词：英文数字按词，中文按相邻两字；用来判断两次派的是不是同一件事 */
export function taskWords(text: string): Set<string> {
  const out = new Set<string>()
  const t = text.toLowerCase()
  for (const w of t.match(/[a-z0-9_.\/-]{2,}/g) ?? []) out.add(w)
  for (const run of t.match(/[\u4e00-\u9fff]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  return out
}

/** 两组词的重合度（交集 / 并集） */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let both = 0
  for (const w of a) if (b.has(w)) both++
  return both / (a.size + b.size - both)
}

/** 相似到算返工的重合度、时间窗 */
export const REDO_OVERLAP = 0.5
export const REDO_WINDOW = 30 * 60_000
/** 至少完成这么多个任务、返工率到这个数的模型，派活时排到角色链后面 */
export const REDO_MIN_JOBS = 5
export const REDO_RATE = 0.3

export type RedoRow = { model: string; ok: number; redo: number }

/** 各模型完成的任务数、其中被返工的次数（返工记在被返工的那个模型上） */
export function redoStats(records: LogRecord[], from: number): RedoRow[] {
  const rows = new Map<string, RedoRow>()
  const row = (m: string): RedoRow => {
    let r = rows.get(m)
    if (!r) rows.set(m, (r = { model: m, ok: 0, redo: 0 }))
    return r
  }
  for (const r of records) {
    if (r.t !== 'pi' || r.ts < from) continue
    if (r.ok) row(r.model).ok++
    if (r.redo) row(r.redo).redo++
  }
  return [...rows.values()].sort((a, b) => b.ok - a.ok)
}

/** 返工多的模型：派活时往后排 */
export function demotedModels(rows: RedoRow[]): Set<string> {
  return new Set(rows.filter(r => r.ok >= REDO_MIN_JOBS && r.redo / r.ok >= REDO_RATE).map(r => r.model))
}

/** 报告里的返工一节；没有返工记录时为空 */
export function redoText(rows: RedoRow[]): string {
  const hit = rows.filter(r => r.redo > 0)
  if (!hit.length) return ''
  const demoted = demotedModels(rows)
  return [
    '外派返工（同一会话、同一角色 30 分钟内又派相似任务，记在上一次的模型上）：',
    ...hit.map(r => `- ${r.model}：完成 ${r.ok} 个，返工 ${r.redo} 次（${Math.round((r.redo / r.ok) * 100)}%）${demoted.has(r.model) ? '，已排到角色链后面' : ''}`),
  ].join('\n')
}


// ---------- 花费构成：额度花在哪 ----------

/** 主对话的花费按官方价拆成读缓存、写缓存、新输入、输出；写缓存里冷点重建的单独算 */
export type CostSplit = {
  turns: number
  read: number
  write: number
  input: number
  output: number
  /** 0.4.0 起才记冷点：记了冷点的轮数和它们的写缓存花费，冷点占比只在这些轮里算 */
  coldTurns: number
  coldScopeWrite: number
  /** 写缓存里，冷点那一轮的（缓存过期、压缩后、会话开头的整段重建） */
  coldWrite: number
  /** 其中隔太久缓存过期（gap）重建的：只有这部分能靠“长对话歇久了先压缩 / 开新会话”省下 */
  gapWrite: number
  /** 每轮平均：缓存读、缓存写的 token，开始时的上下文 */
  crPerTurn: number
  cwPerTurn: number
  ctxPerTurn: number
}

/** 这一版日志记不记冷点：0.4.0 起记，没记版本的是 0.3.1 之前 */
function logsCold(cv: string | undefined): boolean {
  const m = /^(\d+)\.(\d+)/.exec(cv ?? '')
  return !!m && (Number(m[1]) > 0 || Number(m[2]) >= 4)
}

export function costSplit(records: LogRecord[], from: number): CostSplit {
  const s: CostSplit = { turns: 0, read: 0, write: 0, input: 0, output: 0, coldTurns: 0, coldScopeWrite: 0, coldWrite: 0, gapWrite: 0, crPerTurn: 0, cwPerTurn: 0, ctxPerTurn: 0 }
  let cr = 0
  let cw = 0
  let ctx = 0
  let ctxN = 0
  for (const r of records) {
    if (r.t !== 'turn' || r.sub || r.ts < from || !r.model) continue
    const prompt = r.ctx ?? r.in + r.cw + r.cr
    const part = (t: Tokens) => tokenUsd(r.model, t, prompt) ?? 0
    const zero = { in: 0, cw: 0, cr: 0, out: 0 }
    const w = part({ ...zero, cw: r.cw })
    s.turns++
    s.read += part({ ...zero, cr: r.cr })
    s.write += w
    s.input += part({ ...zero, in: r.in })
    s.output += part({ ...zero, out: r.out })
    if (logsCold(r.cv)) {
      s.coldTurns++
      s.coldScopeWrite += w
    }
    if (r.cold) s.coldWrite += w
    if (r.cold === 'gap') s.gapWrite += w
    cr += r.cr
    cw += r.cw
    if (r.ctx !== undefined) {
      ctx += r.ctx
      ctxN++
    }
  }
  if (s.turns) Object.assign(s, { crPerTurn: cr / s.turns, cwPerTurn: cw / s.turns, ctxPerTurn: ctxN ? ctx / ctxN : 0 })
  return s
}

export function costSplitText(c: CostSplit): string {
  const total = c.read + c.write + c.input + c.output
  if (!c.turns || total <= 0) return ''
  const pct = (x: number) => `${Math.round((x / total) * 100)}%`
  const k = (n: number) => `${Math.round(n / 1000)}k`
  const lines = [
    `花费构成（主对话 ${c.turns} 轮，官方价折算 $${total.toFixed(2)}）`,
    `  读缓存 ${pct(c.read)} · 写缓存 ${pct(c.write)} · 输出 ${pct(c.output)} · 新输入 ${pct(c.input)}`,
    `  每轮平均：读缓存 ${k(c.crPerTurn)} token，写缓存 ${k(c.cwPerTurn)} token，开始时上下文 ${k(c.ctxPerTurn)}`,
  ]
  if (c.coldTurns > 0 && c.coldScopeWrite > 0) {
    const scope = c.coldTurns < c.turns ? `0.4.0 起记了冷点的 ${c.coldTurns} 轮里，` : ''
    lines.push(
      `  ${scope}写缓存 ${Math.round((c.coldWrite / c.coldScopeWrite) * 100)}% 是冷点整段重建，其中隔太久缓存过期的 $${c.gapWrite.toFixed(2)}（长对话歇久了，回来先压缩或开新会话能省下这部分）`,
    )
  }
  lines.push('  读写缓存的量取决于上下文大小和一轮里的工具步骤数，是额度的大头；换模型只影响单价。')
  return lines.join('\n')
}
