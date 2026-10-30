// 省额度：拦下会把大量内容灌进上下文的工具调用（同一目标只拦一次），上下文过大时提醒交接，
// 把“节省上下文”“决策与执行分离”两条规则写进系统提示。原来是 settings.json 里的 token_guard / context_watch
// 钩子和 CLAUDE.md 里的两节，并进 auto-router 后共用一份配置、一份日志和效果页。
import type { EngineInterface } from 'claude-code'

/** 同一目标第二次请求在这段时间内直接放行 */
export const AGAIN_WINDOW = 600_000
export const LIMITS = { lines: 2000, textBytes: 200 * 1024, imageBytes: 1024 * 1024, imageEdge: 1024 }
const IMG_EXT = /\.(png|jpe?g|webp|gif|bmp)$/i
const PREVIEW_DIR = '_preview'
const AGAIN = '如果确实需要完整内容，原样再请求一次就会放行（10 分钟内有效）。'

export type GuardKind = 'read' | 'image' | 'fetch' | 'shell'
export type GuardHit = { key: string; kind: GuardKind; reason: string }

/** 大量阅读交给谁：auto 按规则在 scout 和 pi longctx 之间选，scout / pi 固定一边 */
export type BigRead = 'auto' | 'scout' | 'pi'

// ---------- 判断 ----------

export function imageDims(b: Uint8Array): [number, number] | undefined {
  const u16be = (i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0)
  const u32be = (i: number) => ((u16be(i) << 16) | u16be(i + 2)) >>> 0
  const u16le = (i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8)
  const u24le = (i: number) => u16le(i) | ((b[i + 2] ?? 0) << 16)
  const ascii = (i: number, n: number) => String.fromCharCode(...b.slice(i, i + n))
  if (b[0] === 0x89 && ascii(1, 3) === 'PNG') return [u32be(16), u32be(20)]
  if (ascii(0, 4) === 'GIF8') return [u16le(6), u16le(8)]
  if (ascii(0, 2) === 'BM') return [u16le(18) | (u16le(20) << 16), Math.abs((u16le(22) | (u16le(24) << 16)) << 0)]
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && ascii(12, 4) === 'VP8X') return [u24le(24) + 1, u24le(27) + 1]
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i < b.length - 9) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const m = b[i + 1] ?? 0
      if (m >= 0xc0 && m <= 0xc2) return [u16be(i + 7), u16be(i + 5)]
      i += 2 + u16be(i + 2)
    }
  }
  return undefined
}

/** 只解码文件头，判断尺寸用 */
export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/=+$/, '').slice(0, b64.length - (b64.length % 4)))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function countLines(text: string, limit: number): number {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1 && n <= limit; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** Git Bash 的 /d/xxx 换成 d:/xxx；相对路径交给 $.fs 按会话工作目录解析 */
export function normPath(p: string): string {
  const s = p.trim().replace(/^["']|["']$/g, '')
  const m = /^\/([a-zA-Z])\/(.*)$/.exec(s)
  return m ? `${m[1]}:/${m[2]}` : s
}

const FULL_PAGE = /全文|整页|完整内容|全部内容|原文|逐字|verbatim|full (text|content|page)|entire (page|content)/i
const FILTERS =
  /\|\s*(head|tail|grep|rg|wc|less|more|sed|awk|cut|sort|uniq|jq|findstr|select-string|select-object|sls|measure-object|out-null)\b|-tail\b|-totalcount\b|-first\b|-last\b|\s-n\s*\d|--tail|--lines|(?<![0-9&])>\s*[^&\s]/i
const LOG_CMDS = /\b(journalctl|docker\s+logs|docker\s+compose\s+logs|kubectl\s+logs|pm2\s+logs)\b/i

/** 命令里 cat / type / Get-Content / gc / bat 读的文件 */
export function shellTargets(cmd: string): string[] {
  const out: string[] = []
  for (const raw of cmd.split(/&&|\|\||;|\n/)) {
    const head = (raw.split('|')[0] ?? '').trim()
    const m = /^(cat|type|get-content|gc|bat)\s+(.+)$/i.exec(head)
    if (!m) continue
    const parts = (m[2] as string).match(/"[^"]*"|'[^']*'|\S+/g) ?? []
    let skip = false
    for (const p of parts) {
      if (skip) {
        skip = false
        continue
      }
      // -Encoding 后面跟的是编码名，不是文件；-Path / -LiteralPath 后面才是文件
      if (p.toLowerCase() === '-encoding') skip = true
      if (p.startsWith('-')) continue
      out.push(p.replace(/^["']|["']$/g, ''))
    }
  }
  return out
}

async function bigText($: EngineInterface, path: string, size: number): Promise<string | undefined> {
  if (size > LIMITS.textBytes) return `${Math.round(size / 1024)}KB`
  // 每行至少一个换行符，字节数不到行数上限的文件不可能超过上限，省一次读
  if (size <= LIMITS.lines) return undefined
  const text = await $.fs.read(path)
  return countLines(text, LIMITS.lines) > LIMITS.lines ? `超过 ${LIMITS.lines} 行` : undefined
}

async function fileSize($: EngineInterface, path: string): Promise<number | undefined> {
  const st = await $.fs.stat(path, { resolve: true }).catch(() => undefined)
  return st?.kind === 'file' ? st.size : undefined
}

type Input = Record<string, unknown> & { tool: string }

/** 返回要拦的理由；不该拦时 undefined。imgCheck 是 img_check.py 的调用前缀 */
export async function checkTool($: EngineInterface, e: Input, imgCheck: string): Promise<GuardHit | undefined> {
  const tool = e.tool
  if (tool === 'Read') {
    const fp = typeof e.file_path === 'string' ? normPath(e.file_path) : ''
    if (!fp) return undefined
    const size = await fileSize($, fp)
    if (size === undefined) return undefined
    if (IMG_EXT.test(fp)) {
      if (fp.replace(/\\/g, '/').split('/').slice(-2, -1)[0] === PREVIEW_DIR) return undefined
      let dims: [number, number] | undefined
      if (size <= LIMITS.imageBytes) {
        const { base64 } = await $.fs.read(fp, { as: 'bytes' })
        dims = imageDims(fromBase64(base64.slice(0, 87_380)))
      }
      const edge = dims ? Math.max(...dims) : 0
      if (size <= LIMITS.imageBytes && edge <= LIMITS.imageEdge) return undefined
      const p = fp.replace(/\\/g, '/')
      const folder = p.replace(/\/[^/]*$/, '')
      const desc = `${Math.round(size / 1024)}KB${dims ? `，${dims[0]}×${dims[1]}` : ''}`
      return {
        key: `Read:${p.toLowerCase()}`,
        kind: 'image',
        reason:
          `[auto-router 省额度] 这张图较大（${desc}），读进来会一直留在上下文里。按要看的东西选：\n` +
          `- 看构图、风格、内容：先看 768px 预览 ${imgCheck} preview "${p}"（给目录可以一次处理整个文件夹）\n` +
          `- 看一组连续帧的节奏、分镜：拼成联系表 ${imgCheck} sheet "${folder}"（也可以直接给视频文件）\n` +
          `- 看小字、字幕、脸部、色块等细节：在预览图上量好位置，再按原图像素裁局部 ${imgCheck} crop "<预览图路径>" --box x,y,w,h\n` +
          `只有确实要看整张原图的细节时，才原样再请求一次，10 分钟内会放行。`,
      }
    }
    if (e.offset || e.limit || /\.(pdf|ipynb)$/i.test(fp)) return undefined
    const desc = await bigText($, fp, size)
    return desc
      ? {
          key: `Read:${fp.replace(/\\/g, '/').toLowerCase()}`,
          kind: 'read',
          reason: `[auto-router 省额度] 这个文件较大（${desc}），整个读进来会占很多上下文。建议先用 Grep 定位要看的位置，或用 offset/limit 分段读。${AGAIN}`,
        }
      : undefined
  }
  if (tool === 'WebFetch' || /fetch|scrape|crawl/i.test(tool)) {
    const wantsAll = e.full_content === true || (tool === 'WebFetch' && FULL_PAGE.test(String(e.prompt ?? '')))
    if (!wantsAll) return undefined
    return {
      key: `${tool}:${String(e.url ?? JSON.stringify(e.urls ?? ''))}`,
      kind: 'fetch',
      reason: `[auto-router 省额度] 这次请求的是整页全文，网页全文通常很长。建议改成按目标摘取：在 prompt / objective 里写清楚要找的具体信息。${AGAIN}`,
    }
  }
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(e.command ?? '')
    if (!cmd || FILTERS.test(cmd)) return undefined
    const key = `${tool}:${cmd.trim().slice(0, 300)}`
    if (LOG_CMDS.test(cmd) && !/--since|-n\s*\d|--tail/.test(cmd)) {
      return { key, kind: 'shell', reason: `[auto-router 省额度] 这条命令会输出整段日志。建议加 --tail / -n / --since，或用 | tail -n 100、| grep 关键词 过滤。${AGAIN}` }
    }
    for (const t of shellTargets(cmd)) {
      const path = normPath(t)
      const size = await fileSize($, path)
      if (size === undefined) continue
      const desc = await bigText($, path, size).catch(() => undefined)
      if (desc) {
        const name = path.replace(/\\/g, '/').split('/').pop()
        return {
          key,
          kind: 'shell',
          reason:
            `[auto-router 省额度] 这条命令会把整个大文件（${name}，${desc}）打印出来。` +
            `建议用 tail -n / head -n / grep（PowerShell 用 -Tail / -TotalCount / Select-String）只看需要的部分。${AGAIN}`,
        }
      }
    }
  }
  return undefined
}

/** 同一目标拦一次：第一次返回 true（拦），窗口内再请求返回 false（放行） */
export function firstTime(seen: Map<string, number>, key: string, now: number): boolean {
  for (const [k, t] of seen) if (now - t >= AGAIN_WINDOW) seen.delete(k)
  if (seen.has(key)) {
    seen.delete(key)
    return false
  }
  seen.set(key, now)
  return true
}

// ---------- 提示 ----------

/** 刚越过的提醒档位（没越过新档位时 undefined）；done 记着本会话已提醒过的档位 */
export function crossedLevel(ctx: number, levels: readonly number[], done: Set<number>): number | undefined {
  const level = Math.max(0, ...levels.filter(l => ctx >= l))
  if (!level || done.has(level)) return undefined
  done.add(level)
  return level
}

export function remindText(ctx: number, level: number): string {
  return (
    `[auto-router 省额度] 当前会话上下文约 ${Math.round(ctx / 1000)}k token（超过 ${level / 10_000} 万），之后每轮回复都要重读这么多，额度消耗很快。` +
    '请照常完成用户这条消息，然后在回复末尾用一两句话建议用户：如果接下来要做的事和前面关系不大，' +
    '先交接（有 handoff 技能就用它写 STATUS.md）再开新会话；如果还要接着做同一件事，可以手动压缩（/compact）。' +
    '只提建议，不要自己执行交接或压缩。'
  )
}

/**
 * 系统提示里的省额度规则。只随配置和 pi 是否可用变化，不随轮次变化，免得每轮让提示词缓存失效。
 * pi：当前会话有 pi_dispatch 且 longctx 角色有能用的模型。
 */
export function rulesText(opts: { imgCheck: string; bigRead: BigRead; pi: boolean; quotaPct: number }): string {
  const { imgCheck, bigRead, pi, quotaPct } = opts
  const scout = '`auto-router:scout` 子代理（Sonnet，占 Claude 额度；能用 WebFetch / MCP，结论带出处）'
  const longctx = '`mcp__auto-router__pi_dispatch`（role=longctx，DeepSeek 1M 上下文，按量付费，不占 Claude 额度；只能读本机文件和跑命令，高峰时段会排队）'
  let read: string[]
  if (bigRead === 'scout' || !pi) {
    read = [`- 预计要读超过约 3 万 token 原文才能回答的，交给 ${scout}。`]
  } else if (bigRead === 'pi') {
    read = [`- 预计要读超过约 3 万 token 原文、材料都在本机的，交给 ${longctx}；要上网查或要调 MCP 工具的交给 ${scout}。`]
  } else {
    read = [
      '- 大量阅读按下面选，从上往下第一条符合的就用：',
      '  1. 预计原文不到约 3 万 token：自己读，子代理有启动开销，小活交出去反而更费。',
      `  2. 要上网查、要调 MCP 工具，或材料里有不该发给第三方的私密内容：${scout}。`,
      `  3. 预计原文超过约 20 万 token（scout 一次读不完），或 7 天额度已用超过 ${quotaPct}%（会在用户消息旁提示）：${longctx}。`,
      `  4. 其余：${scout}。`,
    ]
  }
  return [
    '# 省额度（auto-router）',
    '',
    '## 节省上下文',
    '- 用户换了和当前无关的任务时，建议开新会话；有 handoff 技能时先用它写 STATUS.md 交接。',
    '- 抓网页优先按目标摘取（写清要找什么），不抓整页全文。',
    '- 看日志用 `tail` / `grep`（PowerShell 用 `-Tail` / `Select-String`），不整个读。',
    `- 检查截帧、截图默认看 768px 预览或联系表（${imgCheck} preview / sheet），要看小字、脸部等细节再用 crop 按原图像素裁局部；ffmpeg 截帧直接加 \`scale=768:-2\`。生成和交付用原图。`,
    '',
    '## 决策与执行分离',
    '- 需要判断、取舍、写提示词或定参数的步骤自己做，不交出去。',
    '- 能写成明确清单的大批量机械执行，默认自己做；只有做完后还要在本会话继续长时间工作（主会话上下文值得保住）时，才按 `auto-router:delegate` 技能的清单模板交给 `auto-router:executor` 子代理，或派给 pi。',
    ...read,
    '- 活小（几步就完）就自己做。当前主会话本身就是 Sonnet 或 Haiku 时，交给 Sonnet 子代理省不了多少，也自己做。',
    '- 验收按清单里的标准检查产出，不重读执行过程；不合格就重做或自己接手。',
  ].join('\n')
}

export function quotaText(pct: number): string {
  return `[auto-router 省额度] 7 天额度已用 ${pct}%。大量阅读如果材料都在本机，优先派给 pi 的 longctx 角色，不占 Claude 额度。`
}
