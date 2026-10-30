# 参与开发

## 环境

- Claude Code（带 mod 支持的版本）
- 本地开发时把仓库目录作为本地 marketplace 加进 Claude Code，改完重开会话即可加载新代码

## 检查

提交前三项都要通过：

```bash
claude plugin validate .
claude plugin test .
npx -p typescript tsc -p <你的 tsconfig> --noUnusedLocals
```

类型检查需要引擎的类型声明 `claude-code.d.ts`（随 Claude Code 的 `plugin-authoring` 技能分发，路径因机器而异，所以仓库里不带 tsconfig）。自己建一个 tsconfig，`include` 里放这个声明文件和 `hooks`、`types`、`tests` 三个目录；编译选项用 `strict`、`noUncheckedIndexedAccess`、`"jsx": "react"`、`"jsxFactory": "h"`。

## 测试怎么写

测试用 `claude-code/testing`，用引擎替身代替真实引擎。`tests/coverage.test.ts` 的 `harness()` 把磁盘、会话、用量都模拟好了，新测试一般这样写：

```ts
test('描述', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG, ctx: 200_000 })
  on('model.classify', () => ({ deny: RATE_LIMITED }))   // 让操作失败要返回 { deny }，不要抛异常
  await start($)
  await submit($, '一条消息')
  await complete($)
  expect(logRows(h)[0]).toMatchObject({ ... })
})
```

## 引擎约束

见 [docs/architecture.md](docs/architecture.md#写-mod-时遇到的引擎约束)。最容易踩的两条：

- `$` 只能传给 function 声明，不能传给箭头函数常量；
- atom 要在使用它的文件里声明。

## 代码风格

- 注释和用户可见文字用中文，写清"为什么"，不复述代码。
- 用户可见的提示要说清楚发生了什么、接下来怎么办。
- 新功能要有测试；改了日志字段要同步 `stats.ts` 的类型和 `docs/architecture.md` 的字段表。
