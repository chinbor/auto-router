import { DEFAULT_CONFIG } from './config'
import type { Config } from './config'

// 本地规则分类：只看字面关键词，不发请求、不花钱、不用等。
// 冷点上小模型分类被限流或超时时兜底；冷点之间每轮都跑，用来判断要不要当场升档、要不要提示外派。
// 只在有把握时给类别，判断不了返回 undefined，调用方保持原模型。
// 规则按默认类别的 label 对应；用户改过类别 label 的，那一类就没有规则。
// 冷点上小模型分类成功时也跑一遍，日志记下规则判的类别（rc），报告里看两边一致率，决定还信不信规则。
// 用历史消息调过：能判出约四成，判出的和小模型分类选同一个模型的约 85%。

const label = (i: number) => DEFAULT_CONFIG.claude.categories[i]?.label as string
/** 命中就停下、判不出：压缩后续接的那条长消息，内容是摘要，看不出这一轮要做什么 */
const STOP = ''

/**
 * 按顺序取第一条命中的：问看法、评审、设计这类更重的排在前面，免得“修复 bug 的方案”被当成编码。
 * 第三项 strong：说法明确、误判少，冷点之间可以凭它当场升档；其余只用来提示外派、在冷点上兜底
 * （“你觉得好就行”这类口头语会撞上问看法那条，凭它升档会白花一次缓存重写）
 */
const RULES: [string, RegExp, boolean?][] = [
  [STOP, /^This session is being continued/],
  [label(0), /天气|星期几|几号|几点|你(用|使用)?的?(是)?什么模型|你是谁/],
  [label(4), /你觉得|有必要|为啥|怎么看|值不值|该不该|哪个更好|有啥(其他|别的)?(办法|方法)/],
  [label(0), /^(你好|您好|hi|hello|hey|嗨|谢谢|多谢|thanks|thank you|ok|okay|好的?|嗯+|收到|在吗)[\s!！。.~？?]*$/i],
  [label(5), /评审|审查|审阅|code ?review|\breview\b|根因|root cause|排查|为什么.{0,20}(报错|失败|不行|不对|没反应|卡住|没生效)|查.{0,4}原因/i, true],
  [label(4), /架构|设计.{0,6}(方案|系统|接口|模块)|怎么设计|技术方案|权衡|取舍|architecture|\bdesign\b|trade-?off/i, true],
  [label(6), /批量|所有文件|全部文件|每个文件|迁移|migrat|across (all|every|many) files/i],
  [label(7), /通读|读完|整个(仓库|项目|代码库)|大量(日志|文档|代码)|梳理.{0,6}(代码|项目|仓库)/i],
  [label(1), /翻译|润色|校对|改写|总结一下|写摘要|translate|proofread|summari[sz]e|rewrite/i],
  [label(3), /实现|写一个|新增|加(一个|个)?.{0,8}(功能|接口|按钮|页面|字段|参数|选项)|重构|修复|修一下|\bbug\b|报错|\bfix\b|implement|refactor|feature/i],
  [label(2), /^(提交|推送|提交并推送|commit|push|继续|重试|试试|再试|启用|更新)[\s\S]{0,12}$|移动到|删除|删掉/i],
  [label(2), /改一下|改成|改为|换成|查一下|找一下|在哪|运行|跑一下|执行一下|rename/i],
]

/** 规则判出的类别 label 和说法是否明确；没把握或那一类被用户改掉了时返回 undefined */
export function ruleHit(cats: Config['claude']['categories'], text: string): { label: string; strong: boolean } | undefined {
  const t = text.trim().slice(0, 500)
  if (!t) return undefined
  for (const [want, re, strong] of RULES) {
    if (!re.test(t)) continue
    if (want === STOP) return undefined
    if (cats.some(c => c.label === want)) return { label: want, strong: strong === true }
  }
  return undefined
}

export function ruleLabel(cats: Config['claude']['categories'], text: string): string | undefined {
  return ruleHit(cats, text)?.label
}
