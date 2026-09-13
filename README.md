# YouTube Digest → WeCom（Cloudflare Workers）

每天定时监控 YouTube 频道新视频 → LLM 摘要 → 推送到**个人微信**。

**部署方式**：GitHub 关联 Cloudflare，push 代码自动部署。

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

### 3. 配置环境变量
Dashboard → Worker → Settings → **Variables and Secrets**

| 变量 | 说明 |
|------|------|
| `API_TOKEN` | 手动触发密钥（`/?token=xxx`） |
| `WECOM_WEBHOOK` | 企业微信群机器人 Webhook |
| `CHANNELS` | `["UCxxx","UCyyy"]` |
| `LLM_KEY` | LLM API Key（用 Workers AI 可省） |

### 4. 创建 KV 命名空间
```bash
wrangler kv:namespace create YTKV
# 把返回的 ID 填入 wrangler.toml
```

### 5. Push → 自动部署 ✅
```bash
git commit -am "update" && git push
# Cloudflare 自动拉取部署，约 30 秒
```

---

## 手动触发测试
```
https://your-worker.workers.dev/?token=你的API_TOKEN
```

## 文档
- [GITHUB_SETUP.md](./GITHUB_SETUP.md) — GitHub 关联部署完整指南
- [.github/workflows/deploy.yml](./.github/workflows/deploy.yml) — GitHub Actions 工作流
