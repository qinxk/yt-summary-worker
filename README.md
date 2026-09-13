# yt-summary-worker（Gemini 直连版）

## 原理
1. Cron / 手动触发 → 拉 YouTube RSS 拿到新视频
2. **直接把 YouTube 链接丢给 Gemini**（`file_data.file_uri`），由 Google 自己去取字幕/音轨/画面
3. Gemini 返回中文摘要 → 推企业微信
4. 若 Gemini 直连失败 → 降级用「标题+描述」再总结一次

不再爬第三方字幕接口，彻底绕开限流。

## 部署步骤

### 1. 改 wrangler.toml
把 `YOUR_KV_NAMESPACE_ID` 换成你真实的 KV 命名空间 ID（Dashboard → Workers → KV）。

### 2. 设置加密变量（3 个，不要写进代码）
```bash
npx wrangler secret put GEMINI_API_KEY   # AI Studio 拿到的 AIzaSy...
npx wrangler secret put API_TOKEN        # 自己编一个随机串，触发用
npx wrangler secret put WECOM_WEBHOOK    # 企业微信机器人完整 URL
```

### 3. 安装 wrangler（首次）
```bash
npm install -g wrangler
wrangler login
```

### 4. 部署
```bash
git add .
git commit -m "feat: 改用 Gemini 直连 YouTube 总结"
git push
```
或本地直接 `wrangler deploy`。

### 5. 验证
```bash
# 健康检查
curl https://kgchaos.eu.cc/health

# 变量自查（确认 GEMINI key 已注入）
curl "https://kgchaos.eu.cc/debug/env?token=你的API_TOKEN"

# 手动触发
curl "https://kgchaos.eu.cc/run-once?token=你的API_TOKEN"
```

看日志：
```bash
npx wrangler tail
```

## 关于 Gemini YouTube 直连
- 用的是 Gemini API 的 `file_data.file_uri` 能力（preview 功能）
- 模型用 `gemini-2.5-flash`：免费层够个人定时任务用
- 若某个视频地区/版权限制导致直连失败，会自动降级到「标题+描述」简版

## 目录
- src/index.js    主代码（整文件替换）
- wrangler.toml   配置（改 KV id + 明文变量）
