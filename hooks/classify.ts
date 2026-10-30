import type { EngineInterface } from 'claude-code'

import type { ClassifyFailure, RouterDecision } from '../types'
import { sticky } from './config'
import type { Config } from './config'
import { CORRECTION } from './stats'

// 分类：每次提交问题时判断请求类型，决定本轮用 haiku / sonnet / opus。
// 先用 $.model.classify（小模型，便宜）；它被限流或超时就改用 $.model.fork（沿用主对话的请求和缓存）。

const CLASSIFY_TIMEOUT_MS = 4000
const FORK_TIMEOUT_MS = 10_000
/** 分类没得到类别时，日志里的类别名：超时、请求出错、模型的回答不在类别里 */
export const FAILURE_NAMES: Record<ClassifyFailure, string> = { timeout: '超时', error: '分类出错', none: '未命中', skip: '跳过（换不了模型）' }

export const RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 }
export const BY_RANK = ['haiku', 'sonnet', 'opus']

type Outcome = {
  label?: string
  cf?: ClassifyFailure
  cerr?: string
  /** 用哪条路分出来的 */
  via?: 'classify' | 'fork'
  /** fork 这次的 token 用量：输入、缓存读、缓存写、输出 */
  fu?: [number, number, number, number]
}

/** 插件自己发的模型请求（classify / complete）在额度紧时会被 429 限流或拖到超时，碰到一次后这段时间直接走 fork */
const CLASSIFY_COOLDOWN_MS = 30 * 60_000
let classifyBlockedUntil = 0

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
async function classifyRequest($: EngineInterface, cats: Config['claude']['categories'], text: string, allowFork: boolean): Promise<Outcome> {
  let first: Outcome | undefined
  if (Date.now() >= classifyBlockedUntil) {
    const prompt = 'A developer sent this message to a coding agent. Classify what kind of request it is.\n\n' + text.slice(0, 4000)
    const asked = $.model
      .classify(prompt, cats.map(c => c.label))
      .then((label): Outcome => (label === undefined ? { cf: 'none', via: 'classify' } : { label, via: 'classify' }))
      .catch(failed)
    first = await withTimeout($, asked, CLASSIFY_TIMEOUT_MS)
    if (first.label) return first
    // 限流和超时都会持续一阵，冷却期内直接走 fork，免得每条消息都先白等 4 秒
    if (first.cf === 'timeout' || (first.cf === 'error' && /\b429\b|rate_limit/.test(first.cerr ?? ''))) {
      classifyBlockedUntil = Date.now() + CLASSIFY_COOLDOWN_MS
    }
  }
  // fork 每次要按 0.1 倍价读一遍主对话的缓存，上下文越长越贵；结果改变不了模型时不 fork
  if (!allowFork) return first ?? { cf: 'skip' }
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

export async function decide($: EngineInterface, cfg: Config, text: string, prev: RouterDecision | null): Promise<RouterDecision> {
  const cats = cfg.claude.categories
  const started = Date.now()
  const current = prev?.model
  const keep = cfg.claude.keepAboveTokens
  // 已在最高档且上下文长到不降档：分出什么类都还是这个模型
  const ctx = current === BY_RANK[2] && keep > 0 ? ((await $.session.usage().catch(() => undefined))?.context.tokens ?? 0) : 0
  const out = await classifyRequest($, cats, text, !(keep > 0 && ctx > keep))
  const hit = cats.find(c => c.label === out.label)
  const fix = CORRECTION.test(text.slice(0, 500))
  const base = {
    label: hit?.name ?? FAILURE_NAMES[out.cf ?? 'none'],
    wanted: hit?.model,
    piRole: hit?.piRole,
    fix,
    cf: out.cf,
    cerr: out.cerr,
    cms: Date.now() - started,
    via: out.via,
    fu: out.fu,
  }
  const next: RouterDecision = { ...base, ...sticky(prev, hit?.model, cfg.claude.downgradeAfter) }

  // 质量防护一：用户在纠正上一轮，说明当前模型可能不够，升一档
  if (fix && cfg.claude.upgradeOnCorrection && current) {
    const up = BY_RANK[Math.min(2, (RANK[current] ?? 2) + 1)] as string
    if ((RANK[up] ?? 0) > (RANK[next.model ?? ''] ?? -1)) return { ...next, model: up, lighterStreak: 0, why: '你在纠正上一轮，升一档' }
  }
  // 质量防护二：上下文很长时不降档，换模型要把整段上下文重写进缓存，省下的可能还不够补
  if (current && next.model && (RANK[next.model] ?? 0) < (RANK[current] ?? 0) && cfg.claude.keepAboveTokens > 0) {
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
