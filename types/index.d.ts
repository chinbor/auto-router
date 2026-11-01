/** 外派出去的一个任务（pi 或 opencode），pane 里一行 */
export type PiJob = {
  id: string
  /** 走哪个通道；旧记录没有，按模型前缀推断（opencode/ 开头是 opencode） */
  channel?: 'pi' | 'opencode'
  /** 配置里的角色名，如 code / bulk / text；手动指定模型时为 custom */
  role: string
  /** 实际跑成功（或最后尝试）的模型 */
  model: string
  /** 任务前 120 字 */
  title: string
  /** waiting：能接的模型都在高峰时段，排队到 runAt 再跑 */
  status: 'waiting' | 'running' | 'done' | 'failed'
  runAt?: number
  startedAt: number
  endedAt?: number
  /** 输出末尾 1500 字 */
  tail: string
  /** 降级过程，如 "agnes/agnes-3.0-flash: No API key" */
  notes: string[]
  /** 禁用了 edit / write / bash */
  readOnly?: boolean
  /** 会写文件的任务跑完后的改动摘要（git status + diff --stat） */
  changes?: string
}

export type SettingsTab = 'claude' | 'pi' | 'stats' | 'jobs'

/** Claude 模型模式：auto 按问题分类，off 不动，其余为固定别名 */
export type ModelMode = 'auto' | 'off' | 'haiku' | 'sonnet' | 'opus'

export type RouterDecision = {
  /** 类别的中文名 */
  label: string
  /** 本轮实际用的 Claude 模型；undefined 为不改 */
  model?: string
  /** 分类想要的模型（降档未达到连续次数时与 model 不同） */
  wanted?: string
  /** 连续判为更轻类别的次数 */
  lighterStreak: number
  /** 建议外派的 pi 角色 */
  piRole?: string
  /** 用户这句像是在纠正上一轮 */
  fix?: boolean
  /** 质量防护改了结果时的说明，如“上下文长，不降档” */
  why?: string
  /** 对照日：只分类不切换，model 是本来会选的 */
  control?: boolean
  /** 分类没得到类别的原因 */
  cf?: ClassifyFailure
  /** 分类请求出错时的报错 */
  cerr?: string
  /** 分类耗时（毫秒） */
  cms?: number
  /** 用哪条路分出来的：classify 小模型，fork 沿用主对话请求 */
  via?: 'classify' | 'fork'
  /** fork 的 token 用量：输入、缓存读、缓存写、输出 */
  fu?: [number, number, number, number]
}

/** timeout 超时；error 请求出错；none 模型的回答不在类别里 */
/** skip：上下文长、已在最高档，分类结果改变不了模型，没去 fork */
export type ClassifyFailure = 'timeout' | 'error' | 'none' | 'skip'

declare module 'claude-code' {
  interface PluginState {
    'auto-router': {
      jobs: Shaped<PiJob[]>
      modelMode: ModelMode
      /** pi 外派建议开关 */
      piAuto: boolean
      last: Shaped<RouterDecision | null>
      /** 设置面板当前的标签页 */
      tab: SettingsTab
      /** Claude 模型页展开了“更多设置” */
      showMore: boolean
      /** 配置文件每保存一次加一，面板读它来重画 */
      configRev: number
      /** `pi --list-models` 里能用的模型，provider/id */
      piModels: Shaped<string[]>
      /** `opencode models opencode` 里此刻还在的免费模型 */
      ocModels: Shaped<string[]>
      /** 因鉴权 / 额度错误被暂停的提供商：暂停到何时、为什么 */
      paused: Shaped<Record<string, { until: number; reason: string }>>
      /** pi 模型页显示全部模型的提供商 */
      setupOpen: string | null
      /** 外派模型页正在确认“按档位重排” */
      rebuildAsk: boolean
      /** 外派模型页展开高级设置 */
      advOpen: boolean
      /** 效果页统计最近几天 */
      statsDays: number
    }
  }
}
