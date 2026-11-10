# dsh-daughter v0.7.1 更新公告

- 发布日期：2026-11-10
- npm：`dsh-daughter@0.7.1`（latest）
- 源码提交：`8fdca6bbd756db3180e781385de367e4b882358a`
- 对比基线：`v0.7.0`

## 新增

- **情感派生改造（DEF-01）**：命中词先按程度分档（有点 / 挺 / 很 / 特别 / 太），再转成 PAD 增量并回算极性；不再单侧命中就饱和到 ±1。`有点烦` ≈ −0.2，`崩溃` ≈ −0.9。
- **记忆冲突（DEF-09）**：同主题、相反极性且差 ≥ 0.4 的事件建立双向 `contradiction` 链接；不覆盖事实，联想块与星图详情并列展示「两种说法」。
- **技能影子池（DEF-19）**：候选技能与在用版本并行记账；样本 ≥ 10、胜率 ≥ 0.6、领先 ≥ 0.1 才转正；转正前写入 `previous` 快照，支持按字段回滚。
- **think 通道（DEF-23）**：`ExpressionKind` 扩展为 `speak | think`；碎碎念不写事件、不占正式回复，默认每轮 ≤2 条、≤40 字、最短间隔 20 分钟。
- **L3 证据表（DEF-08）**：每批新事件先写证据，同向累计 3 次才动 `defenseMaturity`，不随单次事件改权重。
- **speak 影子（DEF-18）**：开启 `speak.shadow` 后只评估不投递、不写冷却/计数；`speak.stats` 按日聚合 `act/hold/silent`。
- **连接器清单（DEF-03）**：适配器用 `connectors/<source>/connector.json` 声明协议版本；核心只认 `CONNECTOR_PROTOCOL = 1`，未知来源与协议不符会摘出白名单。
- **文档数字同步（A3）**：`npm run docs:sync` 渲染文档里的 `<!--docsync:key-->` 标记，`check:link` 新增第 22 项。
- **重放脚本（B3）**：`npm run polarity:replay` 支持日志与历史事件两种模式。

## 修复

- 程度词「特别」里的「别」被当成否定，导致「特别开心」判成负面。
- 「靠不靠谱」这类 X 不 X 反问被当成「否定 + 正面词」，整句落到 −0.9；现在反问两端都不算命中。

## 验证

| 项 | 结果 |
|---|---|
| `npm test` | **299/299** |
| `npm run typecheck` | 0 错 |
| `npm run build` | 通过 |
| `npm run check:link` | **PASS 22 / WARN 0 / FAIL 0** |
| `npm run docs:sync -- --check` | 通过 |
| `npm run memory:doctor` | 0 错 0 警 |
| 真实库重放（112 条） | 复算负 5 / 中性 68 / 正 39；入库负 0 / 中性 21 / 正 91 |

## 升级

- 市场内更新到 `0.7.1`；
- 或 `npm i dsh-daughter@0.7.1`；
- 从 `0.7.0` 直接升级即可；`0.6.5` 用户可一跳升级到 `0.7.1`（已包含 0.6.6 / 0.6.7 全部改动）。

## 已知限制

- 星图冲突并列已做，真实库冲突误报率尚未抽样评估。
- `think` 目前是模板池，未接模型生成。
- L3 只做到证据 → `defenseMaturity`；`biasWeights` / `copingStrategies` 权重更新后置。
- 技能 SHA-256 内容寻址账本后置；当前是一级快照回滚。
- 长文本里单个负向词仍可能拉低整条，属于关键词法的上限。
