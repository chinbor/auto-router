import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/config'
import type { Config } from '../hooks/config'
import { pickByNumber } from '../hooks/classify'
import { imageDims } from '../hooks/saver'
import { categoryStats, categoryText, modelVersions, sessionArms, versionLabel } from '../hooks/stats'
import type { LogRecord } from '../hooks/stats'

type On = Parameters<TestBody>[1]

const SID = 'abcdef1234567890'
const CFG_PATH = /auto-router\.json$/
const CFG_FILE = 'CFG'
const USAGE = { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }
const PANE = {
  plugin: 'auto-router',
  component: 'Pane',
  requestId: 'auto-router',
  props: { title: 'auto-router', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

type Harness = { files: Record<string, string>; sizes: Record<string, number>; bytes: Record<string, string> }

/**
 * 引擎替身：files 是磁盘（配置、日志都在里面，写入也落在这里），sizes 给 fs.stat 用，bytes 给按字节读用。
 * 配置文件按 cfg 预置；目录列表从 files 里推出来。
 */
function harness(on: On, opts: { cfg?: Config | Record<string, unknown>; sid?: string; ctx?: number; wk?: number } = {}): Harness {
  const h: Harness = { files: {}, sizes: {}, bytes: {} }
  if (opts.cfg) h.files.CFG = JSON.stringify(opts.cfg)
  // 配置文件和日志目录的真实位置从插件目录推出来，这里统一换成 CFG、LOG 两个键
  // 相对路径按会话工作目录 D:\work 解析，和引擎一致
  const norm = (p: string) => {
    if (CFG_PATH.test(p)) return 'CFG'
    const abs = /^[A-Za-z]:[\\/]/.test(p) ? p : `D:\\work\\${p}`
    return abs.replace(/\//g, '\\').replace(/^.*\\auto-router\\log(?=\\|$)/, 'LOG')
  }
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__auto-router__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.after', () => new Promise(() => {}))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'C:\\Users\\me\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: opts.sid ?? SID }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: opts.ctx ?? 5000, window: 1_000_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: opts.wk ?? 10 }], cost: { usd: 0 } },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', (_, e) => {
    const p = norm(e.path)
    return { value: p in h.files || p in h.sizes || Object.keys(h.files).some(f => f.startsWith(p + '\\')) }
  })
  on('fs.read', (_, e) => {
    const p = norm(e.path)
    if (e.as === 'bytes') return { value: { base64: h.bytes[p] ?? '' } }
    if (p in h.files) return { value: h.files[p] as string }
    return { deny: `ENOENT ${p}` }
  })
  on('fs.write', (_, e) => {
    h.files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('fs.list', (_, e) => {
    const dir = norm(e.path) + '\\'
    const names = Object.keys(h.files).filter(f => f.startsWith(dir) && !f.slice(dir.length).includes('\\'))
    return { value: names.map(f => ({ name: f.slice(dir.length), kind: 'file' as const, size: 1, mtimeMs: Date.now(), isLink: false })) }
  })
  on('fs.stat', (_, e) => {
    // 测试引擎把相对路径按它自己的目录转成了绝对路径，找不到时按文件名对上 D:\work 下的文件
    const exact = norm(e.path)
    const p = exact in h.sizes || exact in h.files ? exact : `D:\\work\\${exact.split('\\').pop()}`
    const size = h.sizes[p] ?? (p in h.files ? (h.files[p] as string).length : undefined)
    return size === undefined ? { deny: `ENOENT ${p}` } : { value: { kind: 'file' as const, size, mtimeMs: 0, isLink: false } }
  })
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  on('turn.complete', (_, e) => ({ text: e.answer, usage: e.usage }))
  return h
}

const start = ($: Parameters<TestBody>[0]) => $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
const submit = ($: Parameters<TestBody>[0], text: string) => $.prompt.submit({ text } as never)
const complete = ($: Parameters<TestBody>[0], model = 'claude-opus-5-5') =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', usage: { model, ...USAGE } } as never)

function logRows(h: Harness, sid = SID): Record<string, unknown>[] {
  return Object.entries(h.files)
    .filter(([p]) => p.endsWith(`_${sid.slice(0, 8)}.jsonl`))
    .flatMap(([, text]) => text.trim().split('\n').filter(Boolean))
    .map(l => JSON.parse(l) as Record<string, unknown>)
}

/** 落在指定分组的会话 id */
function sidWith(exp: 'route' | 'saver' | 'both', want: { ra?: 'auto' | 'control'; sv?: 'on' | 'off' }): string {
  for (let i = 0; ; i++) {
    const sid = `t${i}`.padEnd(16, '0')
    const a = sessionArms(sid.slice(0, 8), exp)
    if ((!want.ra || a.ra === want.ra) && (!want.sv || a.sv === want.sv)) return sid
  }
}

const RATE_LIMITED = 'auto-router: $.model.classify: the request failed (HTTP 429, rate_limit)'

// ---------- 分类器 ----------

test('fork 的回答按编号对应类别', () => {
  const cats = DEFAULT_CONFIG.claude.categories
  expect(pickByNumber('7', cats)).toBe(cats[6]?.label)
  expect(pickByNumber('Category 4.', cats)).toBe(cats[3]?.label)
  expect(pickByNumber('0', cats)).toBeUndefined()
  expect(pickByNumber('42', cats)).toBeUndefined()
  expect(pickByNumber('coding task', cats)).toBeUndefined()
})

test('classify 被 429 限流时改用 fork，之后 30 分钟直接走 fork', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  let classifyCalls = 0
  let forkCalls = 0
  on('model.classify', () => {
    classifyCalls++
    return { deny: RATE_LIMITED }
  })
  on('model.fork', () => {
    forkCalls++
    return { value: { isAnswered: true, text: '7', usage: USAGE } }
  })
  await start($)
  await submit($, '把 200 个文件的 import 改成别名')
  await complete($)
  await submit($, '再把测试也改了')
  await complete($)

  expect(classifyCalls).toBe(1)
  expect(forkCalls).toBe(2)
  const rows = logRows(h)
  expect(rows.map(r => r.cat)).toEqual(['批量修改', '批量修改'])
  expect(rows.map(r => r.via)).toEqual(['fork', 'fork'])
  expect(rows[0]?.fu).toEqual([10, 1000, 0, 3])
  expect(rows[0]?.pick).toBe('sonnet')
})

test('classify 正常时不 fork', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  let forkCalls = 0
  on('model.classify', () => ({ value: DEFAULT_CONFIG.claude.categories[3]?.label }))
  on('model.fork', () => {
    forkCalls++
    return { value: { isAnswered: true, text: '1', usage: USAGE } }
  })
  await start($)
  await submit($, '实现登录功能')
  await complete($)
  expect(forkCalls).toBe(0)
  expect(logRows(h)[0]).toMatchObject({ cat: '编码', via: 'classify', pick: 'sonnet' })
})

test('两条路都失败时如实记下原因，不切换模型', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  on('model.classify', () => {
    return { deny: RATE_LIMITED }
  })
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  await start($)
  await submit($, '你好')
  await complete($)
  const row = logRows(h)[0] ?? {}
  expect(row.cat).toBe('分类出错')
  expect(row.cf).toBe('error')
  expect(String(row.cerr)).toContain('429')
  expect(String(row.cerr)).toContain('nothing-to-fork')
  expect(row.pick).toBeUndefined()
})

test('fork 答非所问时记为未命中', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  on('model.classify', () => {
    return { deny: RATE_LIMITED }
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: 'a coding task', usage: USAGE } }))
  await start($)
  await submit($, '实现登录功能')
  await complete($)
  expect(logRows(h)[0]).toMatchObject({ cat: '未命中', cf: 'none' })
})

test('已在 Opus 且上下文长到不降档时不 fork：分类结果改变不了模型', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG, ctx: 200_000 })
  let classifyCalls = 0
  let forkCalls = 0
  on('model.classify', () => (++classifyCalls === 1 ? { value: DEFAULT_CONFIG.claude.categories[4]?.label } : { deny: RATE_LIMITED }))
  on('model.fork', () => {
    forkCalls++
    return { value: { isAnswered: true, text: '1', usage: USAGE } }
  })
  await start($)
  await submit($, '实现登录功能')
  await complete($)
  await submit($, '你好')
  await complete($)
  // 第三条 classify 在冷却期，直接判定跳过，不再等 classify
  await submit($, '再看看')
  await complete($)
  expect(forkCalls).toBe(0)
  expect(classifyCalls).toBe(2)
  const rows = logRows(h)
  expect(rows[0]).toMatchObject({ cat: '难题/设计', pick: 'opus' })
  expect(rows[1]).toMatchObject({ cf: 'error', pick: 'opus' })
  expect(rows[2]).toMatchObject({ cat: '跳过（换不了模型）', cf: 'skip', pick: 'opus' })
})

test('上下文短时照常 fork', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG, ctx: 50_000 })
  let forkCalls = 0
  on('model.classify', () => ({ deny: RATE_LIMITED }))
  on('model.fork', () => {
    forkCalls++
    return { value: { isAnswered: true, text: '1', usage: USAGE } }
  })
  await start($)
  await submit($, '实现登录功能')
  await complete($)
  await submit($, '你好')
  await complete($)
  expect(forkCalls).toBe(2)
  expect(logRows(h).every(r => r.via === 'fork')).toBe(true)
})

// ---------- 拦截：各种读法的完整流程 ----------

/** 调一次工具，返回是否到达了“引擎”（没被拦） */
function reachCounter(on: On) {
  const seen: string[] = []
  on('tool.call', (_, e) => {
    seen.push(e.tool)
    return { result: 'ok' }
  })
  return seen
}

test('拦大图：超过 1MB 的图给出预览办法，再请求放行；_preview 里的图直接放行', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  h.sizes['D:\\work\\shot.png'] = 2 * 1024 * 1024
  h.sizes['D:\\work\\_preview\\shot.png'] = 2 * 1024 * 1024
  const seen = reachCounter(on)
  await start($)
  const first = await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\shot.png' })
  expect(JSON.stringify(first)).toContain('img_check.py')
  expect(JSON.stringify(first)).toContain('preview')
  expect(seen.length).toBe(0)
  await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\shot.png' })
  expect(seen.length).toBe(1)
  await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\_preview\\shot.png' })
  expect(seen.length).toBe(2)
  const guards = logRows(h).filter(r => r.t === 'guard')
  expect(guards.map(g => [g.kind, g.again])).toEqual([
    ['image', false],
    ['image', true],
  ])
})

test('拦大图：文件不大但长边超过 1024px 也拦，小图放行', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  // 1600×900 和 800×600 的 PNG 头
  h.sizes['D:\\work\\wide.png'] = 50 * 1024
  h.bytes['D:\\work\\wide.png'] = 'iVBORw0KGgoAAAANSUhEUgAABkAAAAOECAYAAAA='
  h.sizes['D:\\work\\small.png'] = 50 * 1024
  h.bytes['D:\\work\\small.png'] = 'iVBORw0KGgoAAAANSUhEUgAAAyAAAAJYCAYAAAA='
  const seen = reachCounter(on)
  await start($)
  const wide = await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\wide.png' })
  expect(JSON.stringify(wide)).toContain('1600×900')
  await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\small.png' })
  expect(seen).toEqual(['Read'])
})

test('图片尺寸：JPEG、GIF、WebP、BMP', () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, 0x02, 0x58, 0x03, 0x20, 3, 0, 0, 0, 0])
  expect(imageDims(jpeg)).toEqual([800, 600])
  const gif = new Uint8Array([...'GIF89a'].map(c => c.charCodeAt(0)).concat([0x40, 0x06, 0x84, 0x03]))
  expect(imageDims(gif)).toEqual([1600, 900])
  const webp = new Uint8Array(30)
  webp.set([...'RIFF'].map(c => c.charCodeAt(0)), 0)
  webp.set([...'WEBPVP8X'].map(c => c.charCodeAt(0)), 8)
  webp.set([0x3f, 0x06, 0x00, 0x83, 0x03, 0x00], 24)
  expect(imageDims(webp)).toEqual([1600, 900])
  const bmp = new Uint8Array(26)
  bmp.set([0x42, 0x4d], 0)
  bmp.set([0x40, 0x06, 0, 0, 0x84, 0x03, 0, 0], 18)
  expect(imageDims(bmp)).toEqual([1600, 900])
})

test('拦大文本：不到 200KB 但超过 2000 行也拦；行数少的放行', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  h.files['D:\\work\\long.txt'] = 'x'.repeat(30) + '\n'.repeat(3000) + 'y'.repeat(20_000)
  h.files['D:\\work\\wide.txt'] = 'z'.repeat(60_000) + '\n'
  const seen = reachCounter(on)
  await start($)
  const long = await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\long.txt' })
  expect(JSON.stringify(long)).toContain('超过 2000 行')
  await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\wide.txt' })
  expect(seen).toEqual(['Read'])
})

test('拦整页网页：要全文的拦一次，按目标摘取的放行', async ($, on) => {
  harness(on, { cfg: DEFAULT_CONFIG })
  const seen = reachCounter(on)
  await start($)
  const full = await $.tool.call({ tool: 'WebFetch', url: 'https://a.example/doc', prompt: '把整页全文给我' })
  expect(JSON.stringify(full)).toContain('按目标摘取')
  await $.tool.call({ tool: 'WebFetch', url: 'https://a.example/doc', prompt: '这页里的安装命令是什么' })
  expect(seen).toEqual(['WebFetch'])
  await $.tool.call({ tool: 'WebFetch', url: 'https://a.example/doc', prompt: '把整页全文给我' })
  expect(seen).toEqual(['WebFetch', 'WebFetch'])
})

test('拦刷屏命令：cat 大文件、不加过滤的日志命令；加了过滤的放行', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  h.sizes['D:\\work\\big.log'] = 500 * 1024
  const seen = reachCounter(on)
  await start($)
  const cat = await $.tool.call({ tool: 'Bash', command: 'cat big.log' })
  expect(JSON.stringify(cat)).toContain('big.log')
  await $.tool.call({ tool: 'Bash', command: 'cat big.log | tail -n 50' })
  const gc = await $.tool.call({ tool: 'PowerShell', command: 'Get-Content -Path big.log' })
  expect(JSON.stringify(gc)).toContain('-Tail')
  await $.tool.call({ tool: 'PowerShell', command: 'Get-Content -Path big.log -Tail 50' })
  const logs = await $.tool.call({ tool: 'Bash', command: 'docker logs api' })
  expect(JSON.stringify(logs)).toContain('--tail')
  await $.tool.call({ tool: 'Bash', command: 'docker logs api --tail 100' })
  await $.tool.call({ tool: 'Bash', command: 'ls -la' })
  expect(seen).toEqual(['Bash', 'PowerShell', 'Bash', 'Bash'])
})

test('拦截关掉（saver.guard=false）后什么都不拦', async ($, on) => {
  const h = harness(on, { cfg: { ...DEFAULT_CONFIG, saver: { ...DEFAULT_CONFIG.saver, guard: false } } })
  h.sizes['D:\\work\\big.log'] = 500 * 1024
  const seen = reachCounter(on)
  await start($)
  await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\big.log' })
  expect(seen).toEqual(['Read'])
})

// ---------- 子代理、规则、提示 ----------

const OFFER = { description: 'd', source: 'plugin', provider: { plugin: 'auto-router', tier: 'local' } }

test('省额度关掉的会话不提供 scout / executor，开着的照常提供', async ($, on) => {
  harness(on, { cfg: { ...DEFAULT_CONFIG, experiment: 'saver' }, sid: sidWith('saver', { sv: 'off' }) })
  on('agent.offer', () => ({ isOffered: true }))
  await start($)
  const scout = await $.agent.offer({ agent: 'auto-router:scout', ...OFFER } as never)
  const executor = await $.agent.offer({ agent: 'auto-router:executor', ...OFFER } as never)
  const other = await $.agent.offer({ agent: 'someone:else', ...OFFER } as never)
  expect([scout.isOffered, executor.isOffered, other.isOffered]).toEqual([false, false, true])
})

test('省额度开着的会话照常提供 scout', async ($, on) => {
  harness(on, { cfg: { ...DEFAULT_CONFIG, experiment: 'saver' }, sid: sidWith('saver', { sv: 'on' }) })
  on('agent.offer', () => ({ isOffered: true }))
  await start($)
  expect((await $.agent.offer({ agent: 'auto-router:scout', ...OFFER } as never)).isOffered).toBe(true)
})

test('bigRead 固定 scout 时，规则里不提 pi longctx', async ($, on) => {
  harness(on, { cfg: { ...DEFAULT_CONFIG, saver: { ...DEFAULT_CONFIG.saver, bigRead: 'scout' } } })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  await start($)
  const out = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], outputStyle: null, traits: [], tools: ['mcp__auto-router__pi_dispatch'] })
  const text = out.sections.find(s => s.id === 'auto-router:saver')?.text ?? ''
  expect(text).toContain('auto-router:scout')
  expect(text).not.toContain('longctx')
})

test('7 天额度过 70% 时提示一次大量阅读改派 pi', async ($, on) => {
  harness(on, { cfg: DEFAULT_CONFIG, wk: 76 })
  on('model.classify', () => ({ value: 'other' }))
  await start($)
  const a = await submit($, '继续')
  expect(a.context?.join('\n')).toContain('7 天额度已用 76%')
  const b = await submit($, '再继续')
  expect(b.context?.join('\n') ?? '').not.toContain('7 天额度')
})

// ---------- 配置迁移 ----------

test('旧配置的 claude.abTest=true 读成 route 实验，校验照常通过', async ($, on) => {
  const { saver: _s, experiment: _e, ...rest } = DEFAULT_CONFIG
  harness(on, { cfg: { ...rest, claude: { ...DEFAULT_CONFIG.claude, abTest: true } } })
  await start($)
  const got = await $.tool.call({ tool: 'mcp__auto-router__router_config', action: 'get' } as never)
  const text = String(got.result)
  expect(text).toContain('"experiment": "route"')
  expect(text).toContain('"saver"')
  expect(text).not.toContain('abTest')
})

// ---------- 实验入组 ----------

test('实验打开前就开着的会话不入组，日志不打实验标记', async ($, on) => {
  const sid = sidWith('both', { ra: 'control', sv: 'off' })
  const h = harness(on, { cfg: { ...DEFAULT_CONFIG, experiment: 'both' }, sid })
  h.files[`LOG\\2026-10-29_${sid.slice(0, 8)}.jsonl`] =
    JSON.stringify({ t: 'turn', ts: 1, arm: 'auto', model: 'claude-opus-5-5', in: 1, cw: 0, cr: 0, out: 1, sid: sid.slice(0, 8), sv: 'on' }) + '\n'
  h.sizes['D:\\work\\big.log'] = 500 * 1024
  on('model.classify', () => ({ value: DEFAULT_CONFIG.claude.categories[0]?.label }))
  const seen = reachCounter(on)
  await start($)
  await submit($, '你好')
  await complete($)
  // 没入组：按配置 saver.enabled=true 照常拦截，模型照常切换
  await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\big.log' })
  expect(seen).toEqual([])
  const row = logRows(h, sid).find(r => r.t === 'turn' && r.ts !== 1) ?? {}
  expect(row.ex).toBeUndefined()
  expect(row.arm).toBe('auto')
})

test('新会话入组：日志打上实验标记，对照组只分类不切换', async ($, on) => {
  const sid = sidWith('both', { ra: 'control', sv: 'off' })
  const h = harness(on, { cfg: { ...DEFAULT_CONFIG, experiment: 'both' }, sid })
  on('model.classify', () => ({ value: DEFAULT_CONFIG.claude.categories[0]?.label }))
  await start($)
  await submit($, '你好')
  await complete($)
  expect(logRows(h, sid)[0]).toMatchObject({ ex: 'both', ra: 'control', sv: 'off', arm: 'control', pick: 'haiku' })
})

// ---------- 面板与命令 ----------

for (const surface of ['mobile', 'desktop'] as const) {
  test(`面板（${surface}）：显示本会话分组，改对照实验、省额度开关、大量阅读去向都写回配置`, async ($, on) => {
    const sid = sidWith('both', { ra: 'auto', sv: 'on' })
    const h = harness(on, { cfg: { ...DEFAULT_CONFIG, experiment: 'both' }, sid })
    on('command.run', (_, e) => ({ text: e.args }))
    await start($)
    const ui = await $.ui.mount({ ...PANE, surface } as never)
    await ui.press({ key: 'tab-claude' })
    await ui.press({ key: 'more' })
    let arm
    for (let i = 0; i < 30 && !arm; i++) arm = await ui.find({ type: 'Text', text: /本会话：切换组 · 省额度开/ })
    expect(arm).toBeDefined()
    const cfg = () => JSON.parse(h.files[CFG_FILE] ?? '{}') as Config
    const pick = async (key: string, value: string) =>
      surface === 'mobile' ? ui.press({ key: `${key}-${value}` }) : (ui as unknown as { select: (t: { key: string; value: string }) => Promise<unknown> }).select({ key, value })
    await pick('experiment', 'saver')
    for (let i = 0; i < 30 && cfg().experiment !== 'saver'; i++) await ui.findAll({})
    expect(cfg().experiment).toBe('saver')
    await pick('bigread', 'pi')
    for (let i = 0; i < 30 && cfg().saver.bigRead !== 'pi'; i++) await ui.findAll({})
    expect(cfg().saver.bigRead).toBe('pi')
    await ui.press({ key: 'guard' })
    for (let i = 0; i < 30 && cfg().saver.guard; i++) await ui.findAll({})
    expect(cfg().saver.guard).toBe(false)
    await ui.press({ key: 'saver' })
    for (let i = 0; i < 30 && cfg().saver.enabled; i++) await ui.findAll({})
    expect(cfg().saver.enabled).toBe(false)
    await ui.unmount()
  })
}

test('/auto-router eval：带本会话分组和报告', async ($, on) => {
  const sid = sidWith('saver', { sv: 'on' })
  const h = harness(on, { cfg: { ...DEFAULT_CONFIG, experiment: 'saver' }, sid })
  const now = Date.now()
  const rows: string[] = []
  for (let s = 0; s < 3; s++)
    for (const sv of ['on', 'off'])
      rows.push(JSON.stringify({ t: 'turn', ts: now - 1000, arm: 'auto', model: 'claude-opus-5-5', in: 1, cw: 0, cr: 0, out: 1, usd: sv === 'on' ? 0.1 : 0.2, sid: `${sv}${s}`, ex: 'saver', sv }))
  h.files['LOG\\2026-10-30_older.jsonl'] = rows.join('\n') + '\n'
  on('command.run', (_, e) => ({ text: e.args }))
  await start($)
  const out = await $.command.run({ command: 'auto-router', args: 'eval 7' } as never)
  const text = String((out as { text?: string }).text)
  expect(text).toContain('本会话：省额度开')
  expect(text).toContain('【省额度】样本还不够')
  expect(text).toContain('6 个会话')
})

test('按类别统计：纠正记在被纠正的上一轮，按切换组分开，子代理不算', () => {
  const t = (ts: number, sid: string, cat: string, over: Record<string, unknown> = {}): LogRecord =>
    ({ t: 'turn', ts, sid, ra: 'auto', arm: 'auto', cat, model: 'claude-sonnet-5-5', in: 0, cw: 0, cr: 0, out: 0, usd: 0.1, ...over }) as LogRecord
  const rows = categoryStats(
    [
      t(1, 'a', '编码'),
      t(2, 'a', '闲聊/简答', { fix: true }),
      t(3, 'a', '编码', { sub: true }),
      t(1, 'b', '编码', { ra: 'control', model: 'claude-opus-5-5' }),
      t(0, 'a', '编码'),
    ],
    1,
  )
  const coding = rows.find(r => r.cat === '编码' && r.ra === 'auto')
  expect(coding).toMatchObject({ turns: 1, fixes: 1, models: { sonnet: 1 } })
  expect(rows.find(r => r.cat === '闲聊/简答')?.fixes).toBe(0)
  expect(rows.find(r => r.ra === 'control')).toMatchObject({ cat: '编码', turns: 1, models: { opus: 1 } })
  expect(categoryText(rows)).toContain('样本不足')
  expect(categoryText([])).toContain('还没有记录')
})

test('版本号：取各档最近一次实际用到的模型 id', () => {
  const t = (ts: number, model: string) => ({ t: 'turn', ts, arm: 'auto', model, in: 0, cw: 0, cr: 0, out: 0 }) as LogRecord
  const v = modelVersions([t(1, 'claude-opus-5-1'), t(2, 'claude-opus-5-5'), t(1, 'claude-haiku-5-5'), t(3, 'gpt-x')])
  expect(v).toEqual({ opus: 'claude-opus-5-5', haiku: 'claude-haiku-5-5' })
  expect(versionLabel('opus', v.opus)).toBe('Opus 5.5')
  expect(versionLabel('sonnet', v.sonnet)).toBe('Sonnet')
  expect(versionLabel('opus', 'claude-opus-5-5[1m]')).toBe('Opus 5.5')
})
