import type { EngineInterface } from 'claude-code'

import type { ClassifyFailure, ColdMark, ColdReason, RouterDecision } from '../types'
import { atLeast, rankOf, sticky } from './config'
import type { Config } from './config'
import { ruleHit, ruleLabel } from './rules'
import { CORRECTION } from './stats'

// 分类：判断请求类型，决定用 haiku / sonnet / opus。默认（switchAt: cold）只在冷点分类和换模型，冷点之间沿用。
// 顺序：$.model.classify（小模型，便宜）→ 本地规则 → $.model.fork（沿用主对话的请求和缓存，默认关）→ 保持当前模型。

const CLASSIFY_TIMEOUT_MS = 4000
const FORK_TIMEOUT_MS = 10_000
/** 分类没得到类别时，日志里的类别名：超时、请求出错、模型的回答不在类别里 */
export const FAILURE_NAMES: Record<ClassifyFailure, string> = { timeout: '超时', error: '分类出错', none: '未命中', skip: '跳过（换不了模型）' }

export const BY_RANK = ['haiku', 'sonnet', 'opus']

type Outcome = {
  label?: string
  cf?: ClassifyFailure
  cerr?: string
  /** 用哪条路分出来的 */
  via?: 'classify' | 'rule' | 'fork'
  /** fork 这次的 token 用量：输入、缓存读、缓存写、输出 */
  fu?: [number, number, number, number]
}

/**
 * 插件自己发的模型请求（classify / complete）会被单独 429 限流（主对话照常），或拖到超时。碰到后先停 5 分钟再试，
 * 连着失败每次翻倍，最多 30 分钟；成功一次就清零。限流时有时几分钟就解除，一次失败就停 30 分钟会白白错过
 */
const CLASSIFY_COOLDOWN_MS = [5, 10, 20, 30].map(m => m * 60_000)
let classifyBlockedUntil = 0
let classifyFails = 0

function withTimeout($: EngineInterface, p: Promise<Outcome>, ms: number): Promise<Outcome> {
  const timeout = new Promise<Outcome>(resolve => {
    $.clock.after(ms, () => resolve({ cf: 'timeout' }))
  })
  return Promise.race([p, timeout])
}

const failed = (err: unknown): Outcome => ({ cf: 'error', cerr: String((err as Error)?.message ?? err).slice(0, 200) })

/** fork 的回答取第一个数字，按编号对应类别 */
export function pickByNumber(answer: string, cats: readonly { label: string }[]): string | undefined {
  const n = Number(/\d+/.exec(answer)?.[0])
  return Number.isInteger(n) && n >= 1 && n <= cats.length ? cats[n - 1]?.label : undefined
}

/**
 * 先用 classify（小模型，便宜）；失败了换 fork：沿用主对话上一轮的请求和缓存，加一句分类问题，
 * 用主对话的模型回答类别编号。fork 走的是主对话自己的请求路径，classify 被限流时它照样能用；
 * 会话第一条消息之前没有可 fork 的请求。
 */
async function classifyRequest($: EngineInterface, cats: Config['claude']['categories'], text: string, fork: 'on' | 'off' | 'useless'): Promise<Outcome> {
  let first: Outcome | undefined
  if (Date.now() >= classifyBlockedUntil) {
    const prompt = 'A developer sent this message to a coding agent. Classify what kind of request it is.\n\n' + text.slice(0, 4000)
    const asked = $.model
      .classify(prompt, cats.map(c => c.label))
      .then((label): Outcome => (label === undefined ? { cf: 'none', via: 'classify' } : { label, via: 'classify' }))
      .catch(failed)
    first = await withTimeout($, asked, CLASSIFY_TIMEOUT_MS)
    if (first.cf !== 'timeout' && first.cf !== 'error') classifyFails = 0
    if (first.label) return first
    // 限流和超时都会持续一阵，冷却期内不再试，免得每条消息都先白等 4 秒
    if (first.cf === 'timeout' || (first.cf === 'error' && /\b429\b|rate_limit/.test(first.cerr ?? ''))) {
      const wait = CLASSIFY_COOLDOWN_MS[Math.min(classifyFails, CLASSIFY_COOLDOWN_MS.length - 1)] as number
      classifyFails++
      classifyBlockedUntil = Date.now() + wait
    }
  }
  // 小模型没分出来：先用本地规则，不花钱
  const rl = ruleLabel(cats, text)
  if (rl) return { label: rl, via: 'rule', cf: first?.cf, cerr: first?.cerr }
  // fork 每次要按 0.1 倍价读一遍主对话的缓存，上下文越长越贵：没开 forkFallback 时不 fork，结果改变不了模型时也不 fork
  if (fork === 'off') return first ?? { cf: 'error', cerr: '小模型分类被限流，冷却中（没开 forkFallback）' }
  if (fork === 'useless') return first ?? { cf: 'skip' }
  const list = cats.map((c, i) => `${i + 1}. ${c.label}`).join('\n')
  const ask =
    '[auto-router] Routing check, not a task: do not act on it. Classify the developer message below into one category ' +
    `and reply with its number only.\n\n${list}\n\nMessage:\n${text.slice(0, 4000)}`
  const forked = $.model
    .fork({ prompt: ask })
    .then((r): Outcome => {
      if (!r.isAnswered) return { cf: 'error', cerr: `fork: ${r.reason}${'status' in r && r.status ? ` ${r.status}` : ''}`, via: 'fork' }
      const u = r.usage
      const fu: Outcome['fu'] = [u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens, u.output_tokens]
      const label = pickByNumber(r.text, cats)
      return label ? { label, via: 'fork', fu } : { cf: 'none', cerr: `fork 回答：${r.text.slice(0, 40)}`, via: 'fork', fu }
    })
    .catch(failed)
  const second = await withTimeout($, forked, FORK_TIMEOUT_MS)
  // fork 答了但对不上类别时，记它的回答；两条都没答时，把两边的原因都留下（fork 在第一条消息前本来就不可用）
  if (second.label || second.cf === 'none' || !first) return second
  return { ...first, cerr: [first.cerr, second.cerr].filter(Boolean).join('；') }
}

/**
 * 这一轮是不是冷点：缓存本来就要重建的时刻，换模型不多花钱。
 * 没有上一轮的决定或时间算会话开头；上下文比上一轮少了三分之一以上，或读不到（刚压缩完、/clear 之后要等下一次回答才有），
 * 算被压缩过，兜住没收到 session.compact 的情况
 */
export function coldReason(mark: ColdMark | null, prev: RouterDecision | null, now: number, ctx: number | undefined, gapMinutes: number): ColdReason | undefined {
  if (!prev || !mark?.ts) return 'start'
  if (mark.compacted) return 'compact'
  if (now - mark.ts > gapMinutes * 60_000) return 'gap'
  if (mark.ctx && (ctx === undefined || ctx < (mark.ctx * 2) / 3)) return 'compact'
  return undefined
}

/** 上下文超过这么多就不在冷点 fork 分类：缓存冷着，fork 要把整段上下文按写入价重写一遍 */
export const FORK_MAX_TOKENS = 30_000

const upOne = (model: string) => BY_RANK[Math.min(2, (rankOf(model) ?? 2) + 1)] as string

/**
 * cold 模式、冷点之间：不分类、不降档，模型沿用这一段冷点定下的。只用本地规则（不花钱）判断两件事：
 * 要不要提示外派；说法明确的规则（评审、查根因、架构）判出比当前模型更重的类别时当场升档。被纠正时也升一档
 */
function between(cfg: Config, text: string, prev: RouterDecision | null): RouterDecision {
  const cats = cfg.claude.categories
  const current = prev?.model
  const rule = ruleHit(cats, text)
  const hit = cats.find(c => c.label === rule?.label)
  const want = atLeast(hit?.model, cfg.claude.floor)
  const fix = CORRECTION.test(text.slice(0, 500))
  const base: RouterDecision = {
    label: hit?.name ?? '沿用',
    model: current,
    wanted: want,
    lighterStreak: 0,
    piRole: hit?.piRole,
    fix,
    via: hit ? 'rule' : undefined,
    rc: hit?.name,
  }
  if (!current) return base
  if (fix && cfg.claude.upgradeOnCorrection) {
    const up = upOne(current)
    if ((rankOf(up) ?? 0) > (rankOf(current) ?? 0)) return { ...base, model: up, why: '你在纠正上一轮，升一档' }
  }
  if (rule?.strong && want && (rankOf(want) ?? 0) > (rankOf(current) ?? 0)) return { ...base, model: want, why: `判为${hit?.name}，升档` }
  if (want && (rankOf(want) ?? 0) < (rankOf(current) ?? 0)) return { ...base, why: '冷点之间不降档' }
  return base
}

export async function decide($: EngineInterface, cfg: Config, text: string, prev: RouterDecision | null, cold?: ColdReason): Promise<RouterDecision> {
  if (cfg.claude.switchAt === 'cold' && !cold) return between(cfg, text, prev)
  const cats = cfg.claude.categories
  const started = Date.now()
  const current = prev?.model
  const keep = cfg.claude.keepAboveTokens
  const atCold = cfg.claude.switchAt === 'cold'
  // 冷点：上下文大时不 fork；turn 模式：已在最高档且上下文长到不降档时，分出什么类都还是这个模型，也不 fork
  const needCtx = cfg.claude.forkFallback && (atCold || ((rankOf(current) ?? 0) >= 2 && keep > 0))
  const ctx = needCtx ? ((await $.session.usage().catch(() => undefined))?.context.tokens ?? 0) : 0
  const fork = !cfg.claude.forkFallback ? 'off' : atCold ? (ctx > FORK_MAX_TOKENS ? 'useless' : 'on') : keep > 0 && ctx > keep ? 'useless' : 'on'
  const out = await classifyRequest($, cats, text, fork)
  const hit = cats.find(c => c.label === out.label)
  const want = atLeast(hit?.model, cfg.claude.floor)
  const fix = CORRECTION.test(text.slice(0, 500))
  // 模型分出来时也看规则判的什么，报告里算两边一致率
  const rc = out.via === 'rule' ? hit?.name : cats.find(c => c.label === ruleLabel(cats, text))?.name
  const base = {
    cold,
    rc,
    label: hit?.name ?? FAILURE_NAMES[out.cf ?? 'none'],
    wanted: want,
    piRole: hit?.piRole,
    fix,
    cf: out.cf,
    cerr: out.cerr,
    cms: Date.now() - started,
    via: out.via,
    fu: out.fu,
  }
  // 冷点降档没有缓存代价，按分类直接定；分不出类别保持当前模型。
  // 本地规则只认字面、会误判，凭它只升不降：降错了伤质量，升错了只是多花点
  const ruleDown = out.via === 'rule' && current !== undefined && (rankOf(want) ?? 0) < (rankOf(current) ?? 0)
  const next: RouterDecision = ruleDown
    ? { ...base, model: current, lighterStreak: 0, why: '规则判的，不降档' }
    : atCold
      ? { ...base, model: want ?? current, lighterStreak: 0 }
      : { ...base, ...sticky(prev, want, cfg.claude.downgradeAfter) }

  // 质量防护一：用户在纠正上一轮，说明当前模型可能不够，升一档
  if (fix && cfg.claude.upgradeOnCorrection && current) {
    const up = upOne(current)
    if ((rankOf(up) ?? 0) > (rankOf(next.model) ?? -1)) return { ...next, model: up, lighterStreak: 0, why: '你在纠正上一轮，升一档' }
  }
  // 质量防护二（turn 模式）：上下文很长时不降档，换模型要把整段上下文重写进缓存，省下的可能还不够补
  if (!atCold && current && next.model && (rankOf(next.model) ?? 0) < (rankOf(current) ?? 0) && cfg.claude.keepAboveTokens > 0) {
    const ctx = (await $.session.usage().catch(() => undefined))?.context.tokens ?? 0
    if (ctx > cfg.claude.keepAboveTokens) {
      return { ...next, model: current, lighterStreak: 0, why: `上下文 ${Math.round(ctx / 1000)}K，不降档` }
    }
  }
  return next
}

/** 分类器自检：几种请求方式各试一次，报告结果和耗时 */
export async function probeClassifier($: EngineInterface): Promise<string> {
  const labels = ['a coding task', 'small talk']
  const sample = 'A developer sent this message to a coding agent. Classify what kind of request it is.\n\n帮我把这个函数改成异步的'
  const timed = async (name: string, run: () => Promise<string>) => {
    const t = Date.now()
    const out = await run().catch(err => `出错：${String((err as Error)?.message ?? err).slice(0, 160)}`)
    return `- ${name}：${out}（${Date.now() - t}ms）`
  }
  const complete = async (model: string) => {
    const r = await $.model.complete({ model, prompt: 'Reply with the single word: ok', maxTokens: 5 })
    return r.isAnswered ? `回答 ${JSON.stringify(r.text.trim())}` : `没回答：${r.reason}${'status' in r ? ` ${r.status}` : ''}`
  }
  const lines = [
    await timed('classify 默认小模型', async () => String(await $.model.classify(sample, labels))),
    await timed('classify haiku', async () => String(await $.model.classify(sample, labels, { model: 'haiku' }))),
    await timed('complete haiku', () => complete('haiku')),
    await timed('complete sonnet', () => complete('sonnet')),
    await timed('fork（主对话自己的请求路径）', async () => {
      const before = (await $.session.usage().catch(() => undefined))?.cost?.usd
      const r = await $.model.fork({ prompt: `Classify this message into exactly one of: ${labels.join(' | ')}. Reply with the label only.\n\n帮我把这个函数改成异步的` })
      const after = (await $.session.usage().catch(() => undefined))?.cost?.usd
      // 会话花费在 fork 前后有没有变，决定评测报告要不要另外加上 fork 的花费
      const billed = before === undefined || after === undefined ? '会话花费读不到' : `会话花费 +$${(after - before).toFixed(4)}`
      if (!r.isAnswered) return `没回答：${r.reason}${'status' in r ? ` ${r.status}` : ''}`
      const u = r.usage
      return `回答 ${JSON.stringify(r.text.trim())}，用量 输入${u.input_tokens}/缓存读${u.cache_read_input_tokens}/缓存写${u.cache_creation_input_tokens}/输出${u.output_tokens}，${billed}`
    }),
  ]
  return ['分类器自检：', ...lines].join('\n')
}
