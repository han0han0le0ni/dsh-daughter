# dsh-daughter 0.8.1 更新说明

> 基线：0.8.0 · 日期：2026-11-21
> 修复：意见反馈在部分 Windows 环境下无法自动同步到仓库 Issue。

## 问题

0.8.0 的意见反馈面板在提交时提示「同步失败：fetch failed」。根因是这些环境的 HTTPS 代理使用本机证书链，而 Node 内置 `fetch` 只信任自带 CA，TLS 校验会在发请求前就失败；反馈本身已经正确写入本地队列，预填 GitHub Issue 的兜底路径可用，但自动同步失效。

## 修复

- `src/runtime/feedback.ts`：`submitToGitHub` 在 `fetch` 失败时自动改用系统 `curl.exe` 重试。
- Windows 下给 curl 加 `--ssl-no-revoke`，走 Windows 证书链；其他平台只使用普通 curl 配置。
- GitHub 令牌只通过 curl 的 stdin 配置传入，不进命令行参数、不写文件、不写日志；原本不依赖令牌的预填链接兜底保持不变。
- 明确区分错误类型：HTTP 错误继续显示「GitHub 返回 <状态码>」，网络层失败显示具体原因，不再只给一句 `fetch failed`。
- 「重试同步待发条目」同样受益：之前留在队列里的待同步反馈，在升级后点一次即可补发。

## 验证

| 检查 | 结果 |
|---|---|
| `npm test` | 309/309 |
| `npm run typecheck` | 0 错 |
| `npm run build` | 通过 |
| `npm run check:link` | PASS 22 / WARN 0 / FAIL 0 |
| curl 回退链路 | 用无效令牌触发回退，成功到达 GitHub API 并返回 `GitHub 返回 401`（证明 TLS 链路已打通，不会再是 `fetch failed`） |

## 升级说明

- 0.8.0 → 0.8.1 只改反馈同步通道，设置分区、137 项开关、界面与主题均无变化。
- 已有反馈记录不会因为升级丢失；本地队列继续保留。
- 如果用户本机没有 GitHub 登录态，行为与 0.8.0 一致：返回预填 Issue 链接。
