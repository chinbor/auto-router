// 输入框下方那一行状态：图标 + 短句，一眼看出现在用哪个模型、为什么、有什么提醒。
// $.ui.status 只能放纯文字，所以用颜色圆点区分模型档位，用 emoji 区分类别和原因。纯函数，方便测试。

import type { RouterDecision } from '../types'

const MODEL_DOT: Record<string, string> = { haiku: '🟢', sonnet: '🔵', opus: '🟣' }
const MODEL_NAME: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus' }

// 内置类别的图标；用户自己加的类别用 ▫
const CATEGORY_ICON: Record<string, string> = {
  '闲聊/简答': '💬',
  '文本处理': '📝',
  '小改动/查找': '🔍',
  '编码': '💻',
  '难题/设计': '🧠',
  '评审/查根因': '🔬',
  '批量修改': '📦',
  '大量阅读': '📚',
  '其他': '▫',
  '超时': '⚠',
}

const ROLE_NAME: Record<string, string> = {
  review: '评审',
  code: '编码',
  vision: '看图',
  bulk: '批量修改',
  longctx: '长文阅读',
  quick: '杂活',
  text: '文本',
  trivial: '格式整理',
}

const SEP = '  ·  '

/** 模型别名 → "🔵 Sonnet"；不认识的原样显示 */
export function modelTag(model: string): string {
  const key = Object.keys(MODEL_NAME).find(k => model.toLowerCase().includes(k))
  return key ? `${MODEL_DOT[key]} ${MODEL_NAME[key]}` : model
}

/**
 * 主对话每轮的状态行。
 * prevModel：上一轮实际用的模型（用来标出这一轮是升档还是降档）；downgradeAfter：降档要连续几轮。
 */
export function routeStatus(
  d: RouterDecision,
  opts: { prevModel?: string; downgradeAfter: number; showPi: boolean },
): string {
  const parts: string[] = []
  const model = d.model ?? ''
  const rank = (m: string) => ['haiku', 'sonnet', 'opus'].findIndex(k => m.toLowerCase().includes(k))

  if (d.control) {
    return ['🧪 对照日', '不切换', ...(d.model ? [`本来会用 ${modelTag(d.model)}`] : [])].join(SEP)
  }
  if (d.label === '固定') return ['📌 固定', modelTag(model)].join(SEP)

  parts.push(modelTag(model))
  parts.push(`${CATEGORY_ICON[d.label] ?? '▫'} ${d.label}`)

  if (d.why) {
    parts.push(`${d.why.startsWith('你在纠正') ? '⬆' : '🔒'} ${d.why}`)
  } else if (d.wanted && d.wanted !== model) {
    parts.push(`⏳ 想降到 ${modelTag(d.wanted)}（${d.lighterStreak}/${opts.downgradeAfter}）`)
  } else if (opts.prevModel && rank(opts.prevModel) >= 0 && rank(model) >= 0 && rank(opts.prevModel) !== rank(model)) {
    parts.push(rank(model) > rank(opts.prevModel) ? `⬆ 自 ${modelTag(opts.prevModel)}` : `⬇ 自 ${modelTag(opts.prevModel)}`)
  }
  if (opts.showPi && d.piRole) parts.push(`🚀 可派 pi（${ROLE_NAME[d.piRole] ?? d.piRole}）`)
  return parts.join(SEP)
}

/** pi 任务运行时的状态行 */
export function piStatus(role: string, model: string): string {
  return ['🚀 pi', ROLE_NAME[role] ?? role, `${model.split('/').slice(1).join('/') || model} 运行中`].join(SEP)
}
