# 使用说明与操作清单

## 一、安装

1. 安装插件：

   ```
   /plugin marketplace add chinbor/auto-router
   /plugin install auto-router@auto-router
   ```

2. （可选）安装 pi 并配好各家的 key，`pi --list-models` 里能看到模型就行。没装 pi 也能用模型切换和省额度，只是没有外派。
3. （可选）看图工具 `scripts/img_check.py` 需要 Python；处理视频截帧需要 ffmpeg。
4. 重开一个会话。第一次运行会生成 `~/.claude/auto-router.json`，并提示打开 `/auto-router`。

## 二、首次配置（5 分钟）

| 步骤 | 操作 |
|---|---|
| 1 | 运行 `/auto-router`，会直接进入「pi 模型」页 |
| 2 | 每家提供商选"订阅 / 按量付费 / 不用" |
| 3 | 展开一家，给要用的模型标"强 / 中 / 轻"，各角色的模型顺序会立即重排 |
| 4 | 切到「Claude 模型」页，确认每类问题用哪个模型（默认值一般就行） |
| 5 | （可选）"更多设置"里打开对照实验，选 `both` |

也可以直接跟 Claude 说，比如"code 角色改成 sol 优先""把 2027-01-01 到 01-03 加进 deepseek 的节假日"。Claude 会用 `router_config` 工具修改，保存前会校验。

## 三、每项能力怎么触发

### 模型切换（自动）

| 想要 | 怎么做 |
|---|---|
| 自动切换 | 什么都不用做，每条消息自动分类；状态栏显示本轮模型和理由 |
| 临时固定某个模型 | `/auto-router` → Claude 页 → 切换方式选"固定 opus"等 |
| 完全不切换 | 切换方式选"不切换" |
| 当前模型不够用 | 直接说"不对""重做"，本轮升一档 |
| 分类好像不工作 | 跟 Claude 说"用 router_config 的 probe 检查一下分类器" |

### pi 外派

| 想要 | 怎么做 |
|---|---|
| 让 Claude 自己决定外派 | 默认开着：分类判断适合外派时，会给 Claude 附一句建议 |
| 明确要外派 | 跟 Claude 说"把这个交给 pi 的 bulk 角色做" |
| 手动派任务 | `/auto-router run [角色] <任务>`，后台运行，完成后提示 |
| 看任务 | `/auto-router jobs` |
| 取后台任务结果 | Claude 调 `pi_result`，或在任务页看 |
| 某家被熔断了 | 面板 pi 页，那家提供商上点"恢复" |

可写角色要求工作目录是干净的 git 仓库。pi 改完不会自动提交，由 Claude 用 `git diff` 审阅后再决定保留还是撤销。

### 省额度（自动）

| 场景 | 会发生什么 | 你要做的 |
|---|---|---|
| Claude 要读大文件、大图、整页网页 | 第一次被拦下，并提示更省的读法（offset/limit、预览图、按目标摘取） | 一般什么都不用做；确实需要全文时让 Claude 原样再请求一次，会放行 |
| 上下文超过 30 万 / 60 万 | 用户消息旁附一句提醒 | 换话题就用 `handoff` 技能交接后开新会话；继续同一件事就 `/compact` |
| 7 天额度用过 70% | 提醒大量阅读优先派给 pi longctx | 无 |
| 要翻大量材料 | Claude 按规则选择自己读、scout 或 pi longctx | 想指定时直接说"用 scout 查"或"派给 pi longctx" |
| 要批量机械执行 | Claude 先读 `delegate` 技能，写好清单再交给 executor 或 pi | 无 |

开关在 Claude 页"更多设置"：省额度总开关、拦截开关、大量阅读交给谁。

### 对照实验

| 想要 | 怎么做 |
|---|---|
| 开始实验 | 更多设置 → 对照实验 → `route` / `saver` / `both` |
| 看本会话在哪组 | 面板"对照实验"下方；或 `/auto-router eval` 第一行 |
| 看报告 | `/auto-router eval [天数]`，默认 14 天 |
| 看摘要 | `/auto-router stats` |
| 原始数据 | `/auto-router path` 显示日志目录 |

结论规则：每组至少 8 个会话，差值超过两倍标准误才下结论。设计细节见 [experiment.md](experiment.md)。

## 四、命令速查

| 命令 | 作用 |
|---|---|
| `/auto-router` | 打开设置面板 |
| `/auto-router pi` / `stats` / `jobs` | 直接打开对应页 |
| `/auto-router eval [天数]` | 对照实验报告 |
| `/auto-router run [角色] <任务>` | 手动派 pi 任务 |
| `/auto-router export [文件]` | 导出配置给别人 |
| `/auto-router import <文件>` | 导入配置，旧配置备份成 `.bak` |
| `/auto-router path` | 显示配置文件和日志位置 |

| 工具（Claude 调用） | 作用 |
|---|---|
| `pi_dispatch` | 派任务给 pi |
| `pi_result` | 取后台任务结果 |
| `router_config` | `get` / `set` / `reset` 配置，`probe` 自检分类器 |

## 五、排查

| 现象 | 原因和办法 |
|---|---|
| 日志里分类全是"超时"或"分类出错" | 多半是插件自己的模型请求被 429 限流（额度用到八成以上时常见）。新版会自动改用 fork；用 `probe` 确认哪条路能通 |
| 第一条消息没切换 | 正常现象：还没有可 fork 的请求 |
| 日志里有"跳过（换不了模型）" | 已经在 Opus 且上下文长到不降档，分类没有意义，省掉了 fork |
| pi 任务一直在排队 | 能接这个角色的模型都在高峰或被暂停；面板 pi 页看状态，或把节假日加进配置 |
| 可写任务被拒 | 工作目录不是 git 仓库，或有未提交的改动；先提交或 stash |
| 手改配置后弹"校验不通过" | 按提示修改，或让 Claude 用 `router_config reset` 恢复默认（旧配置备份成 `.bak`） |
| 拦截误伤 | 原样再请求一次就会放行；频繁误伤可以关掉拦截开关，并提 issue |
