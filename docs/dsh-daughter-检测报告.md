# dsh-daughter 适配性 / 联动性检测报告

- 时间：2026-11-04 首测，**2026-11-05 复核**（本轮数值以复核为准）
- 方式：`npm run check:link`（`scripts/link-check.ts`），临时数据目录 + 临时端口（`DSH_DAUGHTER_BRIDGE_PORT`，默认 47912），不碰真实存档
- 结果：**PASS 18 / WARN 0 / FAIL 0**；`npm test` **103 项全绿**；`tsc --noEmit` 无错；`npm run build` 通过
- 前置：复核前 `dist` 落后于 `src`，首跑为 PASS 17 / WARN 1（仅 `dist` 新旧一项）；执行 `npm run build` 后转绿

## 一、适配性（8 项）

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 旧版 `config.yaml`（无 `vpet`、无新检索字段） | PASS | `top_k=3` 生效，`vpet.body_link.max_influence` 取默认 0.6 |
| 非法 / 未支持配置 | PASS | 5 条启动告警；`max_influence: 9 → 1`、`stale_ms: 1 → 30000` |
| 旧 L5 快照（无 `body` 字段） | PASS | 读得回，不凭空补 `body` |
| 旧 bridge 心跳（无体力/心情字段） | PASS | `normalizeBodySignal` 返回 null，插件状态不变 |
| `dist` 与 `src` 新旧 | PASS | `npm run build` 后 `dist` 晚于全部 `src`（未构建时该项为 WARN，不判 FAIL） |
| 旧版 MOD（不带 `since`） | PASS | 首次领 3 条，二次 0 条（游标前进）；`/vpet/say` 可用 |
| 旧格式 `rules.yaml`（缺 `enabled`/`priority`/`cooldownMs`） | PASS | 补齐默认值后正常命中 |
| 打包产物 | PASS | `apply` / `inject` 正常；`cordis.patch.yml` 引用 0 个文件；`files` 里 8 个发布资源齐全 |

> 告警数从 4 条变成 5 条，是 §14.7 新增的"配置项已忽略"提示（`storage.backend` / `desktop.enabled` 写了不生效时显式告警）计入所致。

## 二、联动性（10 项）

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 桥接端点 | PASS | `/health` 200，`vpet.pending=0` |
| 用户消息 → `thinking` | PASS | 队列 1 条 `thinking` |
| 回复 → 落盘 + `reply` + ack | PASS | 气泡「嗯，我在。先歇一会儿。」；ack 后 `pending=0`；事件可被 `retrieve` 命中 1 条 |
| 体力 5% → 有效疲劳 0.85 → `Sleep` | PASS | body 通道 → L5 → 情绪动作全链闭合 |
| MOD 忙 / 玩家交互让行 | PASS | `playerActive=true` 时本轮不下发 `motion` |
| `vpet_control` | PASS | 未上报的 graph 返回 400；`Say` 入队（loops=2） |
| `/connectors/<source>/ingest` | PASS | `android` 写入成功，`unknown` 404 |
| 星图与指标 | PASS | 9 星系 / 29 节点 / 13 边，`turns=3` |
| MOT 按 PAD 选动作 | PASS | 低愉悦选中 `MOT-SAD` |
| `/vpet/status` 独立性 | PASS | 无 MOD 上报时仍返回在线判定，不抛错 |

## 三、检测中发现并修复的真实问题

**旧反射规则文件会被整体判为停用。**

`Store.loadReflexRules()` 原来直接把 YAML 透传给运行时，而 `matchReflex` 用 `if (!rule.enabled) continue;` 过滤。旧版规则只写了 `id / match / action`，`enabled` 是 `undefined`（falsy），于是**整份旧规则文件一条都不会触发**，而且没有任何告警。

修复：

- 新增 `normalizeReflexRule`（`src/runtime/content.ts`）：缺失时补 `enabled: true`、`priority: 0`、`cooldownMs: 0`；结构非法（无 id / match.type / action.kind）的规则直接丢弃。
- `Store.loadReflexRules` 改为逐条归一化，全部非法时回落内置默认规则。
- 回归用例：`tests/hardening.test.ts` 新增「旧格式 rules.yaml 缺 enabled 仍命中」「显式 `enabled: false` 仍生效」两项。

> 这类问题只有"拿旧数据实跑"才暴露，写新格式的单元测试永远发现不了。

## 四、本报告覆盖不到的部分

自检用的是临时目录 + 临时端口 + 内存模拟，下面这些它测不出来，需要靠真实运行观察：

| 项 | 原因 | 现状 |
| --- | --- | --- |
| 真实 MOD / pet-shell 的画面与动效 | 自检只校验队列与端点 | 需人工确认（§12.1 表现通道） |
| 真实 VPet 存档读到的体力/心情 | 自检写的是假心跳 | 真实库 `body_signal.json` 已有 11-05 09:45 的心跳（strength 0.05 / feeling 0.4），说明 bridge 通了 |
| 真实语料上的检索质量、情绪极性、重构触发 | 自检只验证"能不能通" | `emotion_history` 真实库仍 0 行，见设计文档 §14.7 复核表 |
| 多进程并发写 | 自检是单进程 | 只有单测里两个 `Store` 实例交替累加的用例 |

## 五、结论

- **适配性**：旧配置、旧快照、旧 MOD、旧规则、旧 bridge 五种历史形态都能被正确识别，唯一的破口（旧规则全失效）已修掉。
- **联动性**：`消息 → 记忆 → 状态 → 动作 → 回执` 与 `存档 → 身体信号 → L5 → 表现` 两条链路都实测闭合，MOD 忙/玩家交互的让行也生效。
- **可重复**：`npm run check:link` 可随时重跑；有 FAIL 时退出码为 1，可直接接进 CI。注意先 `npm run build`，否则会带一条 `dist` WARN。
