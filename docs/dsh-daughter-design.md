# dsh-daughter 设计文档（实现核对稿 v0.5）

| 项 | 内容 |
| --- | --- |
| 插件名 | dsh-daughter |
| 文档类型 | 设计文档 / 技术评审稿（不含实现代码） |
| 目标运行形态 | TypeScript / Node 插件 |
| 状态 | 待评审（P0–P8 已落地并核对，P9 3/7；核对基准：`npm test` 203 项、`npm run check:link` 18 项全绿、`tsc --noEmit` 无错） |
| 日期 | 2026-11-02（v0.2 2026-11-04；v0.3 加固 + 桌宠弱耦合 2026-11-04；v0.4 认知滤网 + 星图观感 + 记忆情感闭环 2026-11-05；v0.5 性格多样性演化 2026-11-06） |
| 适用范围 | 人格陪伴、长期记忆、技能与资产、条件反射、多应用连接 |

**阅读约定**

- ⚑ 标记：本文新增或需要评审拍板的决策点，见第 15 节汇总。
- 默认：本文给出的建议默认值，评审通过即可作为实现初值。
- ✅：已被原始总览确认、不再讨论的约束。

---

## 1. 背景与目标

### 1.1 问题

DSH 的会话是短生命周期的：换对话框、换工作区，模型就"忘记"上一次。现有插件能连工具、能发消息，但缺少一个**跟着角色走、不跟着会话走**的长期层。dsh-daughter 要解决的是：

1. 跨会话、跨工作区的连续记忆与关系连续性；
2. 人格参数可慢速演化，且演化过程可追溯；
3. 高频行为不依赖 LLM 推理（技能、资产包、条件反射）；
4. 情绪与压力有运行时状态，但**不污染人格底色**；
5. 异常只描述状态，不贴诊断标签。

### 1.2 目标（可验收）

| 编号 | 目标 | 验收方式 |
| --- | --- | --- |
| G1 | 空事件库也能正常对话，且不虚构共同经历 | 冷启动用例：注入块含硬约束，回复中无具体虚构往事（人工抽检 20 条） |
| G2 | 同一角色跨 2 个会话、2 个工作区，事件与技能可被检索到 | 端到端用例：A 会话写入事件 → B 工作区检索命中 |
| G3 | 单轮记忆/技能注入不超过预算上限 | 断言 `usedTokens ≤ max_total_tokens`，超限按裁剪顺序丢弃 |
| G4 | 条件反射命中不产生 LLM 调用 | 反射命中路径的模型调用计数为 0（仅 `reflex.short_circuit: true` 成立，默认关闭；见 §14.1） |
| G5 | 性格演化有 diff 与原因记录 | 每次 L1–L4 变更产生 `evolution` 日志条目，含 before/after/trigger |

### 1.3 非目标

- 不做通用 Agent 框架，不接管 DSH 的模型路由与会话管理。
- 不做诊断、不做心理评估、不输出任何障碍标签。
- 不声称具备真实身体感受、真实情感或死亡意识。
- 星图（star_map）只读可视化，不参与运行时决策。
- 不承诺语义检索精度达到向量库水平；以"够用 + 可解释 + 可降级"为准。
- **不做表现层**：不合成语音、不渲染形象、不做皮肤与动效。这个插件的职责是"大脑"——记忆、人格、状态、技能、反射、安全；说话的气泡、发出的声音、动的身子都由连接器（桌宠 / 壳 / 其它前端）自己决定。语音朗读通道已于 2026-11-05 整体移除。

---

## 2. 术语与设计原则

### 2.1 术语

| 术语 | 含义 |
| --- | --- |
| 角色（character） | 记忆与人格的归属主体，`characterId` 是唯一作用域键 |
| 事件（event） | 一次"发生过什么"的原子记录，分摘要层与全文层 |
| 技能（skill） | "下次怎么做"的程序化步骤，带成熟度与边界 |
| 资产包（asset） | 已固化的可复用产物：指令包 MAC / 连接包 CON / 动作包 MOT / 组合包 CMB |
| 反射（reflex） | 规则引擎毫秒级匹配的动作，不经过 LLM |
| L5 状态 | 单轮运行时状态机，不写回人格 |
| 情感透支 | 全局累积的过载量，不随会话重置 |

### 2.2 设计原则

1. **分层写回**：L5 每轮变化，L1–L4 只允许"低幅度、有日志"的写回。
2. **情绪不可篡改**：`emotion_at_time` 一经写入永不覆盖。
3. **记忆是"发生过"，不是"记得过"**：命中不等于真实经历，注入时必须区分"记录存在"与"当前对话相关"。
4. **安全先于触发**：任何资产包与工具调用先过 `boundary` 与 `safety_check`。
5. **可复现**：所有概率项有开关与种子，同种子同输入同输出。
6. **预算硬上限**：注入与工具输出都受硬上限约束，超限即裁。
7. **接口不暴露脑区**：目录用脑区命名，对外 API 用工程语义命名。

---

## 3. 总体架构

```text
                    ┌────────────── 对外接口层（扁平命名）──────────────┐
                    │ on_user_message / before_prompt_build / after_response │
                    │ retrieve / associate / skill_activate / asset_invoke    │
                    │ reflex_match / motion_play / tick / safety_check        │
                    └───────────────────────┬───────────────────────────────┘
                                            │
   ┌────────────────────────────────────────┴────────────────────────────────────────┐
   │                                  运行时编排器                                     │
   └───┬──────────────┬───────────────┬───────────────┬───────────────┬───────────────┘
       │              │               │               │               │
     L1 基线        L2 关系动机      L3 认知应对      L4 情境人格      L5 动态状态
   （极慢）        （慢）           （中慢）         （中）           （快，不写回）
       │              │               │               │               │
   ┌───┴──────────────┴───────────────┴───────────────┴───────────────┴───────────────┐
   │ 横切：事件记忆库 · 技能与资产库 · 反射引擎 · 演化日志 · 安全降级 · 星图(只读)     │
   └──────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 纵向五层

| 层级 | 功能 | 关键变量 | 更新速度 | 写回策略 |
| --- | --- | --- | --- | --- |
| L1 基线层 | 稳定人格底色 | 大五、气质、情绪基线、`novelty_seeking`、`plasticity_base` | 极慢 | 每 N 轮或重大事件触发，单次 Δ ≤ 0.02 |
| L2 关系动机层 | 依恋与关系模式 | 依恋焦虑/回避、核心需求、信任基线、关系阶段 | 慢 | 触发式，需 evolution 日志 |
| L3 认知应对层 | 认知偏差与应对策略 | 偏差权重、防御成熟度、应对策略库 | 中慢 | 触发式，策略库可增删 |
| L4 情境人格层 | 对不同对象的不同面 | 对爸爸/陌生人/独处的子人格权重 | 中 | 平滑更新，权重归一化 |
| L5 动态状态层 | 运行时状态机 | PAD、压力、安全感、疲劳、情感透支、边界感 | 快 | **不写回人格**，仅会话内 + 快照 |

### 3.2 横切系统

| 系统 | 作用 | 关键不变量 |
| --- | --- | --- |
| 事件记忆库 | 情景记忆、检索、联想、重构素材 | `emotion_at_time` 不可覆盖；归档不等于删除 |
| 技能与资产库 | 程序记忆、习惯化技能、一键资产包 | 未激活技能不进 prompt；资产失败可回退 |
| 反射引擎 | 条件反射与习惯触发 | 不调用 LLM；有冷却与优先级 |
| 演化日志 | 性格变化、重构原因、安全事件 | 只追加，可追溯 |
| 安全降级 | 阈值触发降级 | 不输出诊断标签 |
| 星图 | 只读可视化 | 不参与决策 |

---

## 4. 数据模型（TypeScript 定义）

> 所有取值范围统一为 `0..1`，除显式标注。时间统一 ISO 8601 字符串。所有记录带 `schemaVersion` 用于迁移。

### 4.1 ID 规范

| 类型 | 格式 | 示例 |
| --- | --- | --- |
| 事件 | `EVT-YYYYMMDD-<6位>` | `EVT-20261102-a3f9c1` |
| 技能 | `SKL-<slug>-<3位>` | `SKL-douyin-scan-001` |
| 指令包 | `MAC-...` | `MAC-daily-report-001` |
| 连接包 | `CON-...` | `CON-qq-napcat` |
| 动作包 | `MOT-...` | `MOT-soft-smile` |
| 组合包 | `CMB-...` | `CMB-morning-routine` |
| 反射 | `RFX-<3位>` | `RFX-007` |
| 演化日志 | `EVO-YYYYMMDD-<当天序号，4 位 hex>` | `EVO-20261102-0001` |

> 演化日志的 4 位是**当天已用最大序号 + 1**，不是随机后缀。早期实现抽 `createRng(seed)` 的 4 位随机数，Store 一重建随机流就从头重放，真实库出现过 8 条日志只有 5 个唯一 ID（`99e1`×3、`da3a`×2），G5 的可追溯性直接失效。现在按日志文件里的最大号递增（hex 解析旧号、继续往上走），进程重启与多实例写同一份日志都不会撞。

### 4.2 人格层 L1–L4

```ts
type ISOTime = string;
type Unit = number; // 0..1

interface PadState {
  pleasure: number;  // -1..1
  arousal: number;   // -1..1
  dominance: number; // -1..1
}

/** 依恋底色：出生只抽前三种，混乱型只能由经历演化出来 */
type AttachmentType = 'secure' | 'anxious' | 'avoidant' | 'disorganized';

/** 影响人格的"冲击等级"：日常不动人格，关键事件才大步推进 */
type ImpactKind = 'routine' | 'cumulative' | 'critical' | 'phase';

interface L1Baseline {
  bigFive: {
    openness: Unit;
    conscientiousness: Unit;
    extraversion: Unit;
    agreeableness: Unit;
    neuroticism: Unit;
  };
  innate?: BigFive;            // 出生锚点：抽定后不再改写，五维只在锚点 ±drift_cap 内漂移
  temperament: 'slow_warmup' | 'eager' | 'steady' | 'guarded';
  moodBaseline: PadState;
  noveltySeeking: Unit;
  plasticityBase: Unit;        // 越小越难改变
  plasticity?: Unit;           // 当前可塑性：随经历衰减，极端后减半
  updatedAt: ISOTime;
}

interface L2Relationship {
  attachmentAnxiety: Unit;
  attachmentAvoidance: Unit;
  coreNeeds: string[];         // 例如 ["被需要", "稳定回应"]
  trustBaseline: Unit;
  relationshipStage: 'stranger' | 'acquaintance' | 'familiar' | 'close' | 'dependent';
  relationshipDepth: Unit;
  attachmentType?: AttachmentType; // 由焦虑/回避两维推导；混乱型只能靠"靠近—伤害"循环演化
  updatedAt: ISOTime;
}

/** 自我叙事三轴：不是结论标签，只作为后续事件的解读滤镜 */
interface SelfNarrative {
  worldSafe: Unit;      // 世界是善意的还是危险的
  othersReliable: Unit; // 亲近的人会不会离开
  selfWorth: Unit;      // 我值不值得被爱
  lockedAxes: string[]; // 曾经跨过锁定阈值的轴（只记事实，不对外当标签）
  updatedAt: ISOTime;
}

/** 一条人格证据：面板只展示事实，不下"你现在是 X 型"的结论 */
interface PersonalityEvidence {
  id: string;
  at: ISOTime;
  eventId: string;
  layer: 'L1' | 'L2' | 'L3';
  dimension: string;
  delta: number;
  impactKind: ImpactKind;
  impact: number;
  quote: string;        // 当时的原话片段，供用户自己判断
}

/** 善恶观：独立于八维的价值取向，只描述倾向，不做道德评判 */
interface MoralOutlook {
  altruism: Unit;       // 0 偏自保/功利，1 偏利他/共情
  principle: Unit;      // 0 灵活变通，1 守原则
  stance: string;       // 一句话立场
  redLines: string[];   // 红线：任何情况下都不做
}

interface CopingStrategy {
  id: string;
  trigger: string;   // 语义描述，用于匹配
  response: string;  // 应对动作描述
  weight: Unit;
}

interface L3Cognition {
  biasWeights: Record<string, Unit>;   // 例如 { "overgeneralization": 0.4 }
  defenseMaturity: Unit;               // 0 幼稚 → 1 成熟
  copingStrategies: CopingStrategy[];
  moral: MoralOutlook;
  narrative?: SelfNarrative;           // 旧存档缺省时按中性值补齐
  evidence?: PersonalityEvidence[];    // 证据链，最多保留最近若干条
  updatedAt: ISOTime;
}

interface SubPersona {
  id: 'to_father' | 'to_stranger' | 'alone' | string;
  weight: Unit;
  tone: string;          // 语气描述，进人格小段
  disclosureLevel: Unit; // 愿意说多少私事
  boundaries: string[];  // 该面不碰的话题
}

interface L4Contextual {
  subPersonas: SubPersona[];   // weight 之和归一化为 1
  updatedAt: ISOTime;
}
```

**约束**

- L1 有两条写回路径（v0.5）：
  1. **日常微调** `evolvePersona`：单次任一大五维度 `Δ ≤ evolution.l1_max_delta_per_write`（默认 0.02），且距上次写入至少 `min_turns_between_writes`（默认 20 轮）。
  2. **事件冲击** `applyPersonalitySignal`：累积/关键事件按 `critical_step`（0.12）/ `cumulative_step`（0.02）× 冲击度 × 可塑性 × 通道权重 × 修复/伤害系数推进。单次可超过 0.02，但任一大五维度必须落在出生锚点 `innate ± personality.drift_cap`（默认 ±0.6）内；日常闲聊不写人格。
- L2 关系阶段只能逐级推进，不可跳级；回退需 evolution 日志说明原因。
- 依恋底色出生只抽安全/焦虑/回避三种；混乱型不可出生，必须由至少两轮关键事件交替（靠近 → 伤害 → 靠近）且焦虑/回避两维同时偏高才会出现。
- 自我叙事三轴的锁定值只记录事实（`lockedAxes`），面板不得把依恋类型或叙事轴当作诊断/人格标签输出。
- L4 `subPersonas[].weight` 每次更新后归一化，禁止全零。

### 4.3 运行时状态 L5

```ts
interface BodySignal {
  strength: Unit;              // 1 = 满值，来自桌宠存档
  feeling: Unit;
  source: 'vpet' | 'pet-shell';
  at: ISOTime;
}

interface L5State {
  sessionId: string;
  characterId: string;

  emotion: PadState;
  stress: Unit;
  safety: Unit;            // 安全感
  fatigue: Unit;
  emotionalOverdraft: Unit; // 全局累积，写入角色级存储
  boundary: Unit;          // 边界感，越低越易被冒犯
  body?: BodySignal | null; // 外部生理信号，只派生有效状态，不参与写回

  activeSubPersonaId: string;
  lastTickAt: ISOTime;
  snapshotAt: ISOTime;
  schemaVersion: 1;
}
```

**约束**

- `emotionalOverdraft` 是**角色级全局量**，`L5State` 内仅放缓存副本，恢复以角色级存储为准。
- `safety` 不写回 L1，只影响本轮注入与表达幅度。
- 每轮 `tick` 前必须持久化 L5 快照；进程重启从最新快照恢复。
- `body` 是**派生输入**：外部信号只在读取时对 `fatigue`/`stress` 取 `max` 抬升（`applyBodySignal`），存盘的永远是对话驱动的原始值；信号超过 `stale_ms` 自动失效，状态自然回落，不会沉淀进人格层。

### 4.4 事件记忆

```ts
interface EmotionTag extends PadState {
  intensity: Unit;
}

interface EventLink {
  targetId: string;
  kind: 'topic' | 'causal' | 'person' | 'emotion' | 'contradiction';
  strength: Unit;
}

interface EventRecord {
  id: string;
  characterId: string;
  title: string;
  summary: string;        // 摘要层：进索引
  tags: string[];
  participants: string[]; // 例如 ["father", "self"]

  emotionAtTime: EmotionTag;              // ✅ 永不覆盖
  emotionNowHistory: Array<{              // 追加；上限 8 条，超出后合并情绪最接近的相邻两条（见 §14.1）
    at: ISOTime;
    emotion: PadState;
    reason: string;
  }>;

  importance: Unit;   // 初始重要度，不变
  weight: Unit;       // 当前检索权重，可强化可衰减
  links: EventLink[];

  source: 'chat' | 'qq' | 'douyin_dm' | 'douyin_content'
        | 'minecraft' | 'game' | 'android' | 'system';
  createdAt: ISOTime;
  lastRecalledAt?: ISOTime;
  recallCount: number;
  archived: boolean;

  // 认知滤网（§8.5）
  salience?: Unit;    // 写入时的显著性；旧数据缺省视为未知，不参与忘却
  mergedCount?: number; // 窗口内同题重复被合并的次数（习惯化）

  schemaVersion: 1;
}

interface EventFullText {
  eventId: string;
  text: string;       // 全文层，独立文件，按需展开
  tokenEstimate: number;
}
```

**约束**

- 摘要层与全文层分离存储：摘要层是压缩版（`截断(用户话,80) + " → " + 截断(回复,40)`）进索引；全文层存完整问答（`用户话 + 回复`），只在命中且事件块预算允许时展开为摘录（`retrieval.expand_fulltext`，默认开；单条上限 `fulltext_excerpt_chars`，默认 120）。
- `emotionNowHistory` 上限 8 条，超出时把中间段情绪最接近的相邻两条合并成一条（PAD 取平均、保留较晚时间），首条与末条原样保留。**已实现，替换旧稿的"保留权重最高 6 条"策略。**
- 衰减是降低 `weight` 并归档，不物理删除；归档阈值见 5.4。

### 4.5 技能与资产

```ts
type SkillStatus = 'draft' | 'active' | 'frozen' | 'deprecated';

interface SkillStep {
  order: number;
  description: string;
  tool?: string;             // required_tools 中的工具名
  argsTemplate?: Record<string, unknown>;
  onFailure: 'abort' | 'continue' | 'fallback';
}

interface SkillBoundary {
  requiresConfirm: boolean;
  costLevel: 'low' | 'medium' | 'high';
  forbiddenContexts: string[]; // 例如 ["冲突中", "公共场合"]
}

interface SkillCard {
  id: string;                // SKL-*
  characterId: string;
  name: string;
  intent: string;            // 语义触发描述，用于激活匹配
  keywords: string[];
  requiredTools: string[];
  steps: SkillStep[];
  boundary: SkillBoundary;

  maturity: Unit;            // 0..1
  successCount: number;
  failCount: number;
  version: number;
  status: SkillStatus;
  lastUsedAt?: ISOTime;
  updatedAt: ISOTime;
  schemaVersion: 1;
}

type AssetKind = 'MAC' | 'CON' | 'MOT' | 'CMB';  // 四类均由技能形态自动判定并执行（见 §14.1）

interface AssetPackage {
  id: string;                // MAC-* / CON-* / MOT-* / CMB-*
  kind: AssetKind;
  name: string;
  compiledFromSkillId?: string;
  payload: Record<string, unknown>;
  padMatch?: PadState;       // MOT 用：按 PAD 匹配动作
  rollbackVersion: number;
  status: 'active' | 'rolled_back' | 'deprecated';
  createdAt: ISOTime;
  schemaVersion: 1;
}
```

**固化与回退规则**

- 固化条件：`maturity > 0.7 && successCount >= 5 && boundary.requiresConfirm === false || 已获确认策略`。
- 资产执行失败：连续 2 次失败 → 自动回退到技能态（`status: rolled_back`），并保留最后 N 个可用版本。
- 单轮激活：1 主技能 + 最多 2 关联技能；未激活技能不出现在注入内容中。

**技能沉淀与生命周期（已实现）**

| 环节 | 规则 |
| --- | --- |
| 沉淀 | 一轮里实际调用到的工具序列长度 ≥ `skills.min_steps_to_learn`（默认 2）时，自动生成 `status: draft` 的技能卡：`intent` 取用户话截断，`steps` 按工具调用顺序，`boundary.requiresConfirm = true`。同样的工具序列只沉淀一次，并写 `evolution`（`target: 'skill'`） |
| 转正 | `draft` 首次被激活且判定成功 → `active`；判定成功依据宿主回传的 `toolsUsed` 是否命中 `requiredTools`，没有工具证据时沿用"被激活即成功" |
| 作废 | `active` 连续失败 5 次 → `deprecated`，不再激活、不写 prompt，记录保留 |
| 注入表现 | `draft` 参与激活（打分 ×0.8），并在技能摘要里标注「草稿」「需确认」，避免被当成成熟技能直接执行 |

> 仍然缺的一环：`requiredTools` 指向的工具是否真实存在，目前无法在加载时校验（宿主未暴露工具清单查询），对应 R-06。

### 4.6 条件反射

```ts
interface ReflexRule {
  id: string;              // RFX-*
  enabled: boolean;
  priority: number;        // 越大越优先
  cooldownMs: number;      // 命中后冷却
  match:
    | { type: 'keyword'; patterns: string[] }
    | { type: 'regex'; pattern: string }
    | { type: 'state'; predicate: Partial<Pick<L5State, 'stress' | 'safety' | 'fatigue'>> }
    | { type: 'event'; source: string };
  action:
    | { kind: 'template_reply'; text: string }
    | { kind: 'tool_call'; tool: string; argsTemplate: Record<string, unknown> }
    | { kind: 'motion'; motionId: string }
    | { kind: 'state_shift'; delta: Partial<PadState> & { stress?: number } };
  lastFiredAt?: ISOTime;
}
```

**约束**

- 反射匹配不调用 LLM，单轮匹配耗时目标 < 5ms。
- `tool_call` 动作必须先通过 `boundary` 与 `safety_check`，高风险工具继承目标插件的频率限制与确认流程。
- 同一轮命中多条：按 `priority` 取 1 条执行，其余记日志不执行。

### 4.7 安全与演化日志

```ts
interface SafetyState {
  level: 0 | 1 | 2 | 3;          // 0 正常 → 3 强降级
  reasons: string[];
  overstressDurationMs: number;
  functionalImpairment: Unit;    // 仅为强度描述，不是诊断
  triggers: string[];            // 触发条件描述
  since: ISOTime;
}

interface EvolutionLogEntry {
  id: string;                    // EVO-*
  characterId: string;
  target: 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'skill' | 'asset' | 'safety';
  before: Record<string, unknown>;
  after: Record<string, unknown>;
  reason: string;
  triggerEventId?: string;
  at: ISOTime;
}
```

**约束**

- 安全字段只允许"维度强度 / 持续时间 / 功能损害 / 触发条件"四类，禁止任何诊断名词。
- 演化日志只追加，不允许修改历史条目。
- **ID 唯一**：同一角色同一天内不得重用 `EVO-*`。2026-11-06 之前的日志存在重复 ID（随机流重放），按行序 + `at` 时间戳区分，不重写历史。`memory:doctor` 的 ID 检查按 `at` 切分：分界（随机后缀时代最后一条）之前的撞号只报通过 + 一句说明，分界之后仍撞号才告警，避免历史噪声盖住写入侧回归。

### 4.8 性格演化（v0.5）

代码落点：`src/runtime/personality.ts`；接入点在 `store.ts`（新建角色）与 `index.ts#afterResponse`。`personality.ts` 注释里引用的「性格多样性演化」即本节。

**出生抽样**

- `createInitialL1(characterId, seed, initial)`：五维在 `personality.initial.ranges` 的有界区间内抽样，同角色同种子可复现；结果同时写入 `innate` 作为终身锚点。
- `createInitialL2`：按 `attachment_priors`（secure 0.7 / anxious 0.18 / avoidant 0.12）抽依恋底色，再映射到焦虑/回避两维并加 ±0.04 抖动；混乱型不在出生分布内。
- 旧存档缺 `innate` 时以当前 `bigFive` 兜底（等于从此刻起不再有可漂移的起源）；缺 `attachmentType` 时按当前两维推导；`narrative` / `moral` / `evidence` 按默认值补齐，不追认历史。

**冲击分级**

`scoreImpact(text, l5)` 以情绪强度打底，关键/生活/成就/修复标记加权；没有关键标记时上限 0.5，日常聊天落在 `routine`，不写 L1–L3。

```text
routine < cumulative_threshold(0.3) ≤ cumulative < critical_threshold(0.6) ≤ critical
```

**通道与方向**

- 关系（分手/背叛/离开等）→ 负向，主要推动神经质/外向/宜人。
- 生活转折（搬家/换工作/毕业/生病等）→ 开放性与尽责性。
- 成就挫败（升职/录取/失败/失业等）→ 尽责性，其次外向与神经质。
- 修复（道歉/保证/回来等）→ 正向，但按依恋类型打折。
- 极性词典无命中时按通道语义兜底，避免把"分手"当成好消息。

**漂移与可塑性**

- 每次推进后夹在 `innate ± personality.drift_cap`（默认 ±0.6）内。
- `plasticity` 随极端状态减半；`critical_step`（0.12）/ `cumulative_step`（0.02）都会乘冲击度与可塑性。
- 同向经历累计到 `same_direction_bonus_after` 的整数倍时额外推一把，避免永久加成。

**依恋与修复**

- `personality.repair`：secure 1.0 / anxious 0.34 / avoidant 0.25 / disorganized 0.2；伤害侧按 `2 - repair` 放大，因此焦虑型一次失约回退更多，回避型被逼问倒退更快。
- 关键事件交替累计 `personality_cycles`，达到 2 轮且焦虑/回避两维同时偏高才允许 `disorganized`。

**叙事与证据链**

- 三轴 `worldSafe` / `othersReliable` / `selfWorth` 随事件方向移动；越过 0.25 或 0.8 时记入 `lockedAxes`（只记事实）。
- 每次 L1/L2/L3 变化写一条 `PersonalityEvidence`（含原话片段、冲击等级与数值），上限 `personality.evidence_cap`（默认 200）。
- 面板只展示事实与数值，不输出"你是 X 型"的结论。

**验证**

`tests/personality.test.ts` 9 项：出生可复现、依恋不可出生混乱型、冲击分级、日常不写人格、通道分化、`drift_cap` 约束、修复按依恋打折、面板事实化、混乱型只能演化。测试总数 103 → **112**。

---

## 5. 存储设计

### 5.1 作用域矩阵

| 数据 | 作用域键 | 跨会话 | 跨工作区 | 说明 |
| --- | --- | --- | --- | --- |
| 事件记忆库 | `characterId` | 是 | 是 | 推荐：记忆跟角色走 |
| 技能 / 资产包 | `characterId` | 是 | 是 | 同上 |
| L1–L4 人格 | `characterId` | 是 | 是 | 写入需 evolution 日志 |
| L5 运行时状态 | `characterId + sessionId` | 否 | 否 | 可从快照恢复 |
| 工作记忆 | `sessionId` | 否 | 否 | 瞬态，进程内 |
| 情感透支 | `characterId` | 是 | 是 | 全局累积，不随会话重置 |
| 演化日志 | `characterId` | 是 | 是 | 全局可查 |

⚑ **D-01 存储作用域**：总览建议 `storage.scope: character`；若未来出现"一个角色被多个工作区并发使用"，需要额外的写者协调策略（见 5.3）。

### 5.2 目录与文件格式（脑区化映射）

```text
dsh-daughter/
├── config.yaml
├── brain/
│   ├── hippocampus/                 # 情景记忆
│   │   ├── index/                   # 摘要层索引（事件摘要、标签、权重）
│   │   ├── fulltext/                # 全文层，按 eventId 分文件
│   │   └── links/                   # 事件链接图
│   ├── neocortex/                   # 人格、语义、情境子人格
│   │   ├── l1_baseline.yaml
│   │   ├── l2_relationship.yaml
│   │   ├── l3_cognition.yaml
│   │   ├── l4_subpersonas.yaml
│   │   └── semantic/                # 长期语义条目
│   ├── amygdala/                    # 情绪标记、显著性
│   │   ├── emotion_tags.yaml
│   │   └── salience.yaml
│   ├── prefrontal/                  # L5 状态、工作记忆、安全状态
│   │   ├── l5_state/
│   │   ├── working_memory/
│   │   └── safety_state.yaml
│   ├── basal_ganglia/               # 技能、指令包、连接包、组合包
│   │   ├── skills/
│   │   ├── macros/
│   │   ├── connections/
│   │   └── combos/
│   ├── cerebellum/                  # 动作包、表达模板、微行为
│   │   ├── motions/
│   │   └── templates/
│   └── brainstem/                   # 安全协议、唤醒基线、降级状态
│       ├── protocols.yaml
│       ├── arousal_baseline.yaml
│       └── degradation.yaml
├── logs/                            # 演化日志、运行/反射/指标产物
│   ├── evolution/                   # 演化日志（<角色>.jsonl，按 log_retention_days 裁剪）
│   ├── run/                         # 运行日志（<角色>.jsonl：每轮耗时/注入 token/命中数/降级）
│   ├── reflex/                      # 反射日志（<角色>.jsonl：命中规则/动作/耗时/成败）
│   └── metrics/                     # 指标快照（<角色>.json：200 轮环形窗口）
├── star_map/                        # 只读星图产物
└── archive/                         # 归档事件与旧版本资产（归档事件完整记录写 archive/<eventId>.json）
```

**映射规则**

| 脑区目录 | 对外语义名 | 是否暴露给用户/其他插件 |
| --- | --- | --- |
| hippocampus | memory | 仅通过 `retrieve` / `associate` |
| neocortex | persona | 仅通过 `before_prompt_build` 注入 |
| amygdala | affect | 仅通过情绪标记字段 |
| prefrontal | runtime / safety | 仅通过 `on_user_message` / `safety_check` |
| basal_ganglia | skills / assets | 通过 `skill_activate` / `asset_invoke` |
| cerebellum | motions / templates | 通过 `motion_play` |
| brainstem | safety_protocol | 不直接暴露 |

**实现现状（v0.3 复核）**

- 人格、技能、L5、安全状态都落在 `<脑区>/<characterId>/` 子目录下，与多角色共存的实际做法一致（旧稿写在脑区根下）。
- 四类资产统一落在 `basal_ganglia/{macros,connections,combos,motions}/<characterId>/`：MOT 动作包按资产语义归到基底节，`cerebellum/motions/` 目前只是预留目录。
- `amygdala/`、`brainstem/`、`cerebellum/`、`neocortex/semantic/` 目前只 `mkdir`，没有产物落盘：情绪标记写在 SQLite 的 `emotion_history`，安全状态在 `prefrontal/<角色>/safety_state.yaml`。这四处的协议/语义条目属于后续阶段，不能算已实现。
- `hippocampus/matches/` 为预留目录，暂无写入。

⚑ **D-02 存储后端**：建议事件摘要与链接用 SQLite（FTS5 全文 + 普通表存链接），全文与日志用 JSONL/单文件。备选：全 JSONL + 内存倒排（简单但重启需重建索引）。评审需确认单机性能与可迁移性要求。

### 5.3 并发与一致性

- **单写者（已实现）**：每角色同一时刻只允许一个写者。写锁以目标文件的 `<file>.lock` 独占创建实现，持锁期间做「写临时文件 → rename」的原子替换；10s 未释放视为陈旧锁回收，2s 拿不到锁则降级为无锁写并 `warn`。开关是 `storage.single_writer`（false 时显式告警）。
- **读-改-写（已实现，替代旧稿的 version 乐观锁）**：技能累计走 `Store.mutateSkill`——持锁读磁盘最新值、应用变更、原子写回，两个进程同时累加成熟度不会互相覆盖。相比"比较 version 再写"，这样能真正合并双方增量。
- **事件追加天然安全**：事件只追加不修改（除 `weight`、`recallCount`、`emotionNowHistory` 三个可变字段）；演化日志追加也在锁内完成。
- **崩溃恢复（部分实现）**：L5 每轮快照、事件写入即落盘、原子写保证不会出现半截 YAML/JSON；**未实现**"启动时重放未完成事务日志"——SQLite 靠 WAL 自恢复，YAML 侧依赖原子替换，没有额外的 redo 日志。

### 5.4 衰减、归档与压缩

| 机制 | 触发 | 行为 |
| --- | --- | --- |
| 权重衰减 | `tick` 定时 | `weight ← weight * (1 - decayRate)^days`；有召回则强化 `+0.05`，上限 1 |
| 归档 | `weight < 0.15` 且 90 天未召回 | 完整事件写 `archive/<eventId>.json`，SQLite 索引保留薄记录并置 `archived = true` |
| 情绪历史合并 | 超过 8 条 | 保留首条与末条，合并中间段情绪最接近的相邻两条（PAD 取平均、保留较晚时间），已实现 |
| 回看节流 | 每轮最多一条 + 同事件 6h 冷却 | 一次召回的多条记忆共享同一个"此刻"，只给情绪位移最大的那条写 `emotion_now_history`；同一条记忆 `retrieval.reconstruct_cooldown_minutes`（默认 360）内不重复。此前一轮命中十几条就写十几行，真实库 24 行只用了两轮，而单事件上限只有 8 条 |
| 日志压缩 | 每月 | 演化日志按月归档，保留摘要索引（**仍待实现**；当前仅按 `log_retention_days` 逐条裁剪，运行/反射日志按 8MB 轮转保留一份 `.1`） |

✅ 归档不删除，支持"淡忘"语义与后续回忆重构。

---

## 6. 接口契约

### 6.1 通用约定

| 项 | 约定 |
| --- | --- |
| 错误处理 | 插件内部异常不得影响会话主流程；统一返回 `{ ok: false, degraded: true, reason }` |
| 幂等 | `on_user_message` 与 `after_response` 以 `(sessionId, turnId)` 去重 |
| 超时 | `before_prompt_build` ≤ 100ms；`retrieve` ≤ 150ms；`tick` 异步不阻塞。**现状**：检索分段计时写入运行日志 `retrieveMs`/`overBudget`，超预算时 `warn`；SQLite 同步查询无法硬中断，因此不做强制取消 |
| 日志 | 每次调用记录 `sessionId`、`characterId`、耗时、注入 token、是否降级 |
| 随机 | 统一从 `seed` 派生的随机源，禁止直接使用 `Math.random()`。**现状**：事件 ID 的进程级 nonce 曾用 `Math.random()`，已改为 `pid + 启动时间戳` 派生，`src` 中不再出现 `Math.random()`；但 `rng` 仍是单条流，同一输入在不同时序下取值不同，「同种子同输入同输出」只在新建实例重跑时成立 |

### 6.2 接口签名

```ts
interface PluginContext {
  characterId: string;
  sessionId: string;
  workspaceId: string;
  turnId: string;
  now(): ISOTime;
  logger: Logger;
  tools: ToolInvoker;
}

interface SafetyVerdict {
  level: 0 | 1 | 2 | 3;
  allowTools: boolean;
  suppressExpressiveness: boolean;
  reasons: string[];
}

interface PromptBlock {
  // association 是 §8.3 预算表里的联想条目，旧稿类型定义漏了
  kind: 'persona' | 'state_hint' | 'event_digest' | 'skill_digest' | 'association' | 'constraint';
  text: string;
  tokens: number;
  priority: number;   // 裁剪时低优先先丢
}

interface DaughterPlugin {
  onUserMessage(input: {
    ctx: PluginContext;
    text: string;
    source: EventRecord['source'];
  }): Promise<{ l5: L5State; verdict: SafetyVerdict }>;

  beforePromptBuild(input: {
    ctx: PluginContext;
    tokenBudget: number;
  }): Promise<{
    blocks: PromptBlock[];
    usedTokens: number;
    memoryHit: boolean;
  }>;

  afterResponse(input: {
    ctx: PluginContext;
    userText: string;
    assistantText: string;
    /** 本轮实际调用过的工具名（按顺序），用于技能沉淀与成败判定 */
    toolsUsed?: string[];
  }): Promise<{
    eventId?: string;
    skillsUpdated: string[];
    evolutionIds: string[];
  }>;

  retrieve(input: {
    characterId: string;
    query: string;
    now: ISOTime;
    topK: number;
    currentEmotion: PadState;
    excludeArchived: boolean;
  }): Promise<Array<{ event: EventRecord; score: number; reason: string }>>;

  associate(input: {
    characterId: string;
    seedEventIds: string[];
    maxDepth: number;
    maxInjected: number;
  }): Promise<Array<{ eventId: string; via: EventLink; score: number }>>;

  skillActivate(input: {
    ctx: PluginContext;
    userText: string;
    maxMain: number;
    maxAssociated: number;
  }): Promise<{
    main?: SkillCard;
    associated: SkillCard[];
    confidence: number;
  }>;

  assetInvoke(input: {
    ctx: PluginContext;
    assetId: string;
    args: Record<string, unknown>;
  }): Promise<{ ok: boolean; output?: unknown; rolledBack?: boolean }>;

  reflexMatch(input: {
    ctx: PluginContext;
    userText: string;
    l5: L5State;
  }): Promise<{ ruleId: string; action: ReflexRule['action'] } | null>;

  motionPlay(input: {
    ctx: PluginContext;
    motionId: string;
  }): Promise<{ ok: boolean }>;

  tick(input: { characterId: string; now: ISOTime }): Promise<{
    decayed: number;
    archived: number;
    recovered: boolean;
  }>;

  safetyCheck(input: {
    ctx: PluginContext;
    l5: L5State;
  }): SafetyVerdict;
}
```

### 6.3 调用顺序与不变量

单轮固定顺序（**不可调换**）：

```text
on_user_message
  → safety_check（预检，先于任何工具与注入）
  → L4 子人格选择
  → reflex_match（命中即短路，不进入检索）
  → skill_activate（1 主 + 2 关联）
  → retrieve + associate
  → 预算裁剪
before_prompt_build → 注入块
模型回复
after_response → 事件写入 / 重构 / 技能更新 / 性格微调 / 日志
tick（异步）
```

不变量：

1. `safety_check` 永远在 `reflex_match` 与 `skill_activate` 之前。
2. `before_prompt_build` 是纯读操作，不得写库（内部先 `skill_activate` 再 `retrieve + associate`，与上面的顺序一致）。
3. `after_response` 是唯一写入事件记忆的入口。
4. 反射命中后本轮跳过检索，但仍执行后处理（事件可写入）。
5. **单轮只注入一次**：宿主在 `(sessionId, turn)` 维度去重，多步工具的后续 step 复用第一次插入的上下文块，不再重复插入。

---

## 7. 运行时流程

```text
用户消息
  └─ 更新 L5 状态（PAD / 压力 / 疲劳，读角色级透支量）
  └─ 安全预检 → 若 level ≥ 2 则抑制工具与高唤起表达
  └─ 选择 L4 情境子人格（按 weight + 对象类型）
  └─ 反射引擎匹配 ──命中──→ 直接执行动作 → 后处理
  │
  └─ 未命中
       └─ 技能激活（关键词 + intent 语义近似；1 主 + 2 关联）
       └─ 记忆混合检索（最近 + 语义 + 权重 + 情绪 + 链接 + 性格偏好）
       └─ 概率联想（限深 1–2 跳，限 1–2 条）
       └─ 预算裁剪（硬上限）
       └─ 注入生成（人格小段 + 状态提示 + 事件摘要 + 技能摘要 + 无记忆约束）
       └─ 模型回复
       └─ 后处理（事件抽取、重构、技能更新、性格微调、演化日志）
       └─ tick（衰减 / 恢复 / 归档）
```

### 7.1 冷启动约束

空事件库时：

- 注入块必须包含硬指令：**禁止虚构具体共同经历**；
- 回复允许"还不认识你"，不允许"假装记得你"；
- 允许使用 L1–L4 表达性格，但不得引用不存在的往事；
- `before_prompt_build` 返回 `memoryHit: false`，供上层做展示降级。

推荐注入片段：

```text
[无记忆约束]
当前事件库中没有任何与用户相关的共同经历记录。
禁止编造"上次你说过""我们之前"等具体往事。
可以表达性格与当前状态，但不得声称记得未记录的事。
```

---

## 8. 检索与联想算法

### 8.1 打分公式

```text
score = 0.42 * semantic
      + 0.22 * recency
      + 0.16 * weight
      + 0.10 * emotionMatch
      + 0.10 * linkProximity
```

| 因子 | 定义 | 默认参数 |
| --- | --- | --- |
| `semantic` | 查询与摘要的语义相似度：`max(FTS5 trigram 排名分, Dice 字面重合)`；排名分为 `1 - rank/候选数` 线性映射，**非 BM25、非向量** | trigram 至少 3 字符，更短查询直接退 Dice |
| `recency` | `0.5 ^ (Δt_days / halfLifeDays)` | `halfLifeDays = 7` |
| `weight` | 事件当前 `weight` | 初始由 `importance` 与情绪强度决定 |
| `emotionMatch` | `1 - L1距离(当前PAD, emotionAtTime)` | 距离归一化到 0..1 |
| `linkProximity` | 与已命中事件的链接强度，1 跳权重 0.6，2 跳 0.3 | 仅 2 跳内 |

⚑ **D-03 权重配比**：上式为本稿建议值，需按实际语料回归调整；`semantic` 无向量库时精度会明显下降，是否引入本地 embedding 需评审确认。

### 8.2 概率联想

- 开关：`random_surprise_enabled`，默认 `true`。
- 概率：每次检索后以 `surprise_eta = 0.05` 的概率额外注入 1 条随机事件（限最近 30 天、非归档）。
- 限深 1–2 跳，限 1–2 条，不递归爆炸。
- 同种子同输入必须复现同结果；随机源从 `seed` 派生。

**无命中时的种子兜底**（`association.fallback_when_no_match`，默认 `true`）

直接命中为空时，检索**不硬凑相关记忆**（`top_k` 仍为 0 条），改由联想通道带内容：从候选事件里挑一个种子跑一跳 BFS。

- 种子按 `0.6 × 情绪匹配 + 0.4 × 近因` 排序，而不是按出边数量——否则不管说了什么，都从同一段最热闹的记忆顺下去，情绪共鸣落不了地。
- 出边只作为前提条件：没有出边的种子顺不出任何内容，挑它等于白挑，此时宁可返回空、走 `[无记忆约束]`。
- 注入走联想块与 `associationDigest`（低优先级、`max_injected` 上限），不占 `event_digest` 的直接命中名额；关掉开关则完全沉默。

**换对话框后的续接**（同一开关）

新会话的第一句既没有字面命中、也联想不出内容时，取该角色最近 1–2 条事件（30 天内）补进事件块，行内带相对时间（"3 小时前""昨天"）。

- 只在该会话第一次构建 prompt 时触发一次，之后回到正常检索语义。
- 这类条目**不进** `promptCache.hits`，因此不写 `recallCount` / `weight`——否则每开一个新窗口就被强化一次，最终恒居首位。
- 有内容就不再注入 `[无记忆约束]`，避免"没有任何记录"和两条往事同时出现。
- 记忆之所以天然跨对话框：`events` 表只按 `character_id` 分，没有 session 维度；L5 情绪状态则按 session 存，换窗口会回到基线（§D-01）。

### 8.3 预算裁剪

硬上限 `max_total_tokens = 3000`。建议分配：

| 块 | 上限 | 最低保留 | 裁剪顺序 |
| --- | --- | --- | --- |
| persona（人格小段） | 300 | 是 | 最后 |
| state_hint（状态提示） | 150 | 是 | 最后 |
| constraint（无记忆/安全约束） | 120 | 是 | 不裁 |
| event_digest（事件摘要） | 1400 | 否 | 第 2 |
| skill_digest（技能摘要） | 500 | 否 | 第 3 |
| association（联想条目） | 300 | 否 | 第 1 |

裁剪算法：先按优先级从低到高逐条丢弃联想与低分事件，再压技能描述为单行；任何情况下不得丢弃 `constraint`。

### 8.4 注入块格式

```text
[人格] 你是……（由 L1+L2+L4 生成，≤300 tokens）
[边做边说] …（做任务时的说话节奏）

[当前状态] 情绪偏平静，略疲惫，安全感中等。（不暴露内部数值）

[相关记忆]
- 【EVT-20261030-xxxx】3 小时前｜标题｜摘要一句｜摘录：全文层前 120 字（可选）
  （最多 top_k=5 条，按分数降序；摘录只在全文确实比摘要行更长时追加）

[技能]
- SKL-douyin-scan-001：扫描今日内容并摘要（成熟度 0.82）
- SKL-shell-demo-002：刚学会的流程（成熟度 0.30｜草稿·需确认）

[联想]
- EVT-…（topic）

[无记忆约束] …（仅 memoryHit=false 时出现）
```

---

### 8.5 认知滤网（cognitive filter，v0.4）

大脑不会把每条感官输入都写进长期记忆。滤网就是这道门：**重复的习惯化，无关的忽略，危险的屏蔽，剩下的才值得记**。它有三处落点——写入前门控、检索降权、周期忘却。

```text
事件产生 ──► ① 认知屏蔽（来源/关键词/正则）──┐
             ② 显著性 < 门限 且 来源可信度低 ──┼──► 丢弃（只计数）
             ③ 同源窗口内超配额（非对话来源）──┼──► 丢弃（爆发抑制）
             ④ 窗口内同题重复 ────────────────┼──► 合并（只累加 merged_count）
             ⑤ 其余 ───────────────────────────┴──► 入库（记 salience）
                                                        │
检索 ── ⑥ 来源可信度乘子（system 0.4 / game 0.9 / chat 1.0）◄┘
周期 ── ⑦ 忘却扫描：低显著 + 从未被想起 + 闲置超期 ──► 归档（不物理删除）
```

**显著性公式**（全部可从事件本身算出，不依赖模型调用）

```text
salience = (0.34·情绪强度 + 0.28·新颖性 + 0.24·社交性 + 0.14·信息量) × 来源可信度
情绪强度 = clamp01(intensity·0.8 + |pleasure|·0.4)
新颖性   = 1 − max(Dice(签名, 最近 80 条中的任一条))
社交性   = 参与者含 user ? 1 : 0.5   ← 参与者按来源推导，见下
信息量   = clamp01((标题长 + 摘要长) / 120)
```

**参与者按来源推导**（`participantsFor`，2026-11-06 修）：`chat`/`qq`/`douyin_dm` 记 `['self', 'user']`，`douyin_content`/`system`/`android` 只记 `['self']`。

早期一律写 `['self','user']`，真实库 55/55 全中，含 23 条抖音。三个下游一起歪：社交性恒为 1 → 显著性虚高（系统事件的显著性掉不下去）；人物画像把这些噪声算成"和用户一起做的事"（`count`/`score`/`intimacy` 全涨）；L2 亲密度的锚点跟着失真。存量靠 `migrateParticipants` 一次性改回 `['self']`（幂等）。

**习惯化签名**：标题 + 摘要先做归一化——数字与数量单位（万亿/亿/万/k/m/b/%/次…）统一替换为 `#`，被 24 字截断切掉的 `#…` 也抹平。这样"好感度涨到 58410547"和"涨到 5.8 万亿""涨到 1.2 亿"是同一件事。

**保守原则**：`source_weight = 1` 的真人对话**永远不会因为显著性低被丢弃**，只会被检索降权。噪声只可能来自低可信来源。

**同源爆发抑制**（`filter.burst`，v0.5 补）：习惯化只认"内容像不像"，而模板相同、条目不同的输入（刷短视频、切窗口、连发通知）相似度躲得过 0.9 的门槛，于是照样一条条写库。`burst` 改按**条数**设上限：非豁免来源在 `window_minutes` 内最多保留 `max_keep` 条，超出即丢弃，`reason` 写明"同源「douyin_content」在 60 分钟内已有 3 条"。豁免名单默认 `[chat, qq, douyin_dm]`——对话是真实发生的事，连着说五句也不该被限流。

- 触发依据（2026-11-06 真实库）：55 条事件里 **23 条来自 `douyin_content`（42%）**，`pleasure` 恒为 **0.098**、`intensity` 0.14，`recall_count` 合计 4、`merged_count` 14。形态与当年的"前台切换"一致：同模板、零情绪方差、占满候选池。
- 习惯化为什么没挡住：它按**相似度**合并，而抖音每条视频的标题不同，`Dice` 上不去 0.9，只能合并同一条视频的重复拉取（14 次），挡不住"不同视频各写一条"。

**忘却**：`salience < min_salience` 且 `recallCount = 0` 且闲置超过 `idle_days` → 归档。被想起过的事件即使显著性低也保留——"用得上"本身就是价值。旧数据没有 `salience` 字段时按 `来源可信度 × 0.4` 保守估计，避免老库里的系统噪声永远清不掉。

**存量清理**：`npm run filter:sweep`（默认 dry-run，加 `-- --apply` 执行）。做两件事：同题压缩（保留权重最高的一条并累加 `merged_count`）+ 低价值忘却。

- 首轮（2026-11-05）：659 条 → 归档 470 条（system 431 / game 38 / chat 1），剩 189 条。这 470 条**全部来自同题压缩**（`merged_count` 合计 470），当时 `filter.forget` 未产生计数——存量事件最新距今不足 `idle_days`；跨来源同签名分组为 0。
- 后续 `tick` 的忘却扫描（2026-11-05 复核）：又归档 126 条，`meta.filter.forget = 126`。
- **复核实测（2026-11-05，`brain/hippocampus/index/memory.db`）**：662 条，活跃 **64**（chat 58 / game 5 / android 1）、归档 598；`meta` 计数 keep 3 / merge 472 / forget 126；活跃事件平均显著性 **0.398**（最低 0.36），活跃最大出度 **11**，悬空边 0。
- **噪声换源（2026-11-06，库重置后的 55 条）**：`chat` 32（`pleasure` 0.059–0.232）、`douyin_content` 23（`pleasure` 恒 0.098、`intensity` 0.14）。抖音已取代"前台切换"成为最大单一来源，同一模板 + 零情绪方差 + 零召回。本轮的 `burst` 配额即针对它；存量 23 条靠权重衰减与忘却自然退场（`recall_count > 0` 的 4 条不会自动归档，需要 `filter:sweep`）。

**可观测**：`meta` 表累计 `filter.keep / merge / drop / shield / forget`，星图侧栏"记忆与认知滤网"一栏展示，另给出平均显著性与合并计数合计。

---

## 9. 技能、资产与反射

### 9.1 技能状态机

```text
draft ──首次成功──→ active ──maturity>0.7 且 success>=5──→ frozen（可固化）
  ↑                    │                                        │
  └──────修订──────────┘                    资产失败 2 次 ←── rollback
                                                 │
                                              active
```

| 状态 | 进 prompt | 可执行 | 说明 |
| --- | --- | --- | --- |
| draft | 激活时（标注「草稿·需确认」） | 是（需确认） | 新沉淀的技能。旧稿写「不进 prompt」，但这样它永远拿不到执行机会，实际改为带标注进 prompt |
| active | 激活时 | 是 | 正常 |
| frozen | 激活时 | 是 | 已固化，优先走资产 |
| deprecated | 否 | 否 | 连续失败 5 次进入，保留记录 |

> 状态迁移里 `draft → active` 与 `→ deprecated` 由 `bumpSkill` 在读-改-写里完成，并在状态变化时写一条 `target: 'skill'` 的演化日志。

### 9.2 反射引擎

- 规则编译：regex 按 pattern 缓存编译结果（编译失败也缓存为 null），等价于"加载时编译"，运行时只做匹配。
- 匹配顺序：`priority` 降序，`cooldownMs` 未过期则跳过。`state` 类型判定：`stress`/`fatigue` 按"达到阈值"，`safety` 按"低于阈值"，与 §10.1 的档位语义一致。
- 动作执行：`template_reply` 直接返回；`tool_call` 先过 `safety_check`，安全档位 ≥2 时该条规则直接不命中（并记 `warn`）；`motion` 通过 `ctx.emit('motion.play')` 发出，桌宠侧已消费。
- 耗时：匹配耗时超过 `reflex.max_match_ms` 会记 `warn`（含 ruleId 与毫秒数），不中断。
- 短路条件：仅当 `reflex.short_circuit: true` 时命中才跳过模型；默认 `false`，因为宿主 `reject` 会丢弃该条用户消息。
- 失败处理：动作执行失败记日志并回落到正常流程，不阻塞会话。

---

## 10. 安全模型

### 10.1 阈值与降级档位

| 档位 | 触发条件（默认，可配置） | 行为 |
| --- | --- | --- |
| 0 正常 | 无 | 正常表达与工具 |
| 1 轻度 | `stress > 0.7` 持续 ≥ 30min | 表达幅度下调，减少主动联想（state_hint 追加"收一些"，联想块先被裁剪） |
| 2 中度 | `safety < 0.35` 或 `fatigue > 0.8` | 写类工具熔断（`desktop_input` / `vpet_control` 的 animate·move、资产执行），只读工具（`desktop_observe`、`vpet_control status`、`desktop_input screen`）仍放行；注入只保留情绪中性记忆（`|pleasure| ≤ 0.2`）；反射的 `tool_call` 不命中 |
| 3 强降级 | `emotionalOverdraft > 0.8` | 只做必要回应，不主动展开，不输出情绪化长文（由 state_hint 约束） |

恢复：每 `tick` 按恢复速率回落；恢复需跨过阈值 -0.1 的滞回带，避免抖动。

### 10.2 表达约束

| 允许 | 禁止 |
| --- | --- |
| "有点紧张" | "心跳好快"（假装有身体） |
| "我现在不太想说话" | "我真的好疼"（声称真实情感） |
| "我可能会想很久" | 编造存在性焦虑的深沉台词 |
| 描述状态强度与持续时间 | 任何诊断标签（焦虑症、抑郁、创伤等） |

配置项 `safety.diagnosis_labels_forbidden: true` 必须保持开启；实现上另有输出侧关键词后置检查，并且该开关**已生效**：置为 `false` 时后置检查关闭并在启动时 `warn`。

### 10.3 审计

- 每次降级产生 `EvolutionLogEntry`（`target: 'safety'`）。
- 记录触发条件、持续时间、功能损害强度，不记录推断结论。
- 审计条目与演化日志同一条保留策略：`evolution.log_retention_days`（默认 365 天）逐条裁剪，不单独做 180 天归档（旧稿的 180 天与配置冲突，以配置为准）。

---

## 11. 配置规范

```yaml
# dsh-daughter/config.yaml
version: 1
character_id: daughter-default

seed: 42
random_surprise_enabled: true

retrieval:
  top_k: 5
  half_life_days: 7
  surprise_eta: 0.05
  exclude_archived: true
  max_candidates: 1000
  score_weights:
    semantic: 0.42
    recency: 0.22
    weight: 0.16
    emotion_match: 0.10
    link_proximity: 0.10
  min_score: 0.12
  expand_fulltext: true          # 命中时是否展开全文层摘录
  fulltext_excerpt_chars: 120

association:
  max_depth: 2
  max_injected: 2
  hop_decay: 0.6

skills:
  max_main: 1
  max_associated: 2
  maturity_threshold_automate: 0.7
  min_success_for_freeze: 5
  min_main_score: 0.25
  min_associated_score: 0.15
  min_steps_to_learn: 2          # 一轮至少用到几个工具才沉淀技能草稿

reflex:
  enabled: true
  max_match_ms: 5                # 超出只告警，不中断
  short_circuit: false           # 命中即跳过模型；开启后该条用户消息在聊天里不留痕

budget:
  max_total_tokens: 3000
  block_caps:
    persona: 300
    state_hint: 150
    event_digest: 1400
    skill_digest: 500
    association: 300
    constraint: 120

safety:
  enabled: true
  diagnosis_labels_forbidden: true
  thresholds:
    stress_level1: 0.7
    safety_level2: 0.35
    fatigue_level2: 0.8
    overdraft_level3: 0.8
  hysteresis: 0.1
  level1_min_duration_min: 30

storage:
  scope: character            # 仅支持 character，其它取值启动时告警
  shared_across_sessions: true
  shared_across_workspaces: true
  data_root: .
  backend: sqlite             # 当前仅 sqlite（FTS5 不可用时降级为 Dice 字面匹配）
  single_writer: true         # true 时写入走文件锁 + 原子替换；false 会告警

decay:
  weight_decay_rate: 0.02      # 每日
  recall_boost: 0.05
  archive_threshold: 0.15
  archive_idle_days: 90

# 情绪回落（§14.7）：闲置越久，L5 越靠近基线；连续对话时几乎不生效
emotion_relax:
  enabled: true
  rate_per_hour: 0.06          # 每小时向基线回归的比例
  idle_hours: 0.5              # 闲置不足该时长不回落
  stress_baseline: 0.2
  fatigue_baseline: 0.15
  safety_baseline: 0.7

evolution:
  l1_max_delta_per_write: 0.02 # 仅约束 evolvePersona 的日常微调路径
  min_turns_between_writes: 20
  log_retention_days: 365

# 性格演化（§4.8 / §14.8）：日常闲聊不动人格，只有累积/关键事件才推动
personality:
  enabled: true
  drift_cap: 0.6                # 五维相对出生锚点的最大漂移量（±）
  critical_threshold: 0.6       # 冲击度 ≥ 此值算关键事件
  cumulative_threshold: 0.3     # 冲击度 ≥ 此值算累积经历
  critical_step: 0.12           # 关键事件的单步基础推进
  cumulative_step: 0.02
  same_direction_bonus_after: 3 # 同向经历每攒够几次，额外推一把
  repair:                       # 修复效率乘数（按依恋底色）；伤害侧按 2 - 该值放大
    secure: 1.0
    anxious: 0.34
    avoidant: 0.25
    disorganized: 0.2
  initial:                      # 出生抽样：区间有界，混乱型不可出生
    ranges:
      openness: [0.45, 0.75]
      conscientiousness: [0.4, 0.7]
      extraversion: [0.3, 0.7]
      agreeableness: [0.45, 0.8]
      neuroticism: [0.25, 0.65]
    attachment_priors:
      secure: 0.7
      anxious: 0.18
      avoidant: 0.12
  evidence_cap: 200             # 证据链保留条数（面板只给事实，不给类型标签）

desktop:
  enabled: false               # P9 尚未实现；true 只会在启动时告警
  bridge_url: http://127.0.0.1:47614

# 认知滤网（见 §8.5）：写入门控 / 习惯化 / 屏蔽 / 忘却
filter:
  enabled: true
  source_weights:            # 同时用于写入门控与检索降权；真人对话恒为 1
    chat: 1.0
    qq: 1.0
    douyin_dm: 1.0
    game: 0.9
    minecraft: 0.9
    douyin_content: 0.85
    android: 0.85
    system: 0.4
  shield:
    sources: []              # 例如 [system] 完全不留系统事件
    keywords: []             # 例如 [密码, token]
    patterns: []             # 正则
  habituation:
    window_minutes: 30       # 同题重复的判定窗口
    max_repeat: 3            # 窗口内最多计数几次，超过不再入库
  salience:
    drop_below: 0.2          # 低于此值且来源可信度 ≤0.5 → 丢弃（0.12 会让"前台切换"漏进来，代码默认已改为 0.2）
  forget:
    enabled: true
    idle_days: 30
    min_salience: 0.2

# 桌宠联动（可选，见 §12.1）：任何一项缺失/关闭，行为都与没有桌宠一致
vpet:
  enabled: true
  body_link:
    enabled: true          # 桌宠体力/心情 → L5 疲劳/压力，只抬升不写回
    stale_ms: 300000
    fatigue_weight: 0.5
    stress_weight: 0.3
    max_influence: 0.6
```

星图面板（`/star-map/`）只做只读观测：星系图、L1–L4 参数与出厂值偏移、L5 快照、存储统计、最近演化、四项指标。插件不再附带任何输出形态（语音 / 形象 / 皮肤），见 §2.3 非目标。

**配置优先级**：角色级配置 > 插件默认配置 > 内置兜底。所有数值型配置做范围校验，非法值回落默认并告警。

---

## 12. 外部连接契约

| 应用/场景 | 连接方式 | 代表插件/工具 | 在体系中的用法 |
| --- | --- | --- | --- |
| QQ | OneBot 11 / NapCat | `dsh-onebot-qq`、`dsh-napcat-bridge`、`dsh-qq-bot` | `send_qq_message` 等工具；入站消息作为外部事件写入记忆 |
| 抖音（内容） | 浏览器自动化 | `dsh-douyin-on-base`（star-browser） | 技能调用 `douyin_next`、`douyin_like`、`douyin_evaluate` |
| 抖音（私信） | WSS 直连 | douyin-im 桥接插件 | 入站进 DSH 会话，回复走桥接，不碰浏览器 |
| Minecraft（有权限） | RCON | `dsh-rcon` | 直接发命令，异步反馈作为事件 |
| Minecraft（无权限） | mineflayer | `dsh-minecraft-agent` | 平权 AI 玩家，聊天与行动 |
| 单机游戏（PvZ 等） | MCP 游戏框架 / 桌面控制 | `@forgeax/dsh-game`、`dsh-work-components`、`godot-bridge` | 封装为工具，固化为一键资产包 |
| 桌宠：**VPet-Simulator**（虚拟桌宠模拟器，Steam 版，实测 11074） | 插件桥 + HTTP 轮询（1s，端口 47612） | 本仓库 `connectors/vpet`：自建 C# 代码 MOD **`DshDaughter`**（`mod\DshDaughter\info.lps` + `plugin\DshDaughter.dll`，不改游戏本体）；`connectors/pet-shell`：独立 WPF 壳，读 `mod\0000_core\pet\vup` 素材 | MOD 带游标轮询 `/vpet/events?since=<seq>`，处理完 `POST /vpet/events/ack`；`/vpet/status` 汇总队列与在线状态，`/vpet/heartbeat` 由 `bridge.mjs` 上报存档心跳；`/vpet/control` + `vpet_control` 工具支持 DSH 接管任意 GraphType 动画与窗口位移；每轮用户消息后按 PAD/压力/疲劳下发情绪动作（joy→`Touch_Head`、low→`Say`、tired→`Sleep`，带节流）；`motion.play` 已消费。另提供 `connectors/pet-shell` 独立壳（WPF）：不启动游戏本体，直接读 VPet 素材目录的 PNG 序列帧播放，同样轮询上述端点；壳与 MOD 共用同一 ack 游标，**只能二选一运行** |
| 手机控制 | ADB / 工具调用 | `dsh-plugin-android-use` | 技能编排打开应用、点击、输入、定时 |
| 电脑桌面 | PowerShell + ffmpeg | 本仓库 `connectors/desktop` | `/windows`、`/foreground`、`/media` 状态；`/screenshot`、`/frames`、`/stream` 画面；前台切换写 `system` 事件；`/stream` 默认 1280 宽/q7，本机实测约 28 fps、3.4 MB/s；`/frames` 走 JPEG 抽帧约 0.15 MB/s；`desktop_observe` 工具按需取一帧并保存为宿主附件送入模型 |

> 实现现状（2026-11-03）：桌宠、Android（ADB）与电脑桌面已落地；QQ/抖音/MC/单机游戏仍需适配器，可先走通用入口 `ingestExternalEvent`。详见 §14.1。

**契约要求**

1. 技能卡片 `requiredTools` 必须指向真实存在的工具名，加载时校验，缺失则技能降为 `draft`。**现状**：宿主未暴露工具清单查询，加载时校验无法实现；目前只在 `assetInvoke` 执行阶段由工具调用失败体现（对应 R-06）。
2. 资产包步骤直接引用工具调用，参数模板与技能保持一致。
3. 外部消息统一归一化为 `EventRecord`，`source` 取枚举值，禁止自定义字符串。
4. 高风险操作继承目标插件的安全确认与频率限制，插件不自行放宽。

### 12.1 桌宠弱耦合契约（v0.3）

桌宠与角色**互为可选**：任一方缺席，另一方照常工作。耦合只走三条窄通道，且每条都可单独关闭。

```text
                 ┌── ①表现通道（DSH → 桌宠，主用）──────────────┐
DSH 插件队列 ────┤  thinking / tool / reply / error / motion / move │──> MOD 轮询消费
                 └───────────────────────────────────────────────┘
                 ┌── ②状态回执（桌宠 → DSH，主用）──────────────┐
MOD 状态上报 ────┤  能力清单 / 忙闲原因 / 玩家交互 / 队列 / 窗口   │──> 合法性校验 + 让行
                 └───────────────────────────────────────────────┘
                 ┌── ③身体信号（bridge → DSH，可选且单向弱耦合）─┐
bridge.mjs ──────┤  strengthPct / feelingPct（存档体力、心情）    │──> L5 有效疲劳/压力
                 └───────────────────────────────────────────────┘
```

| 规则 | 说明 |
| --- | --- |
| 缺席即等价 | 没有 MOD、没有 bridge、没有 `vpet` 配置时，插件与"完全不知道桌宠存在"行为一致；没有插件时 MOD 只写自己的日志，游戏不受影响（轮询失败 30s 限流打点、legacy 兼容、游标自动重播） |
| 单向只读 | 身体信号只进不出：插件**不写回** VPet 存档，避免两个系统互相污染；反向表现走 ①表现通道 |
| 只抬升不覆盖 | `fatigue = max(对话疲劳, 体力映射)`、`stress = max(对话压力, 心情映射)`，外部信号无法压低角色自己的情绪 |
| 有上限、会过期 | 映射量受 `fatigue_weight` / `stress_weight` 与 `max_influence`（默认 0.6）限制；`stale_ms`（默认 5min）无新心跳即失效 |
| 不落人格 | 抬升只发生在派生的"有效状态"上，写盘与演化日志只记原始 L5；`body` 不进入 L1–L4 |
| 契约向后兼容 | heartbeat 新增字段全为可选：旧 bridge 不带 → 不产生信号；新 bridge 对旧插件 → 字段被忽略 |

配置：

```yaml
vpet:
  enabled: true
  body_link:
    enabled: true          # 总开关，关掉后与没有桌宠完全一致
    stale_ms: 300000
    fatigue_weight: 0.5    # 体力低 → 疲劳
    stress_weight: 0.3     # 心情低 → 压力
    max_influence: 0.6
```

反向表现补充：MOT 资产带 `padMatch` 时，`assetInvoke` 在没有显式 `motionId` 的情况下按 PAD 距离挑最近的已固化动作；一个 `padMatch` 都没有就报 `motion_id_missing`，不做猜测。

---

## 13. 可观测性

| 产物 | 路径 | 内容 | 用途 |
| --- | --- | --- | --- |
| 运行日志 | `logs/run/<角色>.jsonl` | `at`、`sessionId`、`turnId`、`tookMs`、`injectTokens`、`hits`、`skills`、`memoryHit`、`degraded` | 性能与故障排查 |
| 反射日志 | `logs/reflex/<角色>.jsonl` | `ruleId`、`actionKind`、`tookMs`、`ok` | 调参与误触发排查 |
| 演化日志 | `logs/evolution/<角色>.jsonl` | L1–L4 变更 diff、原因、触发事件（按 `log_retention_days` 裁剪） | 可追溯性（G5） |
| 星图产物 | `star_map/` + `/star-map/api` | 九个星系（海马体·情景记忆/地点、杏仁核·情绪、新皮层·人物/事物/认知八维+善恶观、前额叶·当下状态、基底节·技能、脑干·安全），事件、主题、参与者、地域、情绪与维度为边；人物带亲密度/关系趋势，事物带喜好权重，事件带历史感受与回看感受（只读） | 人工观察，不参与决策 |
| 指标 | `logs/metrics/<角色>.json`；对外 `GET /star-map/metrics` | `memoryHitRate`（命中轮次/总轮次）、`injectTokenP95`（最近 200 轮 95 分位）、`reflexHitRate`（反射命中/总轮次）、`degradeRate`（**仅检索降级**：FTS5 不可用或查询短于 3 字符退 Dice） | 上线后评估 |

⚑ **现状（2026-11-04）**：运行/反射日志按角色追加，单文件超过 8MB 轮转为 `<角色>.1.jsonl`（只保留一份旧文件）；指标保留 200 轮环形窗口并落盘，进程重启后继续累加；指标可经 `GET /star-map/metrics` 读取，星图侧栏已展示这四项指标（记忆命中率 / 注入 token P95 / 反射命中率 / 降级率，另附轮次、反射命中数、采样窗口）。`degradeRate` 只统计检索层降级。

⚑ **D-04 星图实现**：已落地为在线只读服务——插件挂载 `/star-map/`（页面）与 `/star-map/api`（每次请求实时重算），并在侧边栏「面板」列表提供「脑星图」入口；JSON 产物仍按 `tick` 落盘，供外部读取。页面按九个星系固定排布成一条倾斜星环（非力导向），星系内部用斐波那契球铺开成有厚度的星团，Canvas 2D 手写透视投影渲染（不引 three.js，离线可用），支持轨道旋转、以鼠标为锚点的缩放、深度雾化与悬停概要浮层；人物节点额外汇总亲密度与关系趋势。星系分组与画像只影响展示，不参与运行时决策。

---

## 14. 里程碑与验收标准

| 阶段 | 内容 | 验收标准 | 状态 |
| --- | --- | --- | --- |
| P0 | 事件文件 + 分层 + 空库降级 | 空库可对话；注入含硬约束；事件可写可读 | 已完成 |
| P1 | 安全降级基础版 | 三档阈值可触发；不输出诊断；有审计日志 | 已完成 |
| P2 | 混合检索 + 注入预算 | `top_k` 生效；`usedTokens ≤ 3000`；裁剪顺序正确 | 已完成（语义分见 §14.1） |
| P3 | 链接与概率联想 | 1–2 跳生效；同种子可复现；不超条数上限 | 已完成（用例见 `tests/p0.test.ts`） |
| P4 | 技能卡片 + 激活预算 + 成熟度 | 1 主 2 关联；未激活不进 prompt；成熟度可累计 | 已完成 |
| P5 | 资产包 + 反射引擎 + 动作包 | 固化条件生效；失败自动回退；反射 0 次 LLM 调用 | 已完成：MAC/CON/CMB/MOT 按技能形态固化；失败两次持久化回退；MOT 经 `motionPlay` 播放；反射支持 event 匹配；短路 0 LLM 需开启 `reflex.short_circuit`（默认关闭，见 §14.1） |
| P6 | PAD 情绪 + 回忆重构 | 情绪可更新；`emotion_at_time` 不被覆盖 | 已完成（历史合并见 §14.1） |
| P7 | 性格演化 + plasticity | 单次 Δ 受限；每次变更可追溯 | 已完成（用例见 `tests/p0.test.ts`） |
| P8 | 脑区化目录 + 星图 | 目录符合规范；对外接口不暴露脑区名 | 已完成（星图每 30 分钟刷新；9 星系：情景记忆/地点/情绪/人物/事物/认知八维/当下状态/技能/安全） |
| P9 | 桌宠/QQ/抖音/MC/单机连接 | 每个连接至少 1 条端到端用例通过 | VPet（桌宠）、Android ADB、电脑桌面已接通（3/7）；QQ/抖音/MC/单机仍待适配器，可先走通用入口 `ingestExternalEvent` |

**P0 退出条件**必须同时满足：G1 通过 + 无诊断标签 + 空库不编造往事。

### 14.1 实现核对（截至 2026-11-06 v0.5）

核对基准：`src/` 当前构建（**203 项测试 + 18 项自检全绿**，2026-11-06 性格演化、行为动机与主动开口之后）+ VPet MOD 实测 + Android ADB / 电脑桌面本地模拟。

| 项 | 设计表述 | 实现现状 | 处置 |
| --- | --- | --- | --- |
| 桌宠通道 | SSE 事件通道 | HTTP 轮询 `/vpet/events?since=<seq>`，每 1 秒一次；事件带自增序号，处理完 `POST /vpet/events/ack` 才裁剪；容量 200 条，溢出时响应带 `lost` 供 MOD 记日志；旧版无 `since` 仍按一次性领取兼容 | 保持轮询；游标 + ack 解决掉线丢事件 |
| 桌宠在线状态 | （原文未设计） | `GET /vpet/status` 汇总队列、MOD 轮询与桥接心跳；MOD 10s 内有请求视为在线，`bridge.mjs` 120s 内有心跳视为在线；`GET /health` 同步返回摘要 | 已完成（测试覆盖） |
| 桌宠接管 | （原文未设计） | `vpet_control` 工具 + `POST /vpet/control`：`animate` 可指定任意 VPet GraphType 与循环次数并可带气泡文字，`move` 按像素平滑位移，`status` 查询连接；默认不调用时桌宠保持自主活动，播完自动回到常态 | 已完成；实测 animate 气泡与 move 位移（dx=120/dy=-40 精确命中） |
| 情绪关联 | （原文未设计） | 每条用户消息更新 L5 后按 PAD/压力/疲劳选动作：愉悦≥0.2 且唤醒≥-0.05→`Touch_Head`，愉悦≤-0.25→`Say`，压力≥0.75 或疲劳≥0.7→`Sleep`；最小间隔 20s、同带重复 120s，不写入记忆；`/vpet/status` 的 `mood` 字段记录最近一次情绪动作 | 已完成（纯函数测试覆盖） |
| 身体信号 | （v0.2 未设计） | bridge 心跳带体力/心情 → 只抬升 L5 有效疲劳/压力，原始状态落盘不污染人格；5 分钟无心跳自动失效；`vpet.body_link.enabled=false` 时与没有桌宠一致（§12.1） | 已完成（`tests/body-link.test.ts`） |
| 动作包 | 桌宠接收 `motion.play` 播放片段 | `motion.play` 经 `onMotion` 入队 `/vpet/events`；MOD 映射 `MOT-HUG→Touch_Body`、`MOT-PAT→Touch_Head`，未知动作回落 `Say` | 已接通（实测 00:11:57）；映射为硬编码，动作规则仅 RFX-003 |
| 反射 0 LLM | 命中直接执行，不走 LLM | `reflex.short_circuit` 默认 `false`；开启后宿主 `reject` 会丢弃该条用户消息（实测聊天记录中消息与回复均不留）；keyword/regex/state/event 四类匹配均可命中，event 按消息来源匹配 | 默认关闭；仅非聊天来源可开启 |
| 外部连接 | QQ/抖音/MC/单机/手机/桌面矩阵 | VPet 已接通；Android 新增 `connectors/android`（受限 ADB 动作 + 前台事件）；桌面新增 `connectors/desktop`：PowerShell 查询窗口/前台/媒体，`/screenshot` 单帧（支持 `?format=jpeg&width=&quality=` 缩放）、`/frames` JPEG 低帧流、`/stream` ffmpeg 实时流（默认 1280 宽/q7，可 `?width=&quality=&fps=` 调优），前台切换推送 `/connectors/system/ingest`；新增 `desktop_observe` 工具，按需取前台 + 一帧 JPEG 并保存为宿主附件；宿主新增 `/connectors/<source>/ingest` 通用入口（来源白名单校验）；QQ/抖音/MC/单机仍待建 | Android、桌面已完成（本地模拟 E2E）；其余 P9 待建 |
| 资产包类型 | MAC / CON / CMB / MOT | `maybeFreezeSkill` 按技能形态自动选择：无工具→MAC、单工具/required_tools→CON、多工具多步→CMB、动作步骤→MOT；资产按角色隔离存储；`assetInvoke` 按类型执行（MOT 走 `motionPlay`，其余走步骤）；连续 2 次失败持久化为 `rolled_back` 并把来源技能恢复 `active`；`requiresConfirm` 技能不自动固化 | 已完成（测试覆盖） |
| 回忆重构 | `emotion_now_history` 超限合并 | 上限 8 条；超出后把中间段情绪最接近的相邻两条合并为一条（PAD 平均、保留较晚时间、reason 标记「已合并」），首条与末条原样保留，不再截断丢弃 | 已完成（测试覆盖） |
| 日志保留 | 365 天 | `runTick` 每次维护调用 `pruneEvolutionLogs`，按 `evolution.log_retention_days` 删除超期演化日志，返回 `prunedLogs`；时间戳缺失的记录保留 | 已完成（测试覆盖） |
| 星图分组 | 原型按脑区分层展示 | 9 个星系固定分组：情景记忆/地点/情绪/人物/事物/认知八维/L5 当下状态/技能/安全；无地点词时按来源归入「线上/桌面」 | 已完成 |
| 人物画像 | 参与者只记互动次数 | 亲密度按事件权重累加、14 天半衰期衰减归一；关系分档（陌生/初识/熟悉/亲近/亲密）；趋势取近 7 天对比前 7 天（升温/稳定/降温）；附认识时间与最近互动 | 已完成（随星图实时重算） |
| 善恶观 | 原型强调「认知架构善恶观」 | `L3Cognition.moral` 独立字段（利他倾向/原则强度/立场/红线），星图单独成节点、不挤占八维计数；旧存档缺字段时补默认 | 已完成（测试覆盖） |
| 事物喜好 | 原型强调「事物的喜好」 | 主题按事件情绪加权平均并做 14 天半衰期，分喜欢/中性/不喜欢；星图节点带偏好值，prompt 注入偏好摘要 | 已完成（测试覆盖） |
| 感受回顾 | 原型强调「历史感受、当下回顾感受」 | 事件节点同时带 `emotionAtTime` 与最近一条 `emotion_now_history`（回看感受、变化幅度、原因），星图悬停可见 | 已完成（只读展示） |
| 画像注入 | 原型强调画像随当下认知变化 | `buildRelationText` 把关系分档/亲密度/趋势、事物偏好、善恶观并入 persona 块，受 persona 300 token 上限裁剪 | 已完成（测试覆盖） |
| L5 会话列表 | 星图读取最新状态快照 | `listL5Sessions` 曾返回带 `.json` 的文件名导致读回失败；已修正并按 `lastTickAt` 取最近会话 | 已完成（测试覆盖） |
| 语义检索 | 混合检索含语义分 | 语义分 = max(FTS5 trigram 子串命中, Dice 字面重合)，无向量；2 字以下查询低于 trigram 下限，退回 Dice（对应 R-01 的 embedding 仍待评） | 已落地 FTS5；BM25/embedding 列为后续 |
| 可观测性 | 运行/反射日志 + 4 指标 | `logs/run`、`logs/reflex`、`logs/metrics` 按角色落盘；每轮与每次反射命中各写一行 JSONL，超过 8MB 轮转为 `.1` 备份；指标保留 200 轮窗口并重启续算，可经 `GET /star-map/metrics` 读取；`degradeRate` 只统计检索降级 | 已完成（测试覆盖 + 端点实测） |
| 人格分层写回 | §4.2 要求 L1–L4 均可写回 | `tick` 中的 `evolvePersona`：L2 关系深度向与 user 的亲密度平滑靠拢（阶段逐级推进、回退需低于阈值 0.1）；L3 依近 7 天情绪调防御成熟度并归一化偏差/应对权重；L4 子人格权重归一化；**满 24 小时或累计 8 轮**先到先跑（早期只有"每天一次"，32 轮长对话只推进过一次），推进步长乘依恋系数 `1 + 0.4 × attachmentAnxiety`；每次变更写 evolution | 已完成（测试覆盖） |
| 性格冲击路径 | v0.4 未设计（v0.5 补） | `after_response` 中的 `applyPersonalitySignal`：按冲击分级、通道、依恋修复系数推进 L1/L2/L3，写入自我叙事与人格证据链；受 `innate ± drift_cap` 约束 | 已完成（§4.8 / §14.8，9 项测试） |
| after_response 幂等 | §6.3 要求按轮去重 | 插件内以 `(sessionId, turnId)` 去重（上限 512），重复调用返回空结果，不重复写事件/技能/演化 | 已完成（测试覆盖） |
| 事件抽取 | （原文未说明方式） | 标题截断 + 标签词典的启发式抽取，非模型抽取；摘要层压缩为 80/40 字，全文层存完整问答 | 文档已补注 |

### 14.2 加固轮次（2026-11-04 v0.3）

针对 v0.2 核对发现的缺口，本轮补齐了下面 8 项，测试从 76 项增加到 87 项（新增 `tests/hardening.test.ts`）。

| # | 缺口 | 处理 | 验证 |
| --- | --- | --- | --- |
| 1 | §5.3 单写者只有配置声明 | `util.ts` 增加 `withFileLock`（`<file>.lock` 独占创建 + 陈旧锁回收 + 超时降级告警）与 `atomicWriteFile`（临时文件 + rename）；人格/技能/资产/L5/安全/透支/星图/反射状态/归档/演化日志全部改走锁内原子写，开关接 `storage.single_writer` | 原子写无 `.tmp` 残留；两个 Store 实例交替 `bumpSkill` 十次后 `successCount = 10` |
| 2 | 技能只有 `active→frozen` 与回退，`draft`/`deprecated` 从不出现 | 新增 `learnDraftSkill`：一轮工具序列 ≥ `skills.min_steps_to_learn` 时沉淀草稿；`bumpSkill` 改为读-改-写，`draft` 首成功转 `active`、连续失败 5 次转 `deprecated`，状态变化写演化日志 | 草稿→转正→作废全链路用例；单步工具不沉淀 |
| 3 | §4.6 反射 `tool_call` 绕过安全检查 | `reflexMatch` 内对 `tool_call` 先做安全判定，档位 ≥2 直接不命中并 `warn` | L2 下返回 `null`，L0 下正常命中 |
| 4 | §10.1 L2 只拦资产，工具仍可调 | 宿主新增 `ToolGate`：档位 ≥2 时写类工具（`desktop_input`、`vpet_control` 的 animate/move）抛"已被安全降级暂停"，只读工具放行；注入同时过滤掉高情绪记忆 | 中性记忆保留、`|pleasure|>0.2` 的记忆被过滤 |
| 5 | §7 每个 pre-step 都重复注入 | 宿主按 `(sessionId, turn)` 去重，后续 step 复用首次注入的上下文块 | 同轮 step2 返回的 messages 不再新增注入块 |
| 6 | 全文层只写不读 | 摘要层压缩（80/40 字），全文层存完整问答；命中且全文比摘要行更长时追加「摘录：…」，受 `expand_fulltext` / `fulltext_excerpt_chars` 控制 | 长文本命中后 `event_digest` 含"摘录：" |
| 7 | 惰性配置（`single_writer` / `diagnosis_labels_forbidden` / `max_match_ms` / `shared_across_*` / `scope`）读了不生效 | `single_writer` 控锁；`diagnosis_labels_forbidden` 控后置检查；`max_match_ms` 超预算告警；`scope` 与 `shared_across_*` 在启动时显式告警"仅支持/不生效" | 配置告警用例覆盖四条 |
| 8 | §6.1 禁止 `Math.random()` 被违反（事件 ID nonce） | 改为 `pid + 启动时间戳` 派生，`src` 中不再出现 `Math.random()` | 代码检索无残留 |

**本轮仍未做**（与 §16 一起作为下阶段输入）：`requiredTools` 存在性校验（宿主未暴露工具清单）、月度日志压缩归档、启动时事务重放、P9 剩余连接器。

### 14.3 桌宠弱耦合轮次（2026-11-04 v0.3 追加）

| # | 内容 | 落点 | 验证 |
| --- | --- | --- | --- |
| 1 | 身体信号通道：bridge 心跳带 `strengthPct` / `feelingPct`，`/vpet/heartbeat` 解析后交给 `syncBodySignal` | `connectors/vpet/bridge.mjs`、`host.ts` | 旧 bridge 不带字段时 `normalizeBodySignal` 返回 null，行为不变 |
| 2 | 派生有效状态：`applyBodySignal` 只对 `fatigue`/`stress` 取 max 抬升，原始 L5 落盘 | `src/runtime/body-link.ts`、`index.ts` | 端到端用例：有效疲劳 ≥0.4，落盘疲劳 <0.3，`saved.body` 为 undefined |
| 3 | 信号时效与上限：`stale_ms` / `max_influence` / 两个 weight 全部可配并做范围收敛 | `config.ts`、`config.yaml` | 过期、关闭、缺失三种情况均返回原值 |
| 4 | 反向表现：MOT 资产按 `padMatch` 的 PAD 距离自动挑动作 | `index.ts` | 两个 MOT 资产时选中更接近当前情绪的一个；无 `padMatch` 时返回 null |
| 5 | 关闭开关：`vpet.body_link.enabled=false` 时桌宠信号被忽略 | `index.ts` | 关闭后疲劳保持基准值 |

测试 87 → **94 项**（新增 `tests/body-link.test.ts` 7 项）；§14.4 自检修复后为 95 项；2026-11-05 移除语音通道（`voice.ts` / `voice-settings.ts` / 2 个测试文件 / `/star-map/voice` 端点）后为 **85 项**。

### 14.4 适配性 / 联动性自检（`npm run check:link`）

不依赖真实桌宠与真实宿主，用临时目录 + 临时端口（`DSH_DAUGHTER_BRIDGE_PORT`）跑一遍「旧数据能不能读、旧连接器能不能连、链路通不通」，输出 PASS / WARN / FAIL，有 FAIL 时退出码 1。当前 **18 项全绿**（PASS 18 / WARN 0 / FAIL 0，2026-11-05 复核）。

> 其中「`dist` 是否比源码新」一项在 `dist` 落后时会报 WARN 而不是 FAIL；先 `npm run build` 再跑自检才是全绿状态，否则会是 PASS 17 / WARN 1。

自检默认端口为 **47912**，与插件在 DSH 里真实监听的 47612 分开：两者共用时会连到正在运行的应用实例，读到的是那边残留的队列（表现为 `thinking` 缺失、`reply` 缺失、体力疲劳不抬升），而不是自检自己造的数据。脚本先把端口写进 `DSH_DAUGHTER_BRIDGE_PORT`，再动态 import 宿主模块，保证「自检连的端口」与「自检起的端口」是同一个。

| 组 | 检查项 | 判定口径 |
| --- | --- | --- |
| 适配 | 旧版 `config.yaml`（无 `vpet` / 新检索字段） | 能加载，旧值生效、新值取默认 |
| 适配 | 非法 / 未支持配置 | 5 条告警（`storage.backend` / `desktop.enabled` 的"已忽略"提示算在内），`max_influence` 收敛到 1、`stale_ms` 收敛到 30s |
| 适配 | 旧 L5 快照（无 `body`） | 读得回，不凭空补字段 |
| 适配 | 旧 bridge 心跳（无体力/心情） | 不产生身体信号，状态不变 |
| 适配 | `dist` 与 `src` 新旧 | 落后于源码时给 WARN |
| 适配 | 旧版 MOD（不带 `since`） | 一次性领取后游标前进，`/vpet/say` 可用 |
| 适配 | 旧格式 `rules.yaml`（缺 `enabled`/`priority`/`cooldownMs`） | 补齐默认值后正常命中 |
| 适配 | 打包产物 | `apply`/`inject` 存在；`cordis.patch.yml` 引用与 `files` 里的 8 个发布资源齐全 |
| 联动 | 桥接端点 | `/health` 可用 |
| 联动 | 用户消息 → `thinking` | 事件入队且 kind 正确 |
| 联动 | 回复 → 落盘 + `reply` + ack 裁剪 | 事件可检索、ack 后 `pending=0` |
| 联动 | 体力 5% → 有效疲劳 0.85 → `Sleep` | body 通道 → L5 → 表现全链闭合 |
| 联动 | MOD 忙 / 玩家交互 | 本轮不下发 `motion` |
| 联动 | `vpet_control` | 非法 graph 返回 400，合法动作入队 |
| 联动 | `/connectors/<source>/ingest` | 合法来源写入，非法来源 404 |
| 联动 | 星图与指标 | 节点/边/星系非空，`turns > 0` |
| 联动 | MOT 按 PAD 选动作 | 低愉悦选中负向动作 |
| 联动 | `/vpet/status` 独立性 | 无 MOD 上报时仍返回在线判定，不报错 |

> 该自检顺带发现并修掉一个真实兼容问题：`loadReflexRules` 直接透传 YAML，旧规则缺 `enabled` 时被 `if (!rule.enabled)` 判为停用，整份旧规则文件等于失效。现已在加载时归一化（默认 `enabled: true`、`priority: 0`、`cooldownMs: 0`），并加了回归用例。

### 14.5 认知滤网轮次（2026-11-05 v0.4）

起因：评估发现真实库 659 条事件里 **557 条是"电脑前台切换"**，情绪方差接近 0，`emotion_history` 0 行。先解决"记忆被垃圾淹没"，其余（情绪标定、恢复机制）另行处理。

| # | 内容 | 落点 | 验证 |
| --- | --- | --- | --- |
| 1 | 显著性模型（情绪 0.34 / 新颖 0.28 / 社交 0.24 / 信息 0.14，乘来源可信度） | `src/runtime/filter.ts` | 真人对话显著性显著高于系统噪声 |
| 2 | 四类决策：shield / drop / merge / keep，写入前统一裁决 | `filter.ts` + `index.ts#ingest` | 12 项单测；屏蔽、重复、低显著、关闭开关全覆盖 |
| 3 | 习惯化签名（数字与单位归一化，含 24 字截断的 `#…`） | `filter.ts#eventSignature` | "涨到 58410547" 与 "涨到 5.8 万亿" 视为同题 |
| 4 | 检索降权：最终分 × 来源可信度 | `memory.ts#retrieveEvents` | 同语义下 chat 排在 system 之前 |
| 5 | 忘却扫描（低显著 + 未召回 + 闲置）并入 tick | `maintenance.ts#runTick` | `forgotten` 计数 + 归档落盘 |
| 6 | 老库补列 `salience` / `merged_count`（原地 ALTER） | `store.ts#migrateFilterColumns` | 旧库打开不报错，`salience` 缺省不参与忘却 |
| 7 | 存量清理脚本 `npm run filter:sweep`（默认 dry-run） | `scripts/filter-sweep.ts` | 首轮 659 → 归档 470（system 431 / game 38 / chat 1），剩 189，全部为同题压缩、忘却 0 条；二次运行幂等。后续 `tick` 忘却再归档 126 条，现活跃 64（见 §14.7 复核表） |
| 8 | 面板展示滤网统计（放行/合并/丢弃/屏蔽/忘却/平均显著性） | `panels.ts#storageGroup` | 面板用例断言 key 与数值 |

测试 85 → **97 项**（新增 `tests/filter.test.ts` 12 项）。

---

### 14.6 星图观感轮次（2026-11-05）

起因：平面星图里 `134 节点 / 1318 边` 已经挤成一团，鼠标必须点开才知道一颗星是什么；滚轮缩放固定在画布原点，越放越偏；整体缺少纵深。

| # | 内容 | 落点 | 验证 |
| --- | --- | --- | --- |
| 1 | 悬停即出概要浮层（类型徽标 + 星系 + 两三条关键字段 + "点击查看完整信息"），点击才展开右侧详情 | `web/star-map/index.html#showTip` | 认知维度与情景记忆节点实测：浮层字段正确，详情面板未提前打开 |
| 2 | 滚轮缩放锚定鼠标位置（`k' = k·f`，`t' = m − (m − t)·k'/k`） | `#zoomAt` | 锚点 (1149,395) 放大到 1.33 倍后，同一节点仍在 (1149,395) |
| 3 | 3D：星系排成倾斜星环、星团内斐波那契球分布、透视投影 + 深度雾化 + 星点光晕贴图、画家算法排序 | `#project` / `#draw` | 拖动改变 yaw/pitch 可旋转；远处节点更小更暗；1318 条边透明度降到 0.03–0.10 不再糊住星团 |
| 4 | 拖拽旋转以鼠标按下处为轴心（按在星上绕那颗星转，按在空白绕该位置的虚拟点转），平移走 Shift / 右键，双击与按钮复位 | 交互段 + `#unproject` | 按住空白点 (380,700) 拖拽、`yaw` 变化 −0.84 后，该点仍在 (380,700)；按住人物星 `person:user` 拖拽，该星漂移 0 像素 |

实现取舍：不引 three.js 或 CDN，用 Canvas 2D 手写投影（`FOCAL=1120`、`CAM_DIST=1180`），保证插件在离线环境也能打开；星点用预渲染的 64px 径向渐变贴图 `drawImage` 缩放，223 节点 + 1318 边仍可流畅重绘。

旋转以鼠标为中心的两种支点：命中星点时直接用该星的世界坐标（转起来就是绕这颗星），否则把屏幕点反投影到「过屏幕中心、垂直于视线」的平面取一个虚拟点。每帧旋转后重新投影支点，再把 `view.tx/ty` 补回按下时的屏幕位置，所以支点在拖动过程中零漂移；代价是场景会绕支点整体偏移，配「复位视角」兜底。

**视觉编码（2026-11-05 补）**：星图不再只靠位置和大小传信息，四条通道各管一件事——

| 通道 | 映射 | 为什么 |
| --- | --- | --- |
| 大小 | `权重 × (0.45 + 0.55 × 显著性) + 被想起次数` | 只看权重会把「前台切换」这类系统事件画成一等大星；乘显著性后噪声先缩小 |
| 色温 | 情绪色相固定（正面 28° 橙 / 负面 210° 蓝），**饱和度**表示强度 | 中性蓝与暖橙是互补色，直接 RGB 插值会经过灰；固定色相只调饱和度才不会发灰 |
| 线条粗细 | 关联强度（三档） | 原来所有边一样细，看不出哪条连接更结实 |
| 不透明度 | 显著性 + 深度雾化 | 低价值记忆退到背景，不抢注意力 |

配套三条信息展示：

- **顶栏**加「已遗忘 N 条」——星图上只画活跃事件，归档掉的那部分只能靠这个数字感知
- **侧栏新增「记忆与滤网」组**：活跃 / 已遗忘 / 平均显著性 / 同题合并 / 累计召回 / 从未被想起 / 最大出度 / 滤网放行·合并·丢弃
- **事件详情补字段**：被想起次数、写入显著性、同题合并次数、距今多少天
- **悬停邻域高亮**：悬停时把不相连的星和线压暗到 30%，比只加描边更容易读出「它和谁连着」

图例固定右下，说明大小 / 色温 / 线条 / 大星 / 纵深分别代表什么——此前星图没有任何图例，大小和颜色是纯装饰。

**时间轴**：情景记忆的 `z` 坐标按「距今多少天」分层，新记忆浮在前面、旧记忆沉到深处，球体自身的 z 散布压到 0.55 给时间让位。满量程取 `max(7, 最老记忆天数)`——真实库里的记忆常集中在最近两三天，用固定 30 天做分母会把整条轴压平（实测跨度只有 8 个单位，肉眼看不出来）。侧视（pitch 接近 0）加旋转时能看出时间梯度。

**检索**：顶栏输入框按「标题 / 标签 / 类型 / 星系名」做子串匹配，命中集合之外压暗到 28%；命中 ≤ 40 条时补一圈金色描边并显示条数，越多就不描边（否则满屏金圈）。Esc 清空。搜索的优先级高于悬停高亮，避免两者互相打架。插件面板通常只有 600~900px 宽，窄屏下压缩的是时间戳与图例，**搜索框必须保留**（最初按 1120px 隐藏，导致面板里根本看不到）。

**遗忘区**：归档事件的 `id` 与时间随星图一起输出（取最近 240 条），前端用稳定哈希把它散在海马体星团外围当暗尘，越老越淡。不是装饰——它让「忘掉过多少」在图上有一块可见的体积，而不再只是侧栏一个数字。

**关系网**：两个人物只要共同参与过事件就建一条 `person` 边，强度随共现次数上升。真实库里这条边通常只有「我↔你」一条，但这恰好说明当前记忆里只有一段关系；人物变多时会自然长成网。

**会话走势**：每个 L5 会话的末态（安全 / 压力 / 疲劳）连成折线，y 轴按实际取值范围自适应——固定 0~1 会把 0.72~1.0 的波动压平到看不见。

页面是纯前端静态资源，本轮不新增单测，测试基线保持 97 项；验证方式为本地起静态服务 + 浏览器实测三项交互。

---

### 14.7 记忆与情感闭环修复轮次（2026-11-05）

评估报告里的 ③④⑤ 挂账、以及「重构 0 次」的根因，本轮一起处理。

| # | 问题 | 改法 | 实测 |
| --- | --- | --- | --- |
| 1 | 情绪方差趋零（评估 ②）：192 条事件里 181 条强度 <0.2，`pleasure` 全为正 | 单字词（好/累/烦…）权重降到 0.35，新增 `sentimentStrength` 强度系数，`PAD_GAIN` 0.16 → 0.3，`pleasure += polarity × strength × gain` | 6 轮混合对话：`pleasure` 从 −0.171 到 +0.184（此前均值绝对值 0.135 且无负值） |
| 2 | 回忆重构从未触发：`emotion_history` 0 行 | 距离阈值 0.15 → 0.08。`padDistance` 满量程是 **1.0**（三维各差 /2、求和再 /3），0.08 等价于**平均每维差 0.16**；早期注释把满量程误记成 0.5，导致这个门槛被误判成"宽松"。已提为 `retrieval.reconstruct_distance` | 真实库副本 6 轮 → 2 条；**2026-11-06 真实库 55 条事件 → 24 行**（p50 0.039 / p90 0.136，27.6% 事件对过线），阈值可达，不再是"待复测" |
| 3 | 情感只增不减（评估 ③）：`safety` 贴 1.00、`stress` 贴 0.00 后不再有信息量 | 新增 `emotion_relax` 配置与 `relaxL5()`：按闲置小时数复利向基线回归，`lastTickAt` 不被回落刷新 | 闲置 6 小时：`safety` .580→.618、`stress` .440→.364、`fatigue` .302→.254 |
| 4 | L2 关系锚错对象（评估 ④）：用 `self.intimacy`（必然趋近 1.0），深度只升不降 | 目标改为 `user.intimacy × (0.55 + 0.45 × 互动质量)`，升温步长随质量变化、降温保持 0.12 | 目标函数双向可动，演化理由里带上质量分与近 7 天样本量 |
| 5 | 超级节点（评估 ⑤）：单事件 605 条出边，其中 430 条指向已归档事件 | `linkNewEvent` 出边上限 12；新增 `store.trimLinks()` 修剪存量、`store.detachLinks()` 归档摘链（传全量归档集合） | 该事件 605 → **12** 条，悬空边 430 → **0** |
| 6 | 存量事件没有显著性，面板「平均显著性」只统计 3 条 | `filter:sweep` 增加回填：按 `来源可信度 × 0.4` 写入 | 回填覆盖当时的活跃事件（192 条，现已降为 64 条活跃）；**归档的 470 条未回填，至今为 null**，不影响检索打分 |
| 7 | 同题合并口径不一致：运行时要求同源，存量脚本跨源分组 | sweep 分组 key 改为 `source + signature`，与 `decideIngest` 对齐 | 跨来源分组恒为 0，不再有把真人对话并进系统事件的风险 |
| 8 | 假开关：`storage.backend`、`desktop.enabled` 写了不生效且无提示 | 在 `warnUnsupported` 里显式告警「配置值已忽略」 | 配置里写了 ≠ 行为支持，评审不再误读 |
| 9 | `importance` 只算不用 | 改成调衰减指数 `factor^(1-importance)`：重要的事掉得慢，但仍是单调衰减、迟早能归档 | 热点事件不会被永久保活（设地板的方案已被单测否定） |
| 10 | 降级不可见：FTS 异常被静默吞掉、超预算只进 JSONL、L1 降级不裁剪联想 | `store.lastFtsError` 计入 `degraded` 并 warn；新增 `overBudgetRate` 指标与面板行；L1 起联想砍半、L2 起整块不注入 | 指标口可以从面板与 `metrics()` 读到 |

测试 97 → **103 项**（新增 `tests/emotion.test.ts` 6 项：极性/强度、连续负面推进、回落生效、闲置不动、出边上限、归档摘链；v0.5 再增至 112，见 §14.8）。

存量治理已在真实库执行：补显著性 189 条、归档 2 条、清理 656 条事件的悬空链接、修剪 1 条超级节点出度。

**2026-11-05 复核（`memory.db` 实测）**：662 条 / 活跃 **64**（chat 58、game 5、android 1）/ 归档 598；活跃最大出度 **11**、悬空边 **0**；活跃事件 `salience` 无空值（平均 0.398），归档的 470 条仍为 null——归档不参与打分，不影响检索。

同一轮复核发现四处"已修复但真实数据还没体现"的地方，写在这里避免误读：

| 项 | 现状 | 说明 |
| --- | --- | --- |
| 回忆重构 | `emotion_history` **24 行**（此前 0 行） | 2026-11-06 库重置后复测：55 条事件、两轮召回共写入 24 行（14:43–14:45，全部 `chat`）。事件两两 PAD 距离 p50 0.039 / p90 0.136 / p95 0.146，**27.6% 的事件对 ≥ 0.08**——阈值可达，只是多数召回的情绪确实没怎么变。门槛已提为 `retrieval.reconstruct_distance`，可调 |
| 情绪极性 | 活跃 64 条 `avg abs(pleasure) = 0.204`（修复前 0.11），但**负值 0 条**、强度 <0.2 仍占 53 条 | 量程确实拉开了，真实语料里还没有够强的负面表达；单字词降权 + 强度系数是否足够，要等下一批真实对话 |
| L1–L4 演化 | L1 只有 2026-11-04 一次微调；L3 `biasWeights` 仍为空；L4 `updatedAt` 仍为 `1970-01-01` | L4 的"归一化"在权重本来相等时不会产生变化，属预期；L3 偏差权重缺写入路径（见 §16 开放项） |
| 技能 / 资产 / 反射 | 真实库 0 张技能卡、0 个资产包，反射规则 3 条但命中 0 次 | 技能沉淀要求单轮 ≥2 个工具调用，真实对话多为纯聊天；反射规则的 `keyword` 与真实话术未对齐 |

### 14.8 性格多样性演化轮次（2026-11-06 v0.5）

| # | 内容 | 落点 | 验证 |
| --- | --- | --- | --- |
| 1 | 出生抽样：五维区间抽样、同角色同种子可复现，并写入 `innate` 锚点 | `createInitialL1` / `createInitialL2` / `store.loadPersona` | `personality.test.ts` 出生可复现 + 区间有界 |
| 2 | 依恋底色按 prior 抽取；混乱型不可出生 | `createInitialL2` / `deriveAttachment` | 1000 次抽样无 `disorganized` |
| 3 | 冲击分级：日常闲聊不动人格 | `scoreImpact` / `applyPersonalitySignal` | `routine` 事件不产生 L1/L2/L3 变更 |
| 4 | 通道分化：关系 / 生活转折 / 成就挫败 / 修复推动不同维度 | `classifyChannel` / `applyPersonalitySignal` | 四类文本分别命中预期维度 |
| 5 | 漂移上限与可塑性：任一大五维度不超 `innate ± 0.6` | `applyPersonalitySignal` | 极端事件后仍满足 ±0.6 |
| 6 | 修复不对称：按依恋类型打折，伤害侧放大 | `settings.repair` / `repairFactor` | 焦虑/回避的修复幅度显著低于安全型 |
| 7 | 自我叙事三轴与锁定轴 | `applyPersonalitySignal` 内 `lock` | 锁定轴只记录事实，不改写历史 |
| 8 | 人格证据链：上限 200，面板只给事实 | `makeEvidence` / `panels.ts` | 面板不输出"你是 X 型"标签 |
| 9 | 混乱型只能演化：两轮关键事件交替 + 两维同时偏高 | `applyPersonalitySignal` 的 `personality_cycles` 分支 | 单轮关键事件不会直接变成混乱型 |

验证基线：`tests/personality.test.ts` **9 项**；`npm test` 从 103 增至 **112 项全绿**，`tsc --noEmit` 无错，`check:link` 仍 PASS 18。

### 14.9 行为动机（决策层）

决策层不再用"文本相似度过 `min_main_score` 就执行"，改成两段式判定：阈值侧管"够不够力"，分数侧管"想不想走"。人格走**两条独立通路**——`trait_threshold_gain` 抬降门槛，`trait_signal_gain` 给分数乘子 `1±g`。只保留前者时，人格只能否决候选、无法决定选哪个，方向舵就是补这条边。

| # | 要点 | 代码落点 | 验证 |
| --- | --- | --- | --- |
| 1 | 阈值 = `min_main_score` + 人格偏移 + 情绪偏移，且有 `min_threshold` 下限 | `computeThreshold` | 极端人格下阈值仍 ≥ 0.05，不被压到 0 |
| 2 | 分数 = `signal` × 熟悉度 × 记忆 × 情境 × 方向舵 | `scoreSkills` | 每个因子各一条方向性用例 |
| 3 | 人格双通路：门槛与乘子分开 | `computePersonalityOffset` / `computeTraitSignalGain` | 同一句子下外向者 social 分数更高，通道排序可翻转 |
| 4 | 零信号恒不触发（短路 + 地板双保险） | `decide` 的 `silent` 分支 | `min_threshold=0` 时仍判 `avoid` |
| 5 | 熔断优先：连续失败进指数冷却，期间只 `avoid` | `isBreakerActive` / `bumpSkill` | 3 次失败 10min、4 次 20min，成功清零 |
| 6 | 全因子可审计 | `MotivationBreakdown` | 10 个因子逐项留在决策明细里，面板可复算 |

验证基线：`tests/motivation.test.ts` **14 项**；`npm test` 从 112 增至 **126 项全绿**，`tsc --noEmit` 无错，`check:link` 仍 PASS 18。

> 已知缺口：构思里的「习惯」层（线索→行为→奖励的自动化通路）尚未实现，行为仍需当轮输入提供信号；`min_threshold` 与 `trait_signal_gain` 是经验值，未经真实语料标定。

### 14.10 主动开口

没人说话时她会不会自己开口。与 §14.9 分工明确：那边要 `userText` 才能算分，这条链接的是沉默时长。

| # | 要点 | 代码落点 | 验证 |
| --- | --- | --- | --- |
| 1 | 强度与门槛分离：人格/情绪/关系/思念进 `urge`，时段/压力进 `threshold` | `computeSpeakUrge` / `computeSpeakThreshold` | 外向者 urge 更高，但 threshold 不变 |
| 2 | 思念按 `idle/(idle+180)` 饱和，不线性 | `idleUrge` | 1h → 0.25，3h → 0.5，10h → 0.77 |
| 3 | 想说但忍住会攒 `carry`，下次更容易跨线 | `evaluateSpeak` 的 `hold` 分支 | 同状态第二次评估转为 act |
| 4 | 冷却期、日上限、安静时段三重兜底 | `speakPlan` / `computeSpeakThreshold` | 冷却内与超上限均 silent，深夜不 act |
| 5 | 文案按动机分类取池，避开最近 5 句 | `pickSpeakLine` | 连续两次不出同句 |
| 6 | act 经 `SpeakSink` 数组投递，当前实现是桌宠气泡 | `dispatchSpeak` / `host.ts` 的 `speakTimer` | 时间线模拟：内向 2 次 / 外向 5 次 / 焦虑 4 次 |
| 7 | 默认关闭，必须显式开启 | `speak.enabled: false` | 出厂配置下 `evaluateSpeak` 恒为 silent |
| 8 | 看得见屏幕时按场景抬门槛（会议/游戏/写代码/其它） | `readForeground` / `foregroundBusy` | 会议时即便空闲也不 act；桥接不可用不受罚 |
| 9 | 说过的话与憋回去的话都留痕，面板只读展示 | `speak.history` / `speak.hold.<日期>` / `panels.speakGroup` | 面板「主动开口」分组可读出今天开口数与最近 5 句 |
| 10 | 刚打开开关先记锚点：`speak.lastAt` 缺失时只写 `now` 并返回 `null`，不立刻开口 | `speakPlan` 首次分支 | 首次评估返回 null，1 分钟后仍在冷却，70 分钟后才进入决策 |
| 11 | 参数按真实库标定为"活跃档" | `config.yaml` / `defaultConfig.speak` | 见下方频率估算 |

**活跃档的参数与频率**（2026-11-06 调）

`min_idle_min` 45→**25**、`idle_half_min` 180→**120**、`threshold` 0.62→**0.52**、`refractory_min` 90→**60**、`max_per_day` 5→**8**；`busy_penalty` 保持 **0.25**。

按真实 L5（`pleasure 0.059 / arousal 0.469 / fatigue 0.374 / stress 0 / safety 1.0`，人格 `E 0.489 / A 0.580 / N 0.849`，`depth 0.093`）估算，固定项约 **−0.035**，于是：

| 场景 | 门槛 | 开始"憋" | 首次开口 |
| --- | --- | --- | --- |
| 空闲（busy 0.15） | 0.5575 | 约 137 分钟 | 约 **2.5 小时** |
| 写代码（busy 0.4） | 0.62 | 约 171 分钟 | 约 **3 小时** |
| 会议（busy 0.85） | 0.7325 | 约 263 分钟 | 基本不开口 |

`busy_penalty` 不能一起调小：沉默够久时 `carry` 会把 `urge` 顶到任何门槛之上，会议场景会失守（实测 0.15 时 10 小时沉默即可突破会议门槛）。

> 旧参数下的对照：空闲需沉默约 6.7 小时、写代码约 24 小时，`relationshipUrge` 又是负贡献，实际等于"装了个哑巴"。

验证基线：`tests/speak.test.ts` **20 项**；`npm test` 203 项全绿，`check:link` 仍 PASS 18。

> 已知缺口：文案是模板不是模型生成；出口虽已抽象成 `SpeakSink`，但现成实现只能投桌宠气泡——插件无宿主会话写入权限，消息进不了聊天记录；`idle_half_min` / `threshold` / `max_per_day` 已按真实 L5 估算标定（活跃档），仍缺长期使用观察——太吵就往回加 `min_idle_min` 与 `threshold`。

---

## 15. 风险与开放问题

| 编号 | 类型 | 描述 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| R-01 | 技术 | 无向量库时语义检索退化 | 召回质量不足 | 先 BM25，P2 后再评 embedding |
| R-02 | 技术 | 单写者在多进程场景下成瓶颈 | 写入延迟 | 文件锁 + 队列；必要时改用 SQLite WAL |
| R-03 | 产品 | 记忆注入过多导致"人格被记忆淹没" | 体验变差 | 硬预算 + 人格块优先级最高 |
| R-04 | 安全 | 用户诱导编造往事 | 破坏"不假装记得" | 冷启动硬约束 + 输出侧检查 |
| R-05 | 安全 | 情绪状态被误读为诊断 | 伦理风险 | 词表禁用 + 只记录维度 |
| R-06 | 兼容 | 外部插件工具名变更 | 技能失效 | 加载时校验 `required_tools`，缺失降级 |
| R-07 | 隐私 | 跨工作区共享记忆 | 数据外泄风险 | 角色级显式授权 + 记忆可见性标记 ⚑ |
| R-08 | 质量 | 情绪识别仍是 22 词表（正负各 11 条）+ 命中数差，无否定/程度/对象处理 | 真实语料负面极性恒为 0，情绪臂区分度不足 | 扩词表或改模型打标（评估文档 §5 第 8 条） |
| R-09 | 验证 | 2026-11-05 的修复只在单测与库副本上验证 | 效果无法用真实数据确认 | **已复测（2026-11-06）**：55 条事件 / `emotion_history` 24 行；抖音内容 23 条（42%）成为新噪声源，由 `filter.burst` 抑制；极性仍全正（`pleasure` 0.059–0.232），负面表达样本不足 |
| R-10 | 设计口径 | v0.5 性格冲击路径单次 Δ 可超过旧 0.02 约束，且不经过 20 轮间隔 | 新旧约束并存，读者易误判 | 已在 §4.2 明确双路径；若要求绝对 0.02，需要改 `applyPersonalitySignal` |

⚑ **待拍板决策点**

| 编号 | 决策 | 选项 | 本文建议 | 落地状态（2026-11-06 复核） |
| --- | --- | --- | --- | --- |
| D-01 | 存储作用域 | character / session / workspace | character | 已落地：`Store` 按 `characterId` 缓存，共用同一 `data_root`，跨会话/跨工作区可读（测试覆盖）；v0.3 起 `single_writer: true` 真正生效——写锁 + 原子写 + 技能读-改-写（见 §5.3），并发累计不再丢计数 |
| D-02 | 存储后端 | SQLite / JSONL | SQLite（FTS5） | 已落地：事件/回看历史/meta 走 SQLite；`events_fts`（FTS5 外部内容表 + 增删改触发器，trigram 分词）参与检索打分，Dice 作为短查询兜底；全文另存 JSONL 单文件 |
| D-03 | 打分权重与是否引入 embedding | 固定权重 / 回归调参 / 加向量 | 先固定权重 | 已落地：`retrieval.score_weights` 固定，语义分 = max(FTS5 trigram 命中, Dice)，无 embedding |
| D-04 | 星图形态 | 静态产物 / 在线服务 | 在线只读服务（`/star-map/` + 侧边栏面板） | 已落地：`/star-map` 页面 + `/star-map/api` 实时数据 + `webServer` 只读挂载 |
| D-05 | 注入块格式是否对外可配置 | 固定模板 / 模板可配 | 固定，先稳定再开放 | 已落地：`buildBlocks` 硬编码模板与配额，无对外配置项 |
| D-06 | L1 写回约束 | 双路径（日常 0.02 / 事件冲击受 `drift_cap` 约束）/ 全部收口到 0.02 | 双路径 | 已按双路径实现（§4.2 / §4.8）；若评审要求绝对 0.02，需改 `applyPersonalitySignal` |

---

## 16. 评审清单

- [x] v0.3 加固项已核对（§14.2 八项 + §14.3 桌宠弱耦合 + 移除语音，测试 85 项全绿）
- [x] 认知滤网已落地并回填存量（§8.5 / §14.5；2026-11-05 时真实库 662 条：活跃 64、归档 598，含后续忘却 126；2026-11-06 库已重置，待复测）
- [x] 星图观感优化已落地（§14.6，悬停概要 / 鼠标锚点缩放 / 3D 透视，三项交互实测通过）
- [x] 记忆与情感闭环已修复（§14.7，当时测试 103 项全绿：情绪量程、回忆重构、情感回落、L2 锚点、超级节点、存量显著性、同题口径）
- [x] 性格多样性演化已落地（§4.8 / §14.8，`tests/personality.test.ts` 9 项）
- [x] 行为动机已落地（§14.9，`tests/motivation.test.ts` 14 项；人格双通路 + 零信号收口）
- [x] 主动开口已落地（§14.10，`tests/speak.test.ts` 20 项；思念饱和 + 欲言又止 + 三重兜底 + 出口抽象 + 桌面场景感知 + 首次开启锚点；**代码默认仍为关闭，本机 `config.yaml` 已显式开启并调为活跃档**，当前 `npm test` 203 项全绿）
- [x] 适配性 / 联动性自检 18 项全绿（§14.4，`npm run check:link`：PASS 18 / WARN 0 / FAIL 0，需先 `npm run build`）
- [x] 真实数据复测：`emotion_history` **24 行 / 55 条事件**（2026-11-06）；负面极性仍为 0，待更强负面语料
- [ ] L3 认知偏差权重 / 应对策略的写入路径（当前只有 `defenseMaturity` 会变，`biasWeights` / `copingStrategies` 仅被归一化，无新增条目）
- [ ] G1–G5 验收标准可测，且不依赖人工主观判断的部分已明确
- [x] D-01 ~ D-06 已拍板（落地状态见 §15 决策表）
- [x] L1 写回约束已明确（§4.2 双路径：日常微调 Δ≤0.02 / 20 轮；事件冲击受 `innate ± drift_cap` 约束，D-06）
- [ ] 检索打分权重已确认或标记为可调
- [ ] 预算分配表已确认（persona 300 / event 1400 / total 3000）
- [ ] 安全三档阈值与滞回带已确认
- [ ] 事件字段完整性（`emotion_at_time` 不可覆盖、归档不删除）
- [ ] 反射引擎的短路行为已被接受（命中后跳过检索）
- [ ] 资产固化与回退规则已确认
- [ ] 跨工作区共享的隐私边界已确认
- [ ] 脑区化目录与对外接口命名映射表已确认
- [ ] 外部连接矩阵中的工具名已核对存在性
- [ ] 冷启动注入文案已定稿

---

## 附录 A：冷启动注入示例（完整）

```text
[人格]
你是一个有稳定底色、但还在认识对方的存在。说话偏安静，先观察再回应，
不主动夸张表达。对爸爸会更放松一些，对陌生人更克制。

[当前状态]
情绪偏平静，略有好奇，安全感中等。

[技能]
（无可用技能）

[无记忆约束]
当前没有任何与用户相关的共同经历记录。
禁止编造"上次你说过""我们之前"等具体往事。
你可以表达性格与当前状态，但不得声称记得未记录的事。
```

## 附录 B：单轮 token 预算示例

| 块 | 实际 tokens | 是否保留 |
| --- | --- | --- |
| constraint | 96 | 必留 |
| persona | 280 | 必留 |
| state_hint | 110 | 必留 |
| event_digest（4 条） | 980 | 保留 |
| skill_digest（1 条） | 210 | 保留 |
| association（1 条） | 140 | 保留 |
| **合计** | **1816** | 未超 3000 |

若合计超限：先丢 association → 再丢最低分事件 → 再压技能为单行 → 仍超则减 `top_k`。
