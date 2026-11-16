# dsh-daughter 0.8.0 更新说明

> 基线：0.7.1（`c544a4a`） · 日期：2026-11-16
> 本轮只做两件事：**把常用开关搬进 DSH 设置界面**，以及**加一个能直接送到仓库意见区的反馈窗口**。外部应用接入计划本轮不动。

## 一、设置界面

- **DSH 设置弹窗左侧新增「daughter设置」分区**（`settings.section`，`/daughter-settings/`）：137 项开关/数值按 6 组展示（记忆与检索 / 联想与连续性 / 情感与表达 / 学习与技能 / 安全与隐私 / 记忆维护与性格）。半透明简约界面，支持白/暗双主题（选择记在本地并同步到意见反馈页），标签栏置顶不随页面滚动，鼠标悬停显示作用、配置路径与取值范围；改完即写入 `settings/overrides.json`，并尝试作用于运行中的插件；每项可「恢复默认」。
- 同时保留 `Config` schema（`index.js`）：按 `config.yaml` 实际值声明整棵配置树，「插件 → 插件配置 → dsh-daughter」的原生 cordis 表单仍可用于细粒度调整；未展示的高级字段 `hidden` 但仍完整声明，不会被 `simplify(config)` 洗掉。
- 字段表唯一真源是 `src/runtime/settings-ui.ts`，设置面板与 Config schema 共用，新增开关只改一处。
- 依赖新增 `@deepseek-ai/schemastery@^3.19.0`，客户端声明 `-ui-slots`、`-locale`、`-ui-renderer` 以注册设置分区。
- 部分运行时开关（`reflex.short_circuit` 等）需要重启宿主后完全生效。

## 二、意见反馈

- 「daughter设置」分区内嵌「意见反馈」标签（`/feedback/`）；侧边栏入口已移除，不占面板位。表单支持类型、标题、正文、可选联系方式与自愿勾选的环境信息。
- 提交后先写入 `logs/feedback/queue.jsonl` 留痕；状态接口 `/feedback/api/status` 显示已同步 / 待同步条数。
- **自动同步**：本机登录过 GitHub CLI（`gh auth login`）或设置 `DSH_GITHUB_TOKEN` 时，插件直接调用 GitHub REST 在 `han0han0le0ni/dsh-daughter` 建 Issue，并把 Issue 链接回显给用户。
- **无令牌兜底**：返回预填好标题与正文的 GitHub Issue 链接，用户在浏览器完成最后一步；之后拿到令牌可在面板里点「重试同步待发条目」补发，已同步的不重复发送。
- 隐私：联系方式与环境信息由用户自愿填写；不上传记忆库、对话正文或令牌；令牌只从环境变量或 `gh auth token` 读取，不写队列、不进日志、不回传给前端。
- 所有反馈路由与星图一致，先过宿主 `connection.requestRejection` 准入；请求体上限 64KB，正文限 5000 字。

## 三、验证

| 检查 | 结果 |
|---|---|
| `npm test` | 309/309（新增 `tests/feedback-submit.test.ts` 6 项、`tests/settings-ui.test.ts` 4 项） |
| `npm run typecheck` | 0 错 |
| `npm run build` | 通过 |
| `npm run check:link` | PASS 22 / WARN 0 / FAIL 0 |
| `npm run docs:sync -- --check` | 通过 |
| 路由冒烟 | `/feedback/` 与 `/feedback/api/status` HTTP 200；设置页面与 API 已编译进 `dist/host.js` |

## 四、升级说明

- 0.7.1 → 0.8.0 只新增设置 schema 与反馈面板，不改记忆/人格/情绪算法，旧数据无需迁移。
- 安装后先在「插件配置」里确认开关状态；原先改在 `config.yaml` 的值仍是基线，宿主表单只保存差异。
- 若希望反馈自动进入仓库意见区，需用户本机具备 GitHub 登录态；否则走预填链接，功能不阻塞。
- 发布状态：代码已提交 `41fa442` 并推送 main；注解 tag `v0.8.0` 已推送；GitHub Release 已发布（更新公告：https://github.com/han0han0le0ni/dsh-daughter/releases/tag/v0.8.0）。npm 发布与市场索引 `market/index.json` 更新仍待执行（需先拿到 npm `time[0.8.0]`）。
