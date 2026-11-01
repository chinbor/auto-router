# 架构与工作原理

auto-router 是一个 Claude Code mod（插件里的 `hooks/register.tsx` 模块），在引擎的事件上挂钩子，做四件事：

1. **模型切换**：每条消息先分类，按类别把本轮主对话换成 haiku / sonnet / opus。
2. **pi 外派**：注册 `pi_dispatch` 工具，Claude 把写得清楚的执行活交给 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)，在非 Claude 模型上跑。
3. **省额度**：拦下会把大量内容灌进上下文的调用，上下文过大时提醒交接，把省额度规则写进系统提示，带上 scout / executor 子代理。
4. **对照实验**：按会话随机分组，衡量前三件事到底省了多少、质量有没有下降。

省钱有两条路：**省 token**（上下文更短、读得更少）和**省额度**（同样的活换便宜的模型，或交给不占 Claude 额度的 pi）。下面按模块说明。

## 模块结构

```
hooks/
  register.tsx   入口：把各模块接到引擎事件上；pi 任务的派发、排队、熔断；斜杠命令和工具
  classify.ts    分类（classify → fork 兜底）、降档粘性、质量防护、分类器自检
  saver.ts       省额度的纯函数：拦截规则、图片尺寸、提醒文案、系统提示规则
  stats.ts       日志格式、效果汇总、对照实验分组与报告、外派返工统计（纯函数）
  report.ts      效果报告：/auto-router eval 和 router_config report 的文字、报告文件、周报提示词、doctor 自检
  config.ts      配置的默认值、读写、校验、pi 模型链排序、高峰时段
  core.ts        共用运行时：配置读写、会话分组、日志读写、pi 工具注册
  panel.tsx      /auto-router 设置面板（四页）
agents/          scout（只读调研）、executor（按清单执行）子代理
skills/delegate  交活前的判断表和任务清单模板
scripts/         img_check.py：图片预览、联系表、局部裁剪
types/           插件状态和决策记录的类型
tests/           集成测试（用 claude-code/testing 的引擎替身）
```

## 一条消息经过哪些钩子

```mermaid
sequenceDiagram
    participant U as 用户
    participant E as 引擎
    participant R as auto-router
    participant M as 模型
    U->>E: 提交消息
    E->>R: prompt.submit
    R->>R: 省额度提醒（上下文档位、7 天额度）
    R->>M: classify（小模型）
    alt 被限流 / 超时
        R->>M: fork（主对话请求路径，回答类别编号）
    end
    R->>R: 降档粘性、质量防护 → 本轮模型
    R-->>E: 附加外派建议（如适合 pi）
    E->>R: prompt.compose（系统提示加省额度规则）
    loop 每一步
        E->>R: turn.step → 改写 model
        E->>R: tool.call → 拦截大读取
    end
    E->>R: turn.complete → 写一行日志
```

## 1. 模型切换

### 什么时候分类：冷点

默认 `claude.switchAt: cold`。`classify.ts` 的 `coldReason` 判断这一轮是不是冷点，也就是缓存本来就要重建的时刻：

| 冷点 | 判断 |
|---|---|
| `start` 会话开头 | 会话状态里还没有上一轮的决定或时间 |
| `gap` 缓存已过期 | 距上一轮主对话超过 `coldGapMinutes`（默认 60，Claude Code 订阅用 1 小时缓存） |
| `compact` 刚压缩 | 收到主对话的 `session.compact`（不算 `precompute`）；或者上下文比上一轮少了三分之一以上、读不到（兜住 /clear 和没收到事件的情况） |

上一轮的时间和上下文记在会话状态 `cold` 里，重载插件后不会被误当成会话开头。

- **冷点**：走下面的分类链，按分类结果直接定模型，不用等连续几轮；不应用 `keepAboveTokens`，因为缓存反正要重写。
- **冷点之间**（`between`）：不分类，模型沿用。只跑本地规则（不花钱），规则用明确的说法（`rules.ts` 里标了 strong 的：评审 / 查根因、架构 / 设计）判出更重的类别时当场升档（状态栏“⬆ 判为…，升档”），被纠正时升一档；判出更轻的类别也不降（“🔒 冷点之间不降档”）。“你觉得……”这类口头语也会撞上难题那条，只用来提示外派，不凭它升档。
- **最低档**（`claude.floor`，默认 `sonnet`）：分类结果低于它时按它算（`config.ts` 的 `atLeast`），闲聊也用 Sonnet。闲聊约占 1% 的花费，降到 Haiku 再升回来每次都要重写缓存。
- **规则只升不降**：冷点上小模型失败、靠规则判出的类别比当前模型轻时保持当前模型（“规则判的，不降档”）。规则判错往低处走伤质量，往高处走只多花一点。

为什么这样做：全部日志（37 个会话、255 轮）里，缓存读取是写入的 40 倍，真正换模型的只有 12 轮，但每轮都在分类，上周 fork 分类和换模型后重写缓存加起来比换小模型省下的还多。冷点约占 24% 的轮次、一半以上的缓存写入，在这些时刻换模型不多花钱。

再往后看（263 轮，按官方价约 $175）：61% 的轮次小模型没分出类别；全用 Opus 约 $185、全用 Sonnet 约 $134，换模型最多省约 28%，因为 Opus 和 Sonnet 读缓存一个价。花费里读缓存 44%、写缓存 36%、输出 19%，20–40 万 token 上下文的轮次占六成。所以分类只求不出大错，省额度主要靠管住上下文（见下面“省额度”的上下文提醒和隔久提示），报告和面板里的“花费构成”（`stats.ts` 的 `costSplit`）用来盯这一块。

`switchAt: turn` 是旧做法：每条消息都分类，降档要连续 `downgradeAfter` 轮，上下文超过 `keepAboveTokens` 不降档。

### 分类链

`classify.ts` 的 `classifyRequest`：

1. 先用 `$.model.classify`（引擎的小模型，最便宜），超时 4 秒。
2. 失败了用本地规则（`rules.ts` 的 `ruleLabel`）：只看关键词，命中就用，日志记 `via: rule`，`cf` 留着小模型失败的原因（不算分类失败）。规则也判不出时：
3. 改用 `$.model.fork`：沿用主对话上一轮的请求和提示词缓存，追加一句"只回答类别编号"，由主对话的模型回答，超时 10 秒。回答取第一个整数，按编号对应类别（`pickByNumber`）。
4. classify 超时或返回 429 后进冷却（5、10、20、30 分钟逐次加长，成功一次清零），冷却期内跳过它。

小模型分出类别时也跑一遍规则，日志记 `rc`，报告里算规则和小模型的一致率。

第 3 步只在 `claude.forkFallback` 打开时才走，默认关：实测一周的账（自动切换组 83 轮）里，fork 分类花了 $4.85，换小模型只省了 $5.55，再加上换模型重写缓存 $4.60，净亏。关掉后 classify 失败的那几轮就保持当前模型，日志记 `cf: error`。

**为什么需要 fork**：实测 7 天额度用到八成以上时，插件自己发起的模型请求（classify、complete，haiku 和 sonnet 都一样）全部返回 `HTTP 429 rate_limit` 或拖到超时，而主对话自己的请求路径照常可用。早期版本把这种情况一律记成"超时"，看起来像网络问题，其实是限流。

**fork 的代价**：每条消息多一次请求，主要是按 0.1 倍价读一遍缓存里的上下文，输出只有一个数字。上下文 20 万时约等于 2 万 token 的输入。引擎的会话花费已经包含这部分（`router_config probe` 实测 fork 前后会话花费的增量与 fork 用量一致）。

**什么时候不 fork**：冷点模式下上下文超过 3 万（`FORK_MAX_TOKENS`）时不 fork，缓存冷着，fork 要把整段上下文按写入价重写一遍。`turn` 模式下已经在 Opus，且上下文超过 `keepAboveTokens`（此时不降档）时，分出什么类别模型都不会变，就不 fork，日志记 `cf: skip`。classify 能用时照常调用，因为它很便宜，还能给出外派建议。

会话第一条消息之前还没有可 fork 的请求；classify 也不可用时，这一条不切换。

### 降档粘性和质量防护（`turn` 模式）

- 升档立即生效；降档要连续 `downgradeAfter`（默认 4，原来是 2：换得太勤，缓存重写的钱快赶上省下的了）轮都判为更轻才降。一句"好的，继续"不会把正在写代码的会话降到 haiku，也减少换模型带来的缓存失效。
- 用户在纠正上一轮（"不对""重做""还是不行"）时升一档。
- 上下文超过 `keepAboveTokens`（默认 15 万）时不降档：换模型要把整段上下文重写进缓存（Claude Code 用 1 小时缓存，缓存写是输入价的 2 倍），省下的可能还不够补。

### 改写模型

`turn.step` 钩子在每一步把 `model` 换成本轮决定的模型。子代理的请求不改。对照组只记录"本来会选什么"，不改。

## 2. 外派（pi / opencode）

- `pi_dispatch` 工具的说明是根据当前配置生成的，列出每个角色和它依次尝试的模型，每个模型前标 `[pi]` 或 `[opencode]`。配置变了就重新注册。工具名沿用 `pi_dispatch`，不改名，以免已有的提示词和技能失效。
- **通道**：模型名以 `opencode/` 开头的走 `opencode run`，其余走 pi（`channelOf`）。一条链里可以混着两条通道，按顺序试。结果头写成 `[opencode p1a2b3c4] 完成 · opencode/glm-5.3-flash-free`，任务记录、状态行（`🚀 opencode · 文本 · glm-5.3-flash-free 运行中`）和日志（`ch` 字段，旧记录按模型前缀推断）都带通道。
- **模型链**：每个角色按"强 / 中 / 轻"档位排；同一档里按计费 免费 → 订阅 → 按量付费，再按 `pi.strengths`（擅长这个角色的在前，没标的居中，专长别的角色的在后）。跳过关掉的提供商、处在高峰时段的提供商、被熔断暂停的提供商、已下架或隐私开关不允许的免费模型；都用不了时用 `pi.fallback`；兜底也不行才排队到下一个空闲时段。
- **运行时兜底**（`runChain`）：角色链的模型依次试，一个失败换下一个；整条都失败后接着试 `pi.fallback` 里还没试过的。另外三条：
  - 一家超时后，同一任务不再试这家的其他模型；
  - 可写任务失败时如果工作区已经有改动，就停下来，不让下一个模型在半成品上接着改；
  - 指定了模型（`model` 参数）时只试那一个。
- **熔断**：报鉴权或额度类错误（没有 / 无效的 api key、401/403、订阅失效、402、429、quota、usage limit、too many requests、没登录）时，整家暂停 `pauseMinutes` 分钟。pi 只看 stderr，退出码非 0 且 stdout 很短时才连 stdout 一起看，免得模型回答里提到 "rate limit" 也熔断。opencode 的免费模型算一家：任何一个限流，整个 opencode 暂停。opencode 只看 stderr 和 error 事件的消息，不看工具输出，免得读到的文件里碰巧有 "api key" 就熔断。
- **安全**：只读角色强制禁用 edit / write / bash（pi 用 `--exclude-tools edit,write,bash`，opencode 见下）。可写角色要求工作目录是 git 仓库、工作区干净、同一仓库没有别的可写任务在跑；跑完附上 `git diff --stat`，由 Claude 审阅，不自动提交。两条通道一样。
- **隔离用户自己装的东西**：外派出去的模型只该碰工作目录。实测两边默认都会带上用户的全局配置：
  - pi 会加载 `~/.pi/agent` 下的扩展、MCP 和技能。作者机器上只读任务也拿得到 `subagent`、`act_ui`（操控桌面）、`launch_browser`、`web_search` 和知识库 MCP（含能写入的 `add_to_inbox`）。所以每次都加 `--no-mcp --no-extensions --no-skills --no-prompt-templates`，只把 `pi.keepExtensions` 里的扩展（默认只拦危险命令的 `cc-safety-net`）用 `-e` 加回来。项目和全局的 AGENTS.md 照常读。
  - opencode 见下一节。
- **超时能杀干净**：Windows 上 npm 装的 `pi`、`opencode` 是 `.cmd` 外壳。经 `cmd /d /c` 起的话，超时只杀掉 cmd，真正干活的 node / opencode.exe 成了孤儿，管道不关，任务一直挂着（实测：kill 后 opencode.exe 还在、close 事件不来）。所以先 `where xxx.cmd`，从外壳里读出真正的程序（`.exe` 直接起，`.js` 交给外壳旁的 node.exe）直接起（`launcher` / `parseShim`）；读不出来才退回 `cmd /d /c`。每个会话开始时重新找一次。
- Windows 上每次调 pi / opencode 前从注册表读一遍用户级环境变量，Claude 启动后才设置的 key 也能用上。

### opencode 通道

实测 opencode 1.19.5 和 2.2.5（Windows 11）：

- 直接起 `opencode.exe`（不经 cmd，见上）；任务从 stdin 传，不拼进命令行（避免引号和长度问题）。按 `--version` 的大版本拼参数：
  - 1.x：`run -m <模型> --format json --dir <目录> --agent <代理>`；
  - 2.x：`run -m <模型> --format json --agent <代理> --standalone`，目录取进程的工作目录（2.x 去掉了 `--dir`）。2.x 的 `run` 默认连后台常驻服务，我们注入的环境变量（代理配置、隔离的配置目录）到不了那个服务，报 "Agent not found"；`--standalone` 起一个自己的服务，环境变量才生效。
- opencode 会自己升级，2.x 换了包名（`@opencode/cli`），程序路径跟着变。所以每次起之前检查缓存的程序路径还在不在，不在就重新从 `.cmd` 外壳里找；同时设 `OPENCODE_DISABLE_AUTOUPDATE=1`，免得任务中途升级。
- 免费模型有用量上限，**按模型算**：到了以后 error 事件是 `{"type":"provider.free-limit","message":"Free usage limit reached…","status":429,"retryAfterMs":…}`。实测（2026-11-01 晚）glm、deepseek-v4.1、mimo、nemotron-vl 已到上限时，flint、nemotron-lightning 照样能用；`retryAfterMs` 约 12.8 小时。所以撞到 free-limit 只暂停这一个模型（暂停表的键用完整模型名），按 `retryAfterMs` 恢复，不暂停整个 opencode。2.x 的 error 字段是 `type` / `message`，1.x 是 `name` / `data.message`，两种都读。
- `--format json` 每行一个事件：`step_start`、`text`、`tool_use`、`step_finish`、`error`。取最后一步的文字当结果（前面几步多是“我先读一下文件”），最后一步没有文字时取全部文字（`parseOpencodeRun`）。成功退出码 0；模型不存在、限流时退出码 1 并带 `error` 事件。退出码 0 但没有文字也算失败，换下一个模型。
- **只读不能用 `--agent plan`**：`opencode debug agent plan` 显示 plan 只 deny 了 edit，`"*"` 是 allow，bash 还能用，能用 shell 写文件。
- **不带上用户的全局配置**：opencode 默认读 `~/.config/opencode/opencode.json`（作者机器上里面有知识库 MCP，每次 `opencode run` 都会起一个 MCP 进程）、全局 AGENTS.md（含个人规则）、插件，还兼容读 `~/.claude` 下的技能和 CLAUDE.md。这些都会跟着任务发给免费模型。所以每次都：
  - `XDG_CONFIG_HOME` 指到插件自己的 `~/.claude/auto-router/opencode`（空配置；第一次用时 opencode 会在里面装一次依赖，要几十秒，所以打开面板时先跑一次 `opencode models`）；
  - `OPENCODE_DISABLE_CLAUDE_CODE=1`；
  - 用 `OPENCODE_CONFIG_CONTENT` 注入两个代理，权限都是先 `"*": "deny"` 再逐个放开：
    - `auto-router-readonly`：只放开 read、grep、glob、list，读 `*.env` 也 deny；
    - `auto-router-write`：再放开 edit、todowrite 和 bash。bash 明确设成 allow，因为用户配置里 bash 是 `"ask"` 时，`opencode run` 没人点允许，会一直卡着（实测）。第一条是 `"*": "allow"`（opencode 按最后一条匹配的规则算），后面 deny `git commit/push/reset/clean`、递归删除（`rm -r`、`Remove-Item -Recurse`、`rd /s`、`del /s`）和 `Format-Volume`，改动留给 Claude 审阅。
  - 实测：只读代理的模型只看得到 glob、grep、read，没起任何 MCP，说不出全局规则的内容，读 `.env` 被拦；可写代理改文件、跑测试都正常，`git commit` 被拦。
  - 项目目录里的 opencode.json、AGENTS.md 照常生效，那是被派活的项目自己的；项目里配的 MCP 也会起，但 `"*": "deny"` 让模型调不到。
- **下架**：免费模型随时可能下架。打开面板时和每个会话第一次派 opencode 时列一次模型（1.x 用 `opencode models opencode`，约 1.4 秒；2.x 用 `opencode models --standalone` 再挑 `opencode/` 开头的），不在列表里的模型派活时跳过并在结果里写一笔“已下架”；列表取不到（没装 opencode）时不按下架处理。
- **隐私**：依据 [OpenCode Zen 文档](https://opencode.ai/docs/zen) 的隐私说明（2026-11-01 查）：

  | 模型 | 官方说明 | 默认 |
  |---|---|---|
  | glm-5.3-flash-free、deepseek-v4.1-flash-free | 零保留，不拿来训练 | 哪里都能用 |
  | beam-free | 不拿来训练，保留 30 天 | 哪里都能用 |
  | big-pickle、mimo-v2.6-flash-free、flint-40b-free | 免费期间收集的数据可能用来改进模型（flint 保留 30 天） | 只在允许的目录 |
  | nemotron-3.5-super-vl-free、nemotron-3.5-lightning-free | NVIDIA 试用端点：会记录，不要提交个人或机密数据 | 只在允许的目录 |

  会记录的模型列在 `opencode.logged`。`opencode.allowDirs` 默认是 `[]`：会记录的模型哪个目录都不用，零保留的照常用。理由是派出去的任务常带着项目代码、日志和路径，默认不该发给会拿去改进模型的端点；而零保留的模型风险和按量付费的 API 相当，没必要拦。用户可以在「外派模型」页 opencode 一组里一键允许当前目录、全部目录（`["*"]`）或清空。`allowDirs` 有值（且不是 `*`）时说明用户在区分目录，这时长文阅读（longctx，整目录发出去）也只在允许的目录里用 opencode（`privacyBlock`）。
- `OPENCODE_DISABLE_FREE_MODELS=1` 会让 opencode 不列免费模型；这时所有 opencode 模型都按“取不到列表”处理，派活时报错后换下一个。

### 旧配置迁移

0.2.x 的配置文件没有 `opencode` 段。读到这样的文件时（`migrateOpencode`）：

1. 加上 `opencode` 提供商（免费）、opencode 模型的档位（只加用户没写过的键）、`pi.strengths` 和 `opencode` 段；
2. 如果角色和兜底还是 0.2 的默认值，按新档位重排（`buildRoles`）；用户手调过的不动，提示里请用户自己点「按档位重排」；
3. 先把原文件存成 `auto-router.json.bak`，再写回新配置，弹一条提示。

## 3. 省额度

| 手段 | 钩子 | 原理 |
|---|---|---|
| 拦大读取 | `tool.call` | 读大文件（超过 2000 行或 200KB 且没带 offset/limit）、大图（超过 1MB 或长边 1024px）、整页网页、`cat` 大文件、不加过滤的日志命令。第一次拒绝并给出更省的读法，10 分钟内原样再请求就放行，最坏情况等于没装。出错一律放行 |
| 上下文提醒 | `prompt.submit` | 上下文越过 20 万、40 万时各提醒一次：交接后开新会话，或 `/compact`。配置里还是旧默认 30 万 / 60 万的读配置时按新值用 |
| 隔久提示 | `prompt.submit` | 上下文超过 10 万、距上一轮超过 `coldGapMinutes` 时弹一条提示（`gapNotice`）：这一轮要把整段上下文重写进缓存，写明 token 数和大约多少钱，建议开新会话或答完 `/compact` |
| 额度提醒 | `prompt.submit` | 7 天额度用过 `quotaPct` 后，提醒大量阅读优先派给 pi longctx |
| 系统提示规则 | `prompt.compose` | "节省上下文、决策与执行分离"规则写在会话段（`scope: session`），只随配置变化，不影响提示词缓存 |
| 子代理 | `agent.offer` | scout（只读调研，Sonnet）、executor（按清单执行）；省额度关掉时不提供 |

**大量阅读交给谁**（`bigRead: auto`）：

1. 原文不到约 3 万 token：自己读，交给子代理的启动开销反而更大；
2. 要上网、要调 MCP，或材料私密：scout；
3. 超过约 20 万 token，或 7 天额度已过阈值：pi longctx（DeepSeek 1M 上下文，不占 Claude 额度）；
4. 其余：scout。

## 4. 对照实验

见 [experiment.md](experiment.md)。

## 日志

每轮结束、每个 pi 任务、每次拦截各写一行 JSON 到 `<dataDir>/log/<日期>_<会话id前8位>.jsonl`（`dataDir` 没设时是 `~/.claude/auto-router`）。每个会话单独写，多个会话同时开着也不会互相覆盖；`$.fs` 没有追加写入，每条都要整份重写，所以一个文件写满 400 行（`LOG_SEGMENT`）就换 `<日期>_<会话id>-2.jsonl`、`-3`……，写满的那段不再动。插件重载后接着最后一段写；读日志时按文件名补 `sid` 会去掉段号。字段定义见 `hooks/stats.ts` 的 `TurnRecord`、`PiRecord`、`GuardRecord`，常用字段：

| 字段 | 含义 |
|---|---|
| `cat` / `pick` / `model` | 分类、路由选的模型、实际模型 |
| `cf` / `cerr` / `cms` / `via` / `fu` | 分类失败原因、报错、耗时、走的哪条路、fork 的 token 用量 |
| `in` / `cw` / `cr` / `out` / `usd` | 输入、缓存写、缓存读、输出 token，这一轮的花费 |
| `ctx` / `wk` | 本轮开始时的上下文 token 数、7 天额度百分比 |
| `sid` / `ex` / `ra` / `sv` | 会话、实验、切换组、省额度组 |
| `cv` | 配置版本，如 `0.3.1-5f3a9c`：插件版本加上 `claude`、`saver`、`experiment` 三段配置的哈希（`configVersion`）。每条现算，会话中途改了配置，后面的记录就带新版本 |

**换数据目录**：`dataDir` 改了以后，每次会话开始时 `moveLogs` 把默认目录里的日志搬过去：同名文件按行合并去重、按时间排序，读回核对每一行都在了才删旧文件（`$.fs` 没有删除，走 `del` / `rm`）。还开着的旧版本会话之后又写到旧目录的，下次会话开始再搬一次。

**报告文件**：每轮主对话结束后看 `<dataDir>/report/latest.md` 的修改时间，超过一小时就重写 `latest.md` 和 `latest.json`（7 天、28 天两份对照实验，按类别统计，整体汇总，CHANGELOG 最近两个版本的条目标题）。按文件时间判断，多个会话同时开着也只写一次；`/auto-router path` 会立即重写。周报 agent 只读这两个文件（见 [weekly-report.md](weekly-report.md)），插件的做法再怎么改，周报的提示词都不用跟着改。

**外派返工**：派任务时和本会话最近 20 个任务比，同一角色、30 分钟内、上一个已完成、任务文本的词重合度（英文按词、中文按相邻两字，交集 / 并集）≥ 0.5，就把新任务的 `redo` 记成上一个任务用的模型。点名模型的任务（`custom`）不算，那多半是在试模型。`redoStats` 按模型统计完成数和被返工次数；完成 ≥ 5 个、返工率 ≥ 30% 的模型，派活时 `liveChain` 把它排到角色链末尾（不删掉，别的都用不了时照样接），不改配置文件。名单按近 14 天日志 10 分钟重算一次；效果页和报告里能看到返工次数。

**周报和自检**：`report.ts` 写报告文件时顺手把 `docs/weekly-report.md` 复制成 `<dataDir>/report/weekly-report-guide.md`，`/auto-router weekly` 和面板按钮生成的提示词指向这个副本，插件升级换了安装目录也不失效。`/auto-router doctor` 逐项检查配置、数据目录、日志、分类失败率、报告时间、外派模型和实验状态。

## 写 mod 时遇到的引擎约束

后来维护的人容易踩到这些：

- `$` 只能传给本文件声明的函数，或者从别的文件导入的 **function 声明**；传给箭头函数常量或依赖注入进来的函数时，模块会加载失败。
- `read` / `update` 用到的 atom 必须在同一个文件里用 `atom(...)` 声明，所以同一个 atom（plugin 和 key 相同）会在多个文件里各声明一份。
- `prompt.submit` 这类不带匹配条件的事件，每个模块只能注册一个钩子。
- 测试里的引擎替身要让操作失败，应返回 `{ deny }`；直接抛异常不会让操作失败。
