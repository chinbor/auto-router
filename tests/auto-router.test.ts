import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { buildRoles, chainFor, DEFAULT_CONFIG, earliestRun, isPeak, liveChain, nextOffPeak, sticky } from '../hooks/config'
import { summarize } from '../hooks/stats'
import { piStatus, routeStatus } from '../hooks/statusline'
import type { LogRecord } from '../hooks/stats'
import type { Config } from '../hooks/config'

const BULK = 'bulk mechanical work: batch edits across many files, migrations, generating many files'
const DS = DEFAULT_CONFIG.pi.providers['cc-switch-deep-seek']?.peak
// 2026-10-29 周四；北京时间 = UTC+8
const at = (iso: string) => Date.parse(iso)
const PEAK = at('2026-10-29T02:00:00Z') // 周四 10:00

type On = Parameters<TestBody>[1]
type Run = { exitCode: number; stdout: string; stderr: string }
/** 引擎的 process.run 结果还带输出是否被截断 */
const full = (r: Run) => ({ ...r, isStdoutTruncated: false, isStderrTruncated: false })
const ok = (stdout = '') => ({ value: full({ exitCode: 0, stdout, stderr: '' }) })

/** 默认的引擎替身；file 给出时假装配置文件里就是它 */
function base(on: On, opts: { write?: boolean; file?: Config } = {}) {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__auto-router__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  // 分类超时、排队计时器都永不触发
  on('clock.after', () => new Promise(() => {}))
  if (opts.file) {
    on('fs.exists', () => ({ value: true }))
    on('fs.read', () => ({ value: JSON.stringify(opts.file) }))
  } else on('fs.exists', () => ({ value: false }))
  if (opts.write !== false) on('fs.write', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

/** 一份不依赖真实时间的配置：没有高峰时段 */
function testConfig(roles: Config['pi']['roles'], fallback: string[] = []): Config {
  return {
    saver: DEFAULT_CONFIG.saver,
    experiment: 'off',
    // 类别引用的角色这里不一定有，去掉外派建议，免得校验不过退回默认配置
    claude: { ...DEFAULT_CONFIG.claude, categories: DEFAULT_CONFIG.claude.categories.map(({ piRole: _r, ...c }) => c) },
    pi: {
      ...DEFAULT_CONFIG.pi,
      defaultRole: Object.keys(roles)[0] as string,
      providers: {
        openai: { enabled: true, billing: 'subscription' },
        agnes: { enabled: true, billing: 'subscription' },
      },
      roles,
      fallback,
    },
  }
}

/** process.run 替身：git 命令按 git 回答，pi 命令交给 pi 回答并记下模型 */
function fakeHost(
  on: On,
  git: (args: readonly string[]) => Run,
  pi: (model: string, argv: readonly string[], env?: Record<string, string>) => Run,
) {
  const tried: string[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'reg') return ok('\r\nHKEY_CURRENT_USER\\Environment\r\n    AGNES_PI_API_KEY    REG_SZ    k-test\r\n    Path    REG_SZ    C:\\x\r\n')
    if (e.argv[0] === 'git') return { value: full(git(e.argv)) }
    if (e.argv.includes('echo %USERPROFILE%')) return ok('C:\\Users\\me\r\n')
    const model = e.argv[e.argv.indexOf('--model') + 1] ?? ''
    tried.push(model)
    return { value: full(pi(model, e.argv, e.init?.env)) }
  })
  return tried
}

const cleanRepo = (args: readonly string[]): Run =>
  args.includes('rev-parse') ? { exitCode: 0, stdout: 'D:/work\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }

test('deepseek 高峰时段：工作日 9-12、14-18 点（北京时间）', () => {
  expect(isPeak(DS, PEAK)).toBe(true) // 周四 10:00
  expect(isPeak(DS, at('2026-10-29T04:30:00Z'))).toBe(false) // 周四 12:30
  expect(isPeak(DS, at('2026-10-29T07:00:00Z'))).toBe(true) // 周四 15:00
  expect(isPeak(DS, at('2026-10-29T10:00:00Z'))).toBe(false) // 周四 18:00
  expect(isPeak(DS, at('2026-10-31T02:00:00Z'))).toBe(false) // 周六 10:00
  expect(nextOffPeak(DS, at('2026-10-29T02:10:00Z'))).toBe(at('2026-10-29T04:00:00Z')) // 排到 12:00
  const holiday = DS && { ...DS, holidays: ['2026-10-29'] }
  expect(isPeak(holiday, PEAK)).toBe(false)
})

test('模型链：高峰跳过 deepseek，关掉 openai 后跳过 gpt，默认不用 deepseek-v4-pro', () => {
  expect(chainFor(DEFAULT_CONFIG, 'code', PEAK)).toEqual(['openai/gpt-6.1-terra', 'openai/gpt-6.1-sol'])
  expect(chainFor(DEFAULT_CONFIG, 'longctx', PEAK)).toEqual(['openai/gpt-6.1-terra'])

  const noGpt: Config = {
    ...DEFAULT_CONFIG,
    pi: { ...DEFAULT_CONFIG.pi, providers: { ...DEFAULT_CONFIG.pi.providers, openai: { enabled: false, billing: 'subscription' } } },
  }
  expect(chainFor(noGpt, 'code')).toEqual(['cc-switch-deep-seek/deepseek-flash'])
  expect(chainFor(noGpt, 'code', PEAK)).toEqual([])
  expect(earliestRun(noGpt, chainFor(noGpt, 'code'), PEAK)).toBe(at('2026-10-29T04:00:00Z'))

  const all = Object.values(DEFAULT_CONFIG.pi.roles).flatMap(r => r.models)
  expect(all.some(m => m.includes('deepseek-v4-pro'))).toBe(false)
})

test('兜底：gpt 退订 + deepseek 高峰时改用 agnes-3.0-flash；熔断的提供商也跳过', () => {
  const noGpt: Config = {
    ...DEFAULT_CONFIG,
    pi: { ...DEFAULT_CONFIG.pi, providers: { ...DEFAULT_CONFIG.pi.providers, openai: { enabled: false, billing: 'subscription' } } },
  }
  expect(liveChain(noGpt, 'code', PEAK)).toEqual({ models: ['agnes/agnes-3.0-flash', 'agnes/agnes-2.5-flash'], isFallback: true })
  // 非高峰：deepseek-flash 正常接，不用兜底
  expect(liveChain(noGpt, 'code', at('2026-10-29T04:30:00Z'))).toEqual({ models: ['cc-switch-deep-seek/deepseek-flash'], isFallback: false })
  // gpt 还订着但被熔断：同样走兜底
  expect(liveChain(DEFAULT_CONFIG, 'review', PEAK, p => p === 'openai').isFallback).toBe(true)
  // 兜底也被熔断：什么都不剩
  expect(liveChain(noGpt, 'code', PEAK, p => p === 'agnes').models).toEqual([])
})

test('Claude 模型：升档立即，降档要连续两轮', () => {
  let s = sticky(null, 'opus', 2)
  expect(s).toEqual({ model: 'opus', lighterStreak: 0 })
  s = sticky(s, 'haiku', 2) // 中途一句“好的继续”，不降
  expect(s).toEqual({ model: 'opus', lighterStreak: 1 })
  s = sticky(s, 'opus', 2) // 又回到编码，计数清零
  expect(s).toEqual({ model: 'opus', lighterStreak: 0 })
  s = sticky(s, 'sonnet', 2)
  s = sticky(s, 'sonnet', 2) // 连续两轮才降
  expect(s).toEqual({ model: 'sonnet', lighterStreak: 0 })
  expect(sticky(s, undefined, 2)).toEqual({ model: 'sonnet', lighterStreak: 0 }) // 分类超时：不动
})

test('router_config：校验不过不保存，合法的才写回', async ($, on) => {
  base(on, { write: false, file: DEFAULT_CONFIG })
  const written: string[] = []
  on('fs.write', (_, e) => {
    written.push(String(e.text))
    return { value: undefined }
  })
  on('process.run', () => ok('C:\\Users\\me\r\n'))
  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  written.length = 0

  const bad = await $.tool.call({ tool: 'mcp__auto-router__router_config', action: 'set', path: 'pi.roles.code.models', value: ['gpt-6.1-sol'] } as never)
  expect(String(bad.result)).toContain('没改')
  expect(written.length).toBe(0)

  const good = await $.tool.call({ tool: 'mcp__auto-router__router_config', action: 'set', path: 'pi.providers.openai.enabled', value: false } as never)
  expect(String(good.result)).toContain('已保存')
  expect(JSON.parse(written[0] ?? '{}').pi.providers.openai.enabled).toBe(false)
})

test('设置面板：电脑端用下拉框，手机端退化成按钮', async ($, on) => {
  base(on)
  on('process.run', () => ok('C:\\Users\\me\r\n'))
  const pane = {
    plugin: 'auto-router',
    component: 'Pane',
    requestId: 'auto-router',
    props: { title: 'auto-router', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
  } as const
  const desk = await $.ui.mount({ ...pane, surface: 'desktop' })
  expect(await desk.find({ type: 'Select' })).toBeDefined()
  await desk.unmount()
  const phone = await $.ui.mount({ ...pane, surface: 'mobile' })
  expect(await phone.find({ type: 'Select' })).toBeUndefined()
  expect(await phone.find({ type: 'Button', key: 'mode-auto' })).toBeDefined()
  await phone.unmount()
})

test('pi 模型页：显示完整模型名，默认只列在用的；改档位后自动重排角色', async ($, on) => {
  // 内存里的配置文件：写过之后就存在，读到最后一次写的内容
  const written: string[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__auto-router__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('clock.after', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: written.length > 0 }))
  on('fs.read', () => ({ value: written[written.length - 1] ?? '' }))
  on('fs.write', (_, e) => {
    written.push(String(e.text))
    return { value: undefined }
  })
  const list = [
    'provider  model  context',
    'openai  gpt-6.1-sol  272K',
    'openai  gpt-6.1-terra  272K',
    'openai  gpt-6.1-mini  272K',
    'cc-switch-deep-seek  deepseek-flash  1M',
    'cc-switch-deep-seek  deepseek-v4-pro  1M',
    'agnes  agnes-3.0-flash  1M',
  ].join('\n')
  on('process.run', (_, e) => ok(e.argv.includes('--list-models') ? list : 'C:\\Users\\me\r\n'))
  on('command.run', (_, e) => ({ text: e.args }))
  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'auto-router', args: '' } as never).catch(() => undefined)

  const ui = await $.ui.mount({
    plugin: 'auto-router',
    component: 'Pane',
    requestId: 'auto-router',
    // 手机端是按钮，好按
    surface: 'mobile',
    props: { title: 'auto-router', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  await ui.press({ key: 'tab-pi' })
  let hit
  for (let i = 0; i < 30 && !hit; i++) hit = await ui.find({ type: 'Text', text: /^gpt-6\.1-sol$/ })
  expect(hit).toBeDefined()
  // 没标档位的 gpt-6.1-mini 先不列，点“显示全部”才出来
  expect(await ui.find({ type: 'Text', text: /^gpt-6\.1-mini$/ })).toBeUndefined()
  await ui.press({ key: 'all-openai' })
  let mini
  for (let i = 0; i < 30 && !mini; i++) mini = await ui.find({ type: 'Text', text: /^gpt-6\.1-mini$/ })
  expect(mini).toBeDefined()

  // deepseek-flash 标成“不用”：各角色里的 deepseek 自动去掉
  written.length = 0
  await ui.press({ key: 'tier-cc-switch-deep-seek/deepseek-flash-none' })
  const roles = () => JSON.parse(written[written.length - 1] ?? '{}').pi?.roles
  for (let i = 0; i < 50 && !roles(); i++) await ui.findAll({})
  expect(roles().code.models).toEqual(['openai/gpt-6.1-terra', 'openai/gpt-6.1-sol'])
  expect(roles().longctx.models).toEqual(['openai/gpt-6.1-terra'])
  await ui.unmount()
})

test('批量类问题：给 Claude 附上外派建议', async ($, on) => {
  base(on)
  on('model.classify', () => ({ value: BULK }))
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  const out = await $.prompt.submit({ text: '把 src 下 200 个文件的 import 改成别名路径' } as never)

  expect(out.context?.join('\n')).toContain('role=bulk')
})

test('只读角色：强制禁用 edit/write/bash，不查 git，补上用户环境变量', async ($, on) => {
  base(on, { file: testConfig({ text: { description: 't', models: ['agnes/agnes-3.0-flash'], readOnly: true } }) })
  let sawGit = false
  const tried = fakeHost(
    on,
    args => {
      sawGit = true
      return cleanRepo(args)
    },
    (_, argv, env) => {
      expect(env).toEqual({ AGNES_PI_API_KEY: 'k-test' })
      expect(argv.slice(0, 4)).toEqual(['cmd', '/d', '/c', 'pi'])
      expect(argv.join(' ')).toContain('--exclude-tools edit,write,bash')
      return { exitCode: 0, stdout: 'translated', stderr: '' }
    },
  )

  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  // Claude 传 readOnly:false 也放不开
  const out = await $.tool.call({ tool: 'mcp__auto-router__pi_dispatch', task: '翻译 README', role: 'text', readOnly: false } as never)

  expect(tried).toEqual(['agnes/agnes-3.0-flash'])
  expect(sawGit).toBe(false)
  expect(String(out.result)).toContain('translated')
})

test('可写角色：工作区不干净就不派', async ($, on) => {
  base(on, { file: testConfig({ code: { description: 'c', models: ['openai/gpt-6.1-terra'] } }) })
  const tried = fakeHost(
    on,
    args => (args.includes('status') ? { exitCode: 0, stdout: ' M src/a.ts\n?? b.ts\n', stderr: '' } : cleanRepo(args)),
    () => ({ exitCode: 0, stdout: 'done', stderr: '' }),
  )

  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  const out = await $.tool.call({ tool: 'mcp__auto-router__pi_dispatch', task: '改 a.ts', role: 'code' } as never)

  expect(String(out.result)).toContain('没派')
  expect(String(out.result)).toContain('2 个未提交的改动')
  expect(tried).toEqual([])
})

test('可写角色：不是 git 仓库就不派', async ($, on) => {
  base(on, { file: testConfig({ code: { description: 'c', models: ['openai/gpt-6.1-terra'] } }) })
  const tried = fakeHost(
    on,
    () => ({ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }),
    () => ({ exitCode: 0, stdout: 'done', stderr: '' }),
  )

  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  const out = await $.tool.call({ tool: 'mcp__auto-router__pi_dispatch', task: '改 a.ts', role: 'code' } as never)

  expect(String(out.result)).toContain('不是 git 仓库')
  expect(tried).toEqual([])
})

test('可写角色：干净仓库里跑完附上改动摘要', async ($, on) => {
  base(on, { file: testConfig({ code: { description: 'c', models: ['openai/gpt-6.1-terra'] } }) })
  let ran = false
  const tried = fakeHost(
    on,
    args => {
      if (args.includes('status')) return { exitCode: 0, stdout: ran ? ' M src/a.ts\n' : '', stderr: '' }
      if (args.includes('diff')) return { exitCode: 0, stdout: ' src/a.ts | 4 ++--\n 1 file changed', stderr: '' }
      return cleanRepo(args)
    },
    (_, argv) => {
      expect(argv.join(' ')).not.toContain('--exclude-tools')
      ran = true
      return { exitCode: 0, stdout: 'edited a.ts', stderr: '' }
    },
  )

  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  const out = String((await $.tool.call({ tool: 'mcp__auto-router__pi_dispatch', task: '改 a.ts', role: 'code' } as never)).result)

  expect(tried).toEqual(['openai/gpt-6.1-terra'])
  expect(out).toContain('pi 改动了 1 个文件')
  expect(out).toContain('src/a.ts | 4')
  expect(out).toContain('git diff')
})

test('熔断：订阅失效后整家跳过，换下一家；普通错误只换下一个模型', async ($, on) => {
  const cfg = testConfig({
    review: { description: 'r', models: ['openai/gpt-6.1-sol', 'openai/gpt-6.1-terra', 'agnes/agnes-3.0-flash', 'agnes/agnes-2.5-flash'], readOnly: true },
  })
  base(on, { file: cfg })
  const tried = fakeHost(on, cleanRepo, model => {
    if (model === 'openai/gpt-6.1-sol') return { exitCode: 1, stdout: '', stderr: 'Error: 401 Unauthorized: subscription expired' }
    if (model === 'agnes/agnes-3.0-flash') return { exitCode: 1, stdout: '', stderr: 'Error: model timed out' }
    return { exitCode: 0, stdout: 'reviewed', stderr: '' }
  })

  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  const out = String((await $.tool.call({ tool: 'mcp__auto-router__pi_dispatch', task: '评审', role: 'review' } as never)).result)

  // sol 鉴权失败 → openai 暂停，terra 跳过；agnes-3.0 超时不熔断 → agnes-2.5 接上
  expect(tried).toEqual(['openai/gpt-6.1-sol', 'agnes/agnes-3.0-flash', 'agnes/agnes-2.5-flash'])
  expect(out).toContain('reviewed')
  expect(out).toContain('openai 已暂停')
})

test('设置面板：四个标签页在电脑端、终端、手机端都画得出来', async ($, on) => {
  base(on)
  on('process.run', () => ok('C:\\Users\\me\r\n'))
  for (const surface of ['desktop', 'terminal', 'mobile'] as const) {
    const ui = await $.ui.mount({
      plugin: 'auto-router',
      component: 'Pane',
      requestId: 'auto-router',
      surface,
      props: { title: 'auto-router', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
    } as never)
    for (const [tab, words] of [
      ['claude', /每类问题用哪个模型/],
      ['pi', /派活时按这个顺序试/],
      ['stats', /Claude 用量/],
      ['jobs', /还没有任务/],
    ] as const) {
      await ui.press({ key: `tab-${tab}` })
      let hit
      for (let i = 0; i < 20 && !hit; i++) hit = await ui.find({ type: 'Text', text: words })
      expect(hit).toBeDefined()
    }
    await ui.unmount()
  }
})

test('快速设置：按默认档位生成的角色和手写的默认配置一致', () => {
  const built = buildRoles(DEFAULT_CONFIG)
  for (const [name, role] of Object.entries(DEFAULT_CONFIG.pi.roles)) {
    expect([name, built.pi.roles[name]?.models]).toEqual([name, role.models])
    expect([name, built.pi.roles[name]?.readOnly === true]).toEqual([name, role.readOnly === true])
  }
  expect(built.pi.fallback).toEqual(DEFAULT_CONFIG.pi.fallback)
})

test('快速设置：别的用户只有 GPT 按量 + 智谱订阅，也能生成可用的角色', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    pi: {
      ...DEFAULT_CONFIG.pi,
      providers: {
        ...DEFAULT_CONFIG.pi.providers,
        openai: { enabled: true, billing: 'token' },
        zhipu: { enabled: true, billing: 'subscription' },
        agnes: { enabled: false, billing: 'subscription' },
        'cc-switch-deep-seek': { enabled: false, billing: 'token' },
      },
      tiers: { 'openai/gpt-x': 'strong', 'zhipu/glm-big': 'mid', 'zhipu/glm-air': 'light' },
    },
  }
  const built = buildRoles(cfg)
  expect(built.pi.roles.review?.models).toEqual(['openai/gpt-x', 'zhipu/glm-big'])
  expect(built.pi.roles.text?.models).toEqual(['zhipu/glm-air', 'zhipu/glm-big'])
  expect(built.pi.roles.longctx?.models).toEqual(['zhipu/glm-big', 'openai/gpt-x'])
  // 兜底只用订阅的轻档，不用按量付费的
  expect(built.pi.fallback).toEqual(['zhipu/glm-air'])
  expect(built.pi.roles.review?.readOnly).toBe(true)
})

test('效果统计：从记录反推 Opus 单价，算出小模型省了多少，扣掉换模型的代价', () => {
  const t = (over: Partial<Extract<LogRecord, { t: 'turn' }>>): LogRecord => ({ t: 'turn', ts: 10, arm: 'auto', model: 'claude-opus-5-5', in: 0, cw: 0, cr: 0, out: 0, ...over })
  const s = summarize(
    [
      t({ in: 1000, usd: 0.5 }), // Opus：每加权 token 0.0005
      t({ model: 'claude-sonnet-5-5', in: 1000, usd: 0.3, switched: true, cw: 0 }),
      t({ model: 'claude-haiku-5-5', in: 1000, usd: 0.1, fix: true }),
      t({ arm: 'control', in: 2000, usd: 1 }),
      { t: 'pi', ts: 10, role: 'text', model: 'agnes/agnes-3.0-flash', ok: true, ms: 2000 },
      t({ ts: 1, in: 999_999, usd: 99 }), // 窗口外
    ],
    5,
  )
  expect(s.arms.auto?.turns).toBe(3)
  expect(s.arms.auto?.fixes).toBe(1)
  expect(s.arms.auto?.switches).toBe(1)
  expect(s.arms.control?.turns).toBe(1)
  expect(Math.round((s.savedUsd ?? 0) * 100)).toBe(60) // (0.5-0.3) + (0.5-0.1)
  expect(Math.round(s.cheapUsd * 100)).toBe(40)
  expect(s.pi).toEqual({ total: 1, ok: 1, byModel: { 'agnes/agnes-3.0-flash': 1 }, files: 0 })
})

test('质量防护：说“不对，重做”时升一档，并把这轮记进效果日志', async ($, on) => {
  base(on, { write: false })
  const SMALL = DEFAULT_CONFIG.claude.categories[0]?.label as string
  on('model.classify', () => ({ value: SMALL }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('process.run', () => ok('C:\Users\me\r\n'))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  let cost = 0
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 5000, window: 200000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 40 }], cost: { usd: (cost += 0.1) } } }))
  const files: Record<string, string> = {}
  on('fs.write', (_, e) => {
    files[e.path] = e.text
    return { value: undefined }
  })
  on('turn.complete', (_, e) => ({ text: e.answer, usage: e.usage }))

  await $.session.start({ cwd: 'D:\work', surface: 'desktop', isInteractive: true })
  const usage = { model: 'claude-haiku-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await $.prompt.submit({ text: '你好' } as never)
  await $.turn.complete({ answer: 'hi', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', usage } as never)
  await $.prompt.submit({ text: '不对，重做一下' } as never)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', usage: { ...usage, model: 'claude-sonnet-5-5' } } as never)

  const log = Object.entries(files).find(([p]) => p.includes('abcdef12') && p.endsWith('.jsonl'))?.[1] ?? ''
  const rows = log.trim().split('\n').map(l => JSON.parse(l) as Record<string, unknown>)
  expect(rows.map(r => r.pick)).toEqual(['haiku', 'sonnet'])
  expect(rows[1]?.fix).toBe(true)
  expect(rows[1]?.switched).toBe(true)
  expect(rows[1]?.wk).toBe(40)
  expect(typeof rows[1]?.usd).toBe('number')
})

test('质量防护：上下文超过阈值时不降档', async ($, on) => {
  base(on)
  const cats = DEFAULT_CONFIG.claude.categories
  let label = cats.find(c => c.model === 'opus')?.label as string
  on('model.classify', () => ({ value: label }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('process.run', () => ok('C:\Users\me\r\n'))
  on('session.id', () => ({ value: 'longctx-session' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 400_000, window: 1_000_000 }, rateLimits: [] } }))

  await $.session.start({ cwd: 'D:\work', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: '实现登录功能' } as never)
  label = cats[0]?.label as string // 之后都是闲聊
  await $.prompt.submit({ text: '好的' } as never)
  await $.prompt.submit({ text: '嗯' } as never)
  await $.prompt.submit({ text: '谢谢' } as never)
  // 连续三轮闲聊本该降到 haiku；从面板的“上一个问题”读出实际决定
  const ui = await $.ui.mount({
    plugin: 'auto-router',
    component: 'Pane',
    requestId: 'auto-router',
    surface: 'terminal',
    props: { title: 'auto-router', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  await ui.press({ key: 'tab-claude' })
  let hit
  for (let i = 0; i < 20 && !hit; i++) hit = await ui.find({ type: 'Text', text: /上一个问题：闲聊\/简答 → opus/ })
  expect(hit).toBeDefined()
})

test('状态行：颜色圆点标模型，图标标类别、降档缓冲、防护和外派', () => {
  const base = { label: '小改动/查找', model: 'sonnet', lighterStreak: 0 }
  const o = { downgradeAfter: 2, showPi: true }
  expect(routeStatus(base, o)).toBe('🔵 Sonnet  ·  🔍 小改动/查找')
  expect(routeStatus(base, { ...o, prevModel: 'claude-haiku-5-5' })).toContain('⬆ 自 🟢 Haiku')
  expect(routeStatus({ ...base, label: '闲聊/简答', model: 'opus', wanted: 'haiku', lighterStreak: 1 }, o)).toContain('⏳ 想降到 🟢 Haiku（1/2）')
  expect(routeStatus({ ...base, model: 'opus', why: '上下文 316K，不降档' }, o)).toContain('🔒 上下文 316K')
  expect(routeStatus({ ...base, model: 'opus', why: '你在纠正上一轮，升一档' }, o)).toContain('⬆ 你在纠正')
  expect(routeStatus({ ...base, label: '评审/查根因', model: 'opus', piRole: 'review' }, o)).toContain('🚀 可派 pi（评审）')
  expect(routeStatus({ ...base, piRole: 'review' }, { ...o, showPi: false })).not.toContain('🚀')
  expect(routeStatus({ ...base, control: true }, o)).toBe('🧪 对照日  ·  不切换  ·  本来会用 🔵 Sonnet')
  expect(routeStatus({ label: '固定', model: 'haiku', lighterStreak: 0 }, o)).toBe('📌 固定  ·  🟢 Haiku')
  expect(piStatus('review', 'openai/gpt-6.1-sol')).toBe('🚀 pi  ·  评审  ·  gpt-6.1-sol 运行中')
})
