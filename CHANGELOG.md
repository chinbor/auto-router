# 更新记录

## 0.3.0 — 2026-11-01

### 新增
- **opencode 通道**：`opencode/` 开头的模型走 `opencode run -m <模型> --format json`，其余照旧走 pi。两条通道共用角色链、高峰避让、熔断、只读限制、git 防护和任务记录；工具名仍是 `pi_dispatch`。
- **免费计费档**：提供商计费多了"免费"，同一档里按 免费 → 订阅 → 按量付费 排。`pi.providers.opencode = { enabled, billing: 'free' }`。
- **`pi.strengths`**：标模型擅长的角色，同档同计费时排在前面；`fallback` 标适合兜底的模型。
- **默认角色加入免费模型**：review / code / longctx / bulk / text 加了 GLM-5.3、DeepSeek-v4.1；quick、trivial 由 MiMo、Nemotron Lightning 打头；vision 加 Nemotron VL；兜底加 MiMo、Flint。完整顺序见 README。
- **只读真的只读**：opencode 的 `plan` 代理只禁 edit、不禁 bash，所以改用 `OPENCODE_CONFIG_CONTENT` 注入自己的代理：只读的 `auto-router-readonly` 只放开 read / grep / glob / list，可写的 `auto-router-write` 再放开 edit 和 bash。
- **下架检测**：打开面板和每个会话第一次派 opencode 时读 `opencode models opencode`，不在列表里的模型划掉，派活时跳过并在结果里写明。
- **隐私开关 `opencode.allowDirs`**：按 OpenCode 官方说明，会记录使用或拿数据改进模型的免费模型（`opencode.logged`）默认哪个目录都不用；零保留的照常用。面板可一键允许当前目录、全部目录或清空。有值时长文阅读也只在允许的目录里用 opencode。
- **通道标签**：结果头 `[opencode p…] 完成 · 模型`、状态行 `🚀 opencode · 文本 · 模型 运行中`、任务页、日志 `ch` 字段、效果页按通道计数；工具说明里每个模型前标 `[pi]` / `[opencode]`。
- `scripts/bench_models.py`：用固定任务（总结、修 bug、抽 JSON、评审、看图）给 opencode 免费模型自动打分，只用标准库；结果文件不进 git。

### 修复（实测发现）
- **超时杀不掉**：Windows 上经 `cmd /c` 起 pi / opencode，超时只杀掉 cmd，真正干活的进程成了孤儿，任务一直挂着。改为从 npm 的 `.cmd` 外壳里读出真正的程序直接起，读不出来才退回 cmd。
- **外派带上了用户的全局配置**：pi 会加载扩展（subagent、电脑操控、浏览器、联网）、MCP（含知识库）和技能，只读任务也能借子代理写文件、借 MCP 写知识库；opencode 会读全局 opencode.json 的 MCP、全局 AGENTS.md、插件和 `~/.claude` 下的技能。现在 pi 加 `--no-mcp --no-extensions --no-skills --no-prompt-templates`（`pi.keepExtensions` 里的扩展照样加载，默认 `cc-safety-net`）；opencode 用插件自己的空配置目录，关掉 Claude Code 兼容，注入的代理权限先全部 deny 再逐个放开。
- **opencode 可写任务卡住**：用户配置里 bash 是 `"ask"` 时，`opencode run` 会一直等人点允许。可写代理把 bash 明确设成 allow（第一条 `"*": "allow"`，后面的 deny 规则优先），拦 `git commit` / `push` / `reset` / `clean`、递归删除（`rm -r`、`Remove-Item -Recurse`、`rd /s`、`del /s`）和 `Format-Volume`。
- **opencode 2.x 不兼容**：opencode 会自己升级，2.x 装到 `@opencode/cli` 下，缓存的程序路径失效（"系统找不到指定的路径"）；`--dir` 被去掉；`run` 默认连后台服务，注入的环境变量（代理配置）不生效（"Agent not found"）。现在每次起之前检查缓存的程序还在不在，不在就重新找；按 `--version` 区分大版本，2.x 用 `--standalone`、从工作目录取目录，列模型用 `models --standalone`；加 `OPENCODE_DISABLE_AUTOUPDATE=1`，免得任务中途升级。
- **兜底只在开头生效**：以前只有角色链一开始就全用不了才用 `pi.fallback`；现在角色链的模型都跑失败后也接着试兜底（跳过已试过的），结果里写明“接着试兜底”。
- **熔断误伤**：以前 pi 的 stdout 里碰巧有 "rate limit"、"quota" 也会熔断整家。现在 pi 只在退出码非 0 且输出很短时看 stdout；规则去掉了 `api key` 这类太宽的词，改成"没有 / 无效的 api key"之类的完整说法。
- **超时后换同家模型**：一家超时后，同一任务里不再试这家的其他模型（多半是网络或服务卡住），结果里写“跳过（刚超时）”。
- **可写任务失败后换模型会叠改动**：可写任务的模型失败了但已经改了文件，就停下来交给 Claude 检查，不再让下一个模型在半成品上接着改。

### 调整
- 面板「pi 模型」页改名「外派模型」，按提供商分组（opencode 一组排最后），计费选项加"免费"，链视图里每个模型标通道，加"按档位重排"按钮。
- 熔断识别多了 `usage limit`、`too many requests`；opencode 任一免费模型限流，整个 opencode 暂停。opencode 只看 stderr 和 error 事件，不看工具输出。实测 opencode 的免费模型现在有用量上限，**按模型算**（error 事件 `provider.free-limit`，429，带 `retryAfterMs`）：只暂停用完的那个模型，按报的时间恢复，同链别的免费模型照常试。以前 2.x 的报错只显示成 "error"，现在读出原文。
- 面板「外派模型」页：每个角色下面写“此刻会用：X；跳过 Y（原因）”，原因分 提供商已关 / 高峰 / 暂停 / 已下架 / 隐私；“按档位重排”先提示会覆盖手调的顺序，确认后才重排。
- **对照实验**：
  - 主指标从“每轮花费”改成“每个会话花费的几何平均”（按对数算差值和标准误）。会话花费长尾很重，个别大会话会左右算术平均；每轮花费会被“会话变短”抵消，只作参考。
  - 每组要 15 个会话才下结论（原来 8 个）；不到 3 轮的会话不算，报告里写明去掉了几个。
  - `claude -p`、定时任务这类一两轮的会话靠上一条去掉（不用 `isInteractive`：桌面 app 和重载后会误报）。
  - 7 天额度是整个账号共用的，涨幅只用没和别的会话同时开着的会话算。
  - 外派次数按组单列；外派模型的花费不在 Claude 花费里，报告里写明。

### 迁移
- 0.2.x 的配置自动加上 opencode 提供商、档位、`pi.strengths` 和 `opencode` 段，原文件存成 `auto-router.json.bak`。角色还是 0.2 默认值的按新档位重排；手调过的不动，提示里请你自己点「按档位重排」。

## 0.2.3 — 2026-10-31

### 新增
- `router_config` 新增 `action=report`（可选 `days`，默认 7）：一次返回对照实验、按类别统计和整体汇总（pi 任务、拦截次数、7 天额度读数）。给定时任务这类不能敲斜杠命令的场合用。
- 按类别统计 `categoryStats`：每类问题的轮数、花费、实际模型、被纠正次数，按切换组分开；纠正记在被纠正的上一轮上；不到 20 轮标“样本不足”。
- 面板的模型下拉框显示版本号（如 Opus 5.5），取这台机器最近 14 天实际调用到的模型 id，不写死；下方列出完整 id。
- 面板说明“也可派给 pi”的含义：这一轮仍由所选的 Claude 模型回答，pi 只做 Claude 交出去的部分。
- `scripts/token_report.py`：全机 token 趋势统计脚本，周报用。

## 0.2.2 — 2026-10-30

### 调整
- **编码类默认改用 Sonnet**（原来是 Opus）。依据 OpenRouter 对 Opus / Sonnet / Haiku 5.5 的实测选型：默认用 Sonnet，长且出错代价高的任务（难题设计、评审查根因）才用 Opus。用户纠正时仍会自动升一档；效果用对照实验的纠正率和每轮花费验证。
- **executor 子代理改用 Haiku**：它只照写死的清单执行，属于高频、按步骤的活。

## 0.2.1 — 2026-10-30

### 改进
- **状态栏**：输入框下方的状态行加了图标。颜色圆点区分模型档位（🟢 Haiku / 🔵 Sonnet / 🟣 Opus），emoji 区分问题类别，并标出升降档（⬆/⬇）、等待降档（⏳）、上下文过长不降档（🔒）、可派 pi（🚀）、对照日（🧪）、固定模型（📌）。pi 任务运行时显示 `🚀 pi · 角色 · 模型 运行中`。新增 `hooks/statusline.ts`。

## 0.2.0 — 2026-10-30

### 新增
- **省额度**：并入原来手工配置的一套方案。拦截大读取（大文件、大图、整页网页、刷屏命令；同一目标只拦一次），上下文过大时提醒交接，7 天额度提醒，系统提示规则，scout / executor 子代理，`delegate` 技能，`scripts/img_check.py`。
- **对照实验**：按会话 id 哈希分成"切换 / 不切换"×"省额度 开 / 关"，只收新会话；`/auto-router eval` 输出报告（以会话为单位求平均值和标准误，样本够、差异超过两倍标准误才下结论）。
- **fork 分类**：classify 被 429 限流或超时时，改用 `$.model.fork` 沿用主对话请求路径分类；之后 30 分钟直接走 fork。
- `router_config` 新增 `probe`：试遍各种分类方式，报告能用哪条路、各用多久，以及 fork 前后会话花费的变化。
- 日志记录分类失败原因（`cf`/`cerr`）、耗时（`cms`）、路径（`via`）、fork 用量（`fu`），以及拦截记录。
- 报告显示 fork 分类占切换组花费的比例。

### 改进
- 已在 Opus 且上下文长到不降档时不再 fork（分类结果改变不了模型），日志记 `cf: skip`。
- `register.tsx` 拆成 `classify.ts`、`core.ts`、`panel.tsx`。
- 配置旧字段 `claude.abTest` 自动迁移为 `experiment: route`。

### 修复
- 分类失败一律记成"超时"，掩盖了 429 限流。
- 文件不到 40KB 但超过 2000 行时漏拦。
- 保存配置时丢掉 `saver`、`experiment` 两节。
- fork 回答对不上类别时误记为出错。

## 0.1.0

- 按问题分类切换 Claude 模型，降档粘性，纠正时升档，上下文长时不降档。
- `pi_dispatch` / `pi_result`：按角色把任务派给 pi，模型链、高峰时段、兜底、熔断、只读角色和 git 防护。
- `/auto-router` 设置面板、`router_config` 工具、效果统计。
