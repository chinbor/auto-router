# auto-router

Claude Code 插件（mod）：**按问题自动切换 Claude 模型，把执行活派给更便宜的模型，拦住浪费上下文的读取，并用对照实验衡量到底省了多少。**

- **模型切换**：每条消息先分类，闲聊用 haiku，小改动用 sonnet，编码和设计用 opus。升档立即生效，降档有缓冲；用户纠正时升一档；上下文长时不降档。
- **pi 外派**：注册 `pi_dispatch` 工具，Claude 把说明写得清楚、做完能验收的任务交给 [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)，在 GPT / DeepSeek / Agnes 上跑，不占 Claude 额度。支持模型链、高峰时段避让、熔断、只读角色和 git 防护。
- **省额度**：拦下读大文件、大图、整页网页、刷屏命令（同一目标只拦一次，原样再请求就放行）；上下文过大时提醒交接；把"节省上下文、决策与执行分离"写进系统提示；附带 scout / executor 子代理和 `delegate` 技能。
- **对照实验**：新会话按 id 随机分到"切换 / 不切换"×"省额度 开 / 关"，按会话比较每轮花费、上下文、额度消耗和纠正率，样本够、差异显著才下结论。

原则：Claude 负责判断、设计和验收，便宜的模型负责能写成清单的执行活。

```mermaid
flowchart LR
    P[用户消息] --> C{分类<br/>classify / fork}
    C -->|闲聊| H[haiku]
    C -->|小改动| S[sonnet]
    C -->|编码 / 设计| O[opus]
    C -.适合外派.-> PI[pi_dispatch<br/>GPT / DeepSeek / Agnes]
    H & S & O --> G[省额度拦截<br/>大文件 / 大图 / 整页网页]
    G --> L[(日志)] --> E[/auto-router eval<br/>对照实验报告/]
```

## 安装

```
/plugin marketplace add chinbor/auto-router
/plugin install auto-router@auto-router
```

装好后重开一个会话，运行 `/auto-router` 按提示配置。

- 外派需要本机能运行 `pi`，并且已配好对应提供商的 key（`pi --list-models` 能列出的模型才能用）。没装 pi 也能用模型切换和省额度。
- 看图工具 `scripts/img_check.py` 需要 Python；处理视频截帧需要 ffmpeg。

## 文档

| 文档 | 内容 |
|---|---|
| [使用说明与操作清单](docs/usage.md) | 安装、首次配置、每项能力怎么触发、命令速查、排查 |
| [架构与工作原理](docs/architecture.md) | 模块结构、钩子流程、分类和 fork 兜底、省额度、pi 外派、日志字段、引擎约束 |
| [对照实验设计](docs/experiment.md) | 分组方法、指标、统计方法、局限、怎么跑实验 |
| [更新记录](CHANGELOG.md) | 版本变化 |
| [参与开发](CONTRIBUTING.md) | 检查命令、测试写法、代码风格 |

## 配置参考

全部策略在 `~/.claude/auto-router.json`，首次运行时生成，每次使用前重新读取，改完立即生效。平时用 `/auto-router` 面板改，或直接跟 Claude 说，由它调用 `router_config` 修改（保存前会校验）。

| 配置 | 默认 | 作用 |
|---|---|---|
| `claude.categories` | 见下表 | 问题类别 → Claude 模型、建议外派的 pi 角色 |
| `claude.downgradeAfter` | 2 | 连续几轮判为更轻的类别才降档 |
| `claude.upgradeOnCorrection` | true | 用户纠正时升一档 |
| `claude.keepAboveTokens` | 150000 | 上下文超过这个数不降档（已在 Opus 时也不再为分类 fork） |
| `saver.enabled` / `saver.guard` | true / true | 省额度总开关 / 拦截开关 |
| `saver.remindAt` | [300000, 600000] | 上下文越过这些档位时各提醒一次 |
| `saver.bigRead` | auto | 大量阅读交给谁：auto / scout / pi |
| `saver.quotaPct` | 70 | 7 天额度用过这个百分比后，大量阅读优先派给 pi |
| `experiment` | off | 对照实验：off / route / saver / both |
| `pi.providers` | | 提供商开关、计费方式、高峰时段、节假日 |
| `pi.roles` | | 角色 → 依次尝试的模型 |
| `pi.fallback` | | 角色链都用不了时的兜底模型 |
| `pi.pauseMinutes` | 30 | 鉴权或额度错误后整家暂停多久 |
| `pi.guard.requireCleanGit` | true | 可写任务要求干净的 git 工作区 |

默认的问题类别：

| 类别 | 模型 | 建议外派 |
|---|---|---|
| 闲聊、简答 | haiku | |
| 翻译、总结、润色 | sonnet | text |
| 小改动、跑命令、查文件 | sonnet | |
| 编码（功能、重构、调试） | sonnet | |
| 难题、架构设计 | opus | |
| 评审、查根因 | opus | review |
| 跨多文件的批量修改 | sonnet | bulk |
| 大量阅读、总结 | sonnet | longctx |
| 其他 / 分类失败 | 不变 | |

默认的 pi 角色（按作者的订阅配置，首次运行时在「pi 模型」页按你自己的改）：

| 角色 | 用途 | 只读 |
|---|---|---|
| review | 独立评审、找根因、复杂算法 | ✓ |
| code | 说明清楚的编码 | |
| vision | 看截图、图片、界面相关 | |
| bulk | 跨多文件的批量机械修改 | |
| longctx | 超过约 20 万 token 的大量阅读 | ✓ |
| quick | 看日志、跑测试汇报、格式转换 | |
| text | 翻译、总结、改写、写提交说明 | ✓ |
| trivial | 抽取字段、整理成 JSON | ✓ |

## 开发

```bash
claude plugin validate .
claude plugin test .
```

详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
