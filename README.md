# YouTube Digest → WeCom（Cloudflare Workers）

每天定时监控 YouTube 频道新视频 → LLM 摘要 → 推送到**个人微信**。

**部署方式**：GitHub 关联 Cloudflare，push 代码自动部署。

---

## 架构

```
Cron 每日触发 (UTC 23:00 = 北京 07:00)
  → 拉频道 RSS (无需 API Key)
  → KV 去重 (只处理新视频)
  → 提取字幕 (youtube-transcript.ai)
  → LLM 总结 (Workers AI 优先 → LLM_URL 兜底)
  → 企业微信 Webhook 推送 → 个人微信
```

---

## 快速开始

### 1. 克隆 & 推送 GitHub
```bash
git init && git add . && git commit -m "init"
git remote add origin https://github.com/<you>/yt-summary-worker.git
git push -u origin main
```

### 2. Cloudflare 关联 GitHub（推荐）
> Dashboard → Workers → 你的 Worker → Settings → Integrations → Connect GitHub

详见 **[GITHUB_SETUP.md](./GITHUB_SETUP.md)**

### 3. 创建 KV 命名空间（一次性）
```bash
wrangler kv:namespace create "YTKV"
# 复制返回的 ID，填入 wrangler.toml 的 [[kv_namespaces]] id 字段
```
或在 Cloudflare Dashboard → **存储和数据库 → Workers KV** 创建，再到 Worker → Settings → **绑定** 里绑定（变量名填 `KV`）。

### 4. 配置变量（双层策略，重要！）

**非敏感变量（写在 `wrangler.toml` 的 `[vars]` 段，随代码部署，不会被删）**：
```toml
[vars]
CHANNELS  = '["UCkHrq03gWLLx6vjS2DOJ8aA"]'
LLM_URL   = "https://one.iflytek.com/api/llm/console/chat/v1"
LLM_MODEL = "claude-opus-5"
```

**敏感变量（在 Cloudflare Dashboard → Worker → Settings → Variables and Secrets 设为「加密」）**：
| 变量 | 说明 |
|------|------|
| `API_TOKEN` | 手动触发密钥（`?token=xxx`） |
| `WECOM_WEBHOOK` | 企业微信群机器人 Webhook |
| `LLM_KEY` | LLM API Key |

> ⚠️ **为什么非敏感变量要写进 `wrangler.toml`？**
> 因为 `wrangler deploy` 会用本地 toml 覆盖 Dashboard 的**同名**变量。
> 之前你遇到的「变量被自动删掉」就是这个原因——只要写在 toml 里，每次部署都会重新设置，不会再丢。

### 5. Push → 自动部署 ✅
```bash
git commit -am "update" && git push
# Cloudflare 自动拉取部署，约 30 秒
```

---

## 路由说明

| 路径 | 鉴权 | 用途 |
|------|------|------|
| `GET /health` | 免 | 健康检查，确认 Worker 在线 |
| `GET /debug/env?token=xxx` | 需 | 打印变量绑定情况（不暴露密钥明文） |
| `GET /run-once?token=xxx` | 需 | 手动触发一次 digest |
| `GET /?token=xxx` | 需 | 兼容旧入口 |

---

## 手工测试（基于你的实际域名 `kgchaos.eu.cc`）

> 你的 workers.dev 已禁用，使用自定义域 `https://kgchaos.eu.cc`。

```bash
# 1. 健康检查（免鉴权，应返回 {"status":"ok",...}）
curl https://kgchaos.eu.cc/health

# 2. 变量自查（需 token，确认 CHANNELS/LLM/KV 都绑定上了）
curl "https://kgchaos.eu.cc/debug/env?token=你的API_TOKEN"

# 3. 手动触发任务（应返回 {"status":"triggered"}，稍后看微信）
curl "https://kgchaos.eu.cc/run-once?token=你的API_TOKEN"
```

本地测试：
```bash
cp .dev.vars.example .dev.vars  # 填入真实密钥
npx wrangler dev
# 另开终端
curl http://localhost:8787/health
curl "http://localhost:8787/run-once?token=xxx"
```

---

## 排错顺序

1. `/health` 不通 → Worker 没部署好 / 域名不对
2. `/debug/env` 里 `hasKV:false` → KV 没绑定或命名空间 ID 错
3. `/debug/env` 里 `channels:[]` → CHANNELS 格式错（必须是 JSON 数组字符串）
4. `/run-once` 有日志但微信没消息 → Webhook 地址/格式错
5. 有字幕但 LLM 没返回 → LLM_URL / LLM_KEY / 模型名错（看 Worker 日志）

---

## 文档
- [GITHUB_SETUP.md](./GITHUB_SETUP.md) — GitHub 关联部署完整指南
- [.github/workflows/deploy.yml](./.github/workflows/deploy.yml) — GitHub Actions 工作流
