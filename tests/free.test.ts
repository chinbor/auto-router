import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { billingOf, buildRoles, DEFAULT_CONFIG, groupOf, liveChain, migrateFree, migrateModel, needsMigrate, pauseMinutesFor, pauseText } from '../hooks/config'
import { describeTool, parseShim, upgradeRecord } from '../hooks/core'
import { configVersion, LOGIC_VERSION, redoStats, summarize } from '../hooks/stats'
import { piStatus } from '../hooks/statusline'
import type { Config } from '../hooks/config'
import type { LogRecord } from '../hooks/stats'

// 测试宿主有 setTimeout，类型声明里没有：等后台派活写完日志、按钮发完请求
declare function setTimeout(fn: (v?: unknown) => void, ms: number): unknown

// 只剩 pi 一个通道（0.5）：免费模型经 magpie 网关在 pi 里用。按模型判断免费、同档排序、按上游组熔断、
// 下架跳过、旧配置迁移、旧记录兼容、面板标签

type On = Parameters<TestBody>[1]
type Run = { exitCode: number; stdout: string; stderr: string }
const full = (r: Run) => ({ ...r, isStdoutTruncated: false, isStderrTruncated: false })

const FREE = 'magpie/opencode-zen-free/'
const GLM = `${FREE}glm-5.3-flash-free`
const MIMO = `${FREE}mimo-v2.6-flash-free`
const DS_FREE = `${FREE}deepseek-v4.1-flash-free`
const VL = `${FREE}nemotron-3.5-super-vl-free`
const LIGHT = `${FREE}nemotron-3.5-lightning-free`
const BEAM = `${FREE}beam-free`
const FLINT = `${FREE}flint-40b-free`
/** magpie 里的付费模型：和免费的同一家，不同上游组 */
const MAGPIE_PAID = 'magpie/openai/gpt-6.1-mini'
const AG3 = 'agnes/agnes-3.0-flash'
const AG25 = 'agnes/agnes-2.5-flash'
const SOL = 'openai/gpt-6.1-sol'
const TERRA = 'openai/gpt-6.1-terra'
const DSF = 'cc-switch-deep-seek/deepseek-flash'

function freeConfig(roles: Config['pi']['roles'], fallback: string[] = []): Config {
  return {
    ...DEFAULT_CONFIG,
    claude: { ...DEFAULT_CONFIG.claude, categories: DEFAULT_CONFIG.claude.categories.map(({ piRole: _r, ...c }) => c) },
    pi: {
      ...DEFAULT_CONFIG.pi,
      defaultRole: Object.keys(roles)[0] as string,
      providers: { agnes: { enabled: true, billing: 'subscription' }, magpie: { enabled: true, billing: 'token' } },
      roles,
      fallback,
    },
  }
}

type Call = { argv: readonly string[]; env?: Record<string, string>; stdin?: string }

// npm 在 Windows 上生成的 .cmd 外壳（节选自真实文件）
const PI_SHIM =
  '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n' +
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n'

/** pi --list-models 的输出：表头一行，下面 provider 和 model 两列 */
const listing = (models: string[]) =>
  ['provider  model  context', ...models.map(m => `${m.split('/')[0]}  ${m.split('/').slice(1).join('/')}  200K`)].join('\n')

/** 引擎替身：配置文件、git、pi 各按给定的回答；记下每次派活的调用（不含列模型清单） */
function host(
  on: On,
  cfg: Config,
  answer: {
    pi?: (model: string, call: Call) => Run | 'timeout'
    /** pi --list-models 列出的模型；不给时列出配置里用到的全部 */
    list?: string[]
    /** 跑过一个模型之后工作区才有改动（模型改了一半） */
    dirtyAfterRun?: boolean
  } = {},
) {
  const calls: Call[] = []
  const writes: { path: string; text: string }[] = []
  const used = [...new Set([...Object.values(cfg.pi.roles).flatMap(r => r.models), ...cfg.pi.fallback])]
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__auto-router__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.after', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({ value: /auto-router\.json$|\\nodejs\\(node\.exe|node_modules\\)/.test(e.path) }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('pi.cmd')) return { value: PI_SHIM }
    if (e.path.endsWith('cc-safety-net\\package.json')) return { value: JSON.stringify({ pi: { extensions: ['./dist/pi/index.js'] } }) }
    if (e.path.endsWith('package.json')) return { deny: 'ENOENT' } as never
    return { value: JSON.stringify(cfg) }
  })
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: String(e.text) })
    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const argv = e.argv
    const call: Call = { argv, env: e.init?.env as Record<string, string> | undefined, stdin: e.init?.stdin as string | undefined }
    if (argv[0] === 'reg') return { value: full({ exitCode: 0, stdout: '', stderr: '' }) }
    if (argv[0] === 'where') return { value: full({ exitCode: 0, stdout: `C:\\nodejs\\${String(argv[1]).replace(/\.cmd$/, '')}\r\nC:\\nodejs\\${argv[1]}\r\n`, stderr: '' }) }
    if (argv.includes('echo %USERPROFILE%')) return { value: full({ exitCode: 0, stdout: 'C:\\Users\\me\r\n', stderr: '' }) }
    if (argv[0] === 'git') {
      if (argv.includes('rev-parse')) return { value: full({ exitCode: 0, stdout: 'D:/work\n', stderr: '' }) }
      const dirty = answer.dirtyAfterRun && calls.length > 0
      return { value: full({ exitCode: 0, stdout: argv.includes('status') && dirty ? ' M a.ts\n' : '', stderr: '' }) }
    }
    if (argv.includes('--list-models')) return { value: full({ exitCode: 0, stdout: listing(answer.list ?? used), stderr: '' }) }
    calls.push(call)
    const model = argv[argv.indexOf('--model') + 1] ?? ''
    const r = answer.pi?.(model, call) ?? { exitCode: 0, stdout: `done by ${model}`, stderr: '' }
    return r === 'timeout' ? ({ deny: 'aborted: still running after 600000ms' } as never) : { value: full(r) }
  })
  return { calls, writes }
}

const start = ($: Parameters<TestBody>[0], cwd = 'D:\\work') => $.session.start({ cwd, surface: 'desktop', isInteractive: true })
const dispatch = async ($: Parameters<TestBody>[0], input: Record<string, unknown>) =>
  String((await $.tool.call({ tool: 'mcp__auto-router__pi_dispatch', ...input } as never)).result)
const modelOf = (c: Call) => c.argv[c.argv.indexOf('--model') + 1]
const mountPane = ($: Parameters<TestBody>[0]) =>
  $.ui.mount({
    plugin: 'auto-router',
    component: 'Pane',
    requestId: 'auto-router',
    surface: 'mobile',
    props: { title: 'auto-router', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  } as never)

test('npm 外壳：读出真正的程序直接起（.js 交给 node），读不出来时返回空', () => {
  expect(parseShim('C:\\nodejs\\pi.cmd', PI_SHIM)).toEqual({
    path: 'C:\\nodejs\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js',
    node: 'C:\\nodejs\\node.exe',
  })
  expect(parseShim('C:\\x\\a.exe.cmd', '"%dp0%\\bin\\a.exe" %*')).toEqual({ path: 'C:\\x\\bin\\a.exe' })
  expect(parseShim('C:\\x\\a.cmd', '"%dp0%\\lib\\a.js" %*')).toEqual({ path: 'C:\\x\\lib\\a.js', node: 'node' })
  expect(parseShim('C:\\x\\a.cmd', '@echo off\r\nnode a.js')).toBeUndefined()
})

test('免费模型也走 pi：只读用 pi 自己的只读模式，不加载扩展、MCP、技能，只留安全扩展；结果头标 [pi]', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM], readOnly: true } })
  const { calls } = host(on, cfg)
  await start($)
  const out = await dispatch($, { task: '翻译', role: 'text' })
  const argv = calls[0]?.argv ?? []
  expect(argv.slice(0, 2)).toEqual(['C:\\nodejs\\node.exe', 'C:\\nodejs\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js'])
  expect(argv[argv.indexOf('--model') + 1]).toBe(GLM)
  for (const flag of ['--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates']) expect(argv).toContain(flag)
  expect(argv[argv.indexOf('-e') + 1]).toMatch(/\\\.pi\\agent\\npm\\node_modules\\cc-safety-net\\dist\\pi\\index\.js$/)
  expect(argv.join(' ')).toContain('--exclude-tools edit,write,bash')
  expect(argv.join(' ')).not.toMatch(/opencode run|--agent/)
  expect(out).toMatch(/^\[pi p\w+\] 完成 · magpie\/opencode-zen-free\/glm-5\.3-flash-free/)
})

test('按模型判断免费：magpie/opencode-zen-free/* 算免费，magpie 别的模型按提供商的计费方式；规则可改', () => {
  expect(billingOf(DEFAULT_CONFIG, GLM)).toBe('free')
  expect(billingOf(DEFAULT_CONFIG, MAGPIE_PAID)).toBe('token')
  expect(billingOf(DEFAULT_CONFIG, AG3)).toBe('subscription')
  expect(billingOf(DEFAULT_CONFIG, DSF)).toBe('token')
  // 没配的提供商按订阅
  expect(billingOf(DEFAULT_CONFIG, 'zhipu/glm-5')).toBe('subscription')
  // 自己加规则：通配符只认 *，点号不当正则
  const custom: Config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, freeModels: ['magpie/openai/*-mini', 'x/a.b'] } }
  expect(billingOf(custom, MAGPIE_PAID)).toBe('free')
  expect(billingOf(custom, GLM)).toBe('token')
  expect(billingOf(custom, 'x/aXb')).toBe('subscription')
})

test('上游组：三段的模型名取前两段，两段的就是提供商', () => {
  expect(groupOf(GLM)).toBe('magpie/opencode-zen-free')
  expect(groupOf(MAGPIE_PAID)).toBe('magpie/openai')
  expect(groupOf(AG3)).toBe('agnes')
})

test('同档排序：免费 → 订阅 → 按量付费；magpie 一家里的免费和付费模型分开排', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    pi: {
      ...DEFAULT_CONFIG.pi,
      providers: { magpie: { enabled: true, billing: 'token' }, sub: { enabled: true, billing: 'subscription' } },
      tiers: { [MAGPIE_PAID]: 'mid', 'sub/m': 'mid', [GLM]: 'mid' },
      strengths: {},
    },
  }
  // 长文阅读：中档免费 1 个、中档付费 1 个（订阅在按量前）
  expect(buildRoles(cfg).pi.roles.longctx?.models).toEqual([GLM, 'sub/m'])
  // 不限计费方式补到 2 个时也是 免费 › 订阅 › 按量
  const noFree: Config = { ...cfg, pi: { ...cfg.pi, freeModels: [] } }
  expect(buildRoles(noFree).pi.roles.longctx?.models).toEqual(['sub/m', MAGPIE_PAID])
})

test('默认角色顺序不变（只换了模型名）；长输出的编码、批量不让 32K 输出上限的免费模型打头', () => {
  const r = DEFAULT_CONFIG.pi.roles
  expect(r.review?.models).toEqual([SOL, TERRA, DS_FREE, DSF])
  expect(r.code?.models).toEqual([TERRA, SOL, GLM, DSF])
  expect(r.vision?.models).toEqual([TERRA, VL, SOL])
  expect(r.bulk?.models).toEqual([TERRA, GLM, AG3])
  expect(r.longctx?.models).toEqual([DS_FREE, DSF, TERRA])
  expect(r.quick?.models).toEqual([MIMO, AG3, TERRA])
  expect(r.text?.models).toEqual([GLM, AG3, AG25])
  expect(r.trivial?.models).toEqual([LIGHT, AG25, BEAM])
  expect(DEFAULT_CONFIG.pi.fallback).toEqual([AG3, AG25, MIMO, FLINT])
  const small = [GLM, MIMO, DS_FREE]
  for (const role of ['code', 'bulk', 'review', 'vision']) expect(small).not.toContain(r[role]?.models[0])
  // 自动生成的和手写的一致
  const built = buildRoles(DEFAULT_CONFIG)
  for (const [name, role] of Object.entries(r)) expect([name, built.pi.roles[name]?.models]).toEqual([name, role.models])
  expect(built.pi.fallback).toEqual(DEFAULT_CONFIG.pi.fallback)
})

test('熔断按上游组：免费组限流只停 magpie/opencode-zen-free，同链里 magpie 的付费模型照常试', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM, DS_FREE, MAGPIE_PAID, AG3], readOnly: true } })
  const { calls } = host(on, cfg, { pi: m => (m === GLM ? { exitCode: 1, stdout: '', stderr: 'Error: 429 Too Many Requests' } : { exitCode: 0, stdout: 'ok', stderr: '' }) })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, MAGPIE_PAID])
  expect(out).toContain(`${DS_FREE}: 跳过（magpie/opencode-zen-free 已暂停）`)
  expect(out).toContain(`完成 · ${MAGPIE_PAID}`)
  // 下一次派活：免费组还在暂停，直接从付费的开始
  calls.length = 0
  await dispatch($, { task: '再总结一次', role: 'text' })
  expect(calls.map(modelOf)).toEqual([MAGPIE_PAID])
})

test('magpie 连不上：按熔断处理，换链上的下一个模型', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM, MIMO, AG3], readOnly: true } })
  const { calls } = host(on, cfg, {
    pi: m => (m.startsWith(FREE) ? { exitCode: 1, stdout: '', stderr: 'Error: connect ECONNREFUSED 127.0.0.1:8080' } : { exitCode: 0, stdout: 'ok', stderr: '' }),
  })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, AG3])
  expect(out).toContain(`${MIMO}: 跳过（magpie/opencode-zen-free 已暂停）`)
})

test('别的提供商照旧：订阅失效按整家（两段名的上游组就是提供商）暂停', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [AG3, AG25, GLM], readOnly: true } })
  const { calls } = host(on, cfg, { pi: m => (m === AG3 ? { exitCode: 1, stdout: '', stderr: '401 Unauthorized' } : { exitCode: 0, stdout: 'ok', stderr: '' }) })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([AG3, GLM])
  expect(out).toContain(`${AG25}: 跳过（agnes 已暂停）`)
})

test('模型下架：pi --list-models 里没有了就跳过，记一笔，换下一个', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM, AG3], readOnly: true } })
  const { calls } = host(on, cfg, { list: [AG3, MIMO] })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([AG3])
  expect(out).toContain(`${GLM}: 跳过（pi --list-models 里已经没有这个模型`)
})

test('点名一个已下架的模型：不去调，直接说明；取不到清单时不按下架处理', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM], readOnly: true } })
  const gone = `${FREE}jev-1.13-free`
  const { calls } = host(on, cfg)
  await start($)
  const out = await dispatch($, { task: '打个招呼', model: gone, readOnly: true })
  expect(calls.length).toBe(0)
  expect(out).toContain(`${gone}: 跳过（pi --list-models 里已经没有这个模型`)
})

test('取不到 pi 的模型清单时不按下架处理', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM, AG3], readOnly: true } })
  const { calls } = host(on, cfg, { list: [] })
  await start($)
  await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM])
})

test('角色链运行时都失败了：接着试兜底，兜底里已下架的这时才记', async ($, on) => {
  const GONE = `${FREE}gone-free`
  const cfg = freeConfig({ text: { description: 't', models: [GLM], readOnly: true } }, [GONE, AG3])
  const { calls } = host(on, cfg, { list: [GLM, AG3], pi: m => (m === GLM ? { exitCode: 1, stdout: '', stderr: 'Unexpected server error' } : { exitCode: 0, stdout: 'ok', stderr: '' }) })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, AG3])
  expect(out).toContain(`text 的模型都没成功，接着试兜底 ${AG3}`)
  expect(out).toContain(`${GONE}: 跳过`)
  expect(out).toContain(`完成 · ${AG3}`)
})

test('超时：同一上游组后面的模型不再等，换别家', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM, DS_FREE, AG3], readOnly: true } })
  const { calls } = host(on, cfg, { pi: m => (m.startsWith(FREE) ? 'timeout' : { exitCode: 0, stdout: 'ok', stderr: '' }) })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, AG3])
  expect(out).toContain(`${DS_FREE}: 跳过（magpie/opencode-zen-free 刚超时）`)
})

test('可写任务失败时已经改了文件：不再换模型，交回去检查', async ($, on) => {
  const cfg = freeConfig({ code: { description: 'c', models: [GLM, AG3] } }, [AG25])
  const { calls } = host(on, cfg, { dirtyAfterRun: true, pi: () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) })
  await start($)
  const out = await dispatch($, { task: '改代码', role: 'code' })
  expect(calls.map(modelOf)).toEqual([GLM])
  expect(out).toContain('已经改了文件；没再换模型')
  expect(out).toContain('a.ts')
})

test('回答里提到限流不熔断，stderr 报 429 才熔断', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [AG3, AG25], readOnly: true } })
  const answer = 'x'.repeat(500) + ' 这个 bug 是 rate limit 处理不对'
  const { calls } = host(on, cfg, { pi: m => (m === AG3 ? { exitCode: 1, stdout: answer, stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' }) })
  await start($)
  const out = await dispatch($, { task: '查限流的 bug', role: 'text' })
  expect(calls.map(modelOf)).toEqual([AG3, AG25])
  expect(out).not.toContain('agnes 已暂停')
})

test('liveChain：skip 拦下的模型去掉，主链空了用兜底；免费组熔断不连累同一家的付费组', () => {
  const cfg = freeConfig({ quick: { description: 'q', models: [MIMO, MAGPIE_PAID] } }, [AG3])
  expect(liveChain(cfg, 'quick', 0, () => false, m => m === MIMO)).toEqual({ models: [MAGPIE_PAID], isFallback: false })
  expect(liveChain(cfg, 'quick', 0, k => k === 'magpie/opencode-zen-free').models).toEqual([MAGPIE_PAID])
  // 0.5 之前按整家暂停的旧记录照样认
  expect(liveChain(cfg, 'quick', 0, k => k === 'magpie')).toEqual({ models: [AG3], isFallback: true })
})

/** 0.4 写下的配置文件：opencode 提供商、opencode/ 模型名、oc: 提供商、顶层 opencode 段，没有 freeModels */
function v04(): Config & { opencode?: unknown } {
  const old = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config & { opencode?: unknown }
  const toOld = (m: string) => m.replace(FREE, 'opencode/')
  const { magpie: _m, ...providers } = old.pi.providers
  old.pi.providers = {
    ...providers,
    opencode: { enabled: true, billing: 'free' },
    'oc:zai': { enabled: true, billing: 'subscription' },
    'xfyun-spark': { enabled: true, billing: 'free' },
  }
  delete (old.pi as Partial<Config['pi']>).freeModels
  for (const r of Object.values(old.pi.roles)) r.models = r.models.map(toOld)
  // 用户手调过：格式整理用了讯飞，文本里加了一个 oc: 模型
  old.pi.roles.trivial = { ...old.pi.roles.trivial, models: ['opencode/nemotron-3.5-lightning-free', 'xfyun-spark/spark-x2.6', AG25, 'opencode/beam-free'] } as never
  old.pi.roles.text = { ...old.pi.roles.text, models: ['oc:zai/glm-5', 'opencode/glm-5.3-flash-free', AG3] } as never
  old.pi.fallback = old.pi.fallback.map(toOld)
  old.pi.tiers = { ...Object.fromEntries(Object.entries(old.pi.tiers).map(([m, t]) => [toOld(m), t])), 'oc:zai/glm-5': 'mid', 'xfyun-spark/spark-x2.6': 'light' }
  old.pi.strengths = Object.fromEntries(Object.entries(old.pi.strengths).map(([m, s]) => [toOld(m), s]))
  old.opencode = { allowDirs: [], logged: [] }
  return old
}

test('旧配置迁移（0.4）：opencode/ 换成 magpie 的写法，去掉 opencode 和 oc: 提供商，顺序不动，写回文件并留 .bak', async ($, on) => {
  const old = v04()
  expect(needsMigrate(old)).toBe(true)
  const { writes } = host(on, old)
  await start($)
  const saved = writes.filter(w => w.path.endsWith('auto-router.json')).map(w => JSON.parse(w.text) as Config & { opencode?: unknown })
  expect(saved.length).toBeGreaterThan(0)
  const cfg = saved[saved.length - 1] as Config & { opencode?: unknown }
  expect(Object.keys(cfg.pi.providers).sort()).toEqual(['agnes', 'cc-switch-deep-seek', 'magpie', 'openai', 'xfyun-spark'])
  expect(cfg.pi.providers.magpie).toEqual(DEFAULT_CONFIG.pi.providers.magpie)
  expect(cfg.pi.freeModels).toEqual(['magpie/opencode-zen-free/*'])
  expect(cfg.pi.roles.code?.models).toEqual(DEFAULT_CONFIG.pi.roles.code?.models)
  expect(cfg.pi.roles.trivial?.models).toEqual([LIGHT, 'xfyun-spark/spark-x2.6', AG25, BEAM])
  expect(cfg.pi.roles.text?.models).toEqual([GLM, AG3])
  expect(cfg.pi.fallback).toEqual(DEFAULT_CONFIG.pi.fallback)
  expect(cfg.pi.tiers[GLM]).toBe('mid')
  expect(cfg.pi.tiers['xfyun-spark/spark-x2.6']).toBe('light')
  expect(Object.keys(cfg.pi.tiers).some(m => m.startsWith('opencode/') || m.startsWith('oc:'))).toBe(false)
  expect(cfg.pi.strengths[GLM]).toEqual(['code', 'bulk', 'text'])
  expect(cfg.opencode).toBeUndefined()
  expect(writes.some(w => w.path.endsWith('auto-router.json.bak'))).toBe(true)
  // 写回后不再迁移
  expect(needsMigrate(cfg)).toBe(false)
})

/** 0.2.x 写下的配置文件：只有 pi 的几家，没有免费模型 */
function v02(roles?: Record<string, string[]>): Config {
  const old = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config
  const { magpie: _m, ...providers } = old.pi.providers
  old.pi.providers = providers
  old.pi.tiers = Object.fromEntries(Object.entries(old.pi.tiers).filter(([m]) => !m.startsWith(FREE)))
  delete (old.pi as Partial<Config['pi']>).strengths
  delete (old.pi as Partial<Config['pi']>).freeModels
  const legacy: Record<string, string[]> = roles ?? {
    review: [SOL, TERRA, DSF],
    code: [TERRA, SOL, DSF],
    vision: [TERRA, SOL, DSF],
    bulk: [TERRA, AG3, DSF],
    longctx: [DSF, TERRA],
    quick: [AG3, TERRA, DSF],
    text: [AG3, AG25, DSF],
    trivial: [AG25, AG3, DSF],
  }
  for (const [name, models] of Object.entries(legacy)) if (old.pi.roles[name]) old.pi.roles[name] = { ...old.pi.roles[name], models } as never
  old.pi.fallback = [AG3, AG25]
  return old
}

test('旧配置迁移（0.2）：还是旧默认角色时加上免费模型并按档位重排；手调过的不动', () => {
  const merged = (old: Config) => ({ ...old, pi: { ...DEFAULT_CONFIG.pi, ...old.pi, strengths: old.pi.strengths ?? {} } }) as Config
  const { cfg, note } = migrateFree(merged(v02()))
  expect(cfg.pi.roles.text?.models).toEqual(DEFAULT_CONFIG.pi.roles.text?.models)
  expect(cfg.pi.fallback).toEqual(DEFAULT_CONFIG.pi.fallback)
  expect(cfg.pi.tiers[GLM]).toBe('mid')
  expect(note).toContain('0.5')
  const tuned = migrateFree(merged(v02({ code: [SOL] })))
  expect(tuned.cfg.pi.roles.code?.models).toEqual([SOL])
  expect(tuned.cfg.pi.providers.magpie?.enabled).toBe(true)
  expect(tuned.cfg.pi.tiers[GLM]).toBe('mid')
})

test('模型名迁移：opencode/ 换成 magpie 的写法，oc: 去掉，其余原样', () => {
  expect(migrateModel('opencode/glm-5.3-flash-free')).toBe(GLM)
  expect(migrateModel('oc:zai/glm-5')).toBeUndefined()
  expect(migrateModel(AG3)).toBe(AG3)
  expect(needsMigrate({ pi: DEFAULT_CONFIG.pi })).toBe(false)
  expect(needsMigrate({})).toBe(false)
})

test('旧记录兼容：日志里的 ch: opencode 和 opencode/ 模型名照常统计，不报错', () => {
  const recs = [
    { t: 'pi', ts: 10, role: 'text', model: 'opencode/glm-5.3-flash-free', ok: true, ms: 1, ch: 'opencode' },
    { t: 'pi', ts: 10, role: 'text', model: GLM, ok: true, ms: 1 },
    { t: 'pi', ts: 10, role: 'text', model: AG3, ok: false, ms: 1 },
  ] as unknown as LogRecord[]
  const s = summarize(recs, 0)
  expect(s.pi.total).toBe(3)
  expect(s.pi.ok).toBe(2)
  expect((s.pi as Record<string, unknown>).byChannel).toBeUndefined()
})

test('标签：工具说明不再分通道，状态行统一写 pi，日志记录不写通道', async ($, on) => {
  const desc = describeTool(DEFAULT_CONFIG)
  expect(desc).toContain(`text [read-only]: pure text: translate, summarize, rewrite, write commit messages, name things (models: ${GLM} -> ${AG3} -> ${AG25})`)
  expect(desc).not.toMatch(/\[pi\]|\[opencode\]|opencode run/)
  expect(piStatus('text', GLM)).toBe('🚀 pi  ·  文本  ·  glm-5.3-flash-free 运行中')
  expect(piStatus('review', SOL)).toBe('🚀 pi  ·  评审  ·  gpt-6.1-sol 运行中')

  const cfg = freeConfig({ text: { description: 't', models: [GLM], readOnly: true } })
  const { writes } = host(on, cfg)
  on('session.id', () => ({ value: 'fr123456789' }))
  await start($)
  await dispatch($, { task: '总结', role: 'text' })
  const piLine = () => (writes.filter(w => w.path.endsWith('.jsonl')).pop()?.text ?? '').split('\n').find(l => l.includes('"t":"pi"'))
  for (let i = 0; i < 50 && !piLine(); i++) await new Promise(r => setTimeout(r, 0))
  const rec = JSON.parse(piLine() ?? '{}') as Record<string, unknown>
  expect(rec.model).toBe(GLM)
  expect(rec.ch).toBeUndefined()
})

test('外派模型页：不分通道，magpie 列在提供商里，免费模型标 [免费]，能测连通', async ($, on) => {
  host(on, DEFAULT_CONFIG, { list: [GLM, MIMO, MAGPIE_PAID, AG3, SOL] })
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-pi' })
  let hit
  for (let i = 0; i < 30 && !hit; i++) hit = await ui.find({ type: 'Text', text: /magpie（本地网关）/ })
  expect(hit).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /① 提供商和模型/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /② 派活顺序/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /通道/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^\[免费\]$/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'conn-magpie' })).toBeDefined()
  await ui.unmount()
})

test('面板“测一下”：每个模型发一句，标出能不能用；不进任务列表', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM, AG3], readOnly: true } })
  const { calls } = host(on, cfg, {
    pi: m => (m === AG3 ? { exitCode: 1, stdout: '', stderr: 'Error: 401 invalid api key' } : { exitCode: 0, stdout: 'OK', stderr: '' }),
  })
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-pi' })
  await ui.press({ key: 'probe' })
  let done
  for (let i = 0; i < 80 && !done; i++) done = await ui.find({ type: 'Text', text: /测过/ })
  expect(done).toBeDefined()
  expect(calls.map(modelOf).sort()).toEqual([AG3, GLM].sort())
  expect(calls.every(c => c.stdin === 'Reply with the single word OK.')).toBe(true)
  expect(await ui.find({ type: 'Text', text: /✗ Error: 401/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
  await ui.press({ key: 'tab-jobs' })
  let empty
  for (let i = 0; i < 20 && !empty; i++) empty = await ui.find({ type: 'Text', text: /还没有任务/ })
  expect(empty).toBeDefined()
  await ui.unmount()
})

test('免费额度用完至少停 6 小时；暂停提示指向「外派模型」页，连不上不提退订', () => {
  const limit = 'Error: 429 OpenCode Zen Free: Free usage limit reached'
  expect(pauseMinutesFor(limit, 30)).toBe(360)
  expect(pauseMinutesFor('Error: 429 Too Many Requests', 30)).toBe(30)
  expect(pauseMinutesFor(limit, 0)).toBe(0)
  expect(pauseMinutesFor(limit, 600)).toBe(600)
  expect(pauseText(GLM, limit, false, '11-02 20:00')).toBe(`${GLM} 免费额度用完了，暂停到 11-02 20:00，其他免费模型照常用（免费额度按模型算）。`)
  const auth = pauseText('agnes', '401 Unauthorized', false, '11-02 20:00')
  expect(auth).toContain('「外派模型」页 ①')
  expect(auth).not.toContain('提供商页')
  const conn = pauseText('agnes', 'connect ECONNREFUSED', true, '11-02 20:00')
  expect(conn).toContain('agnes 连不上')
  expect(conn).not.toContain('退订')
})

test('免费额度用完：只停这一个模型，停到 6 小时后；同组别的免费模型照常用', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM, MIMO, AG3], readOnly: true } })
  const { calls } = host(on, cfg, {
    pi: m => (m === GLM ? { exitCode: 1, stdout: '', stderr: 'Error: 429\nOpenCode Zen Free: Free usage limit reached, resets in 11h' } : { exitCode: 0, stdout: 'ok', stderr: '' }),
  })
  await start($)
  const t0 = Date.now()
  await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, MIMO])
  // 下一次：glm 还停着，同组的 mimo 照常先用
  calls.length = 0
  await dispatch($, { task: '再总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([MIMO])
  const ui = await mountPane($)
  await ui.press({ key: 'tab-pi' })
  let hit
  for (let i = 0; i < 30 && !hit; i++) hit = await ui.find({ type: 'Text', text: /恢复\s+magpie\/opencode-zen-free\/glm-5\.3-flash-free/ })
  expect(hit).toBeDefined()
  const m = /(\d\d)-(\d\d) (\d\d):(\d\d)/.exec(String((hit as { text?: string })?.text ?? ''))
  expect(m).toBeTruthy()
  // 恢复时间（北京时间）离现在约 6 小时，不是 30 分钟
  const d = new Date(t0 + 8 * 3600_000)
  const until = Date.UTC(d.getUTCFullYear(), Number(m?.[1]) - 1, Number(m?.[2]), Number(m?.[3]), Number(m?.[4])) - 8 * 3600_000
  expect(Math.abs(until - (t0 + 360 * 60_000))).toBeLessThan(2 * 60_000)
  await ui.unmount()
})

test('配置版本不带插件版本：0.5 升级后和 0.4.0 的样本是同一版', () => {
  expect(LOGIC_VERSION).toBe('0.4.0')
  expect(configVersion(DEFAULT_CONFIG)).toBe(configVersion(DEFAULT_CONFIG, '0.4.0'))
  expect(configVersion(DEFAULT_CONFIG)).toMatch(/^0\.4\.0-[0-9a-f]{6}$/)
})

test('旧日志里的 opencode/<x> 读成新名字：任务数、返工合成一行', () => {
  const old = { t: 'pi', ts: 1, role: 'text', model: 'opencode/glm-5.3-flash-free', ok: true, ms: 1 } as LogRecord
  const neu = { t: 'pi', ts: 2, role: 'text', model: GLM, ok: true, ms: 1, redo: 'opencode/glm-5.3-flash-free' } as LogRecord
  const rows = redoStats([old, neu].map(upgradeRecord), 0)
  expect(rows).toEqual([{ model: GLM, ok: 2, redo: 1 }])
  const turn = { t: 'turn', ts: 3 } as LogRecord
  expect(upgradeRecord(turn)).toBe(turn)
  const same = { t: 'pi', ts: 4, role: 'text', model: AG3, ok: true, ms: 1 } as LogRecord
  expect(upgradeRecord(same)).toBe(same)
})

test('测连通先挑免费模型：magpie 下付费的排在前面也测免费组', async ($, on) => {
  const base = freeConfig({ text: { description: 't', models: [GLM], readOnly: true } })
  const cfg = { ...base, pi: { ...base.pi, tiers: { [MAGPIE_PAID]: 'mid' as const, ...base.pi.tiers } } }
  const { calls } = host(on, cfg, { list: [MAGPIE_PAID, GLM, AG3] })
  await start($)
  const ui = await mountPane($)
  await ui.press({ key: 'tab-pi' })
  let btn
  for (let i = 0; i < 30 && !btn; i++) btn = await ui.find({ type: 'Button', key: 'conn-magpie' })
  await ui.press({ key: 'conn-magpie' })
  for (let i = 0; i < 50 && !calls.length; i++) await new Promise(r => setTimeout(r, 0))
  expect(calls.map(modelOf)[0]).toBe(GLM)
  await ui.unmount()
})

test('迁移过又被旧版会话写回 opencode 条目：清掉旧条目，0.5 里设的档位和 freeModels 不动', () => {
  const polluted = {
    ...DEFAULT_CONFIG,
    pi: {
      ...DEFAULT_CONFIG.pi,
      providers: { ...DEFAULT_CONFIG.pi.providers, opencode: { enabled: true, billing: 'free' as const } },
      tiers: { ...DEFAULT_CONFIG.pi.tiers, [GLM]: 'light' as const, 'opencode/glm-5.3-flash-free': 'mid' as const },
      strengths: { ...DEFAULT_CONFIG.pi.strengths, 'opencode/glm-5.3-flash-free': ['old'] },
      freeModels: ['magpie/opencode-zen-free/glm-*'],
    },
  } as Config
  expect(needsMigrate(polluted)).toBe(true)
  expect(needsMigrate(DEFAULT_CONFIG)).toBe(false)
  const { cfg, note } = migrateFree(polluted, true)
  expect(Object.keys(cfg.pi.providers)).not.toContain('opencode')
  expect(Object.keys(cfg.pi.tiers).some(m => m.startsWith('opencode/'))).toBe(false)
  expect(Object.keys(cfg.pi.strengths ?? {}).some(m => m.startsWith('opencode/'))).toBe(false)
  expect(cfg.pi.tiers[GLM]).toBe('light')
  expect(cfg.pi.freeModels).toEqual(['magpie/opencode-zen-free/glm-*'])
  expect(cfg.pi.roles).toEqual(polluted.pi.roles)
  expect(note).toContain('旧条目')
  expect(needsMigrate(cfg)).toBe(false)
})

test('任务页：完成但中间换过模型的写出前面为什么没成功；模型名只显示最后一段', async ($, on) => {
  const cfg = freeConfig({ text: { description: 't', models: [GLM, AG3], readOnly: true } })
  host(on, cfg, { pi: m => (m === GLM ? { exitCode: 1, stdout: '', stderr: 'Connection error.' } : { exitCode: 0, stdout: 'ok', stderr: '' }) })
  await start($)
  await dispatch($, { task: '翻译一句话', role: 'text' })
  const ui = await mountPane($)
  await ui.press({ key: 'tab-jobs' })
  let hit
  for (let i = 0; i < 30 && !hit; i++) hit = await ui.find({ type: 'Text', text: /先试的 glm-5\.3-flash-free 没成功：连不上.*换成 agnes-3\.0-flash 做完/ })
  expect(hit).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /opencode-zen-free\/glm/ })).toBeUndefined()
  await ui.unmount()
})
