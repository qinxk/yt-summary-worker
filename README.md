# yt-summary-worker

YouTube 频道新视频监控 → Gemini 总结 → 企业微信推送（Cloudflare Worker）

## 功能
- 定时 / 手动抓取 YouTube 频道 RSS，识别新视频（KV 去重，按已处理 ID 集合）
- **字幕优先 → Gemini 直连 → 标题+描述**，三层兜底
- Gemini 模型链（2.5-flash 主力 + 3.x 预览兜底）+ 指数退避 + 单视频超时预算（绝不卡死 Worker）
- 结构化摘要推送到企业微信机器人（自动按 4096 字节上限截断）

## 字幕获取

按顺序尝试，任一成功即停：

| 优先级 | 源 | 说明 |
|--------|-----|------|
| 1 | YouTube 官方 `timedtext` | 无需第三方，依次试 zh-Hans / zh / en + 自动字幕(asr) |
| 2 | Invidious 实例 | 先取字幕清单，再按语言优先级下载 VTT，用 `INVIDIOUS_HOSTS` 配置 |
| 3 | 自定义 API | `TRANSCRIPT_APIS`，`{id}` 替换为 videoId |

支持 **WebVTT / timedtext XML / JSON** 三种返回格式（按内容嗅探，不假定 JSON）。
字幕带 `[MM:SS]` 时间戳一起喂给模型，摘要里的时间标记是真实的而非编造。

全部字幕源失败时自动降级到 Gemini 直连视频，再失败则用标题+描述，绝不静默跳过。

### 字幕拿不到怎么办
1. `wrangler tail` 看日志里每个源的失败原因
2. 公共 Invidious 实例经常挂，从 `INVIDIOUS_HOSTS` 里换掉失效的
3. 视频本身没字幕（未开自动字幕）→ 会走 Gemini 直连，属正常降级
4. 想要更稳可自建字幕服务，填到 `TRANSCRIPT_APIS`

## 本地测试
```bash
node test-local.js   # 解析逻辑单测（VTT/XML/实体/时区/截断）
node test-flow.js    # 端到端流程（mock fetch + KV，含降级与幂等）
```

## 部署

### 1. 安装 wrangler
```bash
npm install -g wrangler
wrangler login
```

### 2. 创建 KV（去重用）
```bash
wrangler kv:namespace create "KV"
# 把输出的 id 填到 wrangler.toml 的 kv_namespaces.id / preview_id
```

### 3. 设置加密变量
```bash
wrangler secret put GEMINI_API_KEY    # Google AI Studio 申请的 key
wrangler secret put WECOM_WEBHOOK     # 企业微信机器人 webhook URL
wrangler secret put API_TOKEN         # 自定义访问令牌（手动触发用）
```

### 4. 修改 wrangler.toml（**只需改这 2 处**）
- `CHANNELS`：你的 YouTube channel_id（逗号分隔或 JSON 数组）
- `kv_namespaces.id`：上一步创建的 KV ID

`GEMINI_MODELS` 默认值已对齐 2026 年免费可用清单，**一般不用改**：
```toml
GEMINI_MODELS = '["gemini-2.5-flash","gemini-2.5-flash-lite","gemini-flash-latest","gemini-3-flash-preview"]'
```

> 想确认你的 key 到底能用哪些模型，跑一次：
> ```bash
> curl "https://generativelanguage.googleapis.com/v1beta/models?key=$GEMINI_API_KEY"
> ```
> 把返回名（去掉 `models/` 前缀）写进 `GEMINI_MODELS` 即可。**删掉报 404 的，留确定能用的**。

### 5. 部署
```bash
git add .
git commit -m "deploy"
git push   # 绑定 GitHub 则自动部署；否则 wrangler deploy
```

## 本地自检（部署前推荐跑一次）

```bash
node test-runtime.js
# 会校验：CHANNELS 解析、模型链、HTML 拦截、parseFeed（media:description）、Prompt 等
# 全部 ✅ 再部署，避免"部署了才发现字段是空的"
```

## 使用

```bash
# 手动触发（同步，限 BATCH_SIZE 个，推荐先用这个测试）
curl "https://<your-worker>.workers.dev/run-once?token=<API_TOKEN>"

# 健康检查
curl "https://<your-worker>.workers.dev/health"

# 查看变量配置（排查 CHANNELS 为空 / key 未设置等）
curl "https://<your-worker>.workers.dev/debug/env?token=<API_TOKEN>"

# 实时日志
wrangler tail
```

## 常见问题

### 报 `CHANNELS 为空`
→ `wrangler.toml` 的 `CHANNELS` 没填，或格式不对。支持 `"UCxxx"` 或 `["UCxxx"]`。

### Gemini 报 404 "model no longer available"
→ 模型名在你账号不可用。**从 `GEMINI_MODELS` 删掉该名字**即可，不影响其它模型继续尝试。

### 频繁 503 / timeout / "Gemini 繁忙"
→ 免费层晚高峰（北京 19-23 点）限流是常态。
- Cron 已默认放 **UTC 22:00 = 北京 06:00**，错峰跑最稳；
- 手动测试建议早上跑；
- 要彻底稳：开 Google AI Studio 付费层（Flash 极便宜）。

### 字幕源全部失败
→ 公共字幕 API 不稳定是常态，会自动降级到 L2/L3。**可自行替换 `buildTranscriptSources()` 里更稳定的源**（自建代理最稳）。

### Worker 被 canceled / 60s 超时
→ 已加 `PER_VIDEO_BUDGET`（55s）超时降级，不会卡死；
→ 若仍出现，把 `BATCH_SIZE` 调小（如 1-2），Cron 放凌晨。

### 企业微信收不到消息
→ 检查 `WECOM_WEBHOOK`、机器人是否被封；看 `wrangler tail` 里 `[pushWeCom]` 日志。

## 架构
```
RSS → 新视频检测 (KV 去重)
  → L1 字幕多源 → Gemini 文本总结     [最稳，优先]
  → L2 Gemini 直连 YouTube            [视频理解]
  → L3 标题 + 描述兜底                 [无内容时]
  → 全失败：发简版提示                  [绝不静默]
→ 企业微信推送
```

## 目录结构
```
yt-summary-worker/
├── src/index.js         # 全部逻辑（单文件，可直接替换）
├── wrangler.toml        # 配置：CHANNELS / 模型链 / 批次 / Cron
├── test-local.js        # 本地配置解析测试（可选）
├── test-runtime.js      # 集成自检：node test-runtime.js
└── README.md
```
