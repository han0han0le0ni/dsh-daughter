# dsh-daughter 遗留缺陷与优化路径

- 基线：2026-11-07，`npm test` **211 项全绿**、`check:link` **PASS 19**、`tsc --noEmit` 无错、`memory:doctor` **13 项 0 错误**
- 真实库：57 条事件（chat 34 / douyin_content 23）、回看记录 25 行、演化日志 8 条
- 配套材料：`docs/dsh-daughter-评测-第1~4轮.md`（逐轮核对过程与数据）

本文只列**当前仍然存在**的问题。已修项见第 1 节，作为变更记录保留。

---

## 1. 本代已修（2026-11-06 至 11-07）

| 项 | 修法 | 验证 |
| --- | --- | --- |
| 记忆被单向来源淹没 | `filter.burst` 同源爆发抑制（60 min / 3 条，`chat/qq/douyin_dm` 豁免） | 真实库 `filter.drop = 13` |
| 回忆重构从不触发 | `retrieval.reconstruct_distance` 可配（0.08，附真实分布 p50 0.04 / p90 0.14 标定） | 真实库 0 → 25 行 |
| 回看记录批量爆发 | 每轮只写位移最大一条 + 同事件 6h 冷却（可配） | 新代码后单轮只写 1 条 |
| 换对话框断片 | 首轮续接恒占一个槽位（最近 1–3 条 / 7 天内），不再被字面命中挤掉；L5 情绪按 `shared_across_*` 接力 | §8.2 已记录 |
| 联想退化为随机游走 | 边按 strength 降序遍历、弱边 <0.2 跳过、多路径残值累加、带 `path/depth` | 单测覆盖 |
| 语义为 0 也算"相关记忆" | `retrieval.min_semantic` 门禁 + 单字弱命中 | `association.test.ts` |
| 单向输入被记成"共同经历" | `participantsFor()` 按来源推导 | 存量 23 条已迁移 |
| 演化日志 ID 撞号 | 改成当天序号（读库中最大号 +1） | 8 条旧日志 5 唯一，新写入顺序化 |
| 关系 32 轮不动 | 24h 或累计 8 轮先到先跑，步长乘 `cling` | 单测覆盖，真实数据待 tick |
| 情绪只有 22 词且看不见否定 | 正向 19 / 负向 30 + 否定词翻转 + 程度分母保护 | 离线 10 样例 9 中 |
| `Math.random()` 破坏可复现 | speak 抖动改 `createRng(hashText(角色:分钟))` | `src` 中已清零 |
| FTS 触发器过宽 | 收窄为 `UPDATE OF title, summary, tags` | 减少每次权重衰减的索引重写 |
| 数据一致性无自查 | `npm run memory:doctor`（13 项，只读；`--fix` 才动手） | 当前 0 错误 |
| 无法重置 | `npm run reset`（memory / personality / reflex / skills / all，dry-run + 备份 + 回收站） | 7 项单测 |
| **桥接端点无认证**（更高危） | 47612 / 47614 / 47613 全部要求 `x-dsh-token`，常量时间比较；浏览器来源 403；令牌不可用 503；连接器无令牌拒绝启动；`/health` 只回 `{ ok, auth }`；`desktop.enabled` 默认关闭 | `tests/connector-auth.test.ts` 8 项 + 自检 19 项；MOD 与独立壳已重编译 |

---

## 2. 遗留缺陷

严重度：**P1** 影响真实性或可追溯性 · **P2** 影响有效性 · **P3** 体验与工程债。

| 编号 | 严重度 | 问题 | 现状 / 证据 | 建议 |
| --- | --- | --- | --- | --- |
| DEF-01 | **P1** | 情绪极性饱和 | `polarity = (pos−neg)/max(1,pos+neg)`，只要一侧为 0 就必然 ∓1。离线 10 个样例里 **6 个打到 ±1.000**，"有点烦"与"崩溃"不可区分 → `emotion_match` 仍是分段常数 | 改分级：按命中数与程度词（有点/挺/特别/太）输出连续值。验收：不再出现 6 条打满，"有点烦"≈−0.2、"崩溃"≈−0.9 |
| DEF-02 | **P1** | 极性缺时间序列 | 所有"负面不够"的判断只能靠离线复算；无 `logs/polarity/*.jsonl` | 每轮记 `polarity / strength / 命中词`，两周后看分布再定阈值 |
| DEF-03 | **P1** | 关系推进新逻辑未被真实数据验证 | `lastPersonaEvolveAt` 仍为 05:14Z、`lastTickAt` 13:25Z，均早于改动；L2 仍 `stranger / 0.093` | 下一次 `tick` 后确认 depth 是否跨 0.15；若 8 轮触发不生效，查 `personaTurns` 基线 |
| DEF-04 | **P1** | 文档 R-08 与代码矛盾 | `design.md` 仍写"情绪识别仍是 22 词表…无否定/程度"，实际已 19/30 + 否定处理 | 改写为"已扩表 + 否定处理，仍缺程度与对象" |
| DEF-05 | P2 | P9 计数不一致 | `design.md` 两处写 3/7，README 与实现为 4/7（抖音只读已接通） | 统一为 4/7，并在 §12 补 `douyin-link` 只读通道 |
| DEF-06 | P2 | 抖音存量 23 条仍在 | 爆发抑制只拦新写入；存量占 40%，`pleasure` 恒 0.098、召回 4 次 | 跑 `npm run filter:sweep`（同题压缩 + 低价值忘却） |
| DEF-07 | P2 | 旧回看记录未去重 | 旧代码一轮写多条的 24 条仍占满 `emotionNowHistory`（单事件上限 8） | `filter:sweep` 增加"同事件同小时只留位移最大一条" |
| DEF-08 | P2 | L3 认知层只有一半在动 | `biasWeights` / `copingStrategies` 无新增写入路径，只有 `defenseMaturity` 与叙事三轴会变 | 从冲突事件、反复出现的应对方式里沉淀条目 |
| DEF-09 | P2 | 记忆冲突无写入 | `EventLink.kind` 有 `contradiction` 枚举，无写入与展示 | 新旧事件矛盾时双向标记，不覆盖事实 |
| DEF-10 | P2 | 出生区间不覆盖非抽样入口 | 当前存档 O 0.86 / C 0.82 超出 `personality.initial.ranges`（手改 YAML 所致，`.bak` 为 0.559 / 0.40） | 启动时校验越界并告警（像 config 那样），或在 `--fix` 里夹回 |
| DEF-11 | P3 | `plasticity` 语义未定 | 当前 `plasticity 0.65 > plasticityBase 0.35`，与"随经历衰减"方向相反 | 明确写成注释：基准是下限还是起点 |
| DEF-12 | P3 | 历史演化日志撞号保留 | 2 组（`99e1`×3、`da3a`×2）；`memory:doctor` 已按时间分界只说明不告警 | 按"只追加不重写"处理，不回溯修改 |
| DEF-13 | P3 | 注入模板不可配 | `buildBlocks` 硬编码（D-05 决策） | 稳定后再开放，先不动 |
| DEF-14 | P3 | `requiredTools` 无法加载时校验 | 宿主未暴露工具清单 | 等 `tools.list()` |
| DEF-15 | P3 | 图结构缺长边衰减与定期重建 | 只做了出边上限 12 与归档摘链 | 连接强度随时间衰减，季度重建 |
| DEF-16 | P3 | 月度日志压缩归档未做 | 仅按 `log_retention_days` 逐条裁剪 | 与演化日志按月切片一起做 |
| DEF-17 | P3 | P9 剩余三个连接器 | QQ / Minecraft / 单机待适配器 | 可先走 `/connectors/<source>/ingest` |
| DEF-18 | P3 | 主动开口与动机层无真实标定 | `speak.enabled` 默认关闭；`motivation.*` 经验值 | 跑影子模式（只记录不投递）两周再定阈值 |
| DEF-19 | P3 | 令牌以明文落盘 | `brain/brainstem/connector_token` 0600（POSIX）／同用户可读（Windows ACL 未收紧） | 本机威胁模型下的合理取舍；文档写明"同机同账户可读"，建议随版本轮换 |
| DEF-20 | P3 | 认证失败无速率限制与审计 | 只记一条 warn（浏览器来源），401 次数未进 metrics | 401/403 计数进 `metrics.jsonl`，连续失败 ≥10 次打印一次汇总 |
| DEF-21 | P3 | `/health` 收敛后外部监控能力下降 | 只回 `{ ok, auth }`，不再给队列/在线状态 | 确需监控时带令牌读 `/vpet/status`；不要把队列信息放回 `/health` |

---

## 3. 优化路径

**第一条：让情绪真的动起来（DEF-01 + DEF-02）**

情感臂是四轮评测里唯一没有实质进展的臂。词表已够用（离线验证 9/10），真正卡住的是**极性只有符号、没有幅度**，以及**看不到分布**。顺序：先做分级 → 再上 `logs/polarity` → 两周后再决定是否需要模型打标。不要跳过第二步直接调 `PAD_GAIN`，那只会把常数放大。

**第二条：把"已实现"变成"已验证"（DEF-03 + DEF-06 + DEF-07）**

关系推进、抖音存量、回看去重都是"代码好了、数据还没跟上"。建议做一次 `tick` + `filter:sweep` 的组合验证，并把结果写回设计文档 §14 的实测列。

**第三条：文档一致性（DEF-04 + DEF-05）**

这两条都是纯文字工作，但会直接误导下一个读文档的人（R-08 说没有否定处理，实际有；P9 说 3/7，实际 4/7）。建议把"测试数 / P9 计数 / 词表规模"三个数字交给脚本生成，避免每轮手工同步。

---

## 4. 复现方式

```bash
npm install
npm run build          # 改了 src 必须重建，仓库里带 dist
npm test               # 203 项
npm run check:link     # 18 项适配性 / 联动性自检
npm run memory:doctor  # 13 项数据体检（默认只读，--fix 才动手）
npm run reset -- --help
```

四轮评测的过程数据（事件数、极性分布、日志撞号、体检输出）都在 `docs/dsh-daughter-评测-第1~4轮.md` 里，可据此复算。
