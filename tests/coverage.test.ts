import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { chainFor, DEFAULT_CONFIG, liveChain, onlyDetected } from '../hooks/config'
import type { Config } from '../hooks/config'
import { coldReason, pickByNumber } from '../hooks/classify'
import { ruleLabel } from '../hooks/rules'
import { imageDims } from '../hooks/saver'
import { categoryStats, categoryText, cellStats, costSplit, costSplitText, delegateStats, delegateText, summarize, configVersion, demotedModels, modelVersions, overlap, redoStats, redoText, sessionArms, sessionStats, taskWords, versionLabel } from '../hooks/stats'
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
function harness(on: On, opts: { cfg?: Config | Record<string, unknown>; sid?: string; ctx?: number | (() => number); wk?: number; toasts?: string[]; toastMs?: number[]; now?: () => number; tools?: string[] } = {}): Harness {
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
  on('tool.register', (_, e) => {
    opts.tools?.push(e.name)
    return { value: { tool: `mcp__auto-router__${e.name}` } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', (_, e) => {
    opts.toasts?.push(e.text)
    opts.toastMs?.push(e.timeoutMs ?? 4000)
    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('clock.after', () => new Promise(() => {}))
  on('clock.now', () => ({ value: opts.now?.() ?? Date.now() }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: 'C:\\Users\\me\r\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.id', () => ({ value: opts.sid ?? SID }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: (typeof opts.ctx === 'function' ? opts.ctx() : opts.ctx) ?? 5000, window: 1_000_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: opts.wk ?? 10 }], cost: { usd: 0 } },
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
/** 每轮都分类的旧做法（switchAt: turn），分类链的测试用它，每条消息都会走一遍分类 */
const TURN = { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, switchAt: 'turn' as const } }
/** 每轮分类，并打开“分类失败时 fork”（默认关） */
const FORK_ON = { ...TURN, claude: { ...TURN.claude, forkFallback: true } }

// ---------- 分类器 ----------

test('fork 的回答按编号对应类别', () => {
  const cats = DEFAULT_CONFIG.claude.categories
  expect(pickByNumber('7', cats)).toBe(cats[6]?.label)
  expect(pickByNumber('Category 4.', cats)).toBe(cats[3]?.label)
  expect(pickByNumber('0', cats)).toBeUndefined()
  expect(pickByNumber('42', cats)).toBeUndefined()
  expect(pickByNumber('coding task', cats)).toBeUndefined()
})

test('classify 被 429 限流时改用 fork，之后冷却几分钟（连着失败逐步加长）直接走 fork', async ($, on) => {
  const h = harness(on, { cfg: FORK_ON })
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
  await submit($, '200 个文件的 import 都要用别名')
  await complete($)
  await submit($, '测试也一样')
  await complete($)

  expect(classifyCalls).toBe(1)
  expect(forkCalls).toBe(2)
  const rows = logRows(h)
  expect(rows.map(r => r.cat)).toEqual(['批量修改', '批量修改'])
  expect(rows.map(r => r.via)).toEqual(['fork', 'fork'])
  expect(rows[0]?.fu).toEqual([10, 1000, 0, 3])
  expect(rows[0]?.pick).toBe('sonnet')
})

test('默认不 fork：classify 被限流、规则也判不出时如实记原因，保持当前模型，不花 fork 的钱', async ($, on) => {
  const h = harness(on, { cfg: TURN })
  let forkCalls = 0
  on('model.classify', () => ({ deny: RATE_LIMITED }))
  on('model.fork', () => {
    forkCalls++
    return { value: { isAnswered: true, text: '7', usage: USAGE } }
  })
  await start($)
  await submit($, '这里的 import 怎么写比较好')
  await complete($)
  await submit($, '测试那边也看看')
  await complete($)
  expect(forkCalls).toBe(0)
  const rows = logRows(h)
  expect(rows.map(r => r.cf)).toEqual(['error', 'error'])
  expect(String(rows[1]?.cerr)).toContain('冷却中')
  expect(rows[0]?.pick).toBeUndefined()
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
  const h = harness(on, { cfg: FORK_ON })
  on('model.classify', () => {
    return { deny: RATE_LIMITED }
  })
  on('model.fork', () => ({ value: { isAnswered: false, reason: 'nothing-to-fork' } }))
  await start($)
  await submit($, '看下这个')
  await complete($)
  const row = logRows(h)[0] ?? {}
  expect(row.cat).toBe('分类出错')
  expect(row.cf).toBe('error')
  expect(String(row.cerr)).toContain('429')
  expect(String(row.cerr)).toContain('nothing-to-fork')
  expect(row.pick).toBeUndefined()
})

test('fork 答非所问时记为未命中', async ($, on) => {
  const h = harness(on, { cfg: FORK_ON })
  on('model.classify', () => {
    return { deny: RATE_LIMITED }
  })
  on('model.fork', () => ({ value: { isAnswered: true, text: 'a coding task', usage: USAGE } }))
  await start($)
  await submit($, '登录这块你来弄')
  await complete($)
  expect(logRows(h)[0]).toMatchObject({ cat: '未命中', cf: 'none' })
})

test('已在 Opus 且上下文长到不降档时不 fork：分类结果改变不了模型', async ($, on) => {
  const h = harness(on, { cfg: FORK_ON, ctx: 200_000 })
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
  await submit($, '看下这个')
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
  const h = harness(on, { cfg: FORK_ON, ctx: 50_000 })
  let forkCalls = 0
  on('model.classify', () => ({ deny: RATE_LIMITED }))
  on('model.fork', () => {
    forkCalls++
    return { value: { isAnswered: true, text: '1', usage: USAGE } }
  })
  await start($)
  await submit($, '登录这块你来弄')
  await complete($)
  await submit($, '看下这个')
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
  expect(logRows(h, sid)[0]).toMatchObject({ ex: 'both', ra: 'control', sv: 'off', arm: 'control', pick: 'sonnet' })
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
    await pick('guard', 'off')
    for (let i = 0; i < 30 && cfg().saver.guard; i++) await ui.findAll({})
    expect(cfg().saver.guard).toBe(false)
    await pick('saver', 'off')
    for (let i = 0; i < 30 && cfg().saver.enabled; i++) await ui.findAll({})
    expect(cfg().saver.enabled).toBe(false)
    await ui.unmount()
  })
}

test('/auto-router eval：带本会话分组和报告；只比当前配置版本，旧版本单列', async ($, on) => {
  const sid = sidWith('saver', { sv: 'on' })
  const cfg = { ...DEFAULT_CONFIG, experiment: 'saver' as const }
  const h = harness(on, { cfg, sid })
  const now = Date.now()
  const rows: string[] = []
  // 测试里读不到 plugin.json，插件版本记成 ?
  const cv = configVersion(cfg, '?')
  for (const ver of [cv, undefined])
    for (let s = 0; s < 3; s++)
      for (const sv of ['on', 'off'])
        for (let i = 0; i < 3; i++)
          rows.push(JSON.stringify({ t: 'turn', ts: now - (ver ? 1000 : 9000) + i, arm: 'auto', model: 'claude-opus-5-5', in: 1, cw: 0, cr: 0, out: 1, usd: sv === 'on' ? 0.1 : 0.2, sid: `${ver ? 'n' : 'o'}${sv}${s}`, ex: 'saver', sv, cv: ver }))
  h.files['LOG\\2026-10-30_older.jsonl'] = rows.join('\n') + '\n'
  on('command.run', (_, e) => ({ text: e.args }))
  await start($)
  const out = await $.command.run({ command: 'auto-router', args: 'eval 7' } as never)
  const text = String((out as { text?: string }).text)
  expect(text).toContain('本会话：省额度开')
  expect(text).toContain('【省额度】样本还不够')
  expect(text).toContain(`6 个会话，只比配置版本 ${cv}）`)
  expect(text).toContain('0.3.1 之前（没记版本）')
  expect(text).toContain('6 个会话；省额度 开 3 个 $0.300 / 关 3 个 $0.600')
  expect(text).toContain(`${cv}  `)
  expect(text).toContain('← 当前')
})

test('配置版本：只随影响切换、省额度的配置变；dataDir 改了旧日志搬过去，核对后删旧文件', async ($, on) => {
  const base = configVersion(DEFAULT_CONFIG, '0.3.1')
  expect(base).toMatch(/^0\.3\.1-[0-9a-f]{6}$/)
  expect(configVersion({ ...DEFAULT_CONFIG, pi: { ...DEFAULT_CONFIG.pi, timeoutMinutes: 1 } }, '0.3.1')).toBe(base)
  expect(configVersion({ ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, downgradeAfter: 2 } }, '0.3.1')).not.toBe(base)
  expect(configVersion(DEFAULT_CONFIG, '0.3.2')).not.toBe(base)

  const h = harness(on, { cfg: { ...DEFAULT_CONFIG, dataDir: 'E:\\data' } })
  on('command.run', (_, e) => ({ text: e.args }))
  h.files['LOG\\2026-10-30_aaaa.jsonl'] = '{"t":"turn","ts":2}\n{"t":"turn","ts":3}\n'
  h.files['E:\\data\\log\\2026-10-30_aaaa.jsonl'] = '{"t":"turn","ts":1}\n{"t":"turn","ts":2}\n'
  await start($)
  expect(h.files['E:\\data\\log\\2026-10-30_aaaa.jsonl']).toBe('{"t":"turn","ts":1}\n{"t":"turn","ts":2}\n{"t":"turn","ts":3}\n')
  // 删旧文件走 process.run（$.fs 没有删除）；测试里不真删，再搬一次也不会重复
  await start($)
  expect(h.files['E:\\data\\log\\2026-10-30_aaaa.jsonl']).toBe('{"t":"turn","ts":1}\n{"t":"turn","ts":2}\n{"t":"turn","ts":3}\n')

  // 报告文件写在 dataDir\report 下，md 给人和 agent 读，json 给脚本
  const out = String(((await $.command.run({ command: 'auto-router', args: 'path' } as never)) as { text?: string }).text)
  expect(out).toContain('效果报告：E:\\data\\report\\latest.md')
  expect(h.files['E:\\data\\report\\latest.md']).toMatch(/^# auto-router 效果报告[\s\S]*## 最近 7 天[\s\S]*## 最近的改动（CHANGELOG）/)
  const json = JSON.parse(h.files['E:\\data\\report\\latest.json'] as string) as { configVersion: string; week: { experiment: { versions: unknown[] } } }
  expect(json.configVersion).toBe(configVersion({ ...DEFAULT_CONFIG, dataDir: 'E:\\data' }, '?'))
  expect(Array.isArray(json.week.experiment.versions)).toBe(true)
})

test('快速开始：第一次打开显示四步引导，点“设好了”后收起并记住', async ($, on) => {
  harness(on, { cfg: DEFAULT_CONFIG })
  const store: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: store[(e as { key: string }).key] }))
  on('store.set', (_, e) => {
    const { key, value } = e as { key: string; value: unknown }
    store[key] = value
    return { value: undefined }
  })
  on('command.run', (_, e) => ({ text: e.args }))
  await start($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as never)
  await ui.press({ key: 'tab-claude' })
  let card
  for (let i = 0; i < 30 && !card; i++) card = await ui.find({ type: 'Text', text: /快速开始/ })
  expect(card).toBeDefined()
  await ui.press({ key: 'onboard-done' })
  for (let i = 0; i < 30 && store.onboarded !== true; i++) await ui.findAll({})
  expect(store.onboarded).toBe(true)
  let gone = false
  for (let i = 0; i < 30 && !gone; i++) gone = !(await ui.find({ type: 'Text', text: /🚀 快速开始/ }))
  expect(gone).toBe(true)
  await ui.unmount()
})

test('/auto-router weekly 给出指向报告目录里说明文件的提示词；doctor 逐项自检', async ($, on) => {
  const h = harness(on, { cfg: { ...DEFAULT_CONFIG, dataDir: 'E:\\data' } })
  on('command.run', (_, e) => ({ text: e.args }))
  await start($)
  const run = async (args: string) => String(((await $.command.run({ command: 'auto-router', args } as never)) as { text?: string }).text)
  const weekly = await run('weekly')
  expect(weekly).toContain('E:\\data\\report\\weekly-report-guide.md')
  expect(weekly).toContain('E:\\data\\weekly')
  expect(h.files['E:\\data\\report\\latest.md']).toBeDefined()
  expect(await run('weekly F:\\周报')).toContain('F:\\周报')
  const doc = await run('doctor')
  expect(doc).toMatch(/✓ 配置 .*版本/)
  expect(doc).toMatch(/✓ 数据目录/)
  // 分类：只数试过分类的轮次；小模型被限流但规则顶上的不算失败，冷点之间没分类的不算
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const row = (over: Record<string, unknown>) => JSON.stringify({ t: 'turn', ts: Date.now() - 1000, model: 'claude-sonnet-5-5', in: 0, cw: 0, cr: 0, out: 0, usd: 0, ...over })
  h.files[`E:\\data\\log\\${day}_abcdef12.jsonl`] = [
    ...Array.from({ length: 4 }, () => row({ cf: 'error', via: 'rule' })),
    row({ via: 'classify' }),
    row({ cf: 'timeout' }),
    ...Array.from({ length: 10 }, () => row({})),
  ].join('\n') + '\n'
  const doc2 = await run('doctor')
  expect(doc2).toContain('✓ 最近 6 次分类里小模型失败 5 次，4 次用本地规则顶上')
})

test('外派返工：相似任务判得出，返工记在上一次的模型上，返工率高的排到角色链后面', () => {
  const a = taskWords('修复 hooks/core.ts 里日志分段写的 bug，并补测试')
  expect(overlap(a, taskWords('hooks/core.ts 日志分段写的 bug 没修好，重新修复并补测试'))).toBeGreaterThanOrEqual(0.5)
  expect(overlap(a, taskWords('把 README 翻译成英文'))).toBeLessThan(0.2)

  const pi = (model: string, ok: boolean, redo?: string): LogRecord => ({ t: 'pi', ts: 10, role: 'code', model, ok, ms: 1, redo })
  const rows = redoStats([...Array.from({ length: 5 }, () => pi('a/x', true)), pi('a/x', true, 'a/x'), pi('b/y', true, 'a/x'), pi('b/y', true)], 0)
  expect(rows.find(r => r.model === 'a/x')).toEqual({ model: 'a/x', ok: 6, redo: 2 })
  expect([...demotedModels(rows)]).toEqual(['a/x'])
  expect(redoText(rows)).toContain('a/x：完成 6 个，返工 2 次（33%），已排到角色链后面')

  const code = DEFAULT_CONFIG.pi.roles.code?.models ?? []
  const first = code[0] as string
  const live = liveChain(DEFAULT_CONFIG, 'code', Date.UTC(2026, 9, 31, 18), () => false, () => false, new Set([first]))
  expect(live.models[live.models.length - 1]).toBe(first)
})

test('日志分段写：一段写满 400 行换 -2 文件，满的那段不再重写', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  on('model.classify', () => ({ value: DEFAULT_CONFIG.claude.categories[0]?.label }))
  const day = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)
  const full = Array.from({ length: 400 }, (_, i) => JSON.stringify({ t: 'turn', ts: i + 1, arm: 'auto', model: 'm', in: 1, cw: 0, cr: 0, out: 1 })).join('\n') + '\n'
  const first = `LOG\${day}_${SID.slice(0, 8)}.jsonl`
  h.files[first] = full
  await start($)
  await submit($, '你好')
  await complete($)
  expect(h.files[first]).toBe(full)
  const next = h.files[`LOG\${day}_${SID.slice(0, 8)}-2.jsonl`] ?? ''
  expect(next.trim().split('\n').length).toBe(1)
})

test('分类失败率：限流、超时的主对话轮次算进去，未命中和子代理不算', () => {
  const turn = (i: number, extra: Record<string, unknown>): LogRecord =>
    ({ t: 'turn', ts: i, arm: 'auto', model: 'm', in: 1, cw: 0, cr: 0, out: 1, usd: 0.1, sid: 's1', ex: 'route', ra: 'auto', ...extra }) as LogRecord
  const rows = [turn(1, { cf: 'error' }), turn(2, { cf: 'timeout' }), turn(3, { cf: 'none' }), turn(4, {}), turn(5, { cf: 'error', sub: true })]
  const s = sessionStats(rows)
  expect(s[0]?.cfails).toBe(2)
  expect(cellStats(s).cfailRate).toBe(0.5)
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

// ---------- 冷点切换（switchAt: cold，默认） ----------

test('冷点判断：会话开头、隔太久、压缩过（事件或上下文骤减），其余不是冷点', () => {
  const prev = { label: '编码', model: 'sonnet', lighterStreak: 0 }
  const now = 10 * 3600_000
  expect(coldReason({}, prev, now, 5000, 60)).toBe('start')
  expect(coldReason({ ts: now - 1000, ctx: 5000 }, null, now, 5000, 60)).toBe('start')
  expect(coldReason({ ts: now - 1000, ctx: 5000, compacted: true }, prev, now, 5000, 60)).toBe('compact')
  expect(coldReason({ ts: now - 61 * 60_000, ctx: 5000 }, prev, now, 5000, 60)).toBe('gap')
  expect(coldReason({ ts: now - 6 * 60_000, ctx: 5000 }, prev, now, 5000, 5)).toBe('gap')
  expect(coldReason({ ts: now - 1000, ctx: 90_000 }, prev, now, 20_000, 60)).toBe('compact')
  expect(coldReason({ ts: now - 1000, ctx: 90_000 }, prev, now, undefined, 60)).toBe('compact')
  expect(coldReason({ ts: now - 1000, ctx: 90_000 }, prev, now, 95_000, 60)).toBeUndefined()
})

test('本地规则：明确的说法判出类别，含糊的和压缩续接消息判不出', () => {
  const cats = DEFAULT_CONFIG.claude.categories
  const name = (t: string) => cats.find(c => c.label === ruleLabel(cats, t))?.name
  expect(name('你好')).toBe('闲聊/简答')
  expect(name('帮我评审一下这个 diff')).toBe('评审/查根因')
  expect(name('你觉得有必要改吗')).toBe('难题/设计')
  expect(name('实现登录功能')).toBe('编码')
  expect(name('提交')).toBe('小改动/查找')
  expect(name('批量把 import 改成别名')).toBe('批量修改')
  expect(name('再看看')).toBeUndefined()
  expect(name('This session is being continued from a previous conversation… 实现登录功能')).toBeUndefined()
  // 用户改掉了某一类的 label，那一类就没有规则
  expect(ruleLabel(cats.filter(c => c.name !== '编码'), '实现登录功能')).toBeUndefined()
})

test('冷点模式：只在会话开头分类定模型；冷点之间不分类、不降档，规则判出重活时当场升档', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  let classifyCalls = 0
  on('model.classify', () => {
    classifyCalls++
    return { value: DEFAULT_CONFIG.claude.categories[3]?.label }
  })
  await start($)
  await submit($, '登录这块你来弄')
  await complete($, 'claude-sonnet-5-5')
  await submit($, '好的')
  await complete($, 'claude-sonnet-5-5')
  await submit($, '帮我评审一下改动')
  await complete($, 'claude-opus-5-5')
  await submit($, '再看看')
  await complete($, 'claude-opus-5-5')
  expect(classifyCalls).toBe(1)
  const rows = logRows(h)
  expect(rows[0]).toMatchObject({ cold: 'start', cat: '编码', via: 'classify', pick: 'sonnet' })
  // 规则判为闲聊，但冷点之间不降档
  expect(rows[1]).toMatchObject({ cat: '闲聊/简答', via: 'rule', pick: 'sonnet' })
  expect(rows[1]?.cold).toBeUndefined()
  // 规则判为评审：升到 Opus；之后判不出类别，沿用 Opus
  expect(rows[2]).toMatchObject({ cat: '评审/查根因', pick: 'opus' })
  expect(rows[3]).toMatchObject({ cat: '沿用', pick: 'opus' })
})

test('冷点模式：小模型被限流时用本地规则顶上，不算分类失败', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  on('model.classify', () => ({ deny: RATE_LIMITED }))
  await start($)
  await submit($, '实现登录功能')
  await complete($, 'claude-sonnet-5-5')
  const rows = logRows(h)
  expect(rows[0]).toMatchObject({ cold: 'start', cat: '编码', via: 'rule', cf: 'error', pick: 'sonnet' })
  expect(sessionStats(rows.map(r => ({ ...r, ex: 'route', sid: 's1' }) as LogRecord))[0]?.cfails).toBe(0)
})

test('效果统计：冷点上换模型不算缓存重写；冷点、升档次数和规则一致率进报告', () => {
  const t = (i: number, over: Record<string, unknown>): LogRecord =>
    ({ t: 'turn', ts: i, arm: 'auto', model: 'claude-sonnet-5-5', in: 0, cw: 0, cr: 0, out: 0, usd: 0.1, sid: 's1', ex: 'route', ra: 'auto', ...over }) as LogRecord
  const rows = [
    t(1, { cold: 'start', cw: 10_000, cat: '编码', rc: '编码', via: 'classify' }),
    t(2, { model: 'claude-opus-5-5', switched: true, cw: 10_000, cat: '评审/查根因', via: 'rule' }),
    t(3, { model: 'claude-haiku-5-5', switched: true, cold: 'gap', cw: 10_000, cat: '闲聊/简答', rc: '编码', via: 'classify' }),
  ]
  const s = summarize(rows, 0)
  expect(s.arms.auto?.switches).toBe(2)
  expect(s.arms.auto?.coldSwitches).toBe(1)
  // 只有第 2 轮（冷点之间升档）算重写：1 万 ×（Opus 写 − 读）
  const opusOnly = summarize([rows[0] as LogRecord, rows[1] as LogRecord], 0).arms.auto?.switchUsd ?? 0
  expect(opusOnly).toBeGreaterThan(0)
  expect(s.arms.auto?.switchUsd).toBe(opusOnly)
  const c = cellStats(sessionStats(rows))
  expect(Math.abs(c.coldRate - 2 / 3)).toBeLessThan(1e-9)
  expect(c.coldSwitches).toBe(1)
  expect(c.midSwitches).toBe(1)
  expect(c.ruleN).toBe(2)
  expect(c.ruleAgree).toBe(0.5)
})

test('最低档：闲聊分类在冷点上也只降到 Sonnet；最低档改成 Haiku 才用 Haiku', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  on('model.classify', () => ({ value: DEFAULT_CONFIG.claude.categories[0]?.label }))
  await start($)
  await submit($, '今天过得怎么样')
  await complete($, 'claude-sonnet-5-5')
  expect(logRows(h)[0]).toMatchObject({ cold: 'start', cat: '闲聊/简答', pick: 'sonnet' })
})

test('最低档设成 Haiku 时，闲聊照旧用 Haiku', async ($, on) => {
  const h = harness(on, { cfg: { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude, floor: 'haiku' } } })
  on('model.classify', () => ({ value: DEFAULT_CONFIG.claude.categories[0]?.label }))
  await start($)
  await submit($, '今天过得怎么样')
  await complete($, 'claude-haiku-5-5')
  expect(logRows(h)[0]).toMatchObject({ cold: 'start', pick: 'haiku' })
})

test('冷点之间：问看法这类口头语判出难题也不升档，只有说法明确的才升', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  on('model.classify', () => ({ value: DEFAULT_CONFIG.claude.categories[3]?.label }))
  await start($)
  await submit($, '登录这块你来弄')
  await complete($, 'claude-sonnet-5-5')
  await submit($, '你觉得好就行')
  await complete($, 'claude-sonnet-5-5')
  await submit($, '设计一下缓存模块的接口')
  await complete($, 'claude-opus-5-5')
  const rows = logRows(h)
  expect(rows[1]).toMatchObject({ cat: '难题/设计', pick: 'sonnet' })
  expect(rows[2]).toMatchObject({ cat: '难题/设计', pick: 'opus' })
})

test('冷点上规则判出更轻的类别也不降档：规则没把握到能省这一步', async ($, on) => {
  let ctx = 5000
  const h = harness(on, { cfg: DEFAULT_CONFIG, ctx: () => ctx })
  let n = 0
  on('model.classify', () => (n++ === 0 ? { value: DEFAULT_CONFIG.claude.categories[5]?.label } : { deny: RATE_LIMITED }))
  await start($)
  await submit($, '帮我评审一下改动')
  await complete($, 'claude-opus-5-5')
  // 上下文骤减算压缩后的冷点；小模型被限流，规则判为编码（Sonnet），保持 Opus
  ctx = 100
  await submit($, '实现登录功能')
  await complete($, 'claude-opus-5-5')
  const rows = logRows(h)
  expect(rows[1]).toMatchObject({ cold: 'compact', via: 'rule', cat: '编码', pick: 'opus' })
})

test('长对话隔太久回来：提示一次缓存已过期、这轮要整段重写，建议开新会话或压缩', async ($, on) => {
  const toasts: string[] = []
  const toastMs: number[] = []
  let skew = 0
  harness(on, { cfg: DEFAULT_CONFIG, ctx: 150_000, toasts, toastMs, now: () => Date.now() + skew })
  on('model.classify', () => ({ value: DEFAULT_CONFIG.claude.categories[3]?.label }))
  await start($)
  await submit($, '实现登录功能')
  await complete($, 'claude-sonnet-5-5')
  await submit($, '再加个注册')
  expect(toasts.some(t => t.includes('缓存已过期'))).toBe(false)
  await complete($, 'claude-sonnet-5-5')
  skew = 2 * 3600_000
  await submit($, '继续')
  const hit = toasts.filter(t => t.includes('缓存已过期'))
  expect(hit.length).toBe(1)
  expect(hit[0]).toContain('15 万 token')
  expect(hit[0]).toContain('/compact')
  // 默认 4 秒读不完：按字数留时间
  expect(toastMs[toasts.indexOf(hit[0] as string)]).toBeGreaterThanOrEqual(10_000)
})

test('配置里还是旧默认提醒点（30 万 / 60 万）的按新默认（20 万 / 40 万）提醒；改过的照旧', async ($, on) => {
  harness(on, { cfg: { ...DEFAULT_CONFIG, saver: { ...DEFAULT_CONFIG.saver, remindAt: [300_000, 600_000] } }, ctx: 250_000 })
  on('model.classify', () => ({ value: 'other' }))
  await start($)
  const a = await submit($, '继续')
  expect(a.context?.join(' ') ?? '').toContain('20 万')
})

test('花费构成：按官方价拆成读、写、输出、新输入，冷点和隔太久的重建单列', () => {
  const t = (i: number, over: Record<string, unknown>): LogRecord =>
    ({ t: 'turn', ts: i, arm: 'auto', model: 'claude-sonnet-5-5', in: 1000, cw: 0, cr: 100_000, out: 2000, usd: 0, ctx: 100_000, sid: 's1', cv: '0.4.0-abc', ...over }) as LogRecord
  const c = costSplit([t(1, { cold: 'start', cw: 50_000, cr: 0 }), t(2, {}), t(3, { cold: 'gap', cw: 100_000, cr: 0 }), t(4, { sub: true })], 0)
  expect(c.turns).toBe(3)
  // Sonnet 5.5：读 0.2、写 2×2、输出 10、输入 2（每百万）
  expect(Math.abs(c.read - 0.02)).toBeLessThan(1e-9)
  expect(Math.abs(c.write - 0.6)).toBeLessThan(1e-9)
  expect(Math.abs(c.gapWrite - 0.4)).toBeLessThan(1e-9)
  expect(c.coldWrite).toBe(c.write)
  const text = costSplitText(c)
  expect(text).toContain('写缓存')
  expect(text).toContain('隔太久')
  expect(text).not.toContain('记了冷点的')
  expect(costSplitText(costSplit([], 0))).toBe('')
  // 0.4.0 之前的日志没记冷点：冷点占比只在记了的轮里算，并写明是几轮
  const mixed = costSplit([t(0, { cv: undefined, cw: 500_000, cr: 0 }), t(1, { cold: 'gap', cw: 100_000, cr: 0 }), t(2, { cw: 100_000, cr: 0 })], 0)
  expect(mixed.coldTurns).toBe(2)
  expect(costSplitText(mixed)).toContain('0.4.0 起记了冷点的 2 轮里，写缓存 50% 是冷点整段重建')
  expect(costSplitText(costSplit([t(0, { cv: '0.3.1-x', cw: 500_000 })], 0))).not.toContain('冷点')
})

async function toolsWith(on: On, $: Parameters<TestBody>[0], known: { pi: boolean; oc: boolean }): Promise<string[]> {
  const tools: string[] = []
  harness(on, { cfg: DEFAULT_CONFIG, tools })
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'channels' ? { ...known, at: 1 } : undefined }))
  await start($)
  return tools
}

test('上次检测 pi 和 opencode 都没装：不注册外派工具，系统提示里也就不提外派', async ($, on) => {
  const tools = await toolsWith(on, $, { pi: false, oc: false })
  expect(tools).not.toContain('pi_dispatch')
  expect(tools).not.toContain('pi_result')
  expect(tools).toContain('router_config')
})

test('装了 pi：照常注册外派工具', async ($, on) => {
  const tools = await toolsWith(on, $, { pi: true, oc: false })
  expect(tools).toContain('pi_dispatch')
  expect(tools).toContain('pi_result')
})

test('第一次运行按检测结果改默认配置：只开检测到的提供商并重排角色；一个都排不出时只关提供商', () => {
  const cfg = DEFAULT_CONFIG
  // 只装了 opencode
  const oc = onlyDetected(cfg, [], true)
  expect(oc.pi.providers.openai?.enabled).toBe(false)
  expect(oc.pi.providers.opencode?.enabled).toBe(true)
  const chains = Object.keys(oc.pi.roles).flatMap(r => chainFor(oc, r))
  expect(chains.length).toBeGreaterThan(0)
  expect(chains.every(m => m.startsWith('opencode/'))).toBe(true)
  // pi 里只有 openai 有 key
  const gpt = onlyDetected(cfg, ['openai/gpt-6.1-sol', 'openai/gpt-6.1-terra'], false)
  expect(gpt.pi.providers.openai?.enabled).toBe(true)
  expect(gpt.pi.providers.agnes?.enabled).toBe(false)
  expect(Object.keys(gpt.pi.roles).flatMap(r => chainFor(gpt, r)).every(m => m.startsWith('openai/'))).toBe(true)
  // 只装了 pi、配的是没定档位的提供商：排不出角色，提供商全关，外派工具不注册
  const none = onlyDetected(cfg, ['zhipu/glm-5'], false)
  expect(Object.keys(none.pi.roles).flatMap(r => chainFor(none, r))).toEqual([])
})

test('外派提示：附了提示的轮次记下建议的角色，当轮调了 pi_dispatch 记次数；报告算采纳率', async ($, on) => {
  const h = harness(on, { cfg: DEFAULT_CONFIG })
  on('store.get', (_, e) => ({ value: (e as { key: string }).key === 'channels' ? { pi: true, oc: false, at: 1 } : undefined }))
  on('model.classify', () => ({ value: DEFAULT_CONFIG.claude.categories[1]?.label }))
  await start($)
  const a = await submit($, '把这段翻译成英文')
  expect(a.context?.join(' ') ?? '').toContain('role=text')
  await $.tool.call({ tool: 'mcp__auto-router__pi_dispatch', task: '' } as never).catch(() => undefined)
  await complete($, 'claude-sonnet-5-5')
  await submit($, '好的')
  await complete($, 'claude-sonnet-5-5')
  const rows = logRows(h)
  expect(rows[0]).toMatchObject({ ph: 'text', pd: 1 })
  expect(rows[1]?.ph).toBeUndefined()
  expect(rows[1]?.pd).toBeUndefined()
})

test('外派提示统计：提示几轮、真派几轮、没提示也派了几轮，按角色分开', () => {
  const t = (i: number, over: Record<string, unknown>): LogRecord =>
    ({ t: 'turn', ts: i, model: 'claude-sonnet-5-5', in: 0, cw: 0, cr: 0, out: 0, sid: 's1', ...over }) as LogRecord
  const d = delegateStats([t(1, { ph: 'review' }), t(2, { ph: 'review', pd: 1 }), t(3, { ph: 'text' }), t(4, { pd: 2 }), t(5, { ph: 'text', sub: true, pd: 1 }), t(6, {})], 0)
  expect(d).toMatchObject({ hinted: 3, followed: 1, unprompted: 1 })
  expect(d.byRole.review).toEqual({ hinted: 2, followed: 1 })
  const text = delegateText(d)
  expect(text).toContain('提示了 3 轮，当轮真派了 1 轮（33%）；没提示也派了 1 轮')
  expect(text).toContain('review 1/2')
  expect(delegateText(delegateStats([t(1, {})], 0))).toBe('')
})
