# dsh-daughter 夺舍通道设计（只设计，不含实现）

- 状态：设计稿，2026-11-07
- 目标：不再等每个平台来对接。凡是本机已经在跑的账号/客户端/插件，都可以被"借过来"当她的眼睛、嘴巴和手，并注册成 agent 可调用的工具面。
- 一句话：**借一个已有身体，而不是造一个新身份。**

---

## 1. 为什么是夺舍，不是接入

现在三种主流做法各有天花板：

| 做法 | 代表 | 天花板 |
| --- | --- | --- |
| 等平台给 API/webhook | 通用 `POST /connectors/<source>/ingest` | 没人会主动调，等同空转（抖音入口早已存在但一直没人喂） |
| 配置官方/半官方通道 | `dsh-fish-soul`（SnowLuma / OneBot 11）、`dsh-qq-access`（NapCat） | 要装通道、要扫码、要维护登录态，配置成本高 |
| 自己造一个新身份 | `dsh-douyin-agent`（专用 Edge 自主刷抖音） | 新号空信息流，看不到主人真实在看什么 |

夺舍走第四条：**借用主人已经登录好的那个身份**，零配置、零新账号、看到的就是真实的那个人的内容流。

代价必须写在同一页上：借身份 = 借风险（见 §9）。

---

## 2. 四种夺舍姿态

由轻到重，风险递增。每个渠道**必须**明确自己处于哪一档，不允许模糊。

| 档 | 名称 | 做什么 | 能否说话 | 典型对象 | 风险 |
| --- | --- | --- | --- | --- | --- |
| **S1** | 读库（寄生读） | 只读对方落盘的 SQLite / JSONL / 日志 | 否 | 抖音插件共享记忆库（现状）、其它 DSH 插件的 `memory/*.sqlite` | 极低 |
| **S2** | 借道（relay） | 连对方已经建好的本机服务，用它的身份收发 | 是 | NapCat / OneBot 11、Minecraft RCON、本地 RSS、B站 cookie 导出 | 中 |
| **S3** | 占界面（UI 夺舍） | 没有服务时，直接操作对方窗口：截图→定位→点击/输入 | 是 | 微信、无服务端的客户端、单机游戏 | 高 |
| **S4** | 寄生代码（in-process） | 对方提供扩展点时，把我们的代码载进对方进程 | 是 | VPet `MainPlugin` MOD（已实现）、pet-shell 独立壳 | 中 |

设计上**鼓励停留在 S1**：能读就不写，能借道就不占界面。

### 阶梯降级顺序

```
优先 S2（有服务）→ 退 S1（有库）→ 退 S3（只有界面）→ 全失败标 unavailable
```

不允许跳过 S1 直接上 S3——读屏的置信度天然低，只在完全没有结构化来源时使用。

---

## 3. 核心抽象：Channel Adapter 契约

一个渠道 = 一个 adapter。**六个方法，缺一不可**：

```text
probe()          → 目标在不在、契约版本、可达性、证据（进程名/端口/文件 mtime）
capabilities()   → { read, speak, act, media } × 支持的粒度（单聊/群聊/评论/私信/公开内容）
read(cursor)     → ChannelEvent[]，幂等、正序、带 externalId
say(outboxItem)  → 投递一条（受节流、白名单、安全闸）
act(action)      → 结构化动作，只能是该 adapter 白名单内的枚举
health()         → 最近成功率、延迟、契约是否漂移
release()        → 退出夺舍，清游标外的所有残留（不改对方数据）
```

### 六条铁律

1. **幂等**：唯一键 `(source, externalId)`。现在的抖音靠 `updated_at` 游标，对方更新旧记录时会漏或重，换成 external id 才稳。
2. **时序保真**：事件的 `createdAt` 用**外部时间**，不用 `now`。代码里已经踩过这个坑（倒序灌入会让"上周刷的"排到"刚刷的"后面）。
3. **不抢占**：原宿主优先。VPet MOD 与 pet-shell 共用 ack 游标、同时开会互相抢事件——夺舍层必须规定「我们只读不 ack」，或使用独立 `shadow cursor`，且同一目标同一时刻只允许一个适配器持有写权。
4. **失败静默**：probe/read 任何异常都只是"这次没有新内容"，写一行 debug 就退，绝不抛、不阻塞主链路（`douyin-link.ts` 已是这个风格，保留）。
5. **来源可推导**：每个 adapter 声明 source 与参与者推导规则。现有 `participantsFor()` 按来源推"这是不是共同经历"——夺舍来的单向内容**不得**记成"我们一起做过"。
6. **契约版本化**：`contract = 'douyin/memory_entries@1'`。启动时用 `PRAGMA table_info` 之类做软匹配，字段缺失就走降级，不硬崩。

---

## 4. 三层结构

```text
ChannelBus
├── Registry      发现 + 授权 + 调度（谁能被夺、夺到哪一档、现在健康与否）
├── Ingress       统一事件 → renderChannelText（第一人称）→ ingestExternalEvent → 认知滤网
└── Outbox        说的那一侧：限速、去重、过期作废、失败退避、审计

ChannelToolSurface
└── 把已授权渠道注册成 agent 工具（channel_list / channel_read / channel_say / channel_act）
```

关键点：**夺舍进来的东西必须走原有的认知滤网**（`decideIngest` 四类裁决 + 来源可信度 + 显著性质 + 习惯化 + 爆发抑制），不允许开旁路。否则夺舍会变成"记忆污染加速器"。

---

## 5. 发现机制（Discovery）

本机扫描，不联网、不越权、不落盘敏感内容。只产出"可夺舍清单"：

| 目标 | 探测证据 | 默认档 | 能力 |
| --- | --- | --- | --- |
| 抖音插件 | `~/.dsh/douyin-browser/memory/shared.sqlite` | S1 | 只读（**现状，已默认开**） |
| QQ / NapCat | `127.0.0.1:3000`/`3001`、`napcat` 进程 | S2 | 读写 |
| 其它 DSH 插件 | `~/.dsh/*/memory/*.sqlite` | S1 | 只读 |
| VPet | 安装目录 + `mod/DshDaughter` | S4 | 读写（已实现） |
| 桌面窗口 | 前台窗口标题/进程（`readForeground`） | S3 | 读屏 + 键鼠 |
| 独立桌宠壳 | `pet-shell` 进程 | S4 | 读写（已实现） |
| Minecraft | 本地 server RCON 端口 / 日志尾部 | S2 | 读写 |
| B站 | 浏览器 profile 内的 cookie（**需手动导出**，不自动偷） | S2 | 读写 |

UI 呈现跟插件市场同款卡片：**能看什么 / 能说什么 / 风险等级 / 需要授权到哪一档**。默认全关，`douyin` 是唯一默认开的。

发现结果不缓存太久：进程会退出、端口会换、库会挪。一次扫描结果 60 秒内有效。

---

## 6. 权限与安全

这是整个设计里最重的部分，也是能不能上架的分界线。

### 6.1 三档授权

| 权限 | 含义 | 默认 |
| --- | --- | --- |
| `observe` | 只读 | 允许（仅 S1） |
| `speak` | 能发消息 | 关闭，逐渠道显式开 |
| `act` | 能操作界面 | 关闭，且需再开 `unsafe_actions` |

授权写在 config，**不写进记忆库**——记忆库是她的，权限配置是主人的。

### 6.2 白名单制

- 对谁说话：好友白名单 / 群白名单。陌生人先发消息不认领（沿用 `dsh-project-companion` 的思路）。
- 主动发起：禁止主动加好友、关注、私信陌生人、进群、发表公开评论。只允许**回复已存在的对话**，除非显式开 `proactive`。

### 6.3 拟人化节流（防封号，也防"不像人"）

- 每渠道 token bucket：默认 `6 条/分钟`、`40 条/小时`、`120 条/天`
- 同一对象冷却：默认 90 秒
- 出站前随机抖动（已有 `createRng(hashText(角色:分钟))` 的可复现随机，复用）
- 夜间静默：复用 `speak` 的安静时段
- **禁止群发**：一次 outbox 条目只能有一个目标

### 6.4 硬边界（写死在代码里，不可配置开启）

支付/银行/密码框、验证码、实名认证、医疗法律结论、政治内容、任何"替本人立誓/签约"式表述。命中即拒绝并审计，**不提示"可以改成别的说法"**。

### 6.5 出站要过安全模块

`safety` 的三档降级、诊断词检查、写类熔断对夺舍渠道同样生效。夺舍不是后门。

### 6.6 审计与急停

- `logs/channel/<source>.jsonl`：谁、对谁、说了什么、过了哪几道闸、投递结果、耗时。
- 全局急停 `POST /channel/stop` + 单渠道急停；**3 秒内不再有任何出站请求**。
- 进程退出/异常时自动 `release()`，不留后台动作。
- 沿用现有令牌：`x-dsh-token`、常量时间比较、浏览器来源 403、无令牌 503。

---

## 7. 工具面：把渠道变成"工具渠道"

这才是"当工具渠道"的落点——她不需要等主人喂，模型自己能看到、能开口。

| 工具 | 权限 | 说明 |
| --- | --- | --- |
| `channel_list` | 无 | 列出可夺舍/已夺舍目标、当前档位、能力、健康度 |
| `channel_read` | observe | 拉某渠道最近内容（`since`/`limit`），返回已渲染的第一人称文本 + 证据 |
| `channel_say` | speak | 发一条（进 Outbox，不保证即时投递） |
| `channel_act` | act | 结构化动作，只接受 adapter 白名单里的枚举 |

刻意**不提供**任意代码执行、任意键鼠坐标、任意 URL 抓取。S3 的坐标点击必须显式 `unsafe_actions: true`，并且每次调用在审计里留截图。

---

## 8. Outbox：说的那一侧

读是幂等的，写不是。所以写要独立成队列。

- **持久化**：`brain/channels/<source>/outbox.jsonl`，进程重启不丢。
- **过期作废**：默认 10 分钟。一小时前的回复现在才发出去，比不发更糟。
- **去重**：`hash(目标 + 内容)` 在 10 分钟窗口内只发一次。
- **退避**：失败 3 次（1s/4s/16s）后进 dead-letter，写 metrics，设置页可见。
- **优先级**：回应主人 > 主动开口 > 例行同步。
- **不保证即时**：`channel_say` 返回的是"已入队"，不是"已送达"。工具描述里必须写清这一点，否则模型会以为发出去了。

---

## 9. 风险与边界（必须公开写在 README）

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 平台条款 / 封号 | 借主人账号自动发言，可能违反平台规则 | 默认只开 S1；开 speak 时二次确认 + 风险弹窗；节流 |
| 隐私放大 | S3 读屏会把**别人的**消息也读进来 | 只采当前会话区、模糊化非目标窗口、入库前过屏蔽词 |
| 误判 | OCR / 窗口标题推断错，把 A 的话记成 B 的 | S3 置信度 0.6 起，低于阈值的只进"待确认"不进记忆 |
| 抢占 | 与原插件抢游标、抢焦点、抢登录态 | 原宿主优先、单写者锁、shadow cursor |
| 后门化 | 夺舍通道绕过安全模块 | 强制过 `safety` 与 `decideIngest`，无旁路 |
| 依赖脆弱 | 对方改表名/改协议就废 | 契约版本化 + 软探测 + 退化为 `degraded` 不崩 |

**对外文案建议**：内部叫"夺舍流"没问题，市场描述里写"零配置接管本机已有渠道"，避免"夺舍"引起平台方和普通用户的反感。

---

## 10. 兼容性：什么叫"强行兼容"

三原则：

1. **软匹配不硬依赖**：按候选表名/字段名打分匹配（`memory_entries` / `memory` / `entries`），命中就试读，缺字段用默认值补。
2. **有损但不崩**：字段不全时降级成本文文本，不追求结构完整。
3. **失败即退化**：任何一步失败退回上一档姿态，全失败标 `unavailable` 并指数退避（最长 30 分钟一次探测），不重试风暴。

适配器健康状态机：

```
unknown → probing → live(S1/S2/S3) → degraded(契约漂移) → unavailable(多次失败) → probing…
```

设置页对 `degraded` 明确写"对方契约已变，适配器需要更新"，不要假装还在正常工作。

---

## 11. 分期落地（不含代码）

| 期 | 内容 | 验收 |
| --- | --- | --- |
| **P0** | 抽象层 + 抖音迁到新契约（行为不变）+ `channel_list` / `channel_read` + 审计日志 | 同一内容重复读 3 次库里只有 1 条；删库后插件照常启动，日志 1 行 warn |
| **P1** | Outbox + `channel_say` + QQ（NapCat，S2）+ 白名单与节流 | 未授权 speak 返回 403 并写审计；超限拒绝并计数；过期条目不再投递 |
| **P2** | S3 通用窗口适配器（复用 `desktop_observe` + `desktop_input`）+ 危险动作白名单 + 急停 | 急停后 3 秒内零出站；坐标点击需 `unsafe_actions` 且留截图 |
| **P3** | B站 / Minecraft / 微信适配器；设置页"可夺舍清单"卡片；契约版本化 | 改表名后进 `degraded`，不崩、不重复记 |

---

## 12. 配置草案

```yaml
channels:
  defaults:
    posture_max: observe      # observe | speak | act
    outbox_ttl_min: 10
    limits: { per_min: 6, per_hour: 40, per_day: 120 }
    peer_cooldown_sec: 90
    quiet_hours: [23:00, 08:00]
  douyin:
    adapter: douyin-shared-db
    posture: observe
    enabled: true
  qq:
    adapter: napcat-onebot
    posture: relay            # 只读=observe，能回=speak
    endpoint: ws://127.0.0.1:3001
    allow: { friends: [], groups: [], proactive: false }
  desktop:
    adapter: win32-window
    posture: ui
    enabled: false
    unsafe_actions: false
```

数据落点：

```text
brain/channels/
├── douyin/{cursor.json, audit.jsonl}
└── qq/{cursor.json, outbox.jsonl, audit.jsonl, dead-letter.jsonl}
```

---

## 13. 与现有代码的接缝

| 现有 | 夺舍层怎么用 |
| --- | --- |
| `src/runtime/douyin-link.ts` | 抽成 `douyin-shared-db` adapter 的 `read()`，`renderDouyinEventText()` 保留为渲染器 |
| `ingestExternalEvent()` | 变成 Ingress 的唯一入口，不新增写入路径 |
| `decideIngest()` / `filter.ts` | 强制经过，按姿态给来源可信度（S1 0.95 / S2 0.9 / S3 0.6） |
| `participantsFor()` | 夺舍内容默认单向，不记"共同经历" |
| `connector-auth.ts` | 原样复用，S3/S4 必须带令牌 |
| `desktop-observe.ts` / `desktop-input.ts` | 直接作为 S3 的 `read`/`act` 原语，只加白名单与审计 |
| `speak.ts` 安静时段 | Outbox 的夜间静默复用同一套判定 |
| `safety.ts` | 出站强制过闸 |

---

## 14. 一句话总结

> 她不需要每个平台给她开一个门。**门口已经开着的，她借过来用**：能读库的就读，能借道的就借，实在只剩界面的才动手。但借来的每一句话都要过审、记账、限速，而且随时能还回去。
