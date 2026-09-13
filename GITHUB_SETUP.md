# 关联 GitHub 自动部署到 Cloudflare

目标：**push 代码到 GitHub → Cloudflare 自动构建部署**，告别手动 `wrangler deploy`。

---

## 一、方案对比：3 种方式

| 方式 | 触发 | 推荐度 | 说明 |
|------|------|--------|------|
| **Cloudflare Workers GitHub App** | push 到指定分支 | ⭐⭐⭐⭐⭐ | 官方集成，零配置，自动 CI/CD |
| **GitHub Actions + Wrangler** | push / PR | ⭐⭐⭐⭐ | 更灵活，可加测试/多环境 |
| **Direct Upload（Wrangler）** | 手动 | ⭐⭐ | 就是你现在的方式 |

> **推荐第一种**：Cloudflare 官方 GitHub App，绑定后 push 即部署，生产环境适用。

---

## 二、方式一：Cloudflare GitHub App（推荐，5 分钟）

### 1. 准备工作
- 把项目推到 GitHub 仓库（假设 `your-org/yt-summary-worker`）
- 确保仓库是 **public** 或你有 Cloudflare 对应权限

### 2. 安装 GitHub App
1. 登录 [dash.cloudflare.com](https://dash.cloudflare.com)
2. 进入 **Workers & Pages** → 你的 Worker → **Settings** → **Integrations**
3. 点击 **Connect GitHub** → 授权 Cloudflare 访问你的 GitHub 账号
4. 选择要关联的仓库 `yt-summary-worker`

### 3. 配置构建
Cloudflare 会自动检测 `wrangler.toml`。检查以下设置：
- **Production branch**：`main`（或你发布用的分支）
- **Build command**：留空（Workers 不需要 build，wrangler 直接上传）
- **Deploy command**：自动使用 `wrangler deploy`

### 4. 配置环境变量（一次性）
> ⚠️ GitHub App 部署**不会**自动读取你本地 `.dev.vars`，需要在 Cloudflare Dashboard 设置：

**路径**：Worker → Settings → **Variables and Secrets**

添加以下（敏感项点 🔒 Encrypt）：
| 变量名 | 值 | 类型 |
|--------|-----|------|
| `API_TOKEN` | 随机密钥 | Secret |
| `WECOM_WEBHOOK` | 群机器人 Webhook 地址 | Secret |
| `LLM_KEY` | OpenAI 兼容 API Key | Secret |
| `LLM_URL` | `https://api.openai.com/v1/chat/completions` | Text |
| `LLM_MODEL` | `gpt-4o-mini` | Text |
| `CHANNELS` | `["UCxxx","UCyyy"]` | Text |

> KV 命名空间在 Cloudflare 后台绑定一次即可，后续部署自动沿用。

### 5. 验证
```bash
# 本地改一行代码
echo "# test" >> README.md
git add . && git commit -m "test: trigger deploy"
git push origin main
```
回到 Cloudflare Dashboard → **Deployments** 标签页，应看到新的部署记录，状态变绿即成功。

---

## 三、方式二：GitHub Actions（更灵活）

如果你想要 PR 预览、多环境、跑测试等，用 GitHub Actions。

### `.github/workflows/deploy.yml`
```yaml
name: Deploy to Cloudflare Workers

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy Worker
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          accountId: ${{ secrets.CF_ACCOUNT_ID }}
          # PR 评论预览，main 分支正式部署
          command: |
            if [ "${{ github.ref }}" = "refs/heads/main" ]; then
              wrangler deploy
            else
              wrangler deploy --dry-run --outdir ./preview
            fi
        env:
          # 注入 secrets 为环境变量
          API_TOKEN: ${{ secrets.API_TOKEN }}
          WECOM_WEBHOOK: ${{ secrets.WECOM_WEBHOOK }}
          LLM_KEY: ${{ secrets.LLM_KEY }}
          CHANNELS: ${{ secrets.CHANNELS }}
```

### GitHub Repository Secrets 配置
路径：**Settings → Secrets and variables → Actions → New repository secret**

| Secret 名 | 值 |
|-----------|-----|
| `CF_API_TOKEN` | Cloudflare API Token（见下方获取方式） |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID（Dashboard 右侧栏） |
| `API_TOKEN` | Worker 手动触发密钥 |
| `WECOM_WEBHOOK` | 企业微信群机器人 Webhook |
| `LLM_KEY` | LLM API Key |
| `CHANNELS` | `["UCxxx","UCyyy"]` |

#### 获取 CF_API_TOKEN
1. Cloudflare Dashboard → **My Profile** → **API Tokens**
2. 点击 **Create Token** → 选模板 **"Edit Cloudflare Workers"**
3. 复制生成的 token（只显示一次）

---

## 四、完整操作流程（推荐方案一）

### 1. 初始化 Git 仓库
```bash
cd yt-summary-worker
git init
git add .
git commit -m "feat: initial commit - YouTube digest worker"
```

### 2. 创建 GitHub 仓库并推送
```bash
# 在 GitHub 网页创建仓库 yt-summary-worker（不要勾选 README）
git remote add origin https://github.com/你的用户名/yt-summary-worker.git
git branch -M main
git push -u origin main
```

### 3. Cloudflare 关联（见上方「方式一」步骤 2-4）

### 4. 之后开发流程
```bash
# 改代码 → 提交 → 自动部署
vim src/index.js
git add . && git commit -m "fix: improve transcript extraction"
git push
# Cloudflare 自动拉取、部署，约 30 秒完成
```

---

## 五、环境变量管理最佳实践

| 环境 | 管理方式 | 说明 |
|------|----------|------|
| 本地开发 | `.dev.vars`（不入 git） | wrangler dev 自动读取 |
| Cloudflare 生产 | Dashboard → Variables and Secrets | GitHub App 部署时自动注入 |
| GitHub Actions | Repository Secrets | workflow 中通过 `${{ secrets.X }}` 引用 |

> ⚠️ **永远不要把真实密钥写进代码或 `.dev.vars` 后提交到 git**。

---

## 六、常见问题

**Q：push 后 Cloudflare 没有自动部署？**
- 检查 GitHub App 是否授权了对应仓库
- Dashboard → Integrations → 确认仓库在列表中
- 查看 GitHub → Settings → Integrations → Cloudflare Workers → 是否有组织/仓库权限

**Q：环境变量没生效？**
- GitHub App 部署时，**必须**在 Cloudflare Dashboard 手动设置变量（它不会读 GitHub Secrets）
- 改完变量后需要重新触发一次部署

**Q：想区分开发/生产环境？**
- 方式一：Cloudflare 支持 Preview Deployment（PR 预览）
- 方式二：GitHub Actions 中用 `wrangler deploy --env staging`

**Q：KV 绑定需要在 Cloudflare 后台创建吗？**
- 是的，KV 命名空间必须在 Cloudflare 后台创建一次，`wrangler.toml` 中填入 ID。之后所有部署自动沿用。
