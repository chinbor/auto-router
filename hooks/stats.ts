import type { Experiment } from './config'

// 效果统计：每轮对话、每个 pi 任务记一行 JSON 到 ~/.claude/auto-router/log/，面板「效果」页从这里汇总。
// 一个会话一个文件，整份重写（$.fs 没有追加），多个会话同时开也不会互相覆盖。

/** 这一轮属于哪一组：auto 自动切换；control 对照日（只分类不切换）；off 关闭；fixed 固定模型 */
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
  via?: 'classify' | 'fork'
  /** fork 分类的 token 用量：输入、缓存读、缓存写、输出 */
  fu?: [number, number, number, number]
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
}

/** 省额度拦下一次调用（again=false），或同一目标再请求被放行（again=true） */
export type GuardRecord = { t: 'guard'; ts: number; kind: string; again: boolean } & SessionTags

export type PiRecord = {
  t: 'pi'
  ts: number
  role: string
  model: string
  ok: boolean
  ms: number
  ro?: boolean
  /** 改动的文件数 */
  files?: number
} & SessionTags

export type LogRecord = TurnRecord | PiRecord | GuardRecord

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

/** 输入 token 按价格倍数折算：缓存写 1.25 倍、缓存读 0.1 倍、输出 5 倍 */
export function weighted(r: Pick<TurnRecord, 'in' | 'cw' | 'cr' | 'out'>): number {
  return r.in + 1.25 * r.cw + 0.1 * r.cr + 5 * r.out
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
  /** 切换后那一轮缓存写入多花的钱（估算） */
  switchUsd: number
}

export type Summary = {
  from: number
  arms: Partial<Record<Arm, ArmStats>>
  /** 各模型系列每加权 token 的美元价，从记录里反推 */
  unitPrice: Partial<Record<string, number>>
  /** 自动组里没用 Opus 的轮次，如果用 Opus 要多花多少（估算；缺 Opus 单价时为 undefined） */
  savedUsd?: number
  /** 自动组实际花费里，用了小模型的那部分 */
  cheapUsd: number
  pi: { total: number; ok: number; byModel: Record<string, number>; files: number }
  /** 窗口内 7 天额度百分比的最早、最晚读数 */
  week?: { first: number; last: number }
}

const emptyArm = (): ArmStats => ({ turns: 0, priced: 0, usd: 0, byModel: {}, fixes: 0, switches: 0, switchUsd: 0 })

/** 单价：同一系列的总花费 / 总加权 token */
export function unitPrices(turns: TurnRecord[]): Partial<Record<string, number>> {
  const usdBy: Record<string, number> = {}
  const wBy: Record<string, number> = {}
  for (const r of turns) {
    if (r.usd === undefined || r.usd <= 0) continue
    const f = family(r.model)
    usdBy[f] = (usdBy[f] ?? 0) + r.usd
    wBy[f] = (wBy[f] ?? 0) + weighted(r)
  }
  const unitPrice: Partial<Record<string, number>> = {}
  for (const f of Object.keys(usdBy)) if (wBy[f]) unitPrice[f] = (usdBy[f] as number) / (wBy[f] as number)
  return unitPrice
}

/**
 * fork 分类那次请求的估算花费。引擎的会话花费已经含 fork（probe 实测 fork 前后会话花费涨了同样的量），
 * 每轮 usd 是相邻两次 turn.complete 之间的差，提交时的 fork 就落在那一轮里，所以这里只用来算占比，不再另加。
 * fork 用的是上一轮主对话的模型，fu 的顺序是 输入、缓存读、缓存写、输出。
 */
export function forkUsd(fu: TurnRecord['fu'], model: string | undefined, price: Partial<Record<string, number>>): number {
  if (!fu || !model) return 0
  return (price[family(model)] ?? 0) * weighted({ in: fu[0], cr: fu[1], cw: fu[2], out: fu[3] })
}

export function summarize(records: LogRecord[], from: number): Summary {
  const rows = records.filter(r => r.ts >= from).sort((a, b) => a.ts - b.ts)
  const turns = rows.filter((r): r is TurnRecord => r.t === 'turn')
  const pis = rows.filter((r): r is PiRecord => r.t === 'pi')

  const unitPrice = unitPrices(turns)

  const arms: Summary['arms'] = {}
  let saved = 0
  let cheapUsd = 0
  let canEstimate = unitPrice.opus !== undefined
  for (const r of turns) {
    const a = (arms[r.arm] ??= emptyArm())
    a.turns++
    const f = family(r.model)
    a.byModel[f] = (a.byModel[f] ?? 0) + 1
    if (r.fix) a.fixes++
    if (r.usd !== undefined) {
      a.priced++
      a.usd += r.usd
    }
    if (r.switched) {
      a.switches++
      // 换模型后整段上下文要重写缓存：本该按 0.1 倍读的部分按 1.25 倍写了，按全部写入量算是上限
      const p = unitPrice[f]
      if (p !== undefined) a.switchUsd += p * r.cw * 1.15
    }
    if (r.arm === 'auto' && !r.sub && (f === 'sonnet' || f === 'haiku') && r.usd !== undefined) {
      cheapUsd += r.usd
      if (unitPrice.opus !== undefined) saved += unitPrice.opus * weighted(r) - r.usd
      else canEstimate = false
    }
  }

  const piByModel: Record<string, number> = {}
  for (const p of pis) piByModel[p.model] = (piByModel[p.model] ?? 0) + 1
  const wk = turns.filter(r => r.wk !== undefined)
  return {
    from,
    arms,
    unitPrice,
    savedUsd: canEstimate ? saved : undefined,
    cheapUsd,
    pi: { total: pis.length, ok: pis.filter(p => p.ok).length, byModel: piByModel, files: pis.reduce((n, p) => n + (p.files ?? 0), 0) },
    week: wk.length ? { first: wk[0]?.wk as number, last: wk[wk.length - 1]?.wk as number } : undefined,
  }
}

/** 用户在纠正上一轮的说法 */
export const CORRECTION = /不对|错了|有误|重做|重来|重新(做|写|改|来)|还是不行|还是不对|没用|不是这样|搞错|又坏了|没修好|没解决|回退|撤销|wrong|doesn'?t work|still (broken|failing)|redo|revert/i


// ---------- 对照实验（按会话分组） ----------

/** 会话 id 的 FNV-1a 哈希，第 0 位定模型切换组，第 1 位定省额度组：同一会话重载后分组不变 */
export function sessionArms(sid: string, exp: Experiment): Pick<SessionTags, 'ra' | 'sv'> {
  let h = 0x811c9dc5
  for (let i = 0; i < sid.length; i++) h = Math.imul(h ^ sid.charCodeAt(i), 0x01000193) >>> 0
  return {
    ra: exp === 'route' || exp === 'both' ? (h & 1 ? 'control' : 'auto') : undefined,
    sv: exp === 'saver' || exp === 'both' ? (h & 2 ? 'off' : 'on') : undefined,
  }
}

export type SessionStats = {
  sid: string
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
  guards: number
  agains: number
  /** 会话内 7 天额度百分比涨了多少（额度窗口重置的回落不算） */
  wk: number
}

export type CellStats = {
  sessions: number
  turns: number
  usd: number
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
  subShare: number
  /** 花费里 fork 分类的估算占比 */
  forkShare: number
}

export type Effect = {
  factor: 'route' | 'saver'
  /** 实验组（auto / on）和对照组（control / off） */
  on: CellStats
  off: CellStats
  /** 每轮花费的相对变化，负数是省 */
  change: number
  /** 两组各有 MIN_SESSIONS 个会话，且差值超过两倍合并标准误 */
  sure: boolean
}

export type ExperimentReport = {
  sessions: SessionStats[]
  /** 分格，键是 "auto|on" 这样；只测一维时另一维写 "-" */
  cells: Record<string, CellStats>
  effects: Effect[]
}

export const MIN_SESSIONS = 8
const LONG_CTX = 300_000

export function sessionStats(records: LogRecord[]): SessionStats[] {
  type Acc = SessionStats & { ctxSum: number; ctxN: number; wkLast?: number; lastModel?: string }
  const by = new Map<string, Acc>()
  const price = unitPrices(records.filter((r): r is TurnRecord => r.t === 'turn'))
  for (const r of [...records].sort((a, b) => a.ts - b.ts)) {
    if (r.t === 'pi' || !r.ex || !r.sid) continue
    let s = by.get(r.sid)
    if (!s) {
      s = { sid: r.sid, ra: r.ra, sv: r.sv, turns: 0, usd: 0, subUsd: 0, forkUsd: 0, ctxAvg: 0, ctxMax: 0, ctxSum: 0, ctxN: 0, fixes: 0, guards: 0, agains: 0, wk: 0 }
      by.set(r.sid, s)
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
    const fk = forkUsd(r.fu, s.lastModel ?? r.model, price)
    s.forkUsd += Math.min(fk, r.usd ?? fk)
    s.lastModel = r.model
    if (r.fix) s.fixes++
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
  return [...by.values()]
    .filter(s => s.turns > 0)
    .map(({ ctxSum, ctxN, wkLast: _w, lastModel: _m, ...s }) => ({ ...s, ctxAvg: ctxN ? ctxSum / ctxN : 0 }))
}

export function cellStats(list: SessionStats[]): CellStats {
  const n = list.length
  const sum = (f: (s: SessionStats) => number) => list.reduce((a, s) => a + f(s), 0)
  const turns = sum(s => s.turns)
  const usd = sum(s => s.usd)
  const per = list.map(s => s.usd / s.turns)
  const mean = n ? per.reduce((a, b) => a + b, 0) / n : 0
  const sd = n > 1 ? Math.sqrt(per.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0
  const guards = sum(s => s.guards)
  return {
    sessions: n,
    turns,
    usd,
    perTurn: mean,
    perTurnSe: n > 1 ? sd / Math.sqrt(n) : 0,
    turnsPerSession: n ? turns / n : 0,
    ctxAvg: n ? sum(s => s.ctxAvg) / n : 0,
    longShare: n ? list.filter(s => s.ctxMax >= LONG_CTX).length / n : 0,
    fixRate: turns ? sum(s => s.fixes) / turns : 0,
    guards,
    againRate: guards ? sum(s => s.agains) / guards : 0,
    wkPerSession: n ? sum(s => s.wk) / n : 0,
    subShare: usd ? sum(s => s.subUsd) / usd : 0,
    forkShare: usd ? sum(s => s.forkUsd) / usd : 0,
  }
}

export function experimentReport(records: LogRecord[], from: number): ExperimentReport {
  const sessions = sessionStats(records.filter(r => r.ts >= from))
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
    const se = Math.sqrt(on.perTurnSe ** 2 + off.perTurnSe ** 2)
    effects.push({
      factor,
      on,
      off,
      change: off.perTurn ? (on.perTurn - off.perTurn) / off.perTurn : 0,
      sure: on.sessions >= MIN_SESSIONS && off.sessions >= MIN_SESSIONS && se > 0 && Math.abs(on.perTurn - off.perTurn) > 2 * se,
    })
  }
  return { sessions, cells, effects }
}

export function verdict(e: Effect): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`
  if (e.on.sessions < MIN_SESSIONS || e.off.sessions < MIN_SESSIONS) return `样本还不够（每组至少 ${MIN_SESSIONS} 个会话）`
  if (!e.sure) return '差异在误差范围内，还说不准'
  return e.change < 0 ? `确实省了 ${pct(-e.change)}` : `反而多花 ${pct(e.change)}`
}

/** 文字版报告：/auto-router eval 输出，面板「效果」页也显示同样的数 */
export function reportText(rep: ExperimentReport, days: number): string {
  const money = (n: number) => (n < 0.001 ? '<$0.001' : `$${n.toFixed(n < 1 ? 3 : 2)}`)
  const pct = (x: number) => `${Math.round(x * 100)}%`
  const k = (n: number) => `${Math.round(n / 1000)}k`
  if (!rep.sessions.length) return `最近 ${days} 天还没有实验会话。先在 /auto-router 打开“对照实验”，之后新开的会话会自动分组。`
  const NAME: Record<Effect['factor'], [string, string, string]> = {
    route: ['模型切换', '切换', '不切换'],
    saver: ['省额度', '开', '关'],
  }
  const lines = [`对照实验（最近 ${days} 天，${rep.sessions.length} 个会话）`, '']
  for (const e of rep.effects) {
    const [title, a, b] = NAME[e.factor]
    lines.push(
      `【${title}】${verdict(e)}`,
      `  会话数     ${a} ${e.on.sessions}，${b} ${e.off.sessions}`,
      `  每轮花费   ${a} ${money(e.on.perTurn)}±${money(e.on.perTurnSe)}，${b} ${money(e.off.perTurn)}±${money(e.off.perTurnSe)}`,
      `  每会话     ${a} ${e.on.turnsPerSession.toFixed(1)} 轮 ${money(e.on.usd / e.on.sessions)}，${b} ${e.off.turnsPerSession.toFixed(1)} 轮 ${money(e.off.usd / e.off.sessions)}`,
      `  上下文     平均 ${k(e.on.ctxAvg)} / ${k(e.off.ctxAvg)}；到过 30 万的会话 ${pct(e.on.longShare)} / ${pct(e.off.longShare)}`,
      `  7 天额度   每会话涨 ${e.on.wkPerSession.toFixed(1)} / ${e.off.wkPerSession.toFixed(1)} 个百分点`,
      `  质量       纠正率 ${pct(e.on.fixRate)} / ${pct(e.off.fixRate)}`,
    )
    if (e.factor === 'route') lines.push(`  分类花费   fork 分类约占切换组花费的 ${pct(e.on.forkShare)}（已含在每轮花费里）`)
    if (e.factor === 'saver')
      lines.push(`  拦截       ${e.on.guards} 次，其中 ${pct(e.on.againRate)} 被原样再请求（可能是误拦）；子代理花费占 ${pct(e.on.subShare)} / ${pct(e.off.subShare)}`)
    lines.push('')
  }
  const keys = Object.keys(rep.cells).sort()
  if (keys.length > 1) {
    lines.push('分格（切换|省额度）：')
    for (const key of keys) {
      const c = rep.cells[key] as CellStats
      lines.push(`  ${key.padEnd(13)} ${c.sessions} 会话  每轮 ${money(c.perTurn)}  纠正 ${pct(c.fixRate)}  上下文 ${k(c.ctxAvg)}`)
    }
    lines.push('')
  }
  lines.push('花费是按 API 价折算的美元，订阅不按它扣额度，但组间比例可以参考；两组做的活不一样时，差异也可能来自任务本身。')
  return lines.join('\n')
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
