import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { buildRoles, channelOf, DEFAULT_CONFIG, liveChain, migrateOpencode, ocModelArg, parseOpencodeModels, privacyBlock, tagged } from '../hooks/config'
import { describeTool, parseOpencodeRun, parseShim } from '../hooks/core'
import { channelOfRecord, summarize } from '../hooks/stats'
import { piStatus } from '../hooks/statusline'
import type { Config } from '../hooks/config'

// opencode 通道：分流、只读限制、免费排序、下架跳过、隐私开关、旧配置迁移、通道标签

type On = Parameters<TestBody>[1]
type Run = { exitCode: number; stdout: string; stderr: string }
const full = (r: Run) => ({ ...r, isStdoutTruncated: false, isStderrTruncated: false })

const GLM = 'opencode/glm-5.3-flash-free'
const MIMO = 'opencode/mimo-v2.6-flash-free'
const OC_DS = 'opencode/deepseek-v4.1-flash-free'
const AG3 = 'agnes/agnes-3.0-flash'
const AG25 = 'agnes/agnes-2.5-flash'
const ALL_OC = ['opencode/beam-free', 'opencode/big-pickle', OC_DS, 'opencode/flint-40b-free', GLM, MIMO, 'opencode/nemotron-3.5-lightning-free', 'opencode/nemotron-3.5-super-vl-free']

/** opencode run --format json 的一次成功输出：先读文件，再给结论 */
const events = (text: string) =>
  [
    { type: 'step_start', part: { type: 'step-start' } },
    { type: 'tool_use', part: { type: 'tool', tool: 'read', state: { status: 'completed', output: 'api key: none here' } } },
    { type: 'text', part: { type: 'text', text: '我先读一下文件。' } },
    { type: 'step_finish', part: { type: 'step-finish' } },
    { type: 'step_start', part: { type: 'step-start' } },
    { type: 'text', part: { type: 'text', text } },
    { type: 'step_finish', part: { type: 'step-finish' } },
  ]
    .map(e => JSON.stringify(e))
    .join('\n')

function ocConfig(roles: Config['pi']['roles'], over: Partial<Config['opencode']> = {}, fallback: string[] = []): Config {
  return {
    ...DEFAULT_CONFIG,
    claude: { ...DEFAULT_CONFIG.claude, categories: DEFAULT_CONFIG.claude.categories.map(({ piRole: _r, ...c }) => c) },
    pi: {
      ...DEFAULT_CONFIG.pi,
      defaultRole: Object.keys(roles)[0] as string,
      providers: { agnes: { enabled: true, billing: 'subscription' }, opencode: { enabled: true, billing: 'free' } },
      roles,
      fallback,
    },
    opencode: { ...DEFAULT_CONFIG.opencode, ...over },
  }
}

type Call = { argv: readonly string[]; env?: Record<string, string>; stdin?: string }

// npm 在 Windows 上生成的 .cmd 外壳（节选自真实文件）
const OC_SHIM = '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n'
const PI_SHIM =
  '@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n' +
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n'
const OC_EXE = 'C:\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe'

/** 引擎替身：配置文件、git、pi、opencode 各按给定的回答；记下每次调用 */
function host(
  on: On,
  cfg: Config,
  answer: {
    pi?: (model: string) => Run | 'timeout'
    oc?: (model: string, call: Call) => Run | 'timeout'
    ocList?: string[]
    dirty?: boolean
    /** 跑过一个模型之后工作区才有改动（模型改了一半） */
    dirtyAfterRun?: boolean
    /** opencode 升级后外壳指向新位置，旧的 exe 没了 */
    moved?: () => boolean
    ocVersion?: string
  } = {},
) {
  const calls: Call[] = []
  const writes: { path: string; text: string }[] = []
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__auto-router__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.after', () => new Promise(() => {}))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => ({
    value: answer.moved?.() && e.path === OC_EXE ? false : /auto-router\.json$|\\nodejs\\(node\.exe|node_modules\\)/.test(e.path),
  }))
  on('fs.read', (_, e) => {
    if (e.path.endsWith('opencode.cmd')) return { value: answer.moved?.() ? OC_SHIM.replace('opencode-ai', '@opencode\\cli') : OC_SHIM }
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
      const dirty = answer.dirty || (answer.dirtyAfterRun && calls.length > 0)
      return { value: full({ exitCode: 0, stdout: argv.includes('status') && dirty ? ' M a.ts\n' : '', stderr: '' }) }
    }
    const isOc = /opencode\.exe$/.test(argv[0] ?? '')
    if (isOc && argv.includes('--version')) return { value: full({ exitCode: 0, stdout: `opencode v${answer.ocVersion ?? '2.2.5'}\n`, stderr: '' }) }
    if (isOc && argv.includes('models')) {
      return { value: full({ exitCode: 0, stdout: (answer.ocList ?? ALL_OC).join('\n') + '\n', stderr: '' }) }
    }
    calls.push(call)
    const reply = (r: Run | 'timeout') => (r === 'timeout' ? ({ deny: 'aborted: still running after 600000ms' } as never) : { value: full(r) })
    if (isOc) {
      const model = argv[argv.indexOf('-m') + 1] ?? ''
      return reply(answer.oc?.(model, call) ?? { exitCode: 0, stdout: events(`done by ${model}`), stderr: '' })
    }
    const model = argv[argv.indexOf('--model') + 1] ?? ''
    return reply(answer.pi?.(model) ?? { exitCode: 0, stdout: `done by ${model}`, stderr: '' })
  })
  return { calls, writes }
}

const start = ($: Parameters<TestBody>[0], cwd = 'D:\\work') => $.session.start({ cwd, surface: 'desktop', isInteractive: true })
const dispatch = async ($: Parameters<TestBody>[0], input: Record<string, unknown>) =>
  String((await $.tool.call({ tool: 'mcp__auto-router__pi_dispatch', ...input } as never)).result)
const modelOf = (c: Call) => c.argv[c.argv.indexOf(c.argv.includes('-m') ? '-m' : '--model') + 1]

test('通道：opencode/ 开头的走 opencode run，其余走 pi', () => {
  expect(channelOf(GLM)).toBe('opencode')
  expect(channelOf('openai/gpt-6.1-sol')).toBe('pi')
  expect(tagged(GLM)).toBe(`[opencode] ${GLM}`)
  expect(tagged(AG3)).toBe(`[pi] ${AG3}`)
})

test('npm 外壳：读出真正的程序直接起（.exe 直接起，.js 交给 node），读不出来时返回空', () => {
  expect(parseShim('C:\\nodejs\\opencode.cmd', OC_SHIM)).toEqual({ path: OC_EXE })
  expect(parseShim('C:\\nodejs\\pi.cmd', PI_SHIM)).toEqual({
    path: 'C:\\nodejs\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js',
    node: 'C:\\nodejs\\node.exe',
  })
  expect(parseShim('C:\\x\\a.cmd', '"%dp0%\\lib\\a.js" %*')).toEqual({ path: 'C:\\x\\lib\\a.js', node: 'node' })
  expect(parseShim('C:\\x\\a.cmd', '@echo off\r\nnode a.js')).toBeUndefined()
})

test('opencode 输出：取最后一步的文字，error 事件单独返回', () => {
  expect(parseOpencodeRun('\uFEFF' + events('结论：没问题'))).toEqual({ text: '结论：没问题', error: undefined })
  const err = JSON.stringify({ type: 'error', error: { name: 'UnknownError', data: { message: 'Rate limit exceeded' } } })
  expect(parseOpencodeRun(err)).toEqual({ text: '', error: 'Rate limit exceeded' })
})

test('只读角色走 opencode：直接起 opencode.exe，用注入的只读代理（不是 plan），只放开读和搜索；隔离用户全局配置；结果头标 [opencode]', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM, AG3], readOnly: true } })
  const { calls } = host(on, cfg)
  await start($)
  const out = await dispatch($, { task: '总结 README', role: 'text', readOnly: false })

  expect(calls.length).toBe(1)
  const c = calls[0] as Call
  // 不经 cmd /c：超时才杀得掉真正干活的进程
  expect(c.argv[0]).toBe(OC_EXE)
  // 2.x：--standalone 起私有服务（常驻服务收不到注入的代理），目录靠 cwd
  expect(c.argv.slice(1).join(' ')).toBe(`run -m ${GLM} --format json --agent auto-router-readonly --standalone`)
  expect(c.stdin).toBe('总结 README')
  // 不读用户全局的 opencode 配置（MCP、插件、全局 AGENTS.md），也不读 ~/.claude 下的技能和 CLAUDE.md
  expect(c.env?.XDG_CONFIG_HOME).toMatch(/\\\.claude\\auto-router\\opencode$/)
  expect(c.env?.OPENCODE_DISABLE_CLAUDE_CODE).toBe('1')
  expect(c.env?.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
  const agent = JSON.parse(c.env?.OPENCODE_CONFIG_CONTENT ?? '{}').agent['auto-router-readonly']
  expect(agent.permission['*']).toBe('deny')
  expect(Object.entries(agent.permission).filter(([, v]) => v !== 'deny').map(([k]) => k).sort()).toEqual(['glob', 'grep', 'list', 'read'])
  expect(agent.permission.read['*.env']).toBe('deny')
  expect(out).toMatch(/^\[opencode p\w+\] 完成 · opencode\/glm-5\.3-flash-free/)
  expect(out).toContain(`done by ${GLM}`)
  expect(out).not.toContain('我先读一下文件')
})

test('可写角色走 opencode：要求干净的 git 工作区，不注入只读代理', async ($, on) => {
  const cfg = ocConfig({ code: { description: 'c', models: [GLM] } })
  const dirty = host(on, cfg, { dirty: true })
  await start($)
  expect(await dispatch($, { task: '改 a.ts', role: 'code' })).toContain('没派')
  expect(dirty.calls.length).toBe(0)
})

test('可写角色走 opencode：干净仓库里用注入的可写代理，bash 明确放开（不继承用户的 ask，免得卡住），提交和推送拦下', async ($, on) => {
  const cfg = ocConfig({ code: { description: 'c', models: [GLM] } })
  const { calls } = host(on, cfg)
  await start($)
  const out = await dispatch($, { task: '改 a.ts', role: 'code' })
  expect(calls[0]?.argv.slice(-3)).toEqual(['--agent', 'auto-router-write', '--standalone'])
  const perm = JSON.parse(calls[0]?.env?.OPENCODE_CONFIG_CONTENT ?? '{}').agent['auto-router-write'].permission
  expect(perm['*']).toBe('deny')
  expect(perm.edit).toBe('allow')
  // 先全放开、后面的拦截优先（opencode 取最后一条匹配的规则）
  expect(Object.entries(perm.bash)[0]).toEqual(['*', 'allow'])
  for (const p of ['git commit*', 'git push*', 'git reset*', 'rm -r*', 'Remove-Item*-Recurse*', 'rd /s*']) expect(perm.bash[p]).toBe('deny')
  expect(perm.task).toBeUndefined()
  expect(out).toContain('[opencode ')
  expect(out).toContain('（工作区没有改动）')
})

test('pi 的模型照旧走 pi：直接用 node 起 cli.js，不加载扩展、MCP、技能，只留安全扩展；结果头标 [pi]', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [AG3], readOnly: true } })
  const { calls } = host(on, cfg)
  await start($)
  const out = await dispatch($, { task: '翻译', role: 'text' })
  const argv = calls[0]?.argv ?? []
  expect(argv.slice(0, 2)).toEqual(['C:\\nodejs\\node.exe', 'C:\\nodejs\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js'])
  for (const flag of ['--no-mcp', '--no-extensions', '--no-skills', '--no-prompt-templates']) expect(argv).toContain(flag)
  expect(argv[argv.indexOf('-e') + 1]).toMatch(/\\\.pi\\agent\\npm\\node_modules\\cc-safety-net\\dist\\pi\\index\.js$/)
  expect(argv.filter(a => a === '-e').length).toBe(1)
  expect(argv.join(' ')).toContain('--exclude-tools edit,write,bash')
  expect(out).toMatch(/^\[pi p\w+\] 完成 · agnes\/agnes-3\.0-flash/)
})

test('免费模型下架：opencode models 里没有就跳过，记一笔，换下一个', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM, AG3], readOnly: true } })
  const { calls } = host(on, cfg, { ocList: ALL_OC.filter(m => m !== GLM) })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([AG3])
  expect(out).toContain('下架')
  expect(out).toContain('[pi ')
})

test('点名一个已下架的免费模型：不去调，直接说明', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [AG3], readOnly: true } })
  const { calls } = host(on, cfg)
  await start($)
  const out = await dispatch($, { task: '打个招呼', model: 'opencode/jev-1.13-free', readOnly: true })
  expect(calls.length).toBe(0)
  expect(out).toContain('opencode/jev-1.13-free: 跳过（opencode 里已经没有这个模型')
})

test('兜底里被隐私开关挡下的模型：没用到兜底时不记', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM], readOnly: true } }, {}, [MIMO])
  host(on, cfg)
  await start($)
  expect(await dispatch($, { task: '总结', role: 'text' })).not.toContain(MIMO)
})

test('opencode 没装（取不到模型列表）时不按下架处理', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM, AG3], readOnly: true } })
  const { calls } = host(on, cfg, { ocList: [] })
  await start($)
  await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM])
})

test('opencode 限流：整个 opencode 暂停，同链后面的 opencode 模型也跳过', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM, OC_DS, AG3], readOnly: true } })
  const limited = JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'Rate limit exceeded, try later' } } })
  const { calls } = host(on, cfg, { oc: () => ({ exitCode: 1, stdout: limited, stderr: '' }) })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, AG3])
  expect(out).toContain('opencode 已暂停')
})

// opencode 2.2.5 实测：免费额度按模型算，error 带 type 和 retryAfterMs
const FREE_LIMIT = JSON.stringify({
  type: 'error',
  error: { type: 'provider.free-limit', message: 'Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.', status: 429, retryAfterMs: 46_262_000 },
})

test('opencode 2.x 报错：读出 error.message 和恢复时间', () => {
  expect(parseOpencodeRun(FREE_LIMIT)).toEqual({ text: '', error: expect.stringContaining('Free usage limit reached'), freeLimit: true, retryAfterMs: 46_262_000 })
})

test('免费额度用完：只停这个模型（按报的恢复时间），同链别的 opencode 免费模型照常试', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM, OC_DS, AG3], readOnly: true } })
  const { calls } = host(on, cfg, { oc: m => (m === GLM ? { exitCode: 1, stdout: FREE_LIMIT, stderr: '' } : { exitCode: 0, stdout: events('done'), stderr: '' }) })
  await start($)
  const t0 = Date.now()
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, OC_DS])
  expect(out).toContain(`完成 · ${OC_DS}`)
  // 第二次派活：glm 已暂停，直接跳过
  calls.length = 0
  await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([OC_DS])
  expect(Date.now() - t0).toBeLessThan(46_262_000)
})

test('面板“测一下”：每个模型发一句，标出能不能用；额度用完的按报的时间暂停；不进任务列表', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM, OC_DS, AG3], readOnly: true } })
  const { calls } = host(on, cfg, {
    oc: m => (m === GLM ? { exitCode: 1, stdout: FREE_LIMIT, stderr: '' } : { exitCode: 0, stdout: events('OK'), stderr: '' }),
    pi: () => ({ exitCode: 1, stdout: '', stderr: 'Error: 401 invalid api key' }),
  })
  await start($)
  const ui = await $.ui.mount({
    plugin: 'auto-router',
    component: 'Pane',
    requestId: 'auto-router',
    surface: 'mobile',
    props: { title: 'auto-router', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} },
  } as never)
  await ui.press({ key: 'tab-pi' })
  await ui.press({ key: 'probe' })
  let done
  for (let i = 0; i < 80 && !done; i++) done = await ui.find({ type: 'Text', text: /测过/ })
  expect(done).toBeDefined()
  // 切到外派页时会顺带列一次 pi 的模型（没有 stdin），不算检测
  const probes = calls.filter(c => c.stdin !== undefined)
  expect(probes.map(modelOf).sort()).toEqual([AG3, OC_DS, GLM].sort())
  expect(probes.every(c => c.stdin === 'Reply with the single word OK.')).toBe(true)
  // 额度用完的按报的时间暂停，链里只标 ⏸，恢复时间在顶部合成一条；测不通的标 ✗ 和报错；测通的标 ✓
  expect(await ui.find({ type: 'Text', text: /[\d-]+ \d+:\d+ 恢复 {2}glm-5\.3-flash-free/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^⏸$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✗ Error: 401/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
  await ui.press({ key: 'tab-jobs' })
  let empty
  for (let i = 0; i < 20 && !empty; i++) empty = await ui.find({ type: 'Text', text: /还没有任务/ })
  expect(empty).toBeDefined()
  await ui.unmount()
})

test('角色链运行时都失败了：接着试兜底，兜底里被挡下的这时才记', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM], readOnly: true } }, {}, [MIMO, AG3])
  const { calls } = host(on, cfg, { oc: () => ({ exitCode: 1, stdout: '', stderr: 'Unexpected server error' }) })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, AG3])
  expect(out).toContain(`text 的模型都没成功，接着试兜底 ${AG3}`)
  expect(out).toContain(`${MIMO}: 跳过`)
  expect(out).toContain(`完成 · ${AG3}`)
})

test('超时：同一家后面的模型不再等，换别家', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM, OC_DS, AG3], readOnly: true } })
  const { calls } = host(on, cfg, { oc: () => 'timeout' })
  await start($)
  const out = await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, AG3])
  expect(out).toContain(`${OC_DS}: 跳过（opencode 刚超时）`)
})

test('可写任务失败时已经改了文件：不再换模型，交回去检查', async ($, on) => {
  const cfg = ocConfig({ code: { description: 'c', models: [GLM, AG3] } }, {}, [AG25])
  const { calls } = host(on, cfg, { dirtyAfterRun: true, oc: () => ({ exitCode: 1, stdout: '', stderr: 'boom' }) })
  await start($)
  const out = await dispatch($, { task: '改代码', role: 'code' })
  expect(calls.map(modelOf)).toEqual([GLM])
  expect(out).toContain('已经改了文件；没再换模型')
  expect(out).toContain('a.ts')
})

test('pi 失败时回答里提到限流不熔断，stderr 报 429 才熔断', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [AG3, AG25], readOnly: true } })
  const answer = 'x'.repeat(500) + ' 这个 bug 是 rate limit 处理不对'
  const { calls } = host(on, cfg, { pi: m => (m === AG3 ? { exitCode: 1, stdout: answer, stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' }) })
  await start($)
  const out = await dispatch($, { task: '查限流的 bug', role: 'text' })
  expect(calls.map(modelOf)).toEqual([AG3, AG25])
  expect(out).not.toContain('agnes 已暂停')
})

test('opencode 1.x：还用 --dir，不加 --standalone', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM], readOnly: true } })
  const { calls } = host(on, cfg, { ocVersion: '1.14.2' })
  await start($)
  await dispatch($, { task: 'a', role: 'text' })
  expect(calls[0]?.argv.slice(1).join(' ')).toBe(`run -m ${GLM} --format json --dir D:\\work --agent auto-router-readonly`)
})

test('opencode 自己升级挪了位置：缓存的旧路径没了就重新找', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM], readOnly: true } })
  let moved = false
  const { calls } = host(on, cfg, { moved: () => moved })
  await start($)
  await dispatch($, { task: 'a', role: 'text' })
  moved = true
  await dispatch($, { task: 'b', role: 'text' })
  expect(calls.map(c => c.argv[0])).toEqual([OC_EXE, OC_EXE.replace('opencode-ai', '@opencode\\cli')])
})

test('opencode 的工具输出里碰巧有 "api key" 也不熔断：普通失败只换下一个', async ($, on) => {
  const cfg = ocConfig({ text: { description: 't', models: [GLM, OC_DS], readOnly: true } })
  const noText = events('').replace(/"text":""/, '"text":" "')
  const { calls } = host(on, cfg, { oc: m => (m === GLM ? { exitCode: 1, stdout: noText, stderr: '' } : { exitCode: 0, stdout: events('ok'), stderr: '' }) })
  await start($)
  await dispatch($, { task: '总结', role: 'text' })
  expect(calls.map(modelOf)).toEqual([GLM, OC_DS])
})

test('隐私开关：会记录使用的模型只在允许的目录里用；allowDirs 有值时长文阅读也只在这些目录里用 opencode', () => {
  const none = DEFAULT_CONFIG
  expect(privacyBlock(none, MIMO, 'quick', 'D:\\work', true)).toContain('allowDirs')
  expect(privacyBlock(none, GLM, 'text', 'D:\\work', true)).toBeUndefined()
  expect(privacyBlock(none, OC_DS, 'longctx', 'D:\\work', true)).toBeUndefined()
  expect(privacyBlock(none, AG3, 'quick', 'D:\\work', true)).toBeUndefined()

  const pub: Config = { ...DEFAULT_CONFIG, opencode: { ...DEFAULT_CONFIG.opencode, allowDirs: ['D:\\Public\\'] } }
  expect(privacyBlock(pub, MIMO, 'quick', 'd:/public/repo', true)).toBeUndefined()
  expect(privacyBlock(pub, MIMO, 'quick', 'D:\\PublicX', true)).toContain('allowDirs')
  expect(privacyBlock(pub, OC_DS, 'longctx', 'D:\\work', true)).toContain('长文阅读')
  expect(privacyBlock(pub, OC_DS, 'longctx', 'D:\\Public\\big', true)).toBeUndefined()
  expect(privacyBlock(pub, OC_DS, 'review', 'D:\\work', true)).toBeUndefined()

  const all: Config = { ...DEFAULT_CONFIG, opencode: { ...DEFAULT_CONFIG.opencode, allowDirs: ['*'] } }
  expect(privacyBlock(all, MIMO, 'quick', 'D:\\work', true)).toBeUndefined()
})

test('隐私开关：派活时跳过不允许的模型并记一笔；目录允许后照常用', async ($, on) => {
  const roles = { quick: { description: 'q', models: [MIMO, AG3], readOnly: true } }
  const blocked = host(on, ocConfig(roles))
  await start($)
  const out = await dispatch($, { task: '看日志', role: 'quick' })
  expect(blocked.calls.map(modelOf)).toEqual([AG3])
  expect(out).toContain('opencode.allowDirs')
})

test('隐私开关：目录在允许列表里时用会记录使用的模型', async ($, on) => {
  const roles = { quick: { description: 'q', models: [MIMO, AG3], readOnly: true } }
  const ok = host(on, ocConfig(roles, { allowDirs: ['D:\\work'] }))
  await start($)
  await dispatch($, { task: '看日志', role: 'quick' })
  expect(ok.calls.map(modelOf)).toEqual([MIMO])
})

test('liveChain：skip 拦下的模型去掉，主链空了用兜底', () => {
  const cfg = ocConfig({ quick: { description: 'q', models: [MIMO] } }, {}, [AG3])
  expect(liveChain(cfg, 'quick', 0, () => false, m => m === MIMO)).toEqual({ models: [AG3], isFallback: true })
})

test('默认角色顺序：免费模型兜底或打头，按量付费的 deepseek-flash 靠后', () => {
  const r = DEFAULT_CONFIG.pi.roles
  const SOL = 'openai/gpt-6.1-sol'
  const TERRA = 'openai/gpt-6.1-terra'
  const DSF = 'cc-switch-deep-seek/deepseek-flash'
  expect(r.review?.models).toEqual([SOL, TERRA, OC_DS, DSF])
  expect(r.code?.models).toEqual([TERRA, SOL, GLM, DSF])
  expect(r.vision?.models).toEqual([TERRA, 'opencode/nemotron-3.5-super-vl-free', SOL])
  expect(r.bulk?.models).toEqual([TERRA, GLM, AG3])
  expect(r.longctx?.models).toEqual([OC_DS, DSF, TERRA])
  expect(r.quick?.models).toEqual([MIMO, AG3, TERRA])
  expect(r.text?.models).toEqual([GLM, AG3, AG25])
  expect(r.trivial?.models).toEqual(['opencode/nemotron-3.5-lightning-free', AG25, 'opencode/beam-free'])
  expect(DEFAULT_CONFIG.pi.fallback).toEqual([AG3, AG25, MIMO, 'opencode/flint-40b-free'])
  // 自动生成的和手写的一致
  const built = buildRoles(DEFAULT_CONFIG)
  for (const [name, role] of Object.entries(r)) expect([name, built.pi.roles[name]?.models]).toEqual([name, role.models])
  expect(built.pi.fallback).toEqual(DEFAULT_CONFIG.pi.fallback)
})

test('免费排序：同一档里 免费 → 订阅 → 按量付费；关掉 opencode 后各角色自动去掉免费模型', () => {
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    pi: {
      ...DEFAULT_CONFIG.pi,
      providers: { tok: { enabled: true, billing: 'token' }, sub: { enabled: true, billing: 'subscription' }, fr: { enabled: true, billing: 'free' } },
      tiers: { 'tok/m': 'mid', 'sub/m': 'mid', 'fr/m': 'mid' },
      strengths: {},
    },
  }
  // 长文阅读：中档免费 1 个、中档付费 1 个（订阅在按量前），再补
  expect(buildRoles(cfg).pi.roles.longctx?.models).toEqual(['fr/m', 'sub/m'])
  expect(buildRoles(cfg).pi.roles.review?.models).toEqual(['fr/m', 'sub/m'])

  const off: Config = { ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, providers: { ...DEFAULT_CONFIG.pi.providers, opencode: { enabled: false, billing: 'free' } } } }
  const built = buildRoles(off)
  const all = [...Object.values(built.pi.roles).flatMap(x => x.models), ...built.pi.fallback]
  expect(all.some(m => channelOf(m) === 'opencode')).toBe(false)
  expect(built.pi.roles.text?.models).toEqual([AG3, AG25])
  expect(built.pi.fallback).toEqual([AG3, AG25])
})

/** 0.2.x 写下的配置文件：没有 opencode 提供商、档位、opencode 段 */
function legacy(roles?: Record<string, string[]>): Config {
  const old = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config & { opencode?: unknown }
  delete old.opencode
  const { opencode: _p, ...providers } = old.pi.providers
  old.pi.providers = providers
  old.pi.tiers = Object.fromEntries(Object.entries(old.pi.tiers).filter(([m]) => channelOf(m) === 'pi'))
  delete (old.pi as Partial<Config['pi']>).strengths
  const DSF = 'cc-switch-deep-seek/deepseek-flash'
  const SOL = 'openai/gpt-6.1-sol'
  const TERRA = 'openai/gpt-6.1-terra'
  const v02: Record<string, string[]> = roles ?? {
    review: [SOL, TERRA, DSF],
    code: [TERRA, SOL, DSF],
    vision: [TERRA, SOL, DSF],
    bulk: [TERRA, AG3, DSF],
    longctx: [DSF, TERRA],
    quick: [AG3, TERRA, DSF],
    text: [AG3, AG25, DSF],
    trivial: [AG25, AG3, DSF],
  }
  for (const [name, models] of Object.entries(v02)) if (old.pi.roles[name]) old.pi.roles[name] = { ...old.pi.roles[name], models } as never
  old.pi.fallback = [AG3, AG25]
  return old
}

test('旧配置迁移：还是 0.2 的默认角色时，加上 opencode 并按新档位重排，写回文件并留 .bak', async ($, on) => {
  const { writes } = host(on, legacy())
  await start($)
  const saved = writes.filter(w => w.path.endsWith('auto-router.json')).map(w => JSON.parse(w.text) as Config)
  expect(saved.length).toBeGreaterThan(0)
  const cfg = saved[saved.length - 1] as Config
  expect(cfg.pi.providers.opencode).toEqual(DEFAULT_CONFIG.pi.providers.opencode)
  expect(cfg.pi.roles.text?.models).toEqual(DEFAULT_CONFIG.pi.roles.text?.models)
  expect(cfg.pi.fallback).toEqual(DEFAULT_CONFIG.pi.fallback)
  expect(cfg.opencode).toEqual(DEFAULT_CONFIG.opencode)
  expect(writes.some(w => w.path.endsWith('auto-router.json.bak'))).toBe(true)
})

test('旧配置迁移：手调过角色顺序的不动，只加提供商和档位', () => {
  const tuned = legacy({ code: ['openai/gpt-6.1-sol'] })
  const { cfg, note } = migrateOpencode({ ...tuned, opencode: DEFAULT_CONFIG.opencode, pi: { ...tuned.pi, strengths: {} } })
  expect(cfg.pi.roles.code?.models).toEqual(['openai/gpt-6.1-sol'])
  expect(cfg.pi.providers.opencode?.billing).toBe('free')
  expect(cfg.pi.tiers[GLM]).toBe('mid')
  expect(cfg.pi.strengths[GLM]).toEqual(['code', 'bulk', 'text'])
  expect(note).toContain('按档位重排')
  // 已经有 opencode 的配置不再迁移
  expect(migrateOpencode(DEFAULT_CONFIG).note).toBeUndefined()
})

test('通道标签：工具说明、状态行、日志记录都写明 pi 还是 opencode', async ($, on) => {
  const desc = describeTool(DEFAULT_CONFIG)
  expect(desc).toContain(`text [read-only]: pure text: translate, summarize, rewrite, write commit messages, name things (models: [opencode] ${GLM} -> [pi] ${AG3} -> [pi] ${AG25})`)
  expect(desc).toContain('[opencode] opencode/flint-40b-free')
  expect(piStatus('text', GLM)).toBe('🚀 opencode  ·  文本  ·  glm-5.3-flash-free 运行中')
  expect(piStatus('review', 'openai/gpt-6.1-sol')).toBe('🚀 pi  ·  评审  ·  gpt-6.1-sol 运行中')
  // 旧记录没有 ch：按模型前缀推断
  expect(channelOfRecord({ model: GLM })).toBe('opencode')
  expect(channelOfRecord({ model: AG3 })).toBe('pi')
  const s = summarize(
    [
      { t: 'pi', ts: 10, role: 'text', model: GLM, ok: true, ms: 1, ch: 'opencode' },
      { t: 'pi', ts: 10, role: 'text', model: MIMO, ok: true, ms: 1 },
      { t: 'pi', ts: 10, role: 'text', model: AG3, ok: false, ms: 1 },
    ],
    0,
  )
  expect(s.pi.byChannel).toEqual({ opencode: 2, pi: 1 })

  const cfg = ocConfig({ text: { description: 't', models: [GLM], readOnly: true } })
  const { writes } = host(on, cfg)
  on('session.id', () => ({ value: 'oc123456789' }))
  await start($)
  await dispatch($, { task: '总结', role: 'text' })
  const piLine = () => (writes.filter(w => w.path.endsWith('.jsonl')).pop()?.text ?? '').split('\n').find(l => l.includes('"t":"pi"'))
  for (let i = 0; i < 50 && !piLine(); i++) await new Promise(r => setTimeout(r, 0))
  const rec = JSON.parse(piLine() ?? '{}') as Record<string, unknown>
  expect(rec?.ch).toBe('opencode')
})

test('外派模型页：标签改名，模型旁标通道，opencode 一组带隐私开关', async ($, on) => {
  const { writes } = host(on, DEFAULT_CONFIG)
  await start($)
  const ui = await $.ui.mount({
    plugin: 'auto-router',
    component: 'Pane',
    requestId: 'auto-router',
    surface: 'mobile',
    props: { title: 'auto-router', isFocused: true, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
  } as never)
  expect(await ui.find({ type: 'Button', key: 'tab-pi' })).toBeDefined()
  await ui.press({ key: 'tab-pi' })
  let hit
  for (let i = 0; i < 30 && !hit; i++) hit = await ui.find({ type: 'Text', text: /OpenCode 免费模型/ })
  expect(hit).toBeDefined()
  // 按通道分组：pi 一组、opencode 一组
  expect(await ui.find({ type: 'Text', text: /pi 通道/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /opencode 通道/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'bill-opencode-free' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /提供方会保存内容/ })).toBeDefined()
  writes.length = 0
  await ui.press({ key: 'privacy-here' })
  const last = () => writes.filter(w => w.path.endsWith('auto-router.json')).pop()
  for (let i = 0; i < 50 && !last(); i++) await ui.findAll({})
  expect((JSON.parse(last()?.text ?? '{}') as Config).opencode.allowDirs).toEqual(['D:\\work'])
  await ui.unmount()
})

test('opencode 里配的其他提供商：记成 oc:提供商/模型，走 opencode，派活时去掉前缀；隐私开关只管免费模型', () => {
  const list = parseOpencodeModels(['opencode/glm-5.3-flash-free', 'alibaba/qwen3-max', 'zai/glm-5', 'not a model'].join('\n'))
  expect(list).toEqual(['opencode/glm-5.3-flash-free', 'oc:alibaba/qwen3-max', 'oc:zai/glm-5'])
  expect(channelOf('oc:alibaba/qwen3-max')).toBe('opencode')
  expect(ocModelArg('oc:alibaba/qwen3-max')).toBe('alibaba/qwen3-max')
  expect(ocModelArg('opencode/glm-5.3-flash-free')).toBe('opencode/glm-5.3-flash-free')
  expect(channelOfRecord({ model: 'oc:zai/glm-5' })).toBe('opencode')
  const cfg = { ...DEFAULT_CONFIG, opencode: { ...DEFAULT_CONFIG.opencode, allowDirs: [], logged: ['oc:zai/glm-5'] } }
  expect(privacyBlock(cfg, 'oc:zai/glm-5', 'longctx', 'D:\work', true)).toBeUndefined()
})
