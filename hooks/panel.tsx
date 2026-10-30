import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { ModelMode, SettingsTab } from '../types'
import { buildRoles, chainFor, isPeak, providerOf, setPath } from './config'
import type { Config, Tier } from './config'
import { experimentReport, summarize, verdict } from './stats'
import type { Arm } from './stats'
import { armLabel, clock, config, editConfig, logDir, readLogs, refreshPiModels, sessionTags } from './core'

// /auto-router 设置面板：Claude 模型、pi 模型、效果、任务四页。改动经 editConfig 校验后写回配置文件。

// 同一 plugin/key 的 atom 在用到它的每个文件里各声明一份：引擎扫描要求 atom 写在读写它的文件里
const jobs = atom({ plugin: 'auto-router', key: 'jobs' } as const, [], { shape: 'jobs-2' })
const modelMode = atom({ plugin: 'auto-router', key: 'modelMode' } as const, 'auto' as ModelMode)
const piAuto = atom({ plugin: 'auto-router', key: 'piAuto' } as const, true)
const lastDecision = atom({ plugin: 'auto-router', key: 'last' } as const, null, { shape: 'last-3' })
const tab = atom({ plugin: 'auto-router', key: 'tab' } as const, 'claude' as SettingsTab)
const showMore = atom({ plugin: 'auto-router', key: 'showMore' } as const, false)
const configRev = atom({ plugin: 'auto-router', key: 'configRev' } as const, 0)
const piModels = atom({ plugin: 'auto-router', key: 'piModels' } as const, [], { shape: 'models-1' })
const paused = atom({ plugin: 'auto-router', key: 'paused' } as const, {}, { shape: 'paused-1' })
const setupOpen = atom({ plugin: 'auto-router', key: 'setupOpen' } as const, null as string | null)
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
  const toggle = (key: string, isOn: boolean, set: (v: boolean) => void) => (
    <Button key={key} variant={isOn ? 'primary' : 'secondary'} label={isOn ? '已开启' : '已关闭'} onPress={() => set(!isOn)} />
  )
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

  const TABS: [SettingsTab, string][] = [
    ['claude', 'Claude 模型'],
    ['pi', 'pi 模型'],
    ['stats', '效果'],
    ['jobs', '任务记录'],
  ]
  const header = (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold size="heading">
        auto-router
      </Text>
      <Text dimColor size="footnote">
        简单问题自动用小一点的 Claude 模型；能单独交出去的活派给 pi，用你的其他订阅来做
      </Text>
      <Box flexDirection="row" gap={1} marginTop={1} flexWrap="wrap">
        {TABS.map(([id, name]) => (
          <Button
            key={`tab-${id}`}
            variant={id === current ? 'primary' : 'secondary'}
            label={name}
            onPress={async () => {
              await update($, tab, () => id)
              // 面板可能开了很久，切到 pi 模型页时刷新一次 pi 里能用的模型
              if (id === 'pi') await refreshPiModels($)
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
    const MODEL_OPTS = [
      { value: 'haiku', label: 'Haiku' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'opus', label: 'Opus' },
      { value: '-', label: '不变' },
    ]
    body = (
      <Box flexDirection="column">
        {intro('每次提问先判断属于哪一类，再决定这一轮用哪个 Claude 模型。简单的用小模型，省 Claude 额度。')}
        {section(
          '切换方式',
          choice({
            key: 'mode',
            value: mode,
            options: [
              { value: 'auto', label: '自动' },
              { value: 'off', label: '不切换' },
              { value: 'haiku', label: '固定 Haiku' },
              { value: 'sonnet', label: '固定 Sonnet' },
              { value: 'opus', label: '固定 Opus' },
            ],
            onSelect: v => void update($, modelMode, () => v as ModelMode),
          }),
          'cyan',
        )}
        {mode === 'auto' &&
          section(
            '每类问题用哪个模型',
            <Box flexDirection="column">
              {cfg.claude.categories.map((cat, i) => (
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
                      ↳ 提醒派给 pi（{roleName(cat.piRole)}）
                    </Text>
                  )}
                </Box>
              ))}
            </Box>,
          )}
        <Box marginBottom={1}>
          <Button key="more" label={more ? '收起更多设置' : '更多设置'} onPress={() => void update($, showMore, () => !more)} />
        </Box>
        {more &&
          section(
            '更多设置',
            <Box flexDirection="column">
              {setting(
                '降档要连续几轮',
                '换强模型立即生效；换弱模型要连续几轮都是简单问题才换，免得写代码中途一句“继续”就被降级。',
                choice({
                  key: 'downgrade',
                  value: String(cfg.claude.downgradeAfter),
                  options: ['1', '2', '3', '4'].map(n => ({ value: n, label: n })),
                  onSelect: v => edit(c => setPath(c, 'claude.downgradeAfter', Number(v)))(),
                }),
              )}
              {setting(
                '被纠正时升一档',
                '你说“不对 / 重做 / 还是不行”时，这一轮换更强的模型。',
                toggle('fix-up', cfg.claude.upgradeOnCorrection, v => edit(c => setPath(c, 'claude.upgradeOnCorrection', v))()),
              )}
              {setting(
                '对话很长时不降档',
                '换模型要把整段对话重新写进缓存，对话越长越不划算。超过这个长度就不再降档。',
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
              {setting(
                '对照实验',
                '新开的会话按会话 id 固定分组，一两周后到「效果」页或 /auto-router eval 比较花费、上下文和你纠正的次数。省额度要测得准，先撤掉 CLAUDE.md 和 settings.json 里的旧版规则和钩子。',
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
              <Text dimColor size="footnote">
                {armLabel(await sessionTags($))}
              </Text>
              {setting(
                '省额度',
                '拦读大文件、大图、整页网页和刷屏命令（同一目标只拦一次），上下文过大时提醒交接，并把“节省上下文、决策与执行分离”写进系统提示。下个会话起生效。',
                toggle('saver', cfg.saver.enabled, v => edit(c => setPath(c, 'saver.enabled', v))()),
              )}
              {setting(
                '拦大读取',
                '第一次拦下并给出更省的读法，原样再请求就放行。',
                toggle('guard', cfg.saver.guard, v => edit(c => setPath(c, 'saver.guard', v))()),
              )}
              {setting(
                '大量阅读交给',
                'scout 是 Sonnet 子代理，占 Claude 额度；pi longctx 是 DeepSeek，按量付费、不占 Claude 额度。自动：不到 3 万 token 自己读，要上网或含私密内容用 scout，超过 20 万或 7 天额度用过七成用 pi。',
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
                '提醒 Claude 派活给 pi',
                '问题看起来适合交出去时，在提示里提醒 Claude。关掉后 Claude 仍可以自己决定。',
                toggle('suggest', suggest, v => void update($, piAuto, () => v)),
              )}
            </Box>,
          )}
        <Text dimColor size="footnote">
          上一个问题：{last ? `${last.label} → ${last.model ?? '不切换'}${last.why ? `（${last.why}）` : ''}` : '还没有'}
        </Text>
      </Box>
    )
  } else if (current === 'pi') {
    const known = await read($, piModels)
    const expanded = await read($, setupOpen)
    const pausedMap = await read($, paused)
    const tiers = cfg.pi.tiers
    const provs = [...new Set([...Object.keys(cfg.pi.providers), ...known.map(providerOf)])]
    // 改计费方式或档位后，按档位重排各角色的模型
    const rebuild = (fn: (c: Config) => Config) => edit(c => buildRoles(fn(c)))
    const setProvider = (p: string, v: string) =>
      rebuild(c => {
        const old = c.pi.providers[p] ?? { enabled: true, billing: 'subscription' as const }
        const next = v === 'off' ? { ...old, enabled: false } : { ...old, enabled: true, billing: v as 'subscription' | 'token' }
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

    const providerCard = (p: string) => {
      const prov = cfg.pi.providers[p]
      const isUsed = prov?.enabled === true
      const pause = pausedMap[p]
      const isPaused = (pause?.until ?? 0) > now
      const peakNow = prov?.peak && isPeak(prov.peak, now)
      const models = [...new Set([...Object.keys(tiers).filter(m => providerOf(m) === p), ...known.filter(m => providerOf(m) === p)])]
      const used = models.filter(m => tiers[m])
      const rest = models.filter(m => !tiers[m])
      const showAll = expanded === p
      const [state, color] = !isUsed ? ['不用', 'gray'] : isPaused ? ['暂停中', 'red'] : peakNow ? ['高峰中，暂不使用', 'yellow'] : ['可用', 'green']
      const modelRow = (m: string) => (
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box width={30} flexShrink={0}>
            <Text color={tiers[m] ? 'cyan' : undefined}>{modelName(m)}</Text>
          </Box>
          {choice({ key: `tier-${m}`, value: tiers[m] ?? 'none', options: TIER_OPTS, onSelect: v => setTier(m, v) })}
        </Box>
      )
      return (
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginBottom={1}>
          <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
            <Text bold>{providerName(p)}</Text>
            <Text color={color}>· {state}</Text>
            <Box flexGrow={1} />
            {choice({
              key: `bill-${p}`,
              value: isUsed ? prov?.billing : 'off',
              options: [
                { value: 'subscription', label: '订阅' },
                { value: 'token', label: '按量付费' },
                { value: 'off', label: '不用' },
              ],
              onSelect: v => setProvider(p, v),
            })}
          </Box>
          {prov?.peak && (
            <Text dimColor size="footnote">
              高峰时段不用：{prov.peak.weekdays.length === 5 ? '工作日' : `周${prov.peak.weekdays.join('、')}`} {prov.peak.hours.join('、')}（北京时间）
            </Text>
          )}
          {isPaused && (
            <Box flexDirection="row" gap={1} alignItems="center">
              <Text color="red" size="footnote">
                报了鉴权或额度错误，暂停到 {clock(pause?.until ?? 0)}
              </Text>
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
            </Box>
          )}
          {isUsed && (
            <Box flexDirection="column" marginTop={1}>
              {(showAll ? models : used).map(modelRow)}
              {used.length === 0 && !showAll && <Text dimColor>还没选模型，点下面的按钮挑几个标上档位。</Text>}
              {rest.length > 0 && (
                <Box marginTop={1}>
                  <Button
                    key={`all-${p}`}
                    label={showAll ? '只看在用的' : `显示全部 ${models.length} 个模型`}
                    onPress={() => void update($, setupOpen, () => (showAll ? null : p))}
                  />
                </Box>
              )}
            </Box>
          )}
        </Box>
      )
    }

    const roles = Object.entries(cfg.pi.roles)
    body = (
      <Box flexDirection="column">
        {intro('两步：每家选计费方式，再给要用的模型标“强 / 中 / 轻”。派活时自动挑模型：评审用最强的，写代码用强档里快的，文本杂活用轻的，按量付费的排在订阅后面。')}
        {known.length === 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
            <Text>没检测到 pi 里能用的模型。</Text>
            <Text dimColor size="footnote">
              先装 pi 并配好各家的 key（终端里 pi --list-models 能列出来）。不用 pi 也没关系，「Claude 模型」页照样能省额度。
            </Text>
            <Box marginTop={1}>
              <Button key="detect" label="重新检测" onPress={() => void refreshPiModels($)} />
            </Box>
          </Box>
        )}
        {provs.map(providerCard)}
        {section(
          '派活时按这个顺序试（自动生成）',
          <Box flexDirection="column">
            {roles.map(([name, r]) => {
              const live = chainFor(cfg, name, now)
              return (
                <Box flexDirection="row" gap={1}>
                  <Box width={12} flexShrink={0}>
                    <Text>{roleName(name)}</Text>
                  </Box>
                  <Box flexDirection="row" flexGrow={1} flexWrap="wrap">
                    {r.models.map((m, i) => (
                      <Text color={live.includes(m) ? 'cyan' : 'gray'} strikethrough={!live.includes(m)}>
                        {i > 0 ? ' → ' : ''}
                        {modelName(m)}
                      </Text>
                    ))}
                  </Box>
                  {r.readOnly && (
                    <Text color="green" size="footnote">
                      只读
                    </Text>
                  )}
                </Box>
              )
            })}
            <Box flexDirection="row" gap={1}>
              <Box width={12} flexShrink={0}>
                <Text>都不行时</Text>
              </Box>
              <Text color="cyan">{cfg.pi.fallback.map(modelName).join(' → ') || '排队等空闲'}</Text>
            </Box>
            <Box marginTop={1}>
              <Text dimColor size="footnote">
                灰色划线的此刻不会用（高峰或暂停）。只读的角色不能改文件；能改文件的要求 git 工作区干净，跑完把改动交给 Claude 审阅。想单独调某个角色、改高峰时段或节假日，直接跟 Claude 说。
              </Text>
            </Box>
          </Box>,
        )}
      </Box>
    )
  } else if (current === 'stats') {
    const days = await read($, statsDays)
    const from = now - days * 86_400_000
    const s = summarize(await readLogs($, from), from)
    const money = (n: number) => (n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`)
    const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–')
    const ARM_NAMES: Record<Arm, string> = { auto: '自动切换', control: '对照日（不切换）', off: '关闭切换', fixed: '固定模型' }
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
        {intro('每轮结束时记下用的模型、token 和花费，派给 pi 的任务也记一笔。花费是按 API 价折算的美元：订阅不按它扣额度，但两组之间的比例可以参考。')}
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
          '“纠正”是你说“不对 / 重做”这类话的轮次占比，用来看换小模型有没有拉低质量。',
          Object.keys(s.arms).length ? (
            <Box flexDirection="column">{(['auto', 'control', 'off', 'fixed'] as Arm[]).map(armRow)}</Box>
          ) : (
            <Text dimColor>这段时间还没有记录。用几轮再来看。</Text>
          ),
        )}
        {card(
          '省了多少',
          '只算 Claude 这边：自动组里用了 Sonnet / Haiku 的轮次，换成 Opus 要多花多少；Opus 的单价从你自己的记录里反推，再扣掉换模型的缓存代价。',
          s.savedUsd === undefined ? (
            <Text dimColor>记录里还没有 Opus 的轮次，算不出 Opus 单价。用一阵、或开对照实验后再看。</Text>
          ) : (
            <Box flexDirection="column">
              <Text>
                用小模型的轮次实际花 {money(s.cheapUsd)}，全用 Opus 约 {money(s.cheapUsd + s.savedUsd)}
              </Text>
              <Text color={s.savedUsd - switchCost > 0 ? 'green' : 'red'} bold>
                净省约 {money(Math.abs(s.savedUsd - switchCost))}
                {s.savedUsd - switchCost > 0 ? '' : '（亏了：换模型太频繁，考虑调大降档缓冲）'}
              </Text>
              <Text dimColor size="footnote">
                已扣除换模型的缓存重写 {money(switchCost)}（按上限估）
              </Text>
            </Box>
          ),
          'green',
        )}
        {card(
          '对照实验',
          '新会话按会话 id 分组，同一段时间里比较每轮花费、上下文长度和纠正率。完整报告用 /auto-router eval。',
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
                      每轮 {a} {money(ef.on.perTurn)}（{ef.on.sessions} 个会话），{b} {money(ef.off.perTurn)}（{ef.off.sessions} 个会话）
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
          'pi 外派',
          '这些活没占 Claude 额度，花的是 GPT / Agnes 订阅或 DeepSeek 按量的钱。',
          s.pi.total ? (
            <Box flexDirection="column">
              <Text>
                {s.pi.total} 个任务，成功 {s.pi.ok} 个（{pct(s.pi.ok, s.pi.total)}），改了 {s.pi.files} 个文件
              </Text>
              <Text dimColor size="footnote">
                {Object.entries(s.pi.byModel)
                  .sort((a, b) => b[1] - a[1])
                  .map(([m, n]) => `${modelName(m)} ${n}`)
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
    body = (
      <Box flexDirection="column">
        {intro('Claude 调用 pi，或你用 /auto-router run [角色] <任务> 派出去的任务，保留最近 30 条。')}
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
                <Text>{roleName(job.role)}</Text>
                <Text dimColor>
                  · {modelName(job.model)} · {when} · {job.id}
                </Text>
              </Box>
              <Text>{job.title}</Text>
              {job.notes.map(n => (
                <Text dimColor size="footnote">
                  ↳ {n}
                </Text>
              ))}
              {(job.status === 'done' || job.status === 'failed') && (
                <Text dimColor size="footnote">
                  {job.tail.slice(-300)}
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
