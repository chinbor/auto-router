# 更新记录

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
