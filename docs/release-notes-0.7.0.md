# dsh-daughter v0.7.0 更新公告

- 发布日期：2026-11-10
- npm：`dsh-daughter@0.7.0`（latest）
- 仓库：https://github.com/han0han0le0ni/dsh-daughter
- 对比基线：`v0.6.5`

## 新增

- **情绪识别日志层（A1）**：每轮把情绪识别明细追加到 `logs/polarity/<角色>.jsonl`，包含命中词、否定词、`polarity`、`strength`、`padDelta`、`padAfter`；文本只存 SHA-256 前 16 位，不存原文。
- 单文件超过 2MB 自动轮转为 `.1.jsonl`；`tick` 按 `retention_days` 裁剪。
- 新配置：

```yaml
polarity_log:
  enabled: true
  retention_days: 90
  include_text_hash: true
```

`analyzeSentiment` 与 `sentimentPolarity` / `sentimentStrength` 输出逐条一致，**不改变现有情绪判断与打分**。

## 优化（0.6.7）

- **FTS 池外合并**：FTS 命中但不在权重候选池里的事件也会放行，上限 `retrieval.fts_merge_max: 200`；FTS 查询上限与 `max_candidates` 解耦。
- **主动开口写回**：`self_speech` 低权入库（`weight=0.3`、`participants=['self']`），可被召回，不进「局」，不推关系。
- **回看去重**：`filter:sweep` 对同事件同小时只保留 PAD 位移最大一条。
- **长边降权**：`tick` 对超过 30 天未召回事件的边每 24 小时乘 0.9，低于 0.05 摘掉。

## 修复（0.6.6）

- 库里有记忆却注入「没有任何共同经历记录」→ 空库才用该文案，零命中改为「本轮没检索到」。
- 随机联想被当成真实召回并永久免疫忘却 → 排除出召回强化。
- 滤网「最近 80 条」实际是「权重最高 80 条」→ 改为时间窗内最近 80 条。
- `linkProximity` 锚在未命中候选上 → 锚定门禁后得分最高的已命中事件。
- L1 漂移与 L5 使用两套情绪词表 → 统一为 `sentimentPolarity`。

## 验证

| 项 | 结果 |
|---|---|
| `npm test` | **263/263** |
| `npm run typecheck` | 0 错 |
| `npm run build` | 通过 |
| `npm run check:link` | **PASS 21 / WARN 0 / FAIL 0** |
| `npm run memory:doctor`（真实库） | 错误 0 / 警告 0 |

## 升级

- 市场内更新到 `0.7.0`；
- 或 `npm i dsh-daughter@0.7.0`；
- 升级后如需关闭情绪日志，设 `polarity_log.enabled: false`。

## 已知说明

- `0.6.6` / `0.6.7` 没有单独发布到 npm，`0.7.0` 已包含两者全部改动；从 `0.6.5` 升级可直接跳到 `0.7.0`。
- GitHub Release 暂未创建（缺 GitHub token）；本文件作为发布公告，创建 Release 时可直接使用。
- `polarity_log` 只影响可观测性，不影响 `emotionMatch`、召回或关系推进。
