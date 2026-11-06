# dsh-daughter 实现核对（v0.5）

- 核对对象：`dsh-daughter-design.md`（v0.5，2026-11-06）
- 核对基准：`dsh-daughter/` 当前源码，2026-11-06 复核 —— `npm test` **112 项全绿**、`npm run check:link` **PASS 18 / WARN 0 / FAIL 0**、`tsc --noEmit` 无错、`dist` 新鲜度检查 PASS（未重跑 build，避免改动运行中的产物）
- 演进：v0.2（76 项）→ 加固轮（87）→ 桌宠弱耦合（94）→ 移除语音（85）→ 认知滤网（97）→ 情感闭环修复（103）→ 性格多样性演化（**112**）

## 0. 完成度

| 范围 | v0.2 | v0.3（11-04） | v0.4（11-05） | 现在（11-06） |
| --- | --- | --- | --- | --- |
| 主体 P0–P8（§4–§13） | 约 88% | 约 98% | 约 99% | **约 99%**：滤网、观感、情感闭环、性格演化均已落地 |
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

## 3. 仍然缺的

| 缺口 | 原因 | 建议 |
| --- | --- | --- |
| 真实数据复测 | 2026-11-06 库已重置：events 0 条、`emotion_history` 0 行、负面极性无样本 | 跑一批真实对话后复测极性分布、重构行数、L2 新日志 |
| 情绪识别深度 | 仍是 22 词表（正负各 11 条），无否定 / 程度 / 转折 / 对象 | 扩词表或改模型打标（R-08） |
| L3 写入路径 | `biasWeights` 与 `copingStrategies` 没有新增条目的写入逻辑；`evolvePersona` 每天只做归一化，真正会变的是 `defenseMaturity` | 从冲突事件 / 反复出现的应对方式里沉淀 |
| 性格演化标定 | 出生先验与 `critical_step` 只有单测，真实语料尚未出现关键事件 | 用真实关系/成就事件校准 `repair` 与阈值，观察 `drift_cap` 是否过松 |
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

`README.md`：

- 测试数 103 → **112**；测试文件 13 → **14**；TS 文件 20 → **21**
- 新增「性格演化」小节，指向设计 §4.8

`dsh-daughter-记忆情感评估.md`：顶部补 2026-11-06 复核说明（库已重置、662/64/598 为 11-05 历史快照、测试 112）。

`dsh-daughter-检测报告.md`：时间改 2026-11-06 复核、测试 103 → **112**，18 项自检结论不变。
