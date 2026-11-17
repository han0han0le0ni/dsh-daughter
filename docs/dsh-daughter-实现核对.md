# dsh-daughter 实现核对（v0.5）

- 核对对象：`dsh-daughter-design.md`（v0.5，2026-11-06）
- 核对基准：`dsh-daughter/` 当前源码，2026-11-06 复核（动机 + 主动开口 + 出口抽象 + 桌面场景感知后五次复跑）—— `npm test` **203 项全绿**、`npm run check:link` **PASS 18 / WARN 0 / FAIL 0**、`tsc --noEmit` 无错、`dist` 已重跑 build
- 演进：v0.2（76 项）→ 加固轮（87）→ 桌宠弱耦合（94）→ 移除语音（85）→ 认知滤网（97）→ 情感闭环修复（103）→ 性格多样性演化（112）→ 行为动机（126）→ 主动开口（141）→ 出口抽象（143）→ 场景感知（145）→ 记忆检索/溯源/关系推进修复（**203**）

## 0. 完成度

| 范围 | v0.2 | v0.3（11-04） | v0.4（11-05） | 现在（11-06） |
| --- | --- | --- | --- | --- |
| 主体 P0–P8（§4–§13） | 约 88% | 约 98% | 约 99% | **约 99%**：滤网、观感、情感闭环、性格演化、行为动机均已落地 |
| 桌宠联动 | 表达强、感知单向 | 双向弱耦合闭环 | 双向弱耦合闭环（另有真实 bridge 心跳证据） | 双向弱耦合闭环 |
| P9 外部连接 | 3/7 | 3/7 | 3/7 | **3/7**（桌宠 / Android / 桌面；QQ、抖音、MC、单机未动） |
| 整体 | 约 85% | 约 93% | 约 95% | **约 96%**（P9 仍是唯一拖拽项） |

一句话：**机制层基本齐了，欠的是真实语料上的标定与 P9 四个连接器。**

## 1. 本轮（2026-11-06）核对到的四条线

### 1.1 认知滤网（设计 §8.5 / §14.5）

写入前四类裁决（shield / drop / merge / keep）+ 检索按来源降权 + 周期性忘却 + 存量清理脚本。

真实库现状（2026-11-05 快照；2026-11-06 库已重置）：662 条中**活跃 64**（chat 58 / game 5 / android 1）、**归档 598**；`meta` 计数 keep 3 / merge 472 / forget 126；活跃事件平均显著性 0.398、最大出度 11、悬空边 0。

### 1.2 星图观感（设计 §14.6）

悬停概要浮层、鼠标锚点缩放、3D 倾斜星环 + 斐波那契球 + 透视雾化、拖拽以按下点为支点；视觉四通道（大小=权重×显著性+召回、色温=情绪、线宽=强度、透明度=显著性与纵深）；时间轴分层、检索高亮、遗忘区暗尘、关系网、会话走势。

纯前端静态资源，无新增单测，靠浏览器实测（记录在设计 §14.6）。

### 1.3 记忆与情感闭环（设计 §14.7）

情绪量程、回忆重构阈值、`emotion_relax` 回落、L2 改锚 `user.intimacy`、出边上限 + 存量修剪 + 归档摘链、存量显著性回填、同题口径统一、`importance` 进衰减指数、降级可见化。

新增 `tests/emotion.test.ts` 6 项，测试 97 → 103。

### 1.4 性格多样性演化（设计 §4.8 / §14.8）

- **出生抽样**：`createInitialL1` / `createInitialL2` 在同角色同 seed 下可复现；五维落在有界区间并写入 `innate` 锚点；依恋底色按 secure 0.7 / anxious 0.18 / avoidant 0.12 抽取，混乱型不可出生。
- **冲击分级**：`scoreImpact` 把事件分成 `routine / cumulative / critical`；日常闲聊不动人格，关键事件单步 `critical_step 0.12`，累积经历 `cumulative_step 0.02`。
- **通道分化**：关系 / 生活转折 / 成就挫败 / 修复四类文本分别推动不同维度；修复按 `settings.repair` 打折，伤害侧按 `2 - repair` 放大。
- **漂移约束**：任一大五维度夹在 `innate ± drift_cap 0.6` 内；`plasticity` 随极端状态减半；同向经历每 3 次额外加力。
- **叙事与证据**：自我叙事三轴 + `lockedAxes` 只记事实；人格证据链上限 200，面板只展示事实与数值，不输出"你是 X 型"标签。
- **验证**：`tests/personality.test.ts` 9 项；测试 103 → **112**。真实库已新建角色并写入 `innate`，但尚无关键事件，漂移/叙事/证据链尚未在真实语料上触发。

### 1.5 行为动机（决策层，`src/runtime/motivation.ts` 新增）

- **两段式判定**：`threshold = min_main_score + 人格偏移 + 情绪偏移`（下限 `min_threshold`）；`score = signal × 熟悉度 × 记忆 × 情境 × 方向舵`；判定顺序为 `熔断 → avoid`、`零信号 → avoid`、`score ≥ threshold → act`、`≥ hold_ratio × threshold → hold`。
- **人格双通路**：`trait_threshold_gain` 调阈值（"门有多重"），`trait_signal_gain` 给分数乘子 `1±g`（"更想走哪条路"）。只有前者时，人格只能否决候选、不能决定选哪个——方向舵补上了这条边。
- **实测对照**（同一句"聊天 计划"，两个候选技能）：中性人格 social 0.2426 / achievement 0.1977（双 hold）→ 外向宜人拉满 social 0.2911 act、achievement 0.1581 avoid → 尽责拉满则两者排序完全翻转。
- **零信号收口**：`signal = 0` 直接判 `avoid`，不再依赖阈值兜底。修复前极端人格会把阈值压到 `0.00`，`0 ≥ 0` 成立而误判 `act`；现由 `min_threshold 0.05` + 零信号短路双保险，且方向舵是乘子，`signal=0` 时乘什么都不会高于 0。
- **其余因子**：熟悉度倒 U（`peak 0.45`）、记忆三路径（结果预期按 `lastUsedAt` 半衰 30d / 情绪记忆回看 30d / 自我效能取 L3 `selfWorth`）、情绪覆盖（总偏移 clamp −0.15~0.20）、情境乘子（社交通道满额、其余折半）、失败熔断（`fail_streak 3` 起，10 分钟起指数翻倍，成功清零）。
- **可审计**：`MotivationBreakdown` 保留 10 个因子，`confidence` 取 main 的 `score`；`motivation.enabled = false` 退回纯相似度打分。
- **验证**：`tests/motivation.test.ts` 14 项；测试 112 → **126**。

### 1.6 主动开口（`src/runtime/speak.ts` 新增）

没人说话时她会不会自己开口。与动机层分工明确：动机要 `userText`，这条链接的是沉默时长。

- **强度侧 / 门槛侧分离**：`urge` = 思念累积 + 人格 + 情绪 + 关系 + 上一轮 `carry`；`threshold` = 基础值 + 安静时段 + 压力。人格只进 `urge`，不进 `threshold`——"想不想"和"合不合适"是两件事，不互相污染。
- **思念饱和**：`idle / (idle + idle_half_min 180)`。1 小时 0.25、3 小时 0.5、10 小时 0.77，不线性。
- **欲言又止**：`urge ≥ threshold×hold_ratio` 记 `hold`，把 `carry_step 0.05` 累进存储；下次评估带着这份"憋劲"，所以"想几次才说一句"能自然出现。`carry` 有上限 0.25，憋久了不会必然开口。
- **兜底**：冷却 `refractory_min 90`、日上限 `max_per_day 5`、安静时段 `[0,7)` 抬门槛 0.35。她说完话也算"刚联系过"，避免靠沉默累积刷屏。
- **默认关闭**：`speak.enabled: false`。自主开口属于"她会自己做事"，装完插件不该自动开始；开启需显式改配置。
- **出口抽象**：`SpeakSink` 数组 + `dispatchSpeak` 并发投递、单出口失败隔离。当前只有一个 sink（桌宠气泡 `kind: reply`），宿主将来开放主动消息时加 sink 即可，决策层不动。无桌宠轮询时消息只入队，不会进聊天记录（插件无宿主会话写入权限）。
- **实测时间线**（9:00 聊过、全天没人理、jitter=0）：安静内向 2 次 / 欲言又止 6 次（14:45 首次）；外向黏人 5 次 / 15 次（11:15 首次，撞日上限）；焦虑型 4 次，全部归为 `worry` 池。
- **场景感知**：`readForeground` 只读 `/foreground`（不截图、不产生附件），按前台进程/标题算打扰成本——会议 0.85 / 游戏 0.7 / 写代码 0.4 / 其它 0.15，乘 `busy_penalty 0.25` 抬门槛。桥接不可用返回 null、按"看不见屏幕"处理，不会因探测失败变成整天沉默。
- **可审计**：`speak.history`（最近 10 句，含 reason）、`speak.count.<日期>`、`speak.hold.<日期>`、`speak.carry` 全部落进 meta；星图面板新增「主动开口」分组只读展示，今天开口数 / 欲言又止数 / 憋劲 / 上次开口 / 最近说过。写之前这块是黑盒——内容只进气泡队列，测完无从复查。
- **顺带修的**：`config.desktop.enabled` 原本会打印"桌面端能力尚未实现，配置值已忽略"——该能力早已实现，这条告警属过期提示，已删除。
- **验证**：`tests/speak.test.ts` 19 项；测试 126 → **145**。

## 2. 代码落点（v0.5 本轮新增/改动）

| 文件 | 改动 |
| --- | --- |
| `src/runtime/filter.ts`（新增） | 显著性模型、习惯化签名、屏蔽 / 丢弃 / 合并 / 放行裁决、忘却扫描 |
| `src/runtime/maintenance.ts` | `runTick` 接入忘却；`relaxL5()` 情绪回落；`evolvePersona` L2 改锚、L3/L4 归一化；L1 衰减指数 |
| `src/runtime/memory.ts` | `linkNewEvent` 出边上限 12；检索结果乘来源可信度 |
| `src/store.ts` | `migrateFilterColumns` 补列、`trimLinks` / `detachLinks`、L5 会话列表修正 |
| `src/runtime/state.ts` | `sentimentPolarity` 单字词降权、`sentimentStrength`、`PAD_GAIN 0.3` |
| `src/config.ts` | `filter.*`、`emotion_relax.*` 范围收敛；`warnUnsupported` 增加假开关告警 |
| `scripts/filter-sweep.ts`（新增） | 存量治理（默认 dry-run）：同题压缩 + 低价值忘却 + 显著性回填 |
| `web/star-map/index.html` | 3D 星环、悬停浮层、锚点缩放、搜索、遗忘区、图例 |
| `src/runtime/personality.ts`（v0.5 新增） | `createInitialL1` / `createInitialL2` 出生抽样、`scoreImpact` 冲击分级、`classifyChannel` 通道、`applyPersonalitySignal` 漂移/修复/叙事/证据链 |
| `src/types.ts` | L1 增 `innate` / `plasticity`；L2 增 `attachmentType`；L3 增 `moral` / `narrative` / `evidence`；新增 `AttachmentType` / `ImpactKind` / `SelfNarrative` / `PersonalityEvidence` / `MoralOutlook` |
| `src/store.ts` | `loadPersona` 新建角色时调用出生抽样；旧存档缺字段按默认值补齐 |
| `src/index.ts` | `after_response` 在 `applyPersonaDrift` 之后接入 `applyPersonalitySignal` |
| `src/runtime/panels.ts` | 面板新增自我叙事 / 人格证据 / 善恶观展示，只给事实不输出类型标签 |
| `config.yaml` | 新增 `personality.*` 段（drift_cap / 阈值 / step / repair / initial / evidence_cap） |
| `tests/filter.test.ts` / `tests/emotion.test.ts` / `tests/personality.test.ts`（新增） | 12 + 6 + 9 项 |
| `src/runtime/motivation.ts`（新增） | `scoreSkills` 纯函数打分：人格双通路、熟悉度倒 U、记忆三路径、情绪覆盖、情境乘子、零信号收口、熔断；`computeThreshold` 兜 `min_threshold` |
| `src/runtime/content.ts` | `activateSkills` 改用动机决策选 main / associated；`motivation.enabled = false` 时回退 `activateBySimilarity` |
| `src/runtime/maintenance.ts` | `bumpSkill` 失败累计 → `breakerUntil` 指数冷却，成功清零 |
| `src/types.ts` | 新增 `SignalChannel` / `MotivationDecision` / `MotivationBreakdown` / `MotivationConfig` |
| `config.yaml` / `src/config.ts` | 新增 `motivation.*`：`trait_threshold_gain` / `min_threshold` / `trait_signal_gain` / `familiarity` / `memory` / `breaker` / `emotion_override` / `situation` / `hold_ratio`，全部带范围收敛 |
| `tests/motivation.test.ts`（新增） | 14 项 |
| `src/runtime/speak.ts`（新增） | 主动开口纯函数：思念饱和曲线、人格/情绪/关系进强度、时段/压力进门槛、hold 攒劲、文案池与避重；`SpeakSink` + `dispatchSpeak` 出口抽象 |
| `src/runtime/desktop-observe.ts` | 新增 `readForeground`：只读 `/foreground`、不截图、桥接不可用时静默返回 null，供主动开口判断场景 |
| `src/index.ts` | 新增 `speakPlan()`：取最近活跃会话算沉默时长、读写 `speak.*` 元数据（lastAt / carry / 日计数 / 文案避重 / 历史账本）、探测前台场景、act 后落日志 |
| `src/runtime/panels.ts` | 新增「主动开口」分组：今天开口数 / 欲言又止数 / 憋劲 / 上次开口 / 最近说过，只读 |
| `src/host.ts` | 独立 `speakTimer`（默认 3 分钟）调 `speakPlan`，act 时 `queueEvent({ kind: 'reply' })` 投递到气泡 |
| `src/types.ts` | 新增 `SpeakReason` / `SpeakDecision` / `SpeakPlan` / `SpeakConfig`；`DaughterPlugin` 增 `speakPlan` |
| `config.yaml` / `src/config.ts` | 新增 `speak.*` 整段（15 个参数，全部范围收敛），安静时段归一化为 `[起, 止)` |
| `tests/speak.test.ts`（新增） | 19 项 |

## 3. 仍然缺的

| 缺口 | 原因 | 建议 |
| --- | --- | --- |
| 真实数据复测 | 2026-11-06 库已重置：events 0 条、`emotion_history` 0 行、负面极性无样本 | 跑一批真实对话后复测极性分布、重构行数、L2 新日志 |
| 情绪识别深度 | 仍是 22 词表（正负各 11 条），无否定 / 程度 / 转折 / 对象 | 扩词表或改模型打标（R-08） |
| L3 写入路径 | `biasWeights` 与 `copingStrategies` 没有新增条目的写入逻辑；`evolvePersona` 每天只做归一化，真正会变的是 `defenseMaturity` | 从冲突事件 / 反复出现的应对方式里沉淀 |
| 性格演化标定 | 出生先验与 `critical_step` 只有单测，真实语料尚未出现关键事件 | 用真实关系/成就事件校准 `repair` 与阈值，观察 `drift_cap` 是否过松 |
| 动机缺习惯层 | 构思里的「线索→行为→奖励」自动化通路未实现，所有行为仍需当轮输入提供信号；`maturity_threshold_automate` 只是冻结技能、`filter.habituation` 只是消息去重，都不是行为习惯 | 用 `SkillCard` 的成功历史做线索权重，或引入 idle / 情境触发 |
| 动机参数未标定 | `min_threshold 0.05` 与 `trait_signal_gain 0.2` 均为经验值，没有真实 signal 分布作依据 | 真实对话跑一批后统计 signal 分位，再定地板与乘子上限 |
| 主动开口文案是模板 | 5 个动机池共 40 句，无模型生成，长期会显得重复 | 接模型时替换 `pickSpeakLine` 一层，决策逻辑不动 |
| 主动消息进不了聊天记录 | 插件只有"响应"权限，`PluginContext` 无发起消息接口；出口虽已抽成 `SpeakSink`，但现成实现只能投桌宠气泡 | 等宿主开放主动消息后，加一个 sink 即可，无需改决策层 |
| 主动开口参数未标定 | `idle_half_min 180`、`threshold 0.62`、`max_per_day 5` 同样没有真实使用数据支撑 | 跑真实使用一周后看开口频次与被打断比例再调 |
| 记忆冲突标记 | `EventLink.kind` 有 `contradiction` 枚举，无写入与展示 | 新旧事件矛盾时双向标记，不覆盖事实 |
| 重构阈值分位数 | 现为绝对阈值 0.08 | 按情绪分布 P90 自适应 |
| 长边衰减 / 图定期重建 | 只做了 cap 与摘链 | 连接强度随时间衰减 |
| `requiredTools` 加载时校验 | 宿主未暴露工具清单 | 等 `tools.list()` |
| 月度日志压缩归档 | 未排期 | 与演化日志按月切片一起做 |
| 启动时事务重放 | SQLite WAL + 原子写已覆盖 | 需要跨文件事务时再补 |
| P9 剩余 4 个连接器 | 需外部适配器 | 先走 `/connectors/<source>/ingest` |
| 语义检索仍是字面 | D-03 决策 | FTS5 trigram + Dice，无 embedding |
| 桌宠情绪动作只有三带 | 中性直接 `null` | 可扩成 5 带，但要先定映射表 |
| 壳与 MOD 共用 ack 游标 | 设计如此 | 文档已注明只能二选一 |

## 4. 真实数据体检（2026-11-06 复核）

2026-11-05 的实测数据保留作历史对照；2026-11-06 当天库已重置，下面同时列出两列，避免把旧数字当成现状。

| 项 | 2026-11-05 快照 | 2026-11-06 当前 | 备注 |
| --- | --- | --- | --- |
| 事件 | 662 条（活跃 64 / 归档 598） | **0 条** | 库重置；噪声源 system 事件已全部归档 |
| 情绪 | 活跃 avg abs(pleasure) 0.204、负值 0 条、强度 <0.2 占 53/64 | 无数据 | 量程比修复前（0.11）拉开，极性仍单一 |
| 回忆重构 | `emotion_history` 0 行 | 0 行 | 仅在库副本上验证过（6 轮 → 2 条） |
| 关联 | 平均 1.22 出边、活跃最大 11、悬空 0 | 0 边 | 星图当前 9 星系 / 13 节点 / 0 边 |
| 召回 | 34 条从未被想起、累计 213 次、单条最高 53 | 无数据 | 长尾仍在 |
| L1–L4 | L1 微调 1 次；L2 familiar/0.44/0.316；L3 偏差权重空；L4 从未变 | L1 已写入 `innate` 出生锚点；L3 偏差权重仍空；L4 未变 | 出生抽样已在真实角色上生效，性格漂移尚无关键事件 |
| 技能 / 资产 / 反射 | 0 张技能卡、0 个资产包；反射 3 条规则、命中 0 次（221 轮） | 0 / 0 / 命中 0 | 对话多为纯聊天，未达 `min_steps_to_learn` |
| 身体信号 | `body_signal.json` 有 11-05 心跳（strength 0.05 / feeling 0.4） | 待复测 | 真实 bridge → L5 通道在用 |
| 指标 | 221 轮、注入 tokens 330~557、检索降级 16 轮、`reflexHits` 0 | 0 轮 | 远低于 3000 预算 |

## 5. 文档同步（v0.5）

`dsh-daughter-design.md` 修订：

- 封面：v0.5、日期、核对基准（112 测试 / 18 自检 / typecheck）
- §4.2：补 `innate` / `plasticity` / `attachmentType` / `SelfNarrative` / `PersonalityEvidence` / `MoralOutlook`；L1 约束改为双路径（日常 0.02 / 事件冲击受 `drift_cap` 约束）；补依恋底色与叙事锁定约束
- 新增 §4.8「性格演化」：出生抽样、冲击分级、通道分化、漂移/修复、叙事与证据链
- §11 配置：补 `personality.*` 整段；`emotion_relax` 补三条基线；`desktop.enabled` 改为 **false** 并注明"写了只会告警"
- §14.1：新增「性格冲击路径」一行；核对基准 103 → **112**
- §14.7：测试数补注"v0.5 再增至 112，见 §14.8"
- 新增 §14.8「性格多样性演化轮次」：9 项实现与验证对照
- §15：新增 R-10（双路径口径）、D-06（L1 写回约束待评审）
- §16：勾选性格演化、D-01~D-06、L1 双路径；L3 表述改为"只归一化、无新增条目"；真实数据待办注明库已重置
- 动机模块：`README.md` 新增「行为动机」章节（两层结构、人格双通路、各因子、审计字段）与能力表一行；安装 / 目录 / 当前状态三处数字同步为 126 项、22 个 TS、15 个测试文件

`README.md`：

- 测试数 103 → **112**；测试文件 13 → **14**；TS 文件 20 → **21**
- 新增「性格演化」小节，指向设计 §4.8

`dsh-daughter-记忆情感评估.md`：顶部补 2026-11-06 复核说明（库已重置、662/64/598 为 11-05 历史快照、测试 112）。

`dsh-daughter-检测报告.md`：时间改 2026-11-06 复核、测试 103 → **112**，18 项自检结论不变。
