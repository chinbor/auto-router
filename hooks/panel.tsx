import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ModelMode, ModelRefresh, SettingsTab } from '../types'
import { atLeast, buildRoles, CLAUDE_ALIASES, channelOf, claudeModelsFrom, isPeak, privacyBlock, providerOf, say, setPath } from './config'
import type { Billing, Config, Tier } from './config'
import { costSplit, delegateStats, demotedModels, experimentReport, modelVersions, redoStats, summarize, verdict, versionLabel } from './stats'
import { categoryIcon, modelTag } from './statusline'
import type { Arm } from './stats'
import { armLabel, clock, config, currentVersion, dataRoot, editConfig, logDir, reportDir, probeModel, readLogs, refreshOpencodeModels, refreshPiModels, rt, sessionTags } from './core'
import { weeklyPrompt } from './report'

// /auto-router 设置面板：Claude 模型、外派模型（pi 和 opencode）、效果、任务四页。改动经 editConfig 校验后写回配置文件。

// 同一 plugin/key 的 atom 在用到它的每个文件里各声明一份：引擎扫描要求 atom 写在读写它的文件里
const jobs = atom({ plugin: 'auto-router', key: 'jobs' } as const, [], { shape: 'jobs-2' })
const modelMode = atom({ plugin: 'auto-router', key: 'modelMode' } as const, 'auto' as ModelMode)
const piAuto = atom({ plugin: 'auto-router', key: 'piAuto' } as const, true)
const lastDecision = atom({ plugin: 'auto-router', key: 'last' } as const, null, { shape: 'last-3' })
const tab = atom({ plugin: 'auto-router', key: 'tab' } as const, 'claude' as SettingsTab)
const showMore = atom({ plugin: 'auto-router', key: 'showMore' } as const, false)
const configRev = atom({ plugin: 'auto-router', key: 'configRev' } as const, 0)
const piModels = atom({ plugin: 'auto-router', key: 'piModels' } as const, [], { shape: 'models-1' })
const ocModels = atom({ plugin: 'auto-router', key: 'ocModels' } as const, [], { shape: 'models-1' })
const paused = atom({ plugin: 'auto-router', key: 'paused' } as const, {}, { shape: 'paused-1' })
const setupOpen = atom({ plugin: 'auto-router', key: 'setupOpen' } as const, null as string | null)
const rebuildAsk = atom({ plugin: 'auto-router', key: 'rebuildAsk' } as const, false)
const probe = atom({ plugin: 'auto-router', key: 'probe' } as const, {}, { shape: 'probe-1' })
const refresh = atom({ plugin: 'auto-router', key: 'refresh' } as const, null as ModelRefresh | null, { shape: 'refresh-1' })
/**
 * 重新读 pi --list-models 和 opencode models，记下比上次多了、少了哪些。
 * 某条命令这次没取到（没装、失败）时，那边不算增减，免得把整家当成“都下架了”。
 */
async function refreshModels($: EngineInterface): Promise<void> {
  if ((await read($, refresh))?.running) return
  const [pi0, oc0] = [await read($, piModels), await read($, ocModels)]
  await update($, refresh, r => ({ at: r?.at ?? 0, added: r?.added ?? [], removed: r?.removed ?? [], running: true }))
  const [pi1, oc1] = await Promise.all([refreshPiModels($), refreshOpencodeModels($)])
  const diff = (before: string[], after: string[]) =>
    !before.length || !after.length
      ? { added: [], removed: [] }
      : { added: after.filter(m => !before.includes(m)), removed: before.filter(m => !after.includes(m)) }
  const [a, b] = [diff(pi0, pi1), diff(oc0, oc1)]
  await update($, refresh, () => ({ at: Date.now(), added: [...a.added, ...b.added], removed: [...a.removed, ...b.removed] }))
}

const statsDays = atom({ plugin: 'auto-router', key: 'statsDays' } as const, 7)

// 面板里显示的角色中文名和用途；配置里新加的角色显示英文名和配置里的 description
const ROLE_INFO: Record<string, { name: string; desc: string }> = {
  review: { name: '评审', desc: '独立评审代码、找 bug 根因、复杂算法，给 Claude 当第二意见' },
  code: { name: '编码', desc: '说明写清楚的编码：实现模块、补测试、按方案重构' },
  vision: { name: '看图', desc: '需要看截图或图片的任务，界面相关的活' },
  bulk: { name: '批量修改', desc: '跨很多文件的机械修改：改名、迁移、同一个改法套到各处' },
  longctx: { name: '长文阅读', desc: '读大量代码或文档（超过约 20 万 token）后做总结' },
  quick: { name: '杂活', desc: '简单杂活：看日志、跑测试并汇报、格式转换' },
  text: { name: '文本', desc: '纯文本：翻译、总结、改写、写提交说明、起名' },
  trivial: { name: '格式整理', desc: '抽取字段、整理成 JSON、简单分类' },
}

const ROLE_ICON: Record<string, string> = {
  review: '🔬',
  code: '💻',
  vision: '🖼',
  bulk: '📦',
  longctx: '📚',
  quick: '🧰',
  text: '📝',
  trivial: '🧾',
  都不行时: '🛟',
}

// 分类没分出来时，Claude 页“上一个问题”写原因，不当成一个类别
const CF_TEXT: Record<string, string> = { timeout: '分类超时', error: '分类出错', none: '分类没对上', skip: '没分类' }

// 档位的颜色：模型名按档位上色，一眼看出强弱
const TIER_COLOR: Record<string, string> = { strong: 'magenta', mid: 'cyan', light: 'green' }

const PROVIDER_NAMES: Record<string, string> = {
  openai: 'OpenAI（GPT）',
  agnes: 'Agnes',
  'cc-switch-deep-seek': 'DeepSeek',
  opencode: 'OpenCode 免费模型',
}

type PaneEvent = Parameters<EngineInterface['ui']['resolve']>[0]

export async function renderPane($: EngineInterface, e: PaneEvent) {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  await read($, configRev)
  const cfg = await config($)
  const saved = await read($, tab)
  const current: SettingsTab = (['claude', 'pi', 'stats', 'jobs'] as string[]).includes(saved) ? saved : 'claude'
  const now = Date.now()

  const edit = (fn: (c: Config) => Config) => () => {
    void editConfig($, fn).then(errs => {
      if (errs.length) $.ui.toast(`没保存：${errs[0]}`)
    })
  }

  // 一组互斥选项：下拉框；手机端画不出下拉框，退化成一排按钮，当前项高亮
  type Opt = { value: string; label: string }
  const choice = (p: { key: string; value?: string; options: Opt[]; onSelect: (v: string) => void }) =>
    'Select' in els && e.surface !== 'mobile' ? (
      <els.Select key={p.key} value={p.value} options={p.options} onSelect={v => p.onSelect(v)} />
    ) : (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {p.options.map(o => (
          <Button key={`${p.key}-${o.value}`} variant={o.value === p.value ? 'primary' : 'secondary'} label={o.label} onPress={() => p.onSelect(o.value)} />
        ))}
      </Box>
    )
  const toggle = (key: string, isOn: boolean, set: (v: boolean) => void) =>
    choice({
      key,
      value: isOn ? 'on' : 'off',
      options: [
        { value: 'on', label: '开' },
        { value: 'off', label: '关' },
      ],
      onSelect: v => set(v === 'on'),
    })
  // 一行设置：名称、控件、一句灰色说明，同一行排开
  const setting = (title: string, desc: string, control: unknown) => (
    <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
      <Box width={16} flexShrink={0}>
        <Text>{title}</Text>
      </Box>
      {control as never}
      <Text dimColor size="footnote">
        {desc}
      </Text>
    </Box>
  )
  // 一块带边框的区域：标题在左，右边一句灰色小字说明
  const section = (title: string, children: unknown, color = 'gray', right?: string) => (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1} marginBottom={1}>
        <Text bold color={color === 'gray' ? undefined : color}>
          {title}
        </Text>
        {right && (
          <Text dimColor size="footnote">
            {right}
          </Text>
        )}
      </Box>
      {children as never}
    </Box>
  )
  // 色块标签：状态、档位这类一两个字的标记
  const chip = (text: string, color: string) => (
    <Text backgroundColor={color} color="inverseText" size="footnote">
      {` ${text} `}
    </Text>
  )
  // 次要操作：链接样式的按钮，不抢眼
  const link = (key: string, label: string, onPress: () => void) => <Button key={key} plain label={label} onPress={() => onPress()} />
  const intro = (text: string) => (
    <Box marginBottom={1}>
      <Text dimColor>{text}</Text>
    </Box>
  )
  const roleName = (r: string) => ROLE_INFO[r]?.name ?? r
  const providerName = (p: string) => PROVIDER_NAMES[p] ?? p.replace(/^oc:/, '')
  // 模型一律显示完整名称（去掉 provider/ 前缀）
  const modelName = (m: string) => m.split('/').slice(1).join('/') || m
  const CH_COLOR = { pi: 'magenta', opencode: 'blue' } as const

  const running = (await read($, jobs)).filter(j => j.status === 'running' || j.status === 'waiting').length
  const TABS: [SettingsTab, string][] = [
    ['claude', '🤖 Claude 模型'],
    ['pi', '🚀 外派模型'],
    ['stats', '📊 效果'],
    ['jobs', running ? `📋 任务 · ${running}` : '📋 任务'],
  ]
  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Text bold size="heading">
          🧭 auto-router
        </Text>
        <Text dimColor size="footnote">
          小问题用小模型，能交出去的活外派给别的订阅和免费模型
        </Text>
      </Box>
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        {TABS.map(([id, name]) => (
          <Button
            key={`tab-${id}`}
            variant={id === current ? 'primary' : 'secondary'}
            label={name}
            onPress={async () => {
              await update($, tab, () => id)
              // 只在还没读过模型清单时读一次；之后要更新就点“刷新模型列表”
              if (id === 'pi' && !(await read($, piModels)).length && !(await read($, ocModels)).length) await refreshModels($)
            }}
          />
        ))}
      </Box>
    </Box>
  )

  let body
  if (current === 'claude') {
    const last = await read($, lastDecision)
    const mode = await read($, modelMode)
    const more = await read($, showMore)
    const suggest = await read($, piAuto)
    // 版本号取这台机器最近实际用到的模型 id：别名会随 Claude Code 指向新版，写死会过时
    const vers = modelVersions(await readLogs($, Date.now() - 14 * 86_400_000))
    const V = (a: string) => versionLabel(a, (vers as Record<string, string | undefined>)[a])
    // 能选的 Claude 模型：四个别名（跟最新版），加上 pi 清单里列出的具体版本（固定在那个版本）
    const claudeIds = claudeModelsFrom(await read($, piModels))
    const refreshed = await read($, refresh)
    const dot = (m: string) => modelTag(m).split(' ')[0] ?? ''
    const pinnedLabel = (id: string) => `${modelTag(id)} · 固定`
    const MODEL_OPTS = [
      ...CLAUDE_ALIASES.map(a => ({ value: a, label: `${dot(a)} ${V(a)} · 最新` })),
      ...claudeIds.map(id => ({ value: id, label: pinnedLabel(id) })),
      // 配置里写了、但这次清单里没有的具体版本，也留着能看到
      ...[...new Set(cfg.claude.categories.map(c => c.model))]
        .filter((m): m is string => !!m && !CLAUDE_ALIASES.includes(m) && !claudeIds.includes(m))
        .map(m => ({ value: m, label: pinnedLabel(m) })),
      { value: '-', label: '不变' },
    ]
    const onboarded = (await $.store.get('onboarded').catch(() => true)) === true
    // 改了会换配置版本的设置（claude、saver 两段）：实验开着时提醒一句，样本要重新攒
    const versionNote = cfg.experiment !== 'off' ? '实验进行中：改这里会从头攒样本' : undefined
    // 快速开始和“数据与报告”都放这几个控件，key 带上位置免得重名
    const dataNow = await dataRoot($, cfg)
    const dataField = (at: string) =>
      'Input' in els && e.surface !== 'mobile' ? (
        <els.Input
          key={`datadir-${at}`}
          placeholder={cfg.dataDir ? '' : `${dataNow}（默认）`}
          value={cfg.dataDir}
          submitLabel="保存"
          onSubmit={v => edit(c => setPath(c, 'dataDir', v.trim()))()}
        />
      ) : (
        <Text dimColor>{dataNow}（手机上改不了，在电脑上改）</Text>
      )
    const copyWeekly = (at: string) => (
      <Button
        key={`copy-weekly-${at}`}
        plain
        label="📋 复制周报定时任务的提示词"
        onPress={press =>
          void weeklyPrompt($)
            .then(text => $.ui.copy({ text, surface: press.surface }))
            .then(r => say($, r.isCopied ? '已复制：粘到任意平台的定时任务里，每周跑一次（详见 /auto-router weekly）' : '复制失败，改用 /auto-router weekly'))
        }
      />
    )
    const experimentChoice = (at: string) =>
      choice({
      key: at === 'more' ? 'experiment' : `experiment-${at}`,
      value: cfg.experiment,
      options: [
        { value: 'off', label: '关' },
        { value: 'route', label: '测模型切换（推荐）' },
        { value: 'saver', label: '测省额度' },
        { value: 'both', label: '两个都测' },
      ],
      onSelect: v => edit(c => setPath(c, 'experiment', v))(),
    })
    const setOnboarded = (v: boolean) => void $.store.set('onboarded', v).then(() => update($, configRev, n => n + 1)).catch(() => undefined)
    body = (
      <Box flexDirection="column">
        {!onboarded &&
          section(
            '🚀 快速开始',
            <Box flexDirection="column">
              {setting('① 外派模型', '把执行类的活派给 GPT、DeepSeek 或免费模型', link('go-pi', '去「外派模型」页配置 →', () => void update($, tab, () => 'pi')))}
              {setting('② 数据放哪', '日志和报告；清理工具会扫 ~/.claude 的话放别的盘，旧日志自动搬过去', dataField('start'))}
              {setting('③ 对照实验', '想知道切换到底省不省钱就开；只测切换约 30 个会话出结论', experimentChoice('start'))}
              {setting('④ 每周报告', '粘到任意平台的定时任务里', copyWeekly('start'))}
              {link('onboard-done', '✓ 设好了，收起', () => setOnboarded(true))}
            </Box>,
            'magenta',
            '其余都有默认值，不用动',
          )}
        {/* 概览：现在怎么切、上一个问题被分到哪类、用了哪个模型 */}
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
          {chip(mode === 'auto' ? '自动切换' : mode === 'off' ? '不切换' : `固定 ${V(mode)}`, mode === 'auto' ? 'success' : 'warning')}
          <Text dimColor>上一个问题</Text>
          <Text>
            {!last
              ? '还没有'
              : last.cf
                ? `⚠ ${CF_TEXT[last.cf] ?? last.label}，${last.model ? `保持 ${modelTag(last.model)}` : '不切换'}`
                : `${categoryIcon(last.label)} ${last.label}  →  ${last.model ? modelTag(last.model) : '不切换'}`}
          </Text>
        </Box>
        {section(
          '🎛 每类问题用哪个模型',
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
              <Box width={16} flexShrink={0}>
                <Text bold>切换方式</Text>
              </Box>
              {choice({
                key: 'mode',
                value: mode,
                options: [
                  { value: 'auto', label: '自动' },
                  { value: 'off', label: '不切换' },
                  { value: 'haiku', label: `固定 ${V('haiku')}` },
                  { value: 'sonnet', label: `固定 ${V('sonnet')}` },
                  { value: 'opus', label: `固定 ${V('opus')}` },
                ],
                onSelect: v => void update($, modelMode, () => v as ModelMode),
              })}
            </Box>
            {mode === 'auto' &&
              cfg.claude.categories.map((cat, i) => (
                <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Box width={16} flexShrink={0}>
                    <Text>{`${categoryIcon(cat.name)} ${cat.name}`}</Text>
                  </Box>
                  {choice({
                    key: `cm-${i}`,
                    value: cat.model ?? '-',
                    options: MODEL_OPTS,
                    onSelect: v => edit(c => setPath(c, `claude.categories.${i}.model`, v === '-' ? undefined : v))(),
                  })}
                  {atLeast(cat.model, cfg.claude.floor) !== cat.model && (
                    <Text dimColor size="footnote">
                      按最低档 {V(cfg.claude.floor)}
                    </Text>
                  )}
                  {cat.piRole && (
                    <Text dimColor size="footnote">
                      也可外派（{roleName(cat.piRole)}）
                    </Text>
                  )}
                </Box>
              ))}
            {mode === 'auto' && (
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginTop={1}>
                <Text dimColor size="footnote">
                  {claudeIds.length
                    ? `“最新”出新版自动跟着换，“固定”一直用那个版本（可选 ${claudeIds.length} 个）`
                    : '“最新”出新版自动跟着换；想固定某个版本，要在 pi 里配好 anthropic'}
                </Text>
                {link('refresh-claude', refreshed?.running ? '⟳ 刷新中…' : '⟳ 刷新', () => void refreshModels($))}
              </Box>
            )}
          </Box>,
          'cyan',
          mode === 'auto' ? versionNote : undefined,
        )}
        <Box marginBottom={1}>{link('more', more ? '▴ 收起更多设置' : '⚙ 更多设置 ▾', () => void update($, showMore, () => !more))}</Box>
        {more &&
          section(
            '🔀 切换细节',
            <Box flexDirection="column">
              {setting(
                '最低用到',
                '主对话不低于这一档。闲聊轮实测只占花费的 1%，换到 Haiku 省得很少，还要多一次缓存重写',
                choice({
                  key: 'floor',
                  value: cfg.claude.floor,
                  options: [
                    { value: 'sonnet', label: `${V('sonnet')}（推荐）` },
                    { value: 'haiku', label: V('haiku') },
                  ],
                  onSelect: v => edit(c => setPath(c, 'claude.floor', v))(),
                }),
              )}
              {setting(
                '什么时候换模型',
                cfg.claude.switchAt === 'cold'
                  ? '只在缓存本来就要重建时（会话开头、隔太久、上下文刚压缩）分类和换模型，中间沿用，不多花缓存重写的钱'
                  : '每条消息都分类，按需换模型；换一次要重写整段缓存，实测省下的不够补',
                choice({
                  key: 'switch-at',
                  value: cfg.claude.switchAt,
                  options: [
                    { value: 'cold', label: '缓存冷时（推荐）' },
                    { value: 'turn', label: '每条消息' },
                  ],
                  onSelect: v => edit(c => setPath(c, 'claude.switchAt', v))(),
                }),
              )}
              {cfg.claude.switchAt === 'cold' &&
                setting(
                  '缓存多久过期',
                  '隔这么久没说话，下一条就重新定模型；订阅登录是 1 小时，用 API key 是 5 分钟',
                  choice({
                    key: 'cold-gap',
                    value: String(cfg.claude.coldGapMinutes),
                    options: [
                      { value: '5', label: '5 分钟' },
                      { value: '60', label: '1 小时' },
                    ],
                    onSelect: v => edit(c => setPath(c, 'claude.coldGapMinutes', Number(v)))(),
                  }),
                )}
              {cfg.claude.switchAt === 'turn' &&
                setting(
                  '降档要连续几轮',
                  '升档立即生效，降档要连续几轮都是简单问题',
                  choice({
                    key: 'downgrade',
                    value: String(cfg.claude.downgradeAfter),
                    options: ['1', '2', '3', '4', '6'].map(n => ({ value: n, label: n })),
                    onSelect: v => edit(c => setPath(c, 'claude.downgradeAfter', Number(v)))(),
                  }),
                )}
              {setting(
                '被纠正时升一档',
                '你说“不对 / 重做”时换更强的',
                toggle('fix-up', cfg.claude.upgradeOnCorrection, v => edit(c => setPath(c, 'claude.upgradeOnCorrection', v))()),
              )}
              {setting(
                '分类失败时 fork',
                cfg.claude.switchAt === 'cold'
                  ? '小模型和本地规则都分不出时让主模型分；只在上下文不到 3 万时用'
                  : '小模型和本地规则都分不出时让主模型分；要读一遍整段上下文，长对话里比省下的还贵',
                toggle('fork', cfg.claude.forkFallback, v => edit(c => setPath(c, 'claude.forkFallback', v))()),
              )}
              {cfg.claude.switchAt === 'turn' &&
                setting(
                  '对话很长时不降档',
                  '超过这么长不再降档，换模型要重写缓存',
                  choice({
                    key: 'keep',
                    value: String(cfg.claude.keepAboveTokens),
                    options: [
                      { value: '80000', label: '8 万' },
                      { value: '150000', label: '15 万' },
                      { value: '300000', label: '30 万' },
                      { value: '0', label: '不限' },
                    ],
                    onSelect: v => edit(c => setPath(c, 'claude.keepAboveTokens', Number(v)))(),
                  }),
                )}
            </Box>,
            'cyan',
            versionNote,
          )}
        {more &&
          section(
            '💰 省额度',
            <Box flexDirection="column">
              {setting(
                '总开关',
                '拦大文件、大图、整页网页，上下文太大时提醒交接；下个会话起生效',
                toggle('saver', cfg.saver.enabled, v => edit(c => setPath(c, 'saver.enabled', v))()),
              )}
              {setting(
                '拦大读取',
                '第一次拦下并给出省的读法，再请求就放行',
                toggle('guard', cfg.saver.guard, v => edit(c => setPath(c, 'saver.guard', v))()),
              )}
              {setting(
                '大量阅读交给',
                '自动：小的自己读，上网或私密用 scout，超 20 万或额度紧用 pi',
                choice({
                  key: 'bigread',
                  value: cfg.saver.bigRead,
                  options: [
                    { value: 'auto', label: '自动' },
                    { value: 'scout', label: 'scout' },
                    { value: 'pi', label: 'pi longctx' },
                  ],
                  onSelect: v => edit(c => setPath(c, 'saver.bigRead', v))(),
                }),
              )}
              {setting(
                '提醒 Claude 外派',
                '适合交出去的活提醒 Claude 外派',
                toggle('suggest', suggest, v => void update($, piAuto, () => v)),
              )}
            </Box>,
            'green',
            versionNote,
          )}
        {more &&
          section(
            '📁 数据与报告',
            <Box flexDirection="column">
              {setting('数据目录', '回车保存；清空用默认位置。改了以后旧日志在下次开会话时搬过去', dataField('more'))}
              {setting('每周报告', '报告文件每小时更新，定时任务照着它写周报', copyWeekly('more'))}
              <Box flexDirection="row" gap={1} flexWrap="wrap">
                <Text dimColor size="footnote">
                  哪里不对劲时运行 /auto-router doctor 自检。
                </Text>
                {onboarded && link('onboard-again', '重新显示快速开始', () => setOnboarded(false))}
              </Box>
            </Box>,
            'blue',
          )}
        {more &&
          section(
            '🧪 对照实验',
            <Box flexDirection="column">
              {setting('测什么', '新会话随机分组，每组 15 个会话出结论；两个都测要攒约 60 个', experimentChoice('more'))}
              <Text color="cyan" size="footnote">
                {armLabel(await sessionTags($))}
              </Text>
            </Box>,
            'yellow',
          )}
      </Box>
    )
  } else if (current === 'pi') {
    const known = await read($, piModels)
    const ocKnown = await read($, ocModels)
    const expanded = await read($, setupOpen)
    const pausedMap = await read($, paused)
    const confirmRebuild = await read($, rebuildAsk)
    const probes = await read($, probe)
    const tiers = cfg.pi.tiers
    const isOn = (p: string) => cfg.pi.providers[p]?.enabled === true
    const isOcProv = (p: string) => p === 'opencode' || p.startsWith('oc:')
    // 每个通道的提供商：配置过的加上清单里列出的；opencode 自己的免费模型单独放第一家
    const byName = (a: string, b: string) => a.localeCompare(b)
    const piProvs = [...new Set([...Object.keys(cfg.pi.providers).filter(p => !isOcProv(p)), ...known.map(providerOf)])].sort(byName)
    const ocProvs = [
      'opencode',
      ...[...new Set([...Object.keys(cfg.pi.providers).filter(p => p.startsWith('oc:')), ...ocKnown.map(providerOf)])].filter(p => p !== 'opencode').sort(byName),
    ]
    const flags = (expanded ?? '').split(',')
    const flag = (k: string) => flags.includes(k)
    const setFlag = (k: string) => void update($, setupOpen, () => (flag(k) ? flags.filter(f => f && f !== k) : [...flags.filter(Boolean), k]).join(',') || null)
    const listedFor = (p: string) => (isOcProv(p) ? ocKnown : known).filter(m => providerOf(m) === p)
    const refreshed = await read($, refresh)
    // 刷新后新出现的模型，在清单里标“新”
    const isNew = (m: string) => (refreshed?.added ?? []).includes(m)
    const gone = (m: string) => channelOf(m) === 'opencode' && ocKnown.length > 0 && !ocKnown.includes(m)
    // pi 已经列出模型清单时，不在清单里的就是没装或没配 key
    const missing = (m: string) => channelOf(m) === 'pi' && known.length > 0 && !known.includes(m)
    const blocked = (m: string, role: string) => privacyBlock(cfg, m, role, rt.sessionCwd, rt.isWindows)
    // 额度用完的模型在派活顺序里只标 ⏸，什么时候恢复在 ③ 顶部合成一条写
    const QUOTA = '额度用完'
    // 此刻不用这个模型的原因；null 表示能用
    const whyNot = (m: string, role: string): string | null => {
      const p = cfg.pi.providers[providerOf(m)]
      if (p?.enabled === false) return '已关'
      if (missing(m)) return '没检测到'
      if (isPeak(p?.peak, now)) return '高峰'
      if ((pausedMap[providerOf(m)]?.until ?? 0) > now) return '暂停'
      if ((pausedMap[m]?.until ?? 0) > now) return QUOTA
      if (gone(m)) return '已下架'
      if (blocked(m, role)) return '隐私'
      return null
    }
    // 改计费方式或档位后，按档位重排各角色的模型
    const rebuild = (fn: (c: Config) => Config) => edit(c => buildRoles(fn(c)))
    const setProvider = (p: string, v: string) =>
      rebuild(c => {
        const old = c.pi.providers[p] ?? { enabled: true, billing: 'subscription' as const }
        const next = v === 'off' ? { ...old, enabled: false } : { ...old, enabled: true, billing: v as Billing }
        return setPath(c, 'pi.providers', { ...c.pi.providers, [p]: next })
      })()
    const setTier = (m: string, v: string) =>
      rebuild(c => {
        const next = { ...c.pi.tiers }
        if (v === 'none') delete next[m]
        else next[m] = v as Tier
        return setPath(c, 'pi.tiers', next)
      })()
    const TIER_OPTS = [
      { value: 'strong', label: '强' },
      { value: 'mid', label: '中' },
      { value: 'light', label: '轻' },
      { value: 'none', label: '不用' },
    ]
    const BILL_OPTS = [
      { value: 'free', label: '免费' },
      { value: 'subscription', label: '订阅' },
      { value: 'token', label: '按量付费' },
      { value: 'off', label: '不用' },
    ]

    // 列宽：提供商行和模型行的下拉框落在同一列；下拉框定宽，后面的标记也对齐。手机端是一排按钮，不限宽
    const NAME_W = 32
    const SELECT_W = 12
    const fixed = (w: number, node: unknown) =>
      e.surface === 'mobile' ? (
        (node as never)
      ) : (
        <Box width={w} flexShrink={0}>
          {node as never}
        </Box>
      )
    // 一家一行：名称、状态、计费方式
    const providerRow = (p: string) => {
      const prov = cfg.pi.providers[p]
      const isUsed = prov?.enabled === true
      const pause = pausedMap[p]
      const isPaused = (pause?.until ?? 0) > now
      const peakNow = prov?.peak && isPeak(prov.peak, now)
      const [state, color] = !isUsed ? ['不用', 'gray'] : isPaused ? ['暂停', 'red'] : peakNow ? ['高峰', 'yellow'] : ['可用', 'green']
      const total = listedFor(p).length
      const picked = Object.keys(tiers).filter(m => providerOf(m) === p && !missing(m) && !gone(m)).length
      // 名称 + 状态正好占模型行的“缩进 + 模型名”那么宽，付费方式和下面的档位下拉对齐
      return (
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Box width={NAME_W - 7} flexShrink={0}>
            <Text bold>{providerName(p)}</Text>
          </Box>
          <Box width={6} flexShrink={0}>
            {chip(state, color)}
          </Box>
          {fixed(SELECT_W, choice({ key: `bill-${p}`, value: isUsed ? prov?.billing : 'off', options: BILL_OPTS, onSelect: v => setProvider(p, v) }))}
          <Text dimColor size="footnote">
            {[total ? `用 ${picked} / ${total} 个` : picked ? `用 ${picked} 个` : '', isPaused ? `暂停到 ${clock(pause?.until ?? 0)}` : '']
              .filter(Boolean)
              .join(' · ')}
          </Text>
          {isPaused && (
            <Button
              key={`resume-${p}`}
              label="恢复"
              onPress={() =>
                void update($, paused, map => {
                  const { [p]: _gone, ...others } = map
                  return others
                })
              }
            />
          )}
        </Box>
      )
    }

    // 一个模型一行：名称、档位
    const modelRow = (m: string) => (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Box width={NAME_W - 2} flexShrink={0}>
          <Text color={gone(m) ? 'gray' : TIER_COLOR[tiers[m] ?? '']} dimColor={!tiers[m] && !gone(m)} strikethrough={gone(m)}>
            {`${tiers[m] ? '●' : '○'} ${modelName(m)}`}
          </Text>
        </Box>
        {fixed(SELECT_W, choice({ key: `tier-${m}`, value: tiers[m] ?? 'none', options: TIER_OPTS, onSelect: v => setTier(m, v) }))}
        {isNew(m) && chip('新', 'green')}
        {gone(m) && (
          <Text color="yellow" size="footnote">
            已下架
          </Text>
        )}
        {cfg.opencode.logged.includes(m) && (
          <Text color="yellow" size="footnote">
            会保存内容
          </Text>
        )}
      </Box>
    )
    // 一家：上面一行选付费方式，下面列出它的全部模型选档位。没启用的只显示一行；模型太多时没选档位的先收起
    const FOLD_OVER = 12
    const providerBlock = (p: string) => {
      const listed = listedFor(p)
      // 检测到了就列检测到的；没检测到任何（没装 pi / opencode）才列配置里的
      const models = listed.length ? listed : Object.keys(tiers).filter(m => providerOf(m) === p)
      const ignored = listed.length ? Object.keys(tiers).filter(m => providerOf(m) === p && !listed.includes(m)).length : 0
      const open = flag(`all-${p}`)
      const folded = models.length > FOLD_OVER && !open
      const shown = folded ? models.filter(m => tiers[m] || isNew(m)) : models
      return (
        <Box flexDirection="column" marginBottom={1}>
          {providerRow(p)}
          {isOn(p) ? (
            <Box flexDirection="column" paddingLeft={2}>
              {shown.map(modelRow)}
              {models.length === 0 && <Text dimColor size="footnote">没检测到这家的模型。</Text>}
              {ignored > 0 && (
                <Text dimColor size="footnote">
                  配置里另有 {ignored} 个模型这次没检测到，不会用
                </Text>
              )}
              {models.length > FOLD_OVER && (
                <Box>{link(`all-${p}`, open ? '▴ 收起没选档位的' : `▾ 显示其余 ${models.length - shown.length} 个`, () => setFlag(`all-${p}`))}</Box>
              )}
            </Box>
          ) : null}
        </Box>
      )
    }
    // 一个通道：启用的各家逐个列出；没启用的收成一行，点开再选付费方式
    const channelBody = (key: string, provs: string[], keepShown: string[] = []) => {
      const on = provs.filter(p => isOn(p) || keepShown.includes(p))
      const off = provs.filter(p => !on.includes(p))
      const open = flag(`off-${key}`)
      return (
        <Box flexDirection="column">
          {on.map(providerBlock)}
          {off.length > 0 && (
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
              <Text dimColor size="footnote">
                还有 {off.length} 家没启用
              </Text>
              {link(`off-${key}`, open ? '▴ 收起' : '▾ 展开，选一家启用', () => setFlag(`off-${key}`))}
            </Box>
          )}
          {open && off.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              {off.map(providerBlock)}
            </Box>
          )}
        </Box>
      )
    }

    // 隐私开关：哪些目录的内容可以发给会保存内容的免费模型（一个下拉框）
    const dirs = cfg.opencode.allowDirs
    const here = rt.sessionCwd
    const ocUsed = cfg.pi.providers.opencode?.enabled === true
    const privacyValue = dirs.includes('*') ? 'all' : dirs.length === 0 ? 'none' : dirs.length === 1 && dirs[0] === here ? 'here' : 'some'
    const privacy = (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text>标黄的模型（提供方会保存内容）</Text>
          {choice({
            key: 'privacy',
            value: privacyValue,
            options: [
              { value: 'none', label: '不用' },
              { value: 'here', label: '只在当前目录用' },
              ...(privacyValue === 'some' ? [{ value: 'some', label: `只在 ${dirs.length} 个目录用` }] : []),
              { value: 'all', label: '所有目录都用' },
            ],
            onSelect: v => {
              if (v === 'some') return
              const next = v === 'all' ? ['*'] : v === 'here' ? [here] : []
              edit(c => setPath(c, 'opencode.allowDirs', next))()
            },
          })}
        </Box>
      </Box>
    )

    const roles = Object.entries(cfg.pi.roles)
    // “测一下”：派活顺序和兜底里用到的模型，各发一句“回复 OK”，4 个一起跑
    const toProbe = [...new Set([...roles.flatMap(([, r]) => r.models), ...cfg.pi.fallback])].filter(
      m => cfg.pi.providers[providerOf(m)]?.enabled !== false,
    )
    const probing = toProbe.some(m => probes[m]?.running)
    const lastProbe = Math.max(0, ...toProbe.map(m => (probes[m]?.running ? 0 : (probes[m]?.at ?? 0))))
    const runProbe = async () => {
      if (probing) return
      await update($, probe, map => ({ ...map, ...Object.fromEntries(toProbe.map(m => [m, { ok: false, ms: 0, at: 0, running: true }])) }))
      const queue = [...toProbe]
      const worker = async () => {
        for (let m = queue.shift(); m; m = queue.shift()) {
          const r = await probeModel($, cfg, m)
          await update($, probe, map => ({ ...map, [m]: r }))
          // 免费额度用完：按报的时间暂停这个模型；测通了就解除这个模型的暂停
          if (r.retryAfterMs) await update($, paused, map => ({ ...map, [m]: { until: r.at + (r.retryAfterMs ?? 0), reason: r.why ?? '' } }))
          else if (r.ok)
            await update($, paused, map => {
              const { [m]: _done, ...rest } = map
              return rest
            })
        }
      }
      await Promise.all([worker(), worker(), worker(), worker()])
    }
    // 测试结果只标一个符号；跳过的模型不再标（原因已经写了）
    const probeMark = (m: string) => {
      const r = probes[m]
      if (!r) return null
      if (r.running)
        return (
          <Text dimColor size="footnote">
            …
          </Text>
        )
      return r.ok ? (
        <Text color="green" size="footnote">
          ✓
        </Text>
      ) : (
        <Text color="red" size="footnote">
          ✗ {(r.why ?? '').slice(0, 24)}
        </Text>
      )
    }

    // 每类活一行：此刻会用的绿色加粗；此刻跳过的变灰，后面一个小字原因；能用的后面标测试结果
    const chain = (name: string, ms: string[], readOnly?: boolean) => {
      const firstLive = ms.find(m => !whyNot(m, name))
      return (
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
          <Box width={14} flexShrink={0} flexDirection="row" gap={1}>
            <Text bold>{`${ROLE_ICON[name] ?? '▫'} ${roleName(name)}`}</Text>
            {readOnly && (
              <Text dimColor size="footnote">
                只读
              </Text>
            )}
          </Box>
          {ms.map((m, i) => {
            const why = whyNot(m, name)
            return (
              <Box flexDirection="row" gap={1} alignItems="center">
                {i > 0 && <Text dimColor>›</Text>}
                <Text color={why ? 'gray' : m === firstLive ? 'green' : undefined} bold={m === firstLive} dimColor={!!why}>
                  {modelName(m)}
                </Text>
                {why === QUOTA ? (
                  <Text color="yellow" size="footnote">
                    ⏸
                  </Text>
                ) : why ? (
                  <Text color="yellow" size="footnote">
                    {why}
                  </Text>
                ) : (
                  probeMark(m)
                )}
              </Box>
            )
          })}
          {name !== '都不行时' && !firstLive && <Text color="yellow">› 走兜底</Text>}
        </Box>
      )
    }
    const roleRow = ([name, r]: [string, (typeof roles)[number][1]]) => chain(name, r.models, r.readOnly)
    // 额度用完的模型按恢复时间分组：“08:04 恢复 glm-5.3-flash-free、nemotron-3.5-lightning-free”
    const quotaOut = new Map<string, string[]>()
    for (const m of toProbe.filter(m => (pausedMap[m]?.until ?? 0) > now).sort((a, b) => (pausedMap[a]?.until ?? 0) - (pausedMap[b]?.until ?? 0))) {
      const at = clock(pausedMap[m]?.until ?? 0)
      quotaOut.set(at, [...(quotaOut.get(at) ?? []), modelName(m)])
    }
    const auto = buildRoles(cfg).pi
    const drifted = JSON.stringify([auto.roles, auto.fallback]) !== JSON.stringify([cfg.pi.roles, cfg.pi.fallback])

    // 概览：在用几家、几个模型定了档位、几类活此刻有模型可派
    const usedProvs = [...piProvs, ...ocProvs].filter(isOn).length
    const tieredCount = Object.keys(tiers).filter(m => !missing(m) && !gone(m)).length
    const liveRoles = roles.filter(([name, r]) => r.models.some(m => !whyNot(m, name))).length
    body = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
          {chip(`${usedProvs} 家在用`, 'claude')}
          {chip(`${tieredCount} 个模型定了档位`, 'suggestion')}
          {chip(`${liveRoles} / ${roles.length} 类活此刻能派`, liveRoles === roles.length ? 'success' : 'warning')}
          <Text dimColor size="footnote">
            档位：
          </Text>
          <Text color={TIER_COLOR.strong}>● 强</Text>
          <Text color={TIER_COLOR.mid}>● 中</Text>
          <Text color={TIER_COLOR.light}>● 轻</Text>
          <Text dimColor>○ 不用</Text>
        </Box>
        {intro('每家选付费方式，每个模型选档位，改完自动生效；③ 按“免费 › 订阅 › 按量”和档位自动排。')}
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
          {link('refresh-models', refreshed?.running ? '⟳ 刷新中…' : '⟳ 刷新模型列表', () => void refreshModels($))}
          <Text dimColor size="footnote">
            {refreshed?.running
              ? '正在重新读 pi 和 opencode 有哪些模型…'
              : refreshed?.at
                ? `${clock(refreshed.at)} 刷新：${
                    refreshed.added.length || refreshed.removed.length
                      ? [
                          refreshed.added.length ? `多了 ${refreshed.added.length} 个（下面标“新”）` : '',
                          refreshed.removed.length ? `没了 ${refreshed.removed.map(modelName).join('、')}` : '',
                        ]
                          .filter(Boolean)
                          .join('；')
                      : '和上次一样'
                  }`
                : '官方新出或你自己加了模型，点一下就会列出来'}
          </Text>
        </Box>
        {section(
          '① pi 通道',
          <Box flexDirection="column">
            {known.length === 0 && (
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
                <Text color="yellow">没检测到 pi 的模型（终端里 pi --list-models 要能列出来）</Text>
                <Button key="detect" label="重新检测" onPress={() => void refreshPiModels($)} />
              </Box>
            )}
            {channelBody('pi', piProvs)}
          </Box>,
          'magenta',
          '你自己配的各家模型',
        )}
        {section(
          '② opencode 通道',
          <Box flexDirection="column">
            {ocKnown.length === 0 && cfg.pi.providers.opencode?.enabled !== false && (
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
                <Text color="yellow">没检测到 opencode 的模型（终端里 opencode models 要能列出来）</Text>
                <Button key="detect-oc" label="重新检测" onPress={() => void refreshOpencodeModels($)} />
              </Box>
            )}
            {channelBody('oc', ocProvs, ['opencode'])}
            {ocUsed && privacy}
          </Box>,
          'blue',
          '免费模型，和你在 opencode 里配的各家',
        )}
        {section(
          '③ 派活顺序',
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
              {link('probe', probing ? '⏱ 测试中…' : '⏱ 测一下能不能用', () => void runProbe())}
              <Text dimColor size="footnote">
                {probing
                  ? `正在测 ${toProbe.length} 个模型，约半分钟`
                  : lastProbe
                    ? `${clock(lastProbe)} 测过：✓ 能用，✗ 不能用`
                    : `给每个模型发一句“回复 OK”，花费极小`}
              </Text>
            </Box>
            {quotaOut.size > 0 && (
              <Box flexDirection="column" marginBottom={1}>
                <Text color="yellow">⏸ {[...quotaOut.values()].flat().length} 个模型免费额度用完，到点自动恢复：</Text>
                {[...quotaOut].map(([at, ms]) => (
                  <Text dimColor size="footnote">
                    {`   ${at} 恢复  ${ms.join('、')}`}
                  </Text>
                ))}
              </Box>
            )}
            {roles.map(roleRow)}
            {cfg.pi.fallback.length > 0 && chain('都不行时', cfg.pi.fallback)}
            <Text dimColor size="footnote">
              绿色 = 此刻会用；灰色 = 此刻跳过，黄字是原因，⏸ = 额度用完。
            </Text>
            {/* 你或 Claude 手调过顺序时，才给“恢复按档位排”的入口 */}
            {drifted && (
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginTop={1}>
                <Text color="yellow" size="footnote">
                  {confirmRebuild ? '手调过的顺序会被覆盖，确定？' : '有几类活的顺序是手调过的，没按档位排。'}
                </Text>
                {confirmRebuild ? (
                  <Box flexDirection="row" gap={1}>
                    <Button
                      key="rebuild-yes"
                      label="确定"
                      onPress={() => {
                        void update($, rebuildAsk, () => false)
                        void rebuild(c => c)()
                      }}
                    />
                    <Button key="rebuild-no" label="取消" onPress={() => void update($, rebuildAsk, () => false)} />
                  </Box>
                ) : (
                  link('rebuild', '↺ 恢复按档位排', () => void update($, rebuildAsk, () => true))
                )}
              </Box>
            )}
          </Box>,
          'cyan',
          '从左往右试，前一个失败才换下一个',
        )}
      </Box>
    )
  } else if (current === 'stats') {
    const days = await read($, statsDays)
    const from = now - days * 86_400_000
    const logs = await readLogs($, from)
    const s = summarize(logs, from)
    const split = costSplit(logs, from)
    const dg = delegateStats(logs, from)
    const redo = new Map(redoStats(logs, from).map(r => [r.model, r]))
    const demote = demotedModels([...redo.values()])
    const money = (n: number) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–')
    const ARM_NAMES: Record<Arm, string> = { auto: '自动切换', control: '实验对照组（不切换）', off: '关闭切换', fixed: '固定模型' }
    const armRow = (arm: Arm) => {
      const a = s.arms[arm]
      if (!a) return null
      const mix = ['opus', 'sonnet', 'haiku', 'other', 'none']
        .filter(f => a.byModel[f])
        .map(f => `${f === 'other' ? '▫ 其他模型' : f === 'none' ? '▫ 没记模型' : modelTag(f)} ${pct(a.byModel[f] ?? 0, a.turns)}`)
        .join('   ')
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={2} flexWrap="wrap">
            <Box width={20} flexShrink={0}>
              <Text bold>{ARM_NAMES[arm]}</Text>
            </Box>
            <Box width={8} flexShrink={0}>
              <Text tabular>{a.turns} 轮</Text>
            </Box>
            <Box width={14} flexShrink={0}>
              <Text color="cyan" tabular>
                每轮 {a.priced ? money(a.usd / a.priced) : '–'}
              </Text>
            </Box>
            <Text color={a.fixes ? 'yellow' : undefined} tabular>
              纠正 {pct(a.fixes, a.turns)}
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Text dimColor size="footnote">
              {mix}
              {a.switches ? ` · 换模型 ${a.switches} 次${a.coldSwitches ? `（${a.coldSwitches} 次在冷点，不算重写）` : ''}，缓存重写约 ${money(a.switchUsd)}` : ''}
            </Text>
          </Box>
        </Box>
      )
    }
    const switchCost = s.arms.auto?.switchUsd ?? 0
    const forkCost = s.arms.auto?.forkUsd ?? 0
    const saved = s.savedUsd ?? 0
    const net = saved - switchCost - forkCost
    const rep = experimentReport(await readLogs($, from), from, cfg.experiment === 'off' ? undefined : await currentVersion($, cfg))
    const EFFECT_NAMES = { route: ['🔀 模型切换', '切换', '不切换'], saver: ['💰 省额度', '开', '关'] } as const
    // 顶部指标块：一个数字配一行小字
    const tile = (label: string, value: string, color?: string, sub?: string) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color ?? 'gray'} paddingX={1} width={20}>
        <Text dimColor size="footnote">
          {label}
        </Text>
        <Text bold size="heading" color={color} tabular>
          {value}
        </Text>
        {sub && (
          <Text dimColor size="footnote">
            {sub}
          </Text>
        )}
      </Box>
    )
    // 账本的一行：正负号、名称、金额、说明
    const ledger = (sign: '+' | '−', name: string, usd: number, note: string) => (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        <Box width={14} flexShrink={0}>
          <Text color={sign === '+' ? 'green' : 'red'}>{`${sign} ${name}`}</Text>
        </Box>
        <Box width={10} flexShrink={0} justifyContent="flex-end">
          <Text color={sign === '+' ? 'green' : 'red'} tabular>
            {money(usd)}
          </Text>
        </Box>
        <Text dimColor size="footnote">
          {note}
        </Text>
      </Box>
    )
    const auto = s.arms.auto
    const topModels = Object.entries(s.pi.byModel).sort((a, b) => b[1] - a[1])
    const topMax = topModels[0]?.[1] ?? 1
    body = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
          {choice({
            key: 'days',
            value: String(days),
            options: ['1', '7', '14', '30'].map(d => ({ value: d, label: d === '1' ? '今天' : `最近 ${d} 天` })),
            onSelect: v => void update($, statsDays, () => Number(v)),
          })}
          <Text dimColor size="footnote">
            花费按 API 价折算成美元；订阅不按它扣额度，但比例可以参考
          </Text>
        </Box>
        <Box flexDirection="row" gap={1} flexWrap="wrap" marginBottom={1}>
          {tile(
            auto?.turns ? (net > 0 ? '💰 净省' : '💸 净亏') : '💰 净省',
            auto?.turns ? money(Math.abs(net)) : '–',
            auto?.turns ? (net > 0 ? 'green' : 'red') : undefined,
            auto?.turns ? `和一直用 ${versionLabel('opus', s.opus)} 比` : '还没有记录',
          )}
          {tile('🤖 每轮花费', auto?.priced ? money(auto.usd / auto.priced) : '–', 'cyan', auto?.turns ? `自动切换 ${auto.turns} 轮` : '自动切换组')}
          {tile(
            '🚀 外派成功',
            s.pi.routed ? pct(s.pi.routedOk, s.pi.routed) : '–',
            s.pi.routed ? 'magenta' : undefined,
            [s.pi.routed ? `按角色派的 ${s.pi.routedOk} / ${s.pi.routed} 个` : '没按角色派过', dg.hinted ? `提示 ${dg.hinted} 轮、派了 ${dg.followed} 轮` : '']
              .filter(Boolean)
              .join('；'),
          )}
          {s.week &&
            tile(
              '📅 7 天额度',
              `${s.week.last}%`,
              s.week.last >= 70 ? 'yellow' : undefined,
              s.week.reset ? '期间额度窗口重置过' : s.week.last > s.week.first ? `这段时间用了 ${s.week.last - s.week.first}%` : '现在用到的比例',
            )}
        </Box>
        {section(
          '🤖 Claude 用量',
          Object.keys(s.arms).length ? (
            <Box flexDirection="column">{(['auto', 'control', 'off', 'fixed'] as Arm[]).map(armRow)}</Box>
          ) : (
            <Text dimColor>这段时间还没有记录。用几轮再来看。</Text>
          ),
          'cyan',
          '纠正 = 你说“不对 / 重做”的轮次占比',
        )}
        {section(
          '💰 省了多少',
          !auto?.turns ? (
            <Text dimColor>这段时间自动切换组还没有记录。</Text>
          ) : (
            <Box flexDirection="column">
              {ledger('+', '换小模型少花', saved, `小模型的轮次花了 ${money(s.cheapUsd)}，换成 Opus 约 ${money(s.cheapUsd + saved)}`)}
              {ledger('−', '缓存重写', switchCost, auto.coldSwitches ? `换了 ${auto.switches ?? 0} 次模型，${auto.coldSwitches} 次在冷点（缓存本来就要重建）不算；其余换过去那轮要重写整段缓存` : `换了 ${auto.switches ?? 0} 次模型，换过去那轮要重写整段缓存`)}
              {ledger('−', '分类', forkCost, cfg.claude.switchAt === 'cold' ? 'fork 分类读一遍上下文的钱（冷点上才分类，fork 默认关）' : '每轮先判断这句属于哪类，读一遍上下文的钱')}
              <Box flexDirection="row" gap={1} alignItems="center" marginTop={1}>
                <Box width={14} flexShrink={0}>
                  <Text bold>{net > 0 ? '= 净省' : '= 净亏'}</Text>
                </Box>
                <Box width={10} flexShrink={0} justifyContent="flex-end">
                  <Text bold color={net > 0 ? 'green' : 'red'} tabular>
                    {money(Math.abs(net))}
                  </Text>
                </Box>
              </Box>
              {net <= 0 && (
                <Text color="yellow" size="footnote">
                  {cfg.claude.switchAt === 'turn'
                    ? switchCost > forkCost
                      ? '换模型太频繁了。可以在「Claude 模型」页 → 更多设置 → 切换细节，改成“缓存冷时”换模型。'
                      : '分类本身比省下的还贵。上下文长的会话里换小模型省得少，分类却每轮都要读一遍上下文。'
                    : '换模型能省的本来就不多：Opus 和 Sonnet 读缓存一个价。额度的大头在下面的“花费构成”。'}
                </Text>
              )}
            </Box>
          ),
          'green',
          `自动切换组 vs 一直用 ${versionLabel('opus', s.opus)}，按官方价`,
        )}
        {split.turns > 0 &&
          section(
            '📦 花费构成',
            <Box flexDirection="column">
              {(
                [
                  ['读缓存', split.read, '每一步都把整段上下文读一遍'],
                  ['写缓存', split.write, '新内容（工具结果、回答）和整段重建'],
                  ['输出', split.output, '模型写出来的字'],
                ] as const
              ).map(([name, usd, note]) => (
                <Box key={name} flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Box width={14} flexShrink={0}>
                    <Text>{name}</Text>
                  </Box>
                  <Box width={10} flexShrink={0} justifyContent="flex-end">
                    <Text tabular>{`${Math.round((usd / ((split.read + split.write + split.input + split.output) || 1)) * 100)}%`}</Text>
                  </Box>
                  <Text dimColor size="footnote">
                    {note}
                  </Text>
                </Box>
              ))}
              <Text dimColor size="footnote">
                {`每轮平均读 ${Math.round(split.crPerTurn / 1000)}k、写 ${Math.round(split.cwPerTurn / 1000)}k token；上下文越大、一轮里工具步骤越多，这两项越多`}
              </Text>
              {split.gapWrite > 0.01 && (
                <Text color="yellow" size="footnote">
                  {`隔太久缓存过期后整段重建花了 ${money(split.gapWrite)}：长对话歇了一小时以上，回来先 /compact 或开新会话能省下`}
                </Text>
              )}
            </Box>,
            'yellow',
            `主对话 ${split.turns} 轮，按官方价`,
          )}
        {section(
          '🧪 对照实验',
          rep.effects.length ? (
            <Box flexDirection="column">
              {rep.effects.map(ef => {
                const [title, a, b] = EFFECT_NAMES[ef.factor]
                return (
                  <Box flexDirection="column" marginBottom={1}>
                    <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                      {chip(ef.sure ? '有结论' : '样本还不够', ef.sure ? (ef.change < 0 ? 'success' : 'error') : 'inactive')}
                      <Text bold color={ef.sure ? (ef.change < 0 ? 'green' : 'red') : undefined}>
                        {title}：{verdict(ef)}
                      </Text>
                    </Box>
                    <Text>
                      每个会话通常花 {a} {money(ef.on.geoUsd)}（{ef.on.sessions} 个会话），{b} {money(ef.off.geoUsd)}（{ef.off.sessions} 个会话）
                    </Text>
                    <Text dimColor size="footnote">
                      每轮 {money(ef.on.perTurn)} / {money(ef.off.perTurn)}，只作参考；不到 3 轮的会话不算
                    </Text>
                    <Text>
                      纠正率 {pct(ef.on.fixRate * 100, 100)} / {pct(ef.off.fixRate * 100, 100)} · 平均上下文 {Math.round(ef.on.ctxAvg / 1000)}k / {Math.round(ef.off.ctxAvg / 1000)}k
                    </Text>
                  </Box>
                )
              })}
            </Box>
          ) : (
            <Text dimColor>{cfg.experiment !== 'off' ? '实验进行中，两组都有会话后显示对比。' : '还没开。到「Claude 模型」页“更多设置”里打开“对照实验”。'}</Text>
          ),
          'yellow',
          '按会话比较花费（几何平均），完整报告：/auto-router eval',
        )}
        {section(
          '🚀 外派',
          s.pi.total ? (
            <Box flexDirection="column">
              <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
                <Text>
                  {s.pi.total} 个任务（按角色派 {s.pi.routed} 个，指定模型 {s.pi.total - s.pi.routed} 个），改了 {s.pi.files} 个文件
                </Text>
                {Object.entries(s.pi.byChannel).map(([ch, n]) => chip(`${ch} ${n}`, CH_COLOR[ch as keyof typeof CH_COLOR] ?? 'gray'))}
              </Box>
              {/* 用得最多的模型，条形长短按任务数 */}
              {topModels.slice(0, 8).map(([m, n]) => (
                <Box flexDirection="row" gap={1} alignItems="center">
                  <Box width={30} flexShrink={0}>
                    <Text>{modelName(m)}</Text>
                  </Box>
                  <Text color={CH_COLOR[channelOf(m)]}>{'█'.repeat(Math.max(1, Math.round((n / topMax) * 16)))}</Text>
                  <Text dimColor tabular>
                    {n}
                  </Text>
                  {/* 返工：同一角色 30 分钟内又派了相似任务，记在上一次的模型上 */}
                  {redo.get(m)?.redo ? (
                    <Text color={demote.has(m) ? 'red' : 'yellow'} size="footnote">
                      返工 {redo.get(m)?.redo}
                      {demote.has(m) ? ' · 派活时排到后面' : ''}
                    </Text>
                  ) : null}
                </Box>
              ))}
            </Box>
          ) : (
            <Text dimColor>这段时间没有派过任务。</Text>
          ),
          'magenta',
          '没占 Claude 额度的活',
        )}
        <Text dimColor size="footnote">
          记录在 {await logDir($)}，一行一轮；报告文件（每小时更新）在 {await reportDir($)}。换位置改配置里的 dataDir。
        </Text>
      </Box>
    )
  } else {
    const list = (await read($, jobs)).slice().reverse()
    const STATUS = {
      waiting: ['⏳ 排队中', 'cyan'],
      running: ['▶ 运行中', 'yellow'],
      done: ['✔ 完成', 'green'],
      failed: ['✖ 失败', 'red'],
    } as const
    // Windows 中文报错是 GBK，按 UTF-8 解出来成了乱码；看不懂的就换成一句说明
    const readable = (t: string) =>
      (t.match(/\uFFFD/g)?.length ?? 0) >= 3 ? t.replace(/[^\x00-\x7F]*\uFFFD[^\x00-\x7F]*/g, '（Windows 中文报错，编码对不上看不清，多半是找不到程序或路径）') : t
    // 失败原因：免费额度用完、限流这类常见的直接说人话；其余取最后一条备注或输出末尾
    const failReason = (job: (typeof list)[number]) => {
      const all = [...job.notes, job.tail].join('\n')
      if (/free usage limit|quota|额度/i.test(all)) return '免费额度用完'
      if (/\b429\b|rate.?limit/i.test(all)) return '被限流'
      if (/\b40[13]\b|unauthori[sz]ed|invalid api key/i.test(all)) return '鉴权失败（key 或订阅）'
      const last = job.notes[job.notes.length - 1] ?? job.tail.trim().split('\n').pop() ?? ''
      // “opencode/xxx: error” 这种只有一个 error 的，看不出原因，就说没给原因
      return /:\s*error$/i.test(last.trim()) ? '没给出原因（多半是免费额度用完或服务出错）' : readable(last).slice(0, 160)
    }
    const flagOpen = await read($, setupOpen)
    const counts = list.reduce<Record<string, number>>((m, j) => ({ ...m, [j.status]: (m[j.status] ?? 0) + 1 }), {})
    const confirmClear = flagOpen === 'clear-jobs'
    body = (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
          {(['running', 'waiting', 'done', 'failed'] as const)
            .filter(s => counts[s])
            .map(s => chip(`${STATUS[s][0]} ${counts[s]}`, STATUS[s][1]))}
          <Text dimColor size="footnote">
            保留最近 30 条
          </Text>
          {list.length > 0 &&
            (confirmClear ? (
              <Box flexDirection="row" gap={1} alignItems="center">
                <Text color="yellow" size="footnote">
                  清空任务列表？（效果页的统计不受影响）
                </Text>
                {link('clear-jobs-yes', '清空', () => {
                  void update($, jobs, l => l.filter(j => j.status === 'running' || j.status === 'waiting'))
                  void update($, setupOpen, () => null)
                })}
                {link('clear-jobs-no', '取消', () => void update($, setupOpen, () => null))}
              </Box>
            ) : (
              link('clear-jobs', '🧹 清空已结束的', () => void update($, setupOpen, () => 'clear-jobs'))
            ))}
        </Box>
        {list.length === 0 && <Text dimColor>还没有任务。</Text>}
        {/* 一条一个框（边框颜色按状态），框里一行：状态、通道、角色、模型、用时、任务开头；失败的下面一行写原因，有改动的写待审 */}
        {list.map(job => {
          const [label, color] = STATUS[job.status]
          const ch = job.channel ?? channelOf(job.model)
          const when =
            job.status === 'waiting' ? `${clock(job.runAt ?? 0)} 开始` : `${Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000)} 秒`
          return (
            <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
              <Box flexDirection="row" gap={1} alignItems="center">
                <Box width={10} flexShrink={0}>
                  <Text color={color} bold>
                    {label}
                  </Text>
                </Box>
                <Box width={10} flexShrink={0}>
                  <Text color={CH_COLOR[ch]}>{ch}</Text>
                </Box>
                <Box width={30} flexShrink={0}>
                  <Text>{`${job.role === 'custom' ? '🎯' : (ROLE_ICON[job.role] ?? '▫')} ${modelName(job.model)}`}</Text>
                </Box>
                <Box width={8} flexShrink={0}>
                  <Text dimColor tabular>
                    {when}
                  </Text>
                </Box>
                <Text dimColor wrap="truncate">
                  {`${job.id} · ${job.title.split('\n')[0]}`}
                </Text>
              </Box>
              {job.status === 'failed' && (
                <Box paddingLeft={11}>
                  <Text color="red" size="footnote">
                    ↳ {failReason(job)}
                  </Text>
                </Box>
              )}
              {job.changes && (
                <Box paddingLeft={11}>
                  <Text color="yellow" size="footnote">
                    ↳ {job.changes.split('\n')[0]}，等 Claude 审阅
                  </Text>
                </Box>
              )}
            </Box>
          )
        })}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {header}
      {body}
    </Box>
  )
}
