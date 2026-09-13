# yt-summary-worker

YouTube 频道新视频监控 → Gemini 总结 → 企业微信推送（Cloudflare Worker）

## 功能
- 定时/手动抓取 YouTube 频道 RSS，识别新视频
- 字幕优先 → Gemini 直连 YouTube → 标题+描述，三层兜底
- Gemini 3.x 模型链 + 指数退避重试 + 单视频超时预算（绝不卡死 Worker）
- 结构化摘要推送到企业微信机器人

## 部署

### 1. 安装 wrangler
```bash
npm install -g wrangler
wrangler login
```

### 2. 创建 KV（去重用）
```bash
wrangler kv:namespace create "KV"
# 把输出的 id 填到 wrangler.toml 的 kv_namespaces.id
```

### 3. 设置加密变量
```bash
wrangler secret put GEMINI_API_KEY   # Google AI Studio 申请的 key
wrangler secret put WECOM_WEBHOOK    # 企业微信机器人 webhook URL
wrangler secret put API_TOKEN        # 自定义访问令牌（手动触发用）
```

### 4. 配置 wrangler.toml
- `CHANNELS`：你的 YouTube channel_id 列表
- `GEMINI_MODELS`：模型兜底链，**务必改成你账号实际可用的 Gemini 3.x 模型**
- `BATCH_SIZE`：每次处理几个（默认 3）
- `THROTTLE_MS`：视频间隔（默认 2000ms）
- `[triggers] crons`：定时时间（默认 UTC 22:00 = 北京 06:00）

### 5. 部署
```bash
git add .
git commit -m "deploy"
git push   # 若绑定 GitHub，自动部署；否则 wrangler deploy
```

## 使用

```bash
# 手动触发（同步，限 BATCH_SIZE 个）
curl "https://<your-worker>.workers.dev/run-once?token=<API_TOKEN>"

# 健康检查
curl "https://<your-worker>.workers.dev/health"

# 查看变量配置
curl "https://<your-worker>.workers.dev/debug/env?token=<API_TOKEN>"

# 实时日志
wrangler tail
```

## 常见问题

### Gemini 报 404 "model no longer available"
→ 模型已停服。**改 `GEMINI_MODELS` 为你账号当前可用的 Gemini 3.x**（参考 AI Studio 控制台）。

### 字幕源全部失败
→ 公共字幕 API 不稳定是常态，会自动降级到 Gemini 直连/标题兜底。
→ 可自行替换 `buildTranscriptSources()` 里更稳定的源。

### Worker 被 canceled / 60s 超时
→ 已加 `PER_VIDEO_BUDGET`（默认 55s）超时降级，不会卡死；
→ 若仍出现，把 `BATCH_SIZE` 调小（如 1-2），Cron 放凌晨低峰。

### 企业微信收不到消息
→ 检查 `WECOM_WEBHOOK` 是否正确、机器人是否被封；
→ 看 `wrangler tail` 里 `[pushWeCom]` 日志。

## 架构说明
```
RSS → 新视频检测(KV去重)
  → 字幕多源 → Gemini 文本总结   [Layer 1，最稳]
  → Gemini 直连 YouTube          [Layer 2]
  → 标题+描述兜底                 [Layer 3]
  → 全部失败：发简版提示           [绝不静默]
→ 企业微信推送
```
