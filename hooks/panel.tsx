import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ModelMode, SettingsTab } from '../types'
import { buildRoles, channelOf, isPeak, privacyBlock, providerOf, setPath } from './config'
import type { Billing, Config, Tier } from './config'
import { experimentReport, modelVersions, summarize, verdict, versionLabel } from './stats'
import type { Arm } from './stats'
import { armLabel, clock, config, editConfig, logDir, readLogs, refreshOpencodeModels, refreshPiModels, rt, sessionTags } from './core'

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
const advOpen = atom({ plugin: 'auto-router', key: 'advOpen' } as const, false)
const rebuildAsk = atom({ plugin: 'auto-router', key: 'rebuildAsk' } as const, false)
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
  // 一行设置：左边名称和说明，右边控件
  const setting = (title: string, desc: string, control: unknown) => (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
        <Text bold>{title}</Text>
        {control as never}
      </Box>
      <Text dimColor size="footnote">
        {desc}
      </Text>
    </Box>
  )
  const section = (title: string, children: unknown, color = 'gray') => (
    <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color={color === 'gray' ? undefined : color}>
          {title}
        </Text>
      </Box>
      {children as never}
    </Box>
  )
  const card = (title: string, desc: string, control: unknown, color = 'gray') =>
    section(
      title,
      <Box flexDirection="column">
        <Text dimColor size="footnote">
          {desc}
        </Text>
        <Box marginTop={1}>{control as never}</Box>
      </Box>,
      color,
    )
  const intro = (text: string) => (
    <Box marginBottom={1}>
      <Text dimColor>{text}</Text>
    </Box>
  )
  const roleName = (r: string) => ROLE_INFO[r]?.name ?? r
  const providerName = (p: string) => PROVIDER_NAMES[p] ?? p
  // 模型一律显示完整名称（去掉 provider/ 前缀）
  const modelName = (m: string) => m.split('/').slice(1).join('/') || m
  // 通道标签：每个模型旁都标出走 pi 还是 opencode，不混在一起
  const CH_COLOR = { pi: 'magenta', opencode: 'blue' } as const
  const chTag = (m: string) => (
    <Text color={CH_COLOR[channelOf(m)]} size="footnote">
      [{channelOf(m)}]
    </Text>
  )

  const TABS: [SettingsTab, string][] = [
    ['claude', 'Claude 模型'],
    ['pi', '外派模型'],
    ['stats', '效果'],
    ['jobs', '任务记录'],
  ]
  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold size="heading">
        auto-router
      </Text>
      <Text dimColor size="footnote">
        小问题用小模型，能交出去的活外派给其他订阅和免费模型
      </Text>
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        {TABS.map(([id, name]) => (
          <Button
            key={`tab-${id}`}
            variant={id === current ? 'primary' : 'secondary'}
            label={name}
            onPress={async () => {
              await update($, tab, () => id)
              // 面板可能开了很久，切到外派模型页时刷新一次 pi 里能用的模型和 opencode 里还在的免费模型
              if (id === 'pi') await Promise.all([refreshPiModels($), refreshOpencodeModels($)])
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
    const V = (a: 'haiku' | 'sonnet' | 'opus') => versionLabel(a, vers[a])
    const MODEL_OPTS = [
      { value: 'haiku', label: V('haiku') },
      { value: 'sonnet', label: V('sonnet') },
      { value: 'opus', label: V('opus') },
      { value: '-', label: '不变' },
    ]
    const verNote = (['haiku', 'sonnet', 'opus'] as const).map(a => vers[a]).filter(Boolean).join(' / ')
    body = (
      <Box flexDirection="column">
        {intro('每次提问先判断类型，再选这一轮用哪个 Claude 模型。')}
        {section(
          '模型切换',
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
              <Box width={14} flexShrink={0}>
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
              <Text dimColor size="footnote">
                上一个问题：{last ? `${last.label} → ${last.model ?? '不切换'}` : '还没有'}
              </Text>
            </Box>
            {mode === 'auto' &&
              cfg.claude.categories.map((cat, i) => (
                <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Box width={14} flexShrink={0}>
                    <Text>{cat.name}</Text>
                  </Box>
                  {choice({
                    key: `cm-${i}`,
                    value: cat.model ?? '-',
                    options: MODEL_OPTS,
                    onSelect: v => edit(c => setPath(c, `claude.categories.${i}.model`, v === '-' ? undefined : v))(),
                  })}
                  {cat.piRole && (
                    <Text dimColor size="footnote">
                      也可外派（{roleName(cat.piRole)}）
                    </Text>
                  )}
                </Box>
              ))}
            {mode === 'auto' && verNote && (
              <Text dimColor size="footnote">
                版本：{verNote}
              </Text>
            )}
          </Box>,
          'cyan',
        )}
        <Box marginBottom={1}>
          <Button key="more" label={more ? '收起更多设置' : '更多设置'} onPress={() => void update($, showMore, () => !more)} />
        </Box>
        {more &&
          section(
            '切换细节',
            <Box flexDirection="column">
              {setting(
                '降档要连续几轮',
                '换强模型立即生效；换弱模型要连续几轮都是简单问题。',
                choice({
                  key: 'downgrade',
                  value: String(cfg.claude.downgradeAfter),
                  options: ['1', '2', '3', '4'].map(n => ({ value: n, label: n })),
                  onSelect: v => edit(c => setPath(c, 'claude.downgradeAfter', Number(v)))(),
                }),
              )}
              {setting(
                '被纠正时升一档',
                '你说“不对 / 重做”时换更强的模型。',
                toggle('fix-up', cfg.claude.upgradeOnCorrection, v => edit(c => setPath(c, 'claude.upgradeOnCorrection', v))()),
              )}
              {setting(
                '对话很长时不降档',
                '对话超过这个长度就不再降档（换模型要重写缓存）。',
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
          )}
        {more &&
          section(
            '省额度',
            <Box flexDirection="column">
              {setting(
                '省额度',
                '拦大文件、大图、整页网页，上下文过大时提醒交接。下个会话起生效。',
                toggle('saver', cfg.saver.enabled, v => edit(c => setPath(c, 'saver.enabled', v))()),
              )}
              {setting(
                '拦大读取',
                '第一次拦下并给出省的读法，再请求就放行。',
                toggle('guard', cfg.saver.guard, v => edit(c => setPath(c, 'saver.guard', v))()),
              )}
              {setting(
                '大量阅读交给',
                '自动：小的自己读，要上网或含私密内容用 scout，超过 20 万或额度紧用 pi。',
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
                '适合交出去时提醒 Claude。',
                toggle('suggest', suggest, v => void update($, piAuto, () => v)),
              )}
            </Box>,
          )}
        {more &&
          section(
            '对照实验',
            <Box flexDirection="column">
              {setting(
                '测什么',
                '新会话随机分组，一两周后到「效果」页比较花费。',
                choice({
                  key: 'experiment',
                  value: cfg.experiment,
                  options: [
                    { value: 'off', label: '关' },
                    { value: 'route', label: '测模型切换' },
                    { value: 'saver', label: '测省额度' },
                    { value: 'both', label: '两个都测' },
                  ],
                  onSelect: v => edit(c => setPath(c, 'experiment', v))(),
                }),
              )}
              <Text color="cyan" size="footnote">
                {armLabel(await sessionTags($))}
              </Text>
            </Box>,
          )}
      </Box>
    )
  } else if (current === 'pi') {
    const known = await read($, piModels)
    const ocKnown = await read($, ocModels)
    const expanded = await read($, setupOpen)
    const pausedMap = await read($, paused)
    const confirmRebuild = await read($, rebuildAsk)
    const adv = await read($, advOpen)
    const tiers = cfg.pi.tiers
    // 按通道分组：pi 的提供商在前，opencode 在后
    const provs = [...new Set([...Object.keys(cfg.pi.providers), ...(ocKnown.length ? ['opencode'] : [])])].sort(
      (a, b) => Number(a === 'opencode') - Number(b === 'opencode'),
    )
    // pi 清单里有、但你没配置过的提供商：默认藏起来，免得一屏全是用不上的
    const others = [...new Set(known.map(providerOf))].filter(p => !provs.includes(p))
    const flags = (expanded ?? '').split(',')
    const flag = (k: string) => flags.includes(k)
    const setFlag = (k: string) => void update($, setupOpen, () => (flag(k) ? flags.filter(f => f && f !== k) : [...flags.filter(Boolean), k]).join(',') || null)
    const listedFor = (p: string) => (p === 'opencode' ? ocKnown : known.filter(m => providerOf(m) === p))
    const gone = (m: string) => channelOf(m) === 'opencode' && ocKnown.length > 0 && !ocKnown.includes(m)
    // pi 已经列出模型清单时，不在清单里的就是没装或没配 key
    const missing = (m: string) => channelOf(m) === 'pi' && known.length > 0 && !known.includes(m)
    const SHORT: Record<string, string> = { openai: 'GPT', agnes: 'Agnes', 'cc-switch-deep-seek': 'DeepSeek官网', opencode: '免费' }
    // 带上提供商，免得“DeepSeek官网”和“免费的 deepseek”都叫 deepseek
    const label = (m: string) => `${SHORT[providerOf(m)] ?? providerOf(m)} ${modelName(m)}`
    const blocked = (m: string, role: string) => privacyBlock(cfg, m, role, rt.sessionCwd, rt.isWindows)
    // 此刻不用这个模型的原因；null 表示能用
    const whyNot = (m: string, role: string): string | null => {
      const p = cfg.pi.providers[providerOf(m)]
      if (p?.enabled === false) return '已关'
      if (missing(m)) return '没检测到'
      if (isPeak(p?.peak, now)) return '高峰'
      if ((pausedMap[providerOf(m)]?.until ?? 0) > now) return '暂停'
      if ((pausedMap[m]?.until ?? 0) > now) return `额度用完，${clock(pausedMap[m]?.until ?? 0)} 恢复`
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

    // 一家一行：状态点、名称、状态、计费方式
    const providerRow = (p: string) => {
      const prov = cfg.pi.providers[p]
      const isUsed = prov?.enabled === true
      const pause = pausedMap[p]
      const isPaused = (pause?.until ?? 0) > now
      const peakNow = prov?.peak && isPeak(prov.peak, now)
      const [state, color] = !isUsed
        ? ['不用', 'gray']
        : isPaused
          ? [`暂停到 ${clock(pause?.until ?? 0)}`, 'red']
          : peakNow
            ? ['高峰中，暂不用', 'yellow']
            : ['可用', 'green']
      const usable = Object.keys(tiers).filter(m => providerOf(m) === p && !missing(m) && !gone(m)).length
      return (
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Text color={color}>●</Text>
          {chTag(`${p}/-`)}
          <Box width={18} flexShrink={0}>
            <Text bold>{providerName(p)}</Text>
          </Box>
          <Box width={16} flexShrink={0}>
            <Text color={color} size="footnote">
              {state}
            </Text>
          </Box>
          <Box width={10} flexShrink={0}>
            <Text dimColor size="footnote">
              {isUsed ? `${usable} 个模型` : ''}
            </Text>
          </Box>
          {choice({ key: `bill-${p}`, value: isUsed ? prov?.billing : 'off', options: BILL_OPTS, onSelect: v => setProvider(p, v) })}
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

    // 高级：每家的模型和档位
    const modelRow = (m: string) => (
      <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
        {chTag(m)}
        <Box width={30} flexShrink={0}>
          <Text color={gone(m) ? 'gray' : tiers[m] ? 'cyan' : undefined} strikethrough={gone(m)}>
            {modelName(m)}
          </Text>
        </Box>
        {choice({ key: `tier-${m}`, value: tiers[m] ?? 'none', options: TIER_OPTS, onSelect: v => setTier(m, v) })}
        {gone(m) && (
          <Text color="yellow" size="footnote">
            已下架
          </Text>
        )}
        {cfg.opencode.logged.includes(m) && (
          <Text color="yellow" size="footnote">
            提供方可能拿内容改进模型
          </Text>
        )}
      </Box>
    )
    const tierBlock = (p: string) => {
      const listed = listedFor(p)
      // 检测到了就只列检测到的；没检测到任何（没装 pi / opencode）才列配置里的
      const models = listed.length ? listed : Object.keys(tiers).filter(m => providerOf(m) === p)
      const used = models.filter(m => tiers[m])
      const showAll = flag('models')
      const ignored = listed.length ? Object.keys(tiers).filter(m => providerOf(m) === p && !listed.includes(m)).length : 0
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>{providerName(p)}</Text>
          {ignored > 0 && (
            <Text dimColor size="footnote">
              配置里另有 {ignored} 个模型没检测到，已忽略
            </Text>
          )}
          {(showAll ? models : used).map(modelRow)}
          {used.length === 0 && !showAll && <Text dimColor size="footnote">还没选模型。</Text>}
        </Box>
      )
    }

    // 隐私开关：哪些目录的内容可以发给会记录使用的免费模型
    const dirs = cfg.opencode.allowDirs
    const here = rt.sessionCwd
    const setDirs = (next: string[]) => edit(c => setPath(c, 'opencode.allowDirs', next))()
    const ocUsed = cfg.pi.providers.opencode?.enabled === true
    const privacy = (
      <Box flexDirection="column">
        <Text color={dirs.length ? 'cyan' : 'yellow'}>
          {dirs.includes('*')
            ? '所有目录都允许用那几个可能保存内容的免费模型'
            : dirs.length
              ? `只在这些目录允许：${dirs.join('、')}`
              : '有些免费模型（mimo、flint、nemotron）的提供方会保存发去的内容、可能拿来改进模型，所以默认不用；GLM、DeepSeek 不保存，照常用'}
        </Text>
        <Box flexDirection="row" gap={1} flexWrap="wrap">
          {!dirs.includes(here) && !dirs.includes('*') && <Button key="allow-here" label="允许当前目录" onPress={() => setDirs([...dirs, here])} />}
          {!dirs.includes('*') && <Button key="allow-all" label="所有目录都允许" onPress={() => setDirs(['*'])} />}
          {dirs.length > 0 && <Button key="allow-none" label="清空" onPress={() => setDirs([])} />}
        </Box>
      </Box>
    )

    const roles = Object.entries(cfg.pi.roles)
    // 每类活的完整顺序：绿色加粗是此刻会用的，划线的此刻跳过，后面小字是原因
    const chain = (name: string, ms: string[], readOnly?: boolean) => {
      const firstLive = ms.find(m => !whyNot(m, name))
      return (
        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Box width={10} flexShrink={0}>
            <Text bold>{roleName(name)}</Text>
          </Box>
          {ms.map((m, i) => {
            const why = whyNot(m, name)
            return (
              <Box flexDirection="row" gap={1}>
                {i > 0 && <Text dimColor>→</Text>}
                <Text color={why ? 'gray' : m === firstLive ? 'green' : undefined} bold={m === firstLive} strikethrough={!!why}>
                  {label(m)}
                </Text>
                {why && (
                  <Text color="yellow" size="footnote">
                    {why}
                  </Text>
                )}
              </Box>
            )
          })}
          {name !== '都不行时' && !firstLive && <Text color="yellow">→ 走兜底</Text>}
          {readOnly && (
            <Text dimColor size="footnote">
              只读
            </Text>
          )}
        </Box>
      )
    }
    const roleRow = ([name, r]: [string, (typeof roles)[number][1]]) => chain(name, r.models, r.readOnly)

    body = (
      <Box flexDirection="column">
        {intro('每家选好怎么付费，系统就按“免费 → 订阅 → 按量付费”给每类活挑模型。')}
        {known.length === 0 && (
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
            <Text color="yellow">没检测到 pi 的模型（终端里 pi --list-models 要能列出来）</Text>
            <Button key="detect" label="重新检测" onPress={() => void refreshPiModels($)} />
          </Box>
        )}
        {ocKnown.length === 0 && cfg.pi.providers.opencode?.enabled !== false && (
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap" marginBottom={1}>
            <Text color="yellow">没检测到 opencode 的免费模型（终端里 opencode models 要能列出来）</Text>
            <Button key="detect-oc" label="重新检测" onPress={() => void refreshOpencodeModels($)} />
          </Box>
        )}
        {section('① 用哪几家', <Box flexDirection="column">{provs.map(providerRow)}</Box>)}
        {section(
          '② 派活顺序（从左到右依次试）',
          <Box flexDirection="column">
            {roles.map(roleRow)}
            {cfg.pi.fallback.length > 0 && chain('都不行时', cfg.pi.fallback)}
            <Text dimColor size="footnote">
              绿色加粗 = 此刻会用；划线 = 此刻跳过，小字是原因（已关 / 没检测到 / 高峰 / 暂停 / 已下架 / 隐私）。前一个失败了才换下一个。
            </Text>
          </Box>,
          'cyan',
        )}
        {ocUsed && section('③ 免费模型的隐私', privacy)}
        <Box marginBottom={1}>
          <Button key="adv" label={adv ? '收起高级设置' : '高级设置（模型档位、完整顺序）'} onPress={() => void update($, advOpen, () => !adv)} />
        </Box>
        {adv && (
          <Box flexDirection="column">
            {section(
              '模型档位',
              <Box flexDirection="column">
                {provs.map(tierBlock)}
                <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
                  <Text>也列出没设档位的模型</Text>
                  {toggle('show-models', flag('models'), () => setFlag('models'))}
                </Box>
                {others.length > 0 && (
                  <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
                    <Text>pi 里还有 {others.length} 家没配置的提供商</Text>
                    {toggle('show-others', flag('others'), () => setFlag('others'))}
                  </Box>
                )}
              </Box>,
            )}
            {flag('others') &&
              section(
                '没配置的提供商（选个付费方式就启用）',
                <Box flexDirection="column">{others.map(providerRow)}</Box>,
              )}
            {section(
              '重排',
              <Box flexDirection="column">
                <Text dimColor size="footnote">
                  上面的顺序是按档位自动生成的。想单独调某类活、改高峰时段，直接跟 Claude 说。
                </Text>
                {confirmRebuild ? (
                  <Box flexDirection="column" marginTop={1}>
                    <Text color="yellow">会按档位重新生成每类活的顺序，你或 Claude 单独调过的会被覆盖。</Text>
                    <Box flexDirection="row" gap={1}>
                      <Button
                        key="rebuild-yes"
                        label="确认重排"
                        onPress={() => {
                          void update($, rebuildAsk, () => false)
                          void rebuild(c => c)()
                        }}
                      />
                      <Button key="rebuild-no" label="取消" onPress={() => void update($, rebuildAsk, () => false)} />
                    </Box>
                  </Box>
                ) : (
                  <Box marginTop={1}>
                    <Button key="rebuild" label="按档位重排" onPress={() => void update($, rebuildAsk, () => true)} />
                  </Box>
                )}
              </Box>,
            )}
          </Box>
        )}
      </Box>
    )
  } else if (current === 'stats') {
    const days = await read($, statsDays)
    const from = now - days * 86_400_000
    const s = summarize(await readLogs($, from), from)
    const money = (n: number) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–')
    const ARM_NAMES: Record<Arm, string> = { auto: '自动切换', control: '实验对照组（不切换）', off: '关闭切换', fixed: '固定模型' }
    const armRow = (arm: Arm) => {
      const a = s.arms[arm]
      if (!a) return null
      const mix = ['opus', 'sonnet', 'haiku', 'other']
        .filter(f => a.byModel[f])
        .map(f => `${f === 'other' ? '其他' : f[0]?.toUpperCase() + f.slice(1)} ${pct(a.byModel[f] ?? 0, a.turns)}`)
        .join(' · ')
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={2}>
            <Box width={18} flexShrink={0}>
              <Text bold>{ARM_NAMES[arm]}</Text>
            </Box>
            <Text>{a.turns} 轮</Text>
            <Text color="cyan">每轮 {a.priced ? money(a.usd / a.priced) : '–'}</Text>
            <Text color={a.fixes ? 'yellow' : undefined}>纠正 {pct(a.fixes, a.turns)}</Text>
          </Box>
          <Box marginLeft={18}>
            <Text dimColor size="footnote">
              {mix}
              {a.switches ? ` · 换模型 ${a.switches} 次，缓存重写最多约 ${money(a.switchUsd)}` : ''}
            </Text>
          </Box>
        </Box>
      )
    }
    const switchCost = s.arms.auto?.switchUsd ?? 0
    const rep = experimentReport(await readLogs($, from), from)
    const EFFECT_NAMES = { route: ['模型切换', '切换', '不切换'], saver: ['省额度', '开', '关'] } as const
    body = (
      <Box flexDirection="column">
        {intro('花费是按 API 价折算的美元，订阅不按它扣额度，但比例可以参考。')}
        <Box marginBottom={1}>
          {choice({
            key: 'days',
            value: String(days),
            options: ['1', '7', '14', '30'].map(d => ({ value: d, label: d === '1' ? '今天' : `最近 ${d} 天` })),
            onSelect: v => void update($, statsDays, () => Number(v)),
          })}
        </Box>
        {card(
          'Claude 用量',
          '纠正 = 你说“不对 / 重做”的轮次占比。',
          Object.keys(s.arms).length ? (
            <Box flexDirection="column">{(['auto', 'control', 'off', 'fixed'] as Arm[]).map(armRow)}</Box>
          ) : (
            <Text dimColor>这段时间还没有记录。用几轮再来看。</Text>
          ),
        )}
        {card(
          '省了多少',
          '用小模型的轮次，换成 Opus 要多花多少，已扣缓存代价。',
          s.savedUsd === undefined ? (
            <Text dimColor>记录里还没有 Opus 的轮次，算不出 Opus 单价。用一阵、或开对照实验后再看。</Text>
          ) : (
            <Box flexDirection="column">
              <Text>
                用小模型的轮次实际花 {money(s.cheapUsd)}，全用 Opus 约 {money(s.cheapUsd + s.savedUsd)}
              </Text>
              <Text color={s.savedUsd - switchCost > 0 ? 'green' : 'red'} bold>
                {s.savedUsd - switchCost > 0 ? '净省' : '净亏'}约 {money(Math.abs(s.savedUsd - switchCost))}
              </Text>
              {s.savedUsd - switchCost <= 0 && (
                <Text color="yellow" size="footnote">
                  换模型太频繁，缓存重写吃掉了省下的钱。可以把「Claude 模型」页的“降档要连续几轮”调大。
                </Text>
              )}
              <Text dimColor size="footnote">
                已扣除换模型的缓存重写 {money(switchCost)}（按上限估）
              </Text>
            </Box>
          ),
          'green',
        )}
        {card(
          '对照实验',
          '按会话比较花费（几何平均）。完整报告：/auto-router eval',
          rep.effects.length ? (
            <Box flexDirection="column">
              {rep.effects.map(ef => {
                const [title, a, b] = EFFECT_NAMES[ef.factor]
                return (
                  <Box flexDirection="column" marginBottom={1}>
                    <Text bold color={ef.sure ? (ef.change < 0 ? 'green' : 'red') : undefined}>
                      {title}：{verdict(ef)}
                    </Text>
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
            <Text dimColor>{cfg.experiment !== 'off' ? '实验进行中，两组都有会话后显示对比。' : '还没开。到「模型切换」页“更多设置”里打开“对照实验”。'}</Text>
          ),
        )}
        {card(
          '外派（pi / opencode）',
          '没占 Claude 额度的活。',
          s.pi.total ? (
            <Box flexDirection="column">
              <Text>
                {s.pi.total} 个任务，成功 {s.pi.ok} 个（{pct(s.pi.ok, s.pi.total)}），改了 {s.pi.files} 个文件
              </Text>
              <Text size="footnote">
                {Object.entries(s.pi.byChannel)
                  .map(([ch, n]) => `[${ch}] ${n} 个`)
                  .join(' · ')}
              </Text>
              <Text dimColor size="footnote">
                {Object.entries(s.pi.byModel)
                  .sort((a, b) => b[1] - a[1])
                  .map(([m, n]) => `[${channelOf(m)}] ${modelName(m)} ${n}`)
                  .join(' · ')}
              </Text>
            </Box>
          ) : (
            <Text dimColor>这段时间没有派过任务。</Text>
          ),
        )}
        {s.week && (
          <Text dimColor size="footnote">
            7 天额度：这段时间从 {s.week.first}% 到 {s.week.last}%（额度窗口重置后会回落）
          </Text>
        )}
        <Text dimColor size="footnote">
          记录在 {await logDir($)}，一行一轮，可以自己拿去分析。
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
    body = (
      <Box flexDirection="column">
        {intro('外派出去的任务，保留最近 30 条。')}
        {list.length === 0 && <Text dimColor>还没有任务。</Text>}
        {list.map(job => {
          const [label, color] = STATUS[job.status]
          const when =
            job.status === 'waiting'
              ? `${clock(job.runAt ?? 0)} 开始`
              : `用时 ${Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000)} 秒`
          return (
            <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
              <Box flexDirection="row" gap={1}>
                <Text color={color} bold>
                  {label}
                </Text>
                <Text color={CH_COLOR[job.channel ?? channelOf(job.model)]}>[{job.channel ?? channelOf(job.model)}]</Text>
                <Text>{job.role === 'custom' ? '指定模型' : roleName(job.role)}</Text>
                <Text dimColor>
                  · {modelName(job.model)} · {when} · {job.id}
                </Text>
              </Box>
              <Text>{job.title}</Text>
              {job.notes.map(n => (
                <Text dimColor size="footnote">
                  ↳ {readable(n)}
                </Text>
              ))}
              {(job.status === 'done' || job.status === 'failed') && !job.notes.some(n => n.includes(job.tail.trim().slice(0, 40))) && (
                <Text dimColor size="footnote">
                  {readable(job.tail.slice(-300))}
                </Text>
              )}
              {job.changes && <Text color="yellow">{job.changes.split('\n')[0]}，等 Claude 审阅</Text>}
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
