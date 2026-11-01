import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Config } from './config'
import { configPath, validate } from './config'
import { config, currentVersion, dataRoot, logDir, readLogs, reportDir, rt, sep } from './core'
import { categoryStats, categoryText, costSplit, costSplitText, experimentReport, redoStats, redoText, reportText, summarize } from './stats'

const piModels = atom({ plugin: 'auto-router', key: 'piModels' } as const, [], { shape: 'models-1' })
const ocModels = atom({ plugin: 'auto-router', key: 'ocModels' } as const, [], { shape: 'models-1' })
const paused = atom({ plugin: 'auto-router', key: 'paused' } as const, {}, { shape: 'paused-1' })

// 效果报告：/auto-router eval、router_config report、报告文件（<dataDir>/report/latest.md、latest.json）都从这里出。

/** 报告比较哪一版：实验开着就是当前配置的版本；关着时看日志里最近一版（关了实验，当前版本不会有实验会话） */
export async function reportVersion($: EngineInterface, cfg: Config): Promise<string | undefined> {
  return cfg.experiment === 'off' ? undefined : currentVersion($, cfg)
}

async function effectData($: EngineInterface, days: number) {
  const from = Date.now() - days * 86_400_000
  const logs = await readLogs($, from)
  const cfg = await config($)
  const s = summarize(logs, from)
  const exp = experimentReport(logs, from, await reportVersion($, cfg))
  const overall = {
    days,
    configVersion: await currentVersion($, cfg),
    experiment: cfg.experiment,
    arms: s.arms,
    // 官方价：小模型少花 − 换模型重写缓存 − fork 分类 = 净省（自动组主对话）
    savedUsdEstimate: s.savedUsd,
    cheapUsd: s.cheapUsd,
    switchUsd: s.arms.auto?.switchUsd,
    forkUsd: s.arms.auto?.forkUsd,
    netUsd: (s.savedUsd ?? 0) - (s.arms.auto?.switchUsd ?? 0) - (s.arms.auto?.forkUsd ?? 0),
    pi: s.pi,
    // 各外派模型完成数和被返工次数；返工率高的派活时排到角色链后面
    piRedo: redoStats(logs, from),
    weekQuotaPct: s.week,
    // 主对话花费按读缓存、写缓存、新输入、输出拆开（官方价）；冷点重建、缓存过期重建单独算
    costSplit: costSplit(logs, from),
    guards: logs.filter(r => r.t === 'guard' && !r.again).length,
    guardsReleased: logs.filter(r => r.t === 'guard' && r.again).length,
  }
  const { sessions: _s, ...experiment } = exp
  const extra = [costSplitText(overall.costSplit), redoText(overall.piRedo)].filter(Boolean)
  return { overall, experiment, categories: categoryStats(logs, from), text: [reportText(exp, days), ...extra].join('\n\n') }
}

/** 给定时任务这类不能敲斜杠命令的场合用：对照实验、按类别、整体汇总放在一起 */
export async function effectReport($: EngineInterface, days: number): Promise<string> {
  const d = await effectData($, days)
  return [
    `# auto-router 效果（最近 ${days} 天）`,
    '',
    '## 对照实验',
    d.text,
    '',
    '## 按类别（纠正记在被纠正的那一轮）',
    categoryText(d.categories),
    '',
    '## 整体汇总（JSON）',
    JSON.stringify(d.overall, null, 2),
  ].join('\n')
}

/** CHANGELOG 最上面几个版本的条目（只取每条的粗体标题），写进报告文件，看报告的人不用再翻仓库 */
async function changelogHead($: EngineInterface, versions = 2): Promise<string[]> {
  const text = await $.fs.read(`${$.plugin.root}${sep()}CHANGELOG.md`).catch(() => '')
  const out: string[] = []
  let seen = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('## ')) {
      if (++seen > versions) break
      out.push(line.slice(3))
    } else if (seen && /^- \*\*/.test(line)) out.push(`  - ${/^- \*\*(.+?)\*\*/.exec(line)?.[1] ?? ''}`)
  }
  return out
}

const REPORT_EVERY = 3600_000
const GUIDE = 'weekly-report-guide.md'

/**
 * 把效果报告写成文件：<dataDir>/report/latest.md 给人和任何平台的 agent 读，latest.json 给脚本。
 * 每轮结束后检查，距上次写不到一小时就跳过（看文件时间，多个会话同时开也不会重复写）。force 用于 /auto-router report
 */
export async function writeReport($: EngineInterface, force = false): Promise<string | undefined> {
  const dir = await reportDir($)
  const md = `${dir}${sep()}latest.md`
  if (!force && (await $.fs.exists(md))) {
    const st = await $.fs.stat(md).catch(() => undefined)
    if (st && Date.now() - st.mtimeMs < REPORT_EVERY) return undefined
  }
  const cfg = await config($)
  const [week, month] = [await effectData($, 7), await effectData($, 28)]
  const now = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')
  const changes = await changelogHead($)
  const text = [
    `# auto-router 效果报告`,
    '',
    `生成时间：${now}（北京时间）。插件每小时最多更新一次；超过一天没更新，多半是这期间没开 Claude Code。`,
    `当前配置版本：${week.overall.configVersion}。对照实验只比这一版的会话，旧版本列在“按配置版本”里作参考。`,
    '',
    '## 最近 7 天',
    week.text,
    '',
    '### 按类别（纠正记在被纠正的那一轮）',
    categoryText(week.categories),
    '',
    '## 最近 28 天',
    month.text,
    '',
    '## 整体汇总（7 天）',
    '```json',
    JSON.stringify(week.overall, null, 2),
    '```',
    '',
    '## 最近的改动（CHANGELOG）',
    ...changes.map(l => (l.startsWith('  ') ? l : `- ${l}`)),
  ].join('\n')
  const json = {
    generatedAt: Date.now(),
    configVersion: week.overall.configVersion,
    settings: { claude: cfg.claude, saver: cfg.saver, experiment: cfg.experiment },
    week: { overall: week.overall, experiment: week.experiment, categories: week.categories },
    month: { overall: month.overall, experiment: month.experiment, categories: month.categories },
    changelog: changes,
  }
  await $.fs.write(md, text + '\n')
  // 周报说明抄一份到报告目录：插件从市场装时目录随版本变，定时任务认这个固定位置
  const guide = await $.fs.read(`${$.plugin.root}${sep()}docs${sep()}weekly-report.md`).catch(() => '')
  if (guide) await $.fs.write(`${dir}${sep()}${GUIDE}`, guide)
  await $.fs.write(`${dir}${sep()}latest.json`, JSON.stringify(json, null, 2) + '\n')
  return md
}

/**
 * 周报定时任务的提示词，填好本机路径，粘到任何平台的定时任务里就能用。
 * 说明文件指向报告目录里的那份副本（writeReport 每次都抄一份），插件升级换了安装目录也不会失效
 */
export async function weeklyPrompt($: EngineInterface, outDir?: string): Promise<string> {
  await writeReport($, true).catch(() => undefined)
  const dir = await reportDir($)
  const out = outDir?.trim() || `${await dataRoot($)}${sep()}weekly`
  return [
    `按 ${dir}${sep()}${GUIDE} 写本周的 auto-router 效果报告（只读这份说明，照它做）。`,
    `- 报告文件：${dir}${sep()}latest.md`,
    `- 周报写到：${out}`,
    '- 路径里有空格、撇号或中文括号时，命令里一律用双引号。不开子代理，不超过 15 次工具调用。',
  ].join('\n')
}

/** /auto-router weekly：怎么在各平台设每周的定时任务，加上填好路径的提示词 */
export async function weeklyHelp($: EngineInterface, outDir?: string): Promise<string> {
  return [
    '把下面这段提示词设成每周跑一次的定时任务（选一个电脑通常开着的时间）：',
    '',
    '```',
    await weeklyPrompt($, outDir),
    '```',
    '',
    '各平台怎么设：',
    '- Claude Code 桌面版：侧栏「定时任务」→ 新建，粘贴提示词，频率选每周。',
    '- Claude Code 命令行：用系统定时器跑 claude -p "<提示词>"（Windows 用任务计划程序，macOS / Linux 用 cron）。',
    '- 其他 agent（Codex、Cursor、opencode 等）：用它们自己的定时任务，或同样用系统定时器跑它们的非交互命令。能读写本机文件就行。',
    '',
    '周报目录不写时放在数据目录下的 weekly；想放别处：/auto-router weekly <目录>。',
    '插件以后再改，这段提示词也不用改：要读的东西都在报告文件里。',
  ].join('\n')
}

/** /auto-router doctor：一次看清哪里不对，每项一行 */
export async function doctor($: EngineInterface): Promise<string> {
  const ok = (t: string) => `✓ ${t}`
  const warn = (t: string) => `⚠ ${t}`
  const bad = (t: string) => `✗ ${t}`
  const ago = (ms: number) =>
    ms < 3600_000 ? `${Math.max(1, Math.round(ms / 60_000))} 分钟前` : ms < 86_400_000 ? `${Math.round(ms / 3600_000)} 小时前` : `${Math.round(ms / 86_400_000)} 天前`
  const out: string[] = []
  const now = Date.now()

  // 配置：文件读不了或校验不过时，插件在用默认值
  const path = await configPath($, rt.isWindows)
  const raw = await $.fs.read(path).catch(() => undefined)
  let parseErr: string | undefined
  try {
    if (raw !== undefined) JSON.parse(raw)
  } catch (err) {
    parseErr = String(err).slice(0, 120)
  }
  const cfg = await config($)
  const errs = validate(cfg)
  out.push(
    raw === undefined
      ? warn(`配置文件 ${path} 不存在，在用默认值`)
      : parseErr
        ? bad(`配置文件不是合法 JSON，在用默认值：${parseErr}`)
        : errs.length
          ? bad(`配置有问题：${errs.slice(0, 2).join('；')}`)
          : ok(`配置 ${path}，版本 ${await currentVersion($, cfg)}`),
  )

  // 数据目录能不能写：写不进去日志和报告都会丢
  const root = await dataRoot($, cfg)
  const probeFile = `${root}${sep()}.doctor`
  const wrote = await $.fs
    .write(probeFile, String(now))
    .then(() => $.fs.read(probeFile))
    .then(t => t === String(now))
    .catch(() => false)
  out.push(wrote ? ok(`数据目录 ${root} 可写`) : bad(`数据目录 ${root} 写不进去，日志和报告都会丢：检查配置项 dataDir 的路径和权限`))

  // 日志：最近一轮什么时候，分类失败多不多
  const logs = await readLogs($, now - 7 * 86_400_000)
  const turns = logs.flatMap(r => (r.t === 'turn' && !r.sub ? [r] : [])).sort((a, b) => a.ts - b.ts)
  const last = turns.at(-1)
  out.push(last ? ok(`日志 ${await logDir($)}，最近一轮在 ${ago(now - last.ts)}`) : warn('最近 7 天没有日志：插件没在记录，或这段时间没用 Claude Code'))
  // 只数试过分类的轮次（冷点模式下冷点之间不分类）；小模型失败但本地规则顶上的单独算，不算失败
  const recent = turns.filter(r => (r.cf && r.cf !== 'skip') || r.via === 'classify' || r.via === 'fork').slice(-20)
  const small = recent.filter(r => r.cf && r.cf !== 'skip').length
  const ruled = recent.filter(r => r.cf && r.cf !== 'skip' && r.via === 'rule').length
  const failed = small - ruled
  const detail = `最近 ${recent.length} 次分类里小模型失败 ${small} 次${ruled ? `，${ruled} 次用本地规则顶上` : ''}`
  if (recent.length >= 5)
    out.push(
      failed / recent.length > 0.5
        ? warn(`${detail}，${failed} 次没判出类别、保持当前模型（多半是限流）；让 Claude 调 router_config action=probe 看哪条路通`)
        : small / recent.length > 0.5
          ? ok(`${detail}；插件自己的模型请求常被限流，换模型主要靠规则和纠正升档`)
          : ok(`分类：${detail}`),
    )

  // 报告文件
  const md = `${await reportDir($)}${sep()}latest.md`
  const st = await $.fs.stat(md).catch(() => undefined)
  out.push(
    !st
      ? warn('还没有报告文件：下一轮对话结束后生成，或运行 /auto-router path')
      : now - st.mtimeMs > 86_400_000
        ? warn(`报告文件在 ${ago(now - st.mtimeMs)}更新，下一轮对话结束后会重写`)
        : ok(`报告文件 ${md}，${ago(now - st.mtimeMs)}更新`),
  )

  // 外派：模型清单、暂停中的、最近成功率
  const pi = (await read($, piModels)).length
  const oc = (await read($, ocModels)).length
  out.push(pi || oc ? ok(`外派模型清单：pi ${pi} 个，opencode ${oc} 个`) : warn('还没读到外派模型清单：没装 pi / opencode，或还没在「外派模型」页点过刷新'))
  const stopped = Object.entries(await read($, paused)).filter(([, v]) => v.until > now)
  if (stopped.length) out.push(warn(`暂停中：${stopped.slice(0, 4).map(([k, v]) => `${k}（${v.reason}）`).join('、')}，到点自动恢复`))
  const jobs = logs.flatMap(r => (r.t === 'pi' ? [r] : []))
  if (jobs.length) {
    const good = jobs.filter(r => r.ok).length
    out.push(
      good / jobs.length < 0.5
        ? warn(`最近 7 天外派 ${jobs.length} 个，成功 ${good} 个：到「外派模型」页点“测一下能不能用”`)
        : ok(`最近 7 天外派 ${jobs.length} 个，成功 ${good} 个`),
    )
  }

  out.push(ok(cfg.experiment === 'off' ? '对照实验没开' : `对照实验：${cfg.experiment}（每组 15 个会话才下结论；改切换或省额度的设置会重新攒样本）`))
  return out.join('\n')
}
