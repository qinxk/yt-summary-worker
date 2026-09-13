# GitHub + Cloudflare Workers 自动部署

## 一次性配置

### 1. Cloudflare 侧
1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com)，进入 **Workers & Pages**
2. 创建 API Token：**My Profile → API Tokens → Create Token**
   - 模板选 **Edit Cloudflare Workers**
   - 记下 Token（只显示一次）
3. 在 Workers 页面右侧找到 **Account ID**（页面 URL 里也有）

### 2. GitHub 侧（仓库 Settings → Secrets and variables → Actions）
添加两个 Repository Secret：
- `CF_API_TOKEN` = 上面的 API Token
- `CF_ACCOUNT_ID` = 上面的 Account ID

### 3. 加密变量（必须，否则 Worker 跑不起来）
在 Cloudflare Dashboard → Workers → `yt-summary-worker` → **Settings → Variables**
添加以下 **Secret** 类型变量（不要明文进仓库）：
- `GEMINI_API_KEY` = Google AI Studio 的 key
- `WECOM_WEBHOOK` = 企业微信机器人 webhook URL
- `API_TOKEN` = 自定义访问令牌（手动触发 `/run-once?token=xxx` 用）

> ⚠️ GitHub Actions 的 CI 环境**没有这些 secret**，只负责 `wrangler deploy` 上传代码；
> 运行时变量必须在 Cloudflare Dashboard 里配好。

### 4. KV 命名空间
- 在 Cloudflare Dashboard → Workers → **KV** 创建一个 namespace（如 `yt-summary-kv`）
- 把 namespace ID 填到 `wrangler.toml` 的 `[[kv_namespaces]] id` 和 `preview_id`

## 自动部署流程
- `git push` 到 `main` → GitHub Actions 自动 `wrangler deploy` → 线上更新
- 开 PR → 自动 `deploy --dry-run`（预览，不真正发布）

## 验证
```bash
wrangler tail                                          # 看实时日志
curl "https://<worker>.workers.dev/health"             # 健康检查
curl "https://<worker>.workers.dev/run-once?token=<API_TOKEN>"  # 手动触发
```
