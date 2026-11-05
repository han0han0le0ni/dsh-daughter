# dsh-daughter

给 DSH 的"大脑"插件：**人格分层、长期记忆、运行时状态、技能与反射、安全降级**。它不负责表现层——气泡、形象、动效由桌宠端决定。

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
            └── DshDaughter.dll      # .NET 编译产物
```

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
| 外部消息通用入口 | `POST /connectors/<source>/ingest` | QQ / 抖音 / Minecraft / 单机暂走这里，来源白名单校验 |

## 能力

| 模块 | 内容 |
| --- | --- |
| 人格 | L1 基线 / L2 关系 / L3 认知 / L4 情境子人格 / L5 运行时状态；L1–L4 慢速写回并留演化日志，L5 不写回人格 |
| 记忆 | 摘要层 + 全文层分离；SQLite FTS5 trigram + Dice 双路；五维加权（语义/近因/权重/情绪/链接）；一跳二跳联想 + 概率联想；衰减、归档、情绪历史合并 |
| 认知滤网 | 写入前四类裁决（屏蔽 / 丢弃 / 合并 / 放行）+ 来源可信度降权 + 显著性 + 习惯化签名 + 定期忘却；存量治理脚本 |
| 技能与资产 | `draft → active → frozen → deprecated`；按技能形态自动固化为 MAC / CON / CMB / MOT，失败两次自动回退 |
| 反射 | 关键词 / 正则 / 状态 / 事件四类匹配，毫秒级，不调用模型（短路默认关闭） |
| 安全 | 三档降级 + 滞回 + 写类工具熔断 + 输出侧诊断词检查；只描述强度与持续时间 |
| 注入预算 | 硬上限 3000 tokens，按优先级裁剪，`constraint` 永不裁 |
| 星图 | `/star-map/` 只读可视化：九个星系、Canvas 2D 手写透视、无需联网与 three.js |

## 快速开始

```bash
npm install
npm run build        # tsc → dist/
npm test             # 103 项
npm run check:link   # 适配性 / 联动性自检，18 项
```

- 运行配置见 `config.yaml`（数值均有范围校验，非法值回落默认并告警）。
- 运行时数据写到 `data_root`（默认 `.`），目录按脑区划分：`brain/hippocampus`、`brain/neocortex`、`brain/prefrontal` 等。
- 桌宠是可选件：没有 MOD、没有 bridge、没有 `vpet` 配置时，插件行为与"完全不知道桌宠存在"一致。

## 目录

```text
src/                插件主体（20 个 TS 文件）
  runtime/          记忆、人格、状态、安全、滤网、反射、可观测性
scripts/            自检与存量治理（link-check / filter-sweep）
connectors/
  vpet/             VPet MOD 源码（mod-src/，10 个 .cs + info.lps）与桥接脚本（bridge.mjs）
  pet-shell/        独立 WPF 壳（读 VPet 素材，不启动游戏）
  android/          ADB 受限动作
  desktop/          桌面观察与输入
web/                星图页面（纯静态）
tests/              13 个测试文件
docs/               设计文档、实现核对、评估、检测报告
```

## 文档

- [设计文档](docs/dsh-daughter-design.md)——数据模型、检索算法、接口契约、里程碑
- [实现核对](docs/dsh-daughter-实现核对.md)——完成度、代码落点、剩余缺口
- [记忆 / 情感评估](docs/dsh-daughter-记忆情感评估.md)——真实数据体检与改进优先级
- [检测报告](docs/dsh-daughter-检测报告.md)——适配性与联动性自检结果

## 当前状态

P0–P8 已落地并核对；P9 外部连接 3/7（VPet 桌宠 / Android / 桌面已通，QQ、抖音、Minecraft、单机待适配器）。已知短板与后续优先级见上面两份文档。

## 隐私

`brain/`、`logs/`、`archive/`、`star_map/`、`docs/screenshots/`、`dist/` 与 C# 的 `bin/obj` 均排除在版本库之外：前四者包含真实对话记忆、人格状态与界面截图，只在本地生成。

## License

尚未指定。如需开源分发，请补充 `LICENSE`。
