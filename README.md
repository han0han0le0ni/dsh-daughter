# dsh-daughter

给 DSH 的"大脑"插件：**人格分层、性格演化、长期记忆、运行时状态、技能与反射、安全降级**。它不负责表现层——气泡、形象、动效由桌宠端决定。

> 记忆跟着角色走，不跟着会话走：换对话框、换工作区，关系与经历都还在。

## 对接对象（先看这张表）

| 项 | 具体是什么 |
| --- | --- |
| 桌宠软件 | **VPet-Simulator**（虚拟桌宠模拟器，Steam 版，Windows / WPF）。本机实测游戏版本 `11074`，构建引用其 `VPet-Simulator.Windows.Interface.dll` 等 5 个 DLL |
| 配套 MOD | **`DshDaughter`**（`PluginName = dshdaughter`）——自己写的 **C# 代码 MOD**，不是 Steam 创意工坊的现成 MOD |
| 是否改游戏本体 | **否**。不替换、不 patch VPet 的任何文件；MOD 只通过 VPet 官方 `MainPlugin` 扩展点加载 |
| 是否改第三方 MOD | **否**。仓库里的 10 个 `.cs` 全部为新增代码，没有基于别人的 MOD 改造 |
| 两端怎么通信 | 只有 HTTP：MOD 轮询 `http://127.0.0.1:47612/vpet/events`，处理完 `POST /vpet/events/ack`；状态回传 `/vpet/consumer/report`，身体信号 `/vpet/heartbeat` |
| 另一个可选前端 | `connectors/pet-shell`（独立 WPF 壳），不启动游戏，直接读 VPet 的 PNG 素材帧；与 MOD **共用一个 ack 游标，只能二选一运行** |

## 桌宠联动

### A. VPet-Simulator + `DshDaughter` MOD（推荐）

**装到哪里**：VPet 安装目录下的 `mod\DshDaughter\`，结构为

```text
<VPet 安装目录>\
└── mod\
    └── DshDaughter\
        ├── info.lps                 # MOD 清单（vupmod#DshDaughter / author / gamever 11074）
        └── plugin\
            ├── DshDaughter.dll      # .NET 编译产物
            └── token.txt            # 连接器令牌（v0.6.1 起必需，见下）
```

**令牌怎么拿**：插件端点不再接受"本机来的就放行"（详见设计文档 §12.2）。先让插件跑起来一次（会生成 `brain/brainstem/connector_token`），然后：

```bash
npm run connector:token -- --write-to "<VPet 安装目录>\mod\DshDaughter\plugin"
```

也可以手动把 `brain/brainstem/connector_token` 的内容复制成 `plugin/token.txt`，或设置环境变量 `DSH_DAUGHTER_TOKEN`。令牌缺失时 MOD 仍会启动，但请求会被 401 拒绝，日志里会写明原因。

**怎么编译**（MOD 源码在 `connectors/vpet/mod-src/`，目标框架 `net10.0-windows`）：

```powershell
cd connectors/vpet/mod-src
dotnet build -c Release -p:VPetDir="E:\SteamLibrary\steamapps\common\VPet"
```

`VPetDir` 默认就是上面那个路径，装在别处时用参数覆盖。5 个 VPet 程序集以 `Private=false` 引用，**不随 DLL 分发**，运行时由游戏自身提供。

**怎么装**：把 `bin/Release/DshDaughter.dll` 复制到 `mod\DshDaughter\plugin\`，把 `info.lps` 复制到 `mod\DshDaughter\`，重启游戏。日志写在游戏目录的 `dsh-daughter-mod.log`。

**改了哪些文件**（全部为新增，`connectors/vpet/mod-src/`）：

| 文件 | 职责 |
| --- | --- |
| `Plugin.cs` | 唯一入口，继承 `MainPlugin`；1s 轮询、游标推进、忙闲裁决、置顶自愈 |
| `DshClient.cs` | HTTP 客户端：`/vpet/events`、`/vpet/events/ack`、`/vpet/consumer/report`、`/vpet/heartbeat` |
| `EventRouter.cs` | 把 `thinking / tool / reply / error / motion / move` 事件翻译成气泡与待执行指令 |
| `MotionPlayer.cs` | 播放 VPet 原生 `GraphType` 动画，处理旧动画回调不打断新动画 |
| `PetWindowController.cs` | 窗口置顶、相对像素平移、头顶锚点 |
| `InteractionGuard.cs` | 玩家摸头/点击后的短时间内本地优先，DSH 动作排队等待 |
| `CommandQueue.cs` | 待执行桌宠指令的排队与去重 |
| `ConsumerState.cs` | 能力清单（支持的 GraphType）、忙闲、玩家交互，上报给 DSH |
| `CloudBubble.cs` | 头顶云朵气泡：点击穿透、不抢焦点、默认 6s 淡出 |
| `PetLog.cs` | 异步轻量日志，避免 UI 线程被文件 I/O 拖住 |
| `info.lps` | MOD 清单（游戏读取的元信息） |

**行为边界**：MOD 只调用 VPet 公开 API（`IMainWindow`、`GraphInfo.GraphType`、气泡与窗口句柄），不写 VPet 存档；插件侧对身体信号只做单向只读（见设计文档 §12.1）。

### B. `connectors/pet-shell`（独立壳，可选）

不启动游戏本体，直接按 VPet 素材目录的 PNG 序列帧播放。

- 素材默认探测 `...\VPet\mod\0000_core\pet\vup`，也可在设置里改
- 配置在 `%LOCALAPPDATA%\DshPet\pet.json`（首次启动生成）：素材路径、缩放、置顶、点击穿透、气泡、桥地址
- 桥地址默认 `http://127.0.0.1:47612`（旧版本写死的 `47614` 是桌面连接器端口，启动时会自动纠正）
- 与 MOD 共用同一 ack 游标，**同时开会互相抢事件**，只保留一个

### C. 其它连接器

| 连接器 | 端口 / 入口 | 说明 |
| --- | --- | --- |
| `connectors/android` | ADB | 受限动作 + 前台事件，需 `adb` 可用 |
| `connectors/desktop` | `127.0.0.1:47614` | 窗口/前台/媒体查询、截图、抽帧、ffmpeg 推流、输入注入 |
| 外部消息通用入口 | `POST /connectors/<source>/ingest` | QQ / Minecraft / 单机暂走这里，来源白名单校验；抖音改走共享记忆只读拉取（见「抖音联动」） |

## 能力

| 模块 | 内容 |
| --- | --- |
| 人格 | L1 基线 / L2 关系 / L3 认知 / L4 情境子人格 / L5 运行时状态；L1–L4 慢速写回并留演化日志，L5 不写回人格 |
| 记忆 | 摘要层 + 全文层分离；SQLite FTS5 trigram + Dice 双路；五维加权（语义/近因/权重/情绪/链接）；一跳二跳联想 + 概率联想；衰减、归档、情绪历史合并 |
| 认知滤网 | 写入前四类裁决（屏蔽 / 丢弃 / 合并 / 放行）+ 来源可信度降权 + 显著性 + 习惯化签名 + 定期忘却；存量治理脚本 |
| 技能与资产 | `draft → active → frozen → deprecated`；按技能形态自动固化为 MAC / CON / CMB / MOT，失败两次自动回退 |
| 行为动机 | 人格双通路（降阈值 + 方向舵）、熟悉度倒 U、记忆三路径、情绪覆盖、情境乘子；分数与阈值比较后给出 `act / hold / avoid`；失败熔断；零信号恒不触发 |
| 主动开口 | **默认关闭**。开启后按思念/人格/情绪/关系决定要不要自己开口；欲言又止会攒劲；安静时段、冷却期、日上限兜底；模板文案经可插拔出口投递到桌宠气泡 |
| 反射 | 关键词 / 正则 / 状态 / 事件四类匹配，毫秒级，不调用模型（短路默认关闭） |
| 安全 | 三档降级 + 滞回 + 写类工具熔断 + 输出侧诊断词检查；只描述强度与持续时间 |
| 注入预算 | 硬上限 3000 tokens，按优先级裁剪，`constraint` 永不裁 |
| 星图 | `/star-map/` 只读可视化：九个星系、Canvas 2D 手写透视、无需联网与 three.js |

## 安装

三种方式，按需选一种。

**1. 通过 DSH 插件市场（推荐）**

仓库自带一份 format 1 索引：[`market/index.json`](market/index.json)。在 DSH 里打开 **插件 → 发现 → 索引源 → 添加**，填入：

```text
https://cdn.jsdelivr.net/gh/han0han0le0ni/dsh-daughter@main/market/index.json
```

之后在「发现」里搜 `daughter` 安装即可。索引里固定了 commit，装到的是可复现的版本。

**2. 直接从 git 装**

```bash
dsh plugin add git+https://github.com/han0han0le0ni/dsh-daughter.git
```

**3. 本地开发**

```bash
npm install
npm run build        # tsc → dist/
npm test             # 203 项
npm run check:link   # 适配性 / 联动性自检，18 项
```

> 仓库里提交了 `dist/`：市场与 git 安装没有构建步骤，必须带一份可直接加载的产物。改了 `src/` 记得 `npm run build` 再提交（`prepare` 脚本也会兜一层）。

- 运行配置见 `config.yaml`（数值均有范围校验，非法值回落默认并告警）。
- 运行时数据写到 `data_root`（默认 `.`），目录按脑区划分：`brain/hippocampus`、`brain/neocortex`、`brain/prefrontal` 等。
- 桌宠是可选件：没有 MOD、没有 bridge、没有 `vpet` 配置时，插件行为与"完全不知道桌宠存在"一致。

## 记忆体检

记忆是「SQLite 索引 + 全文/归档文件 + 星图」三层，容易出现"表里删了、文件还在"这类对不上的状态。`npm run memory:doctor` 只读扫一遍，`--fix` 才动手修：

```bash
npm run memory:doctor -- --root=<数据根>            # 只报告
npm run memory:doctor -- --root=<数据根> --fix       # 修可安全修的那几项
npm run memory:doctor -- --root=<数据根> --json      # 给脚本用
```

检查项：SQLite 完整性、事件/归档计数、孤儿回看记录、FTS 索引是否真的查得到已有事件（外部内容表的 `COUNT(*)` 和 `integrity-check` 都看不出索引被清空，所以用真实标题做功能探针）、全文与归档文件的缺失/孤儿、字段越界、出边悬空/自环/重复/超过 12 条上限、星图边的引用一致性。

`--fix` 的动作都是可逆或安全的：孤儿文件移到 `logs/memory-doctor-trash/<时间戳>/`（不删）、缺失全文用摘要补一份、悬空边从出边里摘掉、越界值夹回 0..1、FTS 必要时 rebuild。

## 重置数据

清记忆 / 恢复出厂人格 / 清条件反射 / 清技能 / 恢复出厂设置，都走 `npm run reset`。默认只列清单（dry-run），加 `--apply` 才真的删，删完会读回真实状态复核，复核不过退出码非 0：

```bash
npm run reset -- memory                 # 只报告：会清掉多少事件、回看、全文与归档
npm run reset -- memory --apply         # 清记忆
npm run reset -- personality --apply    # 人格恢复出厂 L1–L4
npm run reset -- reflex --apply         # 反射规则与冷却状态
npm run reset -- skills --apply         # 技能卡与动作模板
npm run reset -- all --apply --yes      # 恢复出厂设置（多一道 --yes 确认）
```

可选：`--no-backup` 跳过备份、`--root=<路径>` 指定数据根。建议先停掉 DSH 再重置，否则插件会把内存里的状态写回去。

被清掉的目录不会递归删除，而是整体移到 `logs/reset-trash/<时间戳>/`（想捞回来搬回去即可）；备份在 `logs/reset-backup/<时间戳>/`。

## 目录

```text
src/                插件主体（23 个 TS 文件）
  runtime/          记忆、人格、状态、动机、主动开口、安全、滤网、反射、可观测性
scripts/            自检与存量治理（link-check / filter-sweep / reset / memory-doctor）
connectors/
  vpet/             VPet MOD 源码（mod-src/，10 个 .cs + info.lps）与桥接脚本（bridge.mjs）
  pet-shell/        独立 WPF 壳（读 VPet 素材，不启动游戏）
  android/          ADB 受限动作
  desktop/          桌面观察与输入
web/                星图页面（纯静态）
tests/              21 个测试文件
docs/               设计文档、实现核对、评估、检测报告
```

## 文档

- [设计文档](docs/dsh-daughter-design.md)——数据模型、检索算法、接口契约、里程碑
- [实现核对](docs/dsh-daughter-实现核对.md)——完成度、代码落点、剩余缺口
- [记忆 / 情感评估](docs/dsh-daughter-记忆情感评估.md)——真实数据体检与改进优先级
- [检测报告](docs/dsh-daughter-检测报告.md)——适配性与联动性自检结果

## 性格演化

出生时五维按有界区间抽样，并把结果写入 `innate` 锚点；同角色同种子可复现。日常闲聊不动人格，只有累积/关键事件才按通道推动五维，任一项不超出锚点 `±0.6`。依恋底色出生只抽安全/焦虑/回避，混乱型只能靠经历演化。面板只展示证据与数值，不输出"你是 X 型"的结论。完整规则见设计文档 §4.8。

## 行为动机

决策层不再用"文本相似度过线"就执行技能，而是给每个技能算一个动机分，再和阈值比。两层结构，职责不重叠：

```text
阈值侧（够不够力）   skills.min_main_score + 人格偏移 + 情绪偏移 → 不低于 min_threshold
分数侧（想不想走）   signal ×(熟悉度)×(记忆)×(情境)×(方向舵)  → 0..1
决策                 熔断 → avoid；零信号 → avoid；score ≥ 阈值 → act；≥ 0.7×阈值 → hold
```

**人格走两条独立通路**，这是这套设计的关键：

| 通路 | 参数 | 作用 | 类比 |
| --- | --- | --- | --- |
| 阈值偏移 | `trait_threshold_gain` | 五维按通道映射成阈值的升降 | 门有多重 |
| 方向舵 | `trait_signal_gain` | 五维按通道映射成分数乘子 `1±g` | 更想走哪条路 |

只有阈值通路时，人格无法影响"几个候选技能里选哪个"，只能影响"一个都别选"——所以补了方向舵。方向舵是**乘子不是加项**：`signal=0` 时乘什么都不会高于 0，零信号永远不会被凭空变成行动。

其余因子：

- **熟悉度倒 U**：`exposure = uses/(uses+k)`，太少犹豫、太多厌倦，峰值在 `peak`。
- **记忆三路径**：结果预期（按 `lastUsedAt` 半衰）／情绪记忆（近 `lookback_days` 天相关事件的愉悦度）／自我效能（L3 自我价值），权重归一化。
- **情绪覆盖**：安全感低、压力高、心情低、疲劳高 → 更谨慎；高唤醒 → 更容易动。总偏移被 `clamp_min/max` 截断。
- **情境乘子**：关系深度 + 子人格披露度，社交通道吃满，其余通道折半。
- **失败熔断**：连续失败 `fail_streak` 次进入指数冷却，期间只 `avoid`，成功即清零。

每个技能的因子都留在 `MotivationBreakdown` 里（`signal / personalityOffset / emotionOffset / threshold / familiarityGain / memoryGain / situationMultiplier / traitSignalGain / score / decision`），面板与日志可以逐项复算。`motivation.enabled = false` 时退回旧的相似度打分，便于对照。数值含义与取值范围见 `config.yaml` 注释。

## 主动开口

没人说话的时候，她会不会自己开口。这条链和上面的动机层是分开的：动机回答"这个技能该不该用"，需要用户输入；主动开口回答"这会儿想不想说话"，信号来自沉默时长而不是文本。

```text
强度侧（想不想）   思念累积 + 人格 + 情绪 + 关系 + 上一轮攒下的"憋劲"
门槛侧（合不合适） 基础阈值 + 安静时段 + 压力
决策               冷却期/日上限 → silent；urge ≥ 阈值 → act；≥ 0.75×阈值 → hold
```

拟人靠三件事：

- **思念有饱和**：`idle / (idle + 180min)`。沉默一小时只有 0.25，十小时到 0.77——不会两小时没回就急，但一整天没动静会明显想说话。
- **欲言又止**：`hold` 不是失败。它把"这次的憋劲"累进 `carry`，攒够下一次才真开口。所以会看到"她想了好几次，最后才说一句"。
- **时机不对就不说**：安静时段（默认 0–7 点）抬门槛 0.35，压力大再抬 0.06；刚说过话有 90 分钟冷却；一天最多 5 次。她说完话也算"刚联系过"，不会因为对方没回就靠沉默累积刷屏。

文案按动机分类取池（想念 / 关心 / 分享 / 不安 / 无聊），最近 5 句会被避开。**目前是模板，不是模型生成**——接模型后可替换这一层，其余决策逻辑不用动。

**默认是关闭的**（`speak.enabled: false`）。"她会自己开口"属于自主行为，装完插件不该自动开始——要用就改成 `true`，并确认桌宠在跑。

**能看见屏幕时会先看场景。** `connectors/desktop` 桥接在跑时，每次评估先读一眼前台窗口，按打扰成本抬门槛：开会 ×0.85、游戏 ×0.7、写代码 ×0.4、其它 ×0.15（再乘 `busy_penalty 0.25`）。桥接没启动就静默跳过——不会因为探测失败变成一整天不说话的哑巴。

投递走可插拔的表达出口（`expression.sinks`，类型 `ExpressionSink`）：`pet` 投给 DSH 内置桌宠 dsh-pet（气泡走 `/dsh-pet-7340/broadcast`，情绪动作走 `/anim`），`vpet` 把文本塞进 VPet 的 `/vpet/events` 队列（`kind: reply`），`http` 把事件 JSON POST 给任意应用，`file` 追加 JSONL 供本地 `tail -f`。多个出口可同时开，并发投递、单个出口抛错不影响其他；决策层只负责"想说什么"，往哪发由配置决定，加一个出口不用动决策。

**换了桌宠不用改代码。** `pet` 出口的地址由宿主自己拼（`webServer` 端口 + dsh-pet 的路由段），不需要填端口；出厂配置只有 `vpet` 时，启动会探一下 dsh-pet 在不在，在就让它接管（`prefer_pet: true`），免得两套桌宠把同一句话各弹一遍。VPet 卸掉之后，`vpet` 出口只是往没人消费的队列里写，不会再出现在屏幕上。

**干活时桌宠也会动。** dsh-pet 接管后，她的 thinking / tool / reply / error 会点播成 dsh-pet 内置的工作状态动画（`events.workStatus`）：思考冒泡、忙碌点按、清点归档、垂头叹气冒汗。这些动画是 dsh-pet 自带的，不用从 VPet 搬素材——两边的动作词汇表不通用，VPet 认 `GraphType`（Say/Touch_Head/Sleep），dsh-pet 认它素材目录里的中文名，所以按接管方各选各的。

**说过的话留痕。** 星图面板的「主动开口」分组能翻到：今天开口几次、几次欲言又止、憋着多少劲、最近说过哪几句。没有这块的话，她说什么只存在于气泡队列里，测完什么都看不到。

没有桌宠在轮询时，消息只会入队、不会出现在聊天记录里——插件没有往宿主会话里插消息的权限。

## 抖音联动

装了 `dsh-douyin-browser-local` 时，她能知道你刷了什么。不是靠对方推送——那个插件没有对外事件或 webhook——而是**只读**它的共享记忆库（`~/.dsh/douyin-browser/memory/shared.sqlite`）里 `origin='video'` 的条目，把新出现的记录写成自己的一条事件（`source: douyin_content`），之后走同一套认知滤网、衰减与联想。

- **只读连接**：不写对方的库，观看记录也不会被反向同步回去
- **游标在内存里推进**：首次启动与长时间关机后只补最近 24 小时，不把上周刷的当成"刚看到的"
- **失败即静默**：库不存在、表结构变了、运行环境没有 `node:sqlite`，都只是"这次没有新内容"，不影响其它功能
- 参数在 `config.yaml` 的 `douyin` 段：`enabled` / `memory_db` / `poll_interval_min`（默认 10 分钟）/ `max_items`（单次最多 5 条）

## 当前状态

P0–P8 已落地并核对（当前 `npm test` **203 项全绿**，`check:link` PASS 18）；P9 外部连接 4/7（VPet 桌宠 / Android / 桌面已通，抖音走只读共享记忆拉取，QQ、Minecraft、单机待适配器）。已知短板与后续优先级见上面两份文档。

## 隐私

`brain/`、`logs/`、`archive/`、`star_map/`、`docs/screenshots/`、`dist/` 与 C# 的 `bin/obj` 均排除在版本库之外：前四者包含真实对话记忆、人格状态与界面截图，只在本地生成。

## License

[MIT](LICENSE) © 2026 han0han0le0ni
