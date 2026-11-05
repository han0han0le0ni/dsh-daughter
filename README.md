# dsh-daughter

给 DSH 的"大脑"插件：**人格分层、长期记忆、运行时状态、技能与反射、安全降级**。它不负责表现层——气泡、声音、形象由桌宠 / 壳 / 其它前端自己决定。

> 记忆跟着角色走，不跟着会话走：换对话框、换工作区，关系与经历都还在。

## 能力

| 模块 | 内容 |
| --- | --- |
| 人格 | L1 基线 / L2 关系 / L3 认知 / L4 情境子人格 / L5 运行时状态；L1–L4 慢速写回并留演化日志，L5 不写回人格 |
| 记忆 | 事件摘要层 + 全文层分离；SQLite FTS5 trigram + Dice 双路检索；五维加权（语义/近因/权重/情绪/链接）；一跳二跳联想 + 概率联想；衰减、归档、情绪历史合并 |
| 认知滤网 | 写入前四类裁决（屏蔽 / 丢弃 / 合并 / 放行）+ 来源可信度降权 + 显著性 + 习惯化签名 + 定期忘却；存量治理脚本 |
| 技能与资产 | `draft → active → frozen → deprecated`；按技能形态自动固化为 MAC / CON / CMB / MOT，失败两次自动回退 |
| 反射 | 关键词 / 正则 / 状态 / 事件四类匹配，毫秒级，不调用模型（短路默认关闭） |
| 安全 | 三档降级 + 滞回 + 写类工具熔断 + 输出侧诊断词检查；只描述强度与持续时间 |
| 注入预算 | 硬上限 3000 tokens，按优先级裁剪，`constraint` 永不裁 |
| 星图 | `/star-map/` 只读可视化：九个星系、Canvas 2D 手写透视、无需联网与 three.js |
| 连接器 | 桌宠（VPet MOD / WPF 壳）、Android ADB、电脑桌面；QQ / 抖音 / Minecraft / 单机走通用入口 |

## 快速开始

```bash
npm install
npm run build        # tsc → dist/
npm test             # 103 项
npm run check:link   # 适配性 / 联动性自检，18 项
```

- 运行配置见 `config.yaml`（数值均有范围校验，非法值回落默认并告警）。
- 运行时数据默认写到 `data_root`（`.`），目录按脑区划分：`brain/hippocampus`、`brain/neocortex`、`brain/prefrontal` 等。
- 桌宠联动是可选的：没有 MOD、没有 bridge、没有 `vpet` 配置时，行为与"完全不知道桌宠存在"一致。

## 目录

```text
src/           插件主体（20 个 TS 文件）
  runtime/     记忆、人格、状态、安全、滤网、反射、可观测性
scripts/       自检与存量治理（link-check / filter-sweep）
connectors/    vpet（MOD 桥 + WPF 壳）、android、desktop
web/           星图页面（纯静态）
tests/         13 个测试文件
docs/          设计文档、实现核对、评估、检测报告
```

## 文档

- [设计文档](docs/dsh-daughter-design.md)——数据模型、检索算法、接口契约、里程碑
- [实现核对](docs/dsh-daughter-实现核对.md)——完成度、代码落点、剩余缺口
- [记忆 / 情感评估](docs/dsh-daughter-记忆情感评估.md)——真实数据体检与改进优先级
- [检测报告](docs/dsh-daughter-检测报告.md)——适配性与联动性自检结果

## 当前状态

P0–P8 已落地并核对；P9 外部连接 3/7（桌宠 / Android / 桌面已通，QQ、抖音、Minecraft、单机待适配器）。已知短板与后续优先级见上面两份文档。

## 隐私

`brain/`、`logs/`、`archive/`、`star_map/` 与 `docs/screenshots/` 均已排除在版本库之外：它们包含真实对话记忆、人格状态与界面截图，只在本地生成。首次运行会自动创建，无需手工准备。

## License

尚未指定。如需开源分发，请补充 `LICENSE`。
