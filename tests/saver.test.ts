import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { DEFAULT_CONFIG } from '../hooks/config'
import type { Config } from '../hooks/config'
import { countLines, crossedLevel, firstTime, fromBase64, imageDims, normPath, rulesText, shellTargets } from '../hooks/saver'
import { experimentReport, forkUsd, MIN_SESSIONS, reportText, sessionArms, unitPrices } from '../hooks/stats'
import type { LogRecord, TurnRecord } from '../hooks/stats'

type On = Parameters<TestBody>[1]

function base(on: On, cfg: Config, sid = 'abcdef1234567890') {
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__auto-router__${e.name}` } }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('clock.after', () => new Promise(() => {}))
  on('fs.exists', (_, e) => ({ value: e.path.endsWith('auto-router.json') }))
  on('fs.read', (_, e) => ({ value: e.path.endsWith('auto-router.json') ? JSON.stringify(cfg) : 'x' }))
  on('fs.write', () => ({ value: undefined }))
  on('session.id', () => ({ value: sid }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
}

/** 找一个落在指定省额度组的会话 id */
function sidFor(sv: 'on' | 'off'): string {
  for (let i = 0; ; i++) if (sessionArms(`s${i}`.padEnd(8, '0'), 'saver').sv === sv) return `s${i}`.padEnd(8, '0')
}

test('命令里读文件的目标：-Encoding 后面不是文件，-Path 后面是', () => {
  expect(shellTargets('cat a.log && type "b c.txt"')).toEqual(['a.log', 'b c.txt'])
  expect(shellTargets('Get-Content -Path big.log -Encoding utf8')).toEqual(['big.log'])
  expect(shellTargets('cat a.log | tail -n 5')).toEqual(['a.log'])
  expect(normPath('/d/work/a.txt')).toBe('d:/work/a.txt')
})

test('图片尺寸：PNG 头', () => {
  // 1600×900 的 PNG 文件头（签名 + IHDR）
  const png = 'iVBORw0KGgoAAAANSUhEUgAABkAAAAOECAYAAAA='
  expect(imageDims(fromBase64(png))).toEqual([1600, 900])
  expect(countLines('a\nb\nc\n', 10)).toBe(3)
})

test('同一目标拦一次，再请求放行，过了窗口重新拦', () => {
  const seen = new Map<string, number>()
  expect(firstTime(seen, 'k', 0)).toBe(true)
  expect(firstTime(seen, 'k', 1000)).toBe(false)
  expect(firstTime(seen, 'k', 2000)).toBe(true)
  expect(firstTime(seen, 'k', 2000 + 700_000)).toBe(true)
})

test('上下文提醒每档一次', () => {
  const done = new Set<number>()
  expect(crossedLevel(100_000, [300_000, 600_000], done)).toBeUndefined()
  expect(crossedLevel(320_000, [300_000, 600_000], done)).toBe(300_000)
  expect(crossedLevel(350_000, [300_000, 600_000], done)).toBeUndefined()
  expect(crossedLevel(650_000, [300_000, 600_000], done)).toBe(600_000)
})

test('会话分组稳定，四格都会出现', () => {
  expect(sessionArms('abcdef12', 'both')).toEqual(sessionArms('abcdef12', 'both'))
  const cells = new Set(Array.from({ length: 64 }, (_, i) => JSON.stringify(sessionArms(`sess${i}`, 'both'))))
  expect(cells.size).toBe(4)
  expect(sessionArms('abcdef12', 'route').sv).toBeUndefined()
  expect(sessionArms('abcdef12', 'off')).toEqual({ ra: undefined, sv: undefined })
})

test('大量阅读的规则：没有 pi 时只给 scout，auto 时写清选择顺序', () => {
  const noPi = rulesText({ imgCheck: 'py', bigRead: 'auto', pi: false, quotaPct: 70 })
  expect(noPi).toContain('auto-router:scout')
  expect(noPi).not.toContain('longctx')
  const auto = rulesText({ imgCheck: 'py', bigRead: 'auto', pi: true, quotaPct: 70 })
  expect(auto).toContain('role=longctx')
  expect(auto).toContain('70%')
})

test('实验报告：省额度组每轮更便宜、样本够时下结论', () => {
  const rows: LogRecord[] = []
  const turn = (sid: string, sv: 'on' | 'off', i: number, usd: number): TurnRecord => ({
    t: 'turn', ts: 1000 + i, arm: 'auto', model: 'claude-opus', in: 1, cw: 0, cr: 0, out: 1, usd, ctx: sv === 'on' ? 50_000 : 200_000, sid, ex: 'saver', sv,
  })
  for (let s = 0; s < MIN_SESSIONS; s++) {
    for (let i = 0; i < 5; i++) {
      rows.push(turn(`on${s}`, 'on', i, 0.1 + s * 0.001))
      rows.push(turn(`off${s}`, 'off', i, 0.2 + s * 0.001))
    }
  }
  rows.push({ t: 'guard', ts: 1, kind: 'read', again: false, sid: 'on0', ex: 'saver', sv: 'on' })
  rows.push({ t: 'guard', ts: 2, kind: 'read', again: true, sid: 'on0', ex: 'saver', sv: 'on' })
  const rep = experimentReport(rows, 0)
  const ef = rep.effects.find(e => e.factor === 'saver')
  expect(ef?.sure).toBe(true)
  expect(ef?.change).toBeLessThan(-0.45)
  expect(ef?.on.againRate).toBe(1)
  const text = reportText(rep, 14)
  expect(text).toContain('确实省了')
  expect(text).toContain('被原样再请求')
})

test('拦大文件：第一次拒绝并给出读法，原样再请求放行', async ($, on) => {
  base(on, DEFAULT_CONFIG)
  on('fs.stat', () => ({ value: { kind: 'file', size: 300 * 1024, mtimeMs: 0, isLink: false } }))
  let reached = 0
  on('tool.call', () => {
    reached++
    return { result: 'file text' }
  })

  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  const first = await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\big.log' })
  expect(reached).toBe(0)
  expect(JSON.stringify(first)).toContain('offset/limit')
  await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\big.log' })
  expect(reached).toBe(1)
  // 带了 limit 的直接放行
  await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\other.log', limit: 50 })
  expect(reached).toBe(2)
})

test('省额度规则写进系统提示；实验里分到“关”的会话不写', async ($, on) => {
  const cfg: Config = { ...DEFAULT_CONFIG, experiment: 'saver' }
  base(on, cfg, sidFor('on'))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  const out = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], outputStyle: null, traits: [], tools: ['mcp__auto-router__pi_dispatch'] })
  const saver = out.sections.find(s => s.id === 'auto-router:saver')
  expect(saver?.text).toContain('role=longctx')
})

test('实验里分到“关”的会话：不拦、不写规则', async ($, on) => {
  const cfg: Config = { ...DEFAULT_CONFIG, experiment: 'saver' }
  base(on, cfg, sidFor('off'))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 300 * 1024, mtimeMs: 0, isLink: false } }))
  let reached = 0
  on('tool.call', () => {
    reached++
    return { result: 'file text' }
  })
  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  const out = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['desktop'], outputStyle: null, traits: [], tools: [] })
  expect(out.sections.some(s => s.id === 'auto-router:saver')).toBe(false)
  await $.tool.call({ tool: 'Read', file_path: 'D:\\work\\big.log' })
  expect(reached).toBe(1)
})

test('上下文超过 30 万时在用户消息旁附一次提醒', async ($, on) => {
  base(on, { ...DEFAULT_CONFIG, claude: { ...DEFAULT_CONFIG.claude } })
  on('model.classify', () => ({ value: 'other' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 320_000, window: 1_000_000 }, rateLimits: [{ kind: 'seven_day', percentUsed: 10 }] } }))
  on('prompt.submit', (_, e) => ({ text: e.text, context: e.context }))
  await $.session.start({ cwd: 'D:\\work', surface: 'desktop', isInteractive: true })
  const a = await $.prompt.submit({ text: '继续' } as never)
  expect(a.context?.join('\n')).toContain('320k')
  const b = await $.prompt.submit({ text: '再继续' } as never)
  expect(b.context?.join('\n') ?? '').not.toContain('320k')
})

test('评测报告 fork 分类在切换组花费里的占比：fork 按上一轮的模型计价，不重复加', () => {
  const mk = (sid: string, ra: 'auto' | 'control', i: number, model: string, fu?: TurnRecord['fu']): TurnRecord => ({
    t: 'turn', ts: 1000 + i, arm: ra, model, in: 0, cw: 0, cr: 100_000, out: 0, usd: model.includes('opus') ? 0.05 : 0.03, sid, ex: 'route', ra, fu,
  })
  const rows: LogRecord[] = [
    mk('a1', 'auto', 0, 'claude-opus-5-5'),
    mk('a1', 'auto', 1, 'claude-sonnet-5-5', [0, 10_000, 0, 0]),
    mk('c1', 'control', 0, 'claude-opus-5-5'),
    mk('c1', 'control', 1, 'claude-opus-5-5'),
  ]
  const price = unitPrices(rows as TurnRecord[])
  // 第二轮的 fork 发生在切换前，按 opus 计价：缓存读 1 万是一轮 opus（10 万）的十分之一
  expect(Math.abs(forkUsd([0, 10_000, 0, 0], 'claude-opus-5-5', price) - 0.005)).toBeLessThan(1e-9)
  const rep = experimentReport(rows, 0)
  const ef = rep.effects.find(e => e.factor === 'route')
  expect(Math.abs((ef?.on.usd ?? 0) - 0.08)).toBeLessThan(1e-9)
  expect(Math.abs((ef?.on.forkShare ?? 0) - 0.005 / 0.08)).toBeLessThan(1e-9)
  expect(ef?.off.forkShare).toBe(0)
  expect(reportText(rep, 7)).toContain('fork 分类约占切换组花费的 6%')
})
