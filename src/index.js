// YouTube Digest → Summary → WeCom Bot Worker
//
// 架构（稳定性优先）：
//   RSS 拿新视频
//     → 字幕优先（invidious/captions-api，纯文本喂 Gemini，最稳）
//     → 字幕失败 → Gemini 直连 YouTube（视频理解，兜底）
//     → 都失败 → 标题+描述 降级
//   Gemini：模型兜底链 + 指数退避重试
//   推送：企业微信（结构化 markdown）
//
// 关键稳定性设计：
//   - 严格串行 + 节流（避免打爆免费层 10-15 RPM）
//   - 单次请求 20s 超时
//   - 503/429 指数退避 + jitter，最多 3 次
//   - 模型链：flash → flash-lite → 2.0-flash，容量按模型隔离
//   - 分批处理（BATCH_SIZE），KV 记录进度，避免一次 15 条
//   - Cron 建议放凌晨（避开高峰）
//
// 路由：
//   GET /health             免鉴权
//   GET /debug/env?token=x  查变量
//   GET /run-once?token=x   手动触发（同步、限 BATCH_SIZE 个）
//   GET /?token=x           兼容入口
//
// 加密变量（wrangler secret put）：
//   GEMINI_API_KEY
//   WECOM_WEBHOOK
//   API_TOKEN
// [vars]（wrangler.toml 明文）：
//   GEMINI_MODELS = '["gemini-2.5-flash","gemini-2.5-flash-lite","gemini-2.0-flash"]'
//   CHANNELS      = '["UCxxx"]'
//   BATCH_SIZE    = "3"      // 每次最多处理几个视频
//   THROTTLE_MS   = "2000"   // 每条之间间隔

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT = 20000; // 单次请求超时
const MAX_RETRIES = 3; // 每模型重试次数（含首次 = 最多 4 次/模型）
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

// 字幕源（免费，多源轮询）
const TRANSCRIPT_SOURCES = [
  // 1) youtube-captions vercel 接口
  (videoId) =>
    `https://youtube-captions-api.vercel.app/api/captions?videoId=${videoId}&lang=zh-Hans,zh,en`,
  // 2) invidious 多实例
  ...['https://invidious.io.lol', 'https://yewtu.be', 'https://invidious.privacydev.net'].map(
    (base) => (videoId) => `${base}/api/v1/captions/${videoId}?lang=zh-Hans,zh,en`
  ),
];

export default {
  async scheduled(controller, env, ctx) {
    // Cron：全量分批处理（最长 15 分钟）
    ctx.waitUntil(
      runDigest(env, { limit: Infinity }).then((results) => {
        console.log('[scheduled] done', JSON.stringify(results));
      })
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/health') {
      return Response.json({ status: 'ok', time: new Date().toISOString() });
    }

    if (path === '/debug/env') {
      if (url.searchParams.get('token') !== env.API_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      return Response.json({
        hasKV: !!env.KV,
        hasGeminiKey: !!env.GEMINI_API_KEY,
        models: getModels(env),
        channels: safeParseChannels(env.CHANNELS),
        batchSize: getBatchSize(env),
        hasWeCom: !!env.WECOM_WEBHOOK,
        hasAPIToken: !!env.API_TOKEN,
      });
    }

    if (url.searchParams.get('token') !== env.API_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (path === '/run-once' || path === '/') {
      const start = Date.now();
      const results = await runDigest(env, { limit: getBatchSize(env) });
      return Response.json({
        status: 'done',
        costMs: Date.now() - start,
        note: `已处理最新 ${getBatchSize(env)} 个，剩余留给下次 Cron`,
        results,
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ==================== 主流程 ====================
async function runDigest(env, opts = {}) {
  const limit = opts.limit != null ? opts.limit : Infinity;
  console.log('[runDigest] start, limit:', limit);
  ensureConfig(env);

  const channels = safeParseChannels(env.CHANNELS);
  const results = [];

  if (!channels.length) {
    return [{ status: 'error', error: 'CHANNELS 为空' }];
  }

  for (const channelId of channels) {
    try {
      const feed = await fetchRSS(channelId);
      console.log('[runDigest] feed count:', feed.length);
      if (!feed.length) {
        results.push({ channel: channelId, status: 'noop', reason: 'feed 为空' });
        continue;
      }

      feed.slice(0, 3).forEach((v, i) => {
        console.log(
          `[runDigest] feed[${i}] title="${v.title}" published="${v.published}" descLen=${v.description.length} channel="${v.channelName}"`
        );
      });

      const lastId = await env.KV.get(`last:${channelId}`);
      console.log('[runDigest] lastId:', lastId);
      const newVideos = [];
      for (const v of feed) {
        if (v.id === lastId) break;
        newVideos.push(v);
      }

      // 分批：limit 以内，且不超过 BATCH_SIZE（全量时按批处理，KV 逐步推进）
      const todo = newVideos.slice(0, Math.min(limit, getBatchSize(env)));
      console.log('[runDigest] newVideos:', newVideos.length, 'todo:', todo.length);

      for (const video of todo) {
        console.log('[runDigest] processing:', video.title);

        // 串行 + 节流（避免并发打爆免费层）
        const summary = await summarizeWithFallback(video, env);
        await pushWeCom(video, summary, env);
        console.log('[pushWeCom] ok');
        results.push({ title: video.title, status: 'ok' });

        // 节流：每条之间等一下
        await sleep(getThrottleMs(env));
      }

      // 推进去重标记：仅全量（Cron）时推进 1 个，分批跑完靠多次 Cron 自然推进
      if (feed[0] && limit === Infinity) {
        await env.KV.put(`last:${channelId}`, feed[0].id);
        console.log('[runDigest] updated lastId:', feed[0].id);
      } else {
        console.log('[runDigest] skip update lastId (partial/limited run)');
      }

      results.push({ channel: channelId, status: 'done', processed: todo.length });
    } catch (err) {
      console.error('[runDigest] channel error:', channelId, err.message);
      results.push({ channel: channelId, status: 'error', error: err.message });
    }
  }

  console.log('[runDigest] finished');
  return results;
}

// ==================== 总结（三层兜底）====================
async function summarizeWithFallback(video, env) {
  // 第 1 层：字幕优先（拿到字幕 → 纯文本喂 Gemini，最稳）
  try {
    const transcript = await getTranscript(video.videoId);
    if (transcript && transcript.length > 100) {
      console.log('[summarize] transcript ok, length:', transcript.length);
      const summary = await summarizeText(transcript, video, env);
      console.log('[summarize] layer1(transcript) ok');
      return summary;
    }
  } catch (e) {
    console.warn('[summarize] layer1 failed:', e.message);
  }

  // 第 2 层：Gemini 直连 YouTube（视频理解）
  try {
    const summary = await summarizeViaGemini(video, env);
    console.log('[summarize] layer2(gemini-direct) ok');
    return summary;
  } catch (e) {
    console.warn('[summarize] layer2 failed:', e.message);
  }

  // 第 3 层：标题 + 描述 降级
  try {
    const summary = await summarizeTextFallback(video, env);
    console.log('[summarize] layer3(fallback) ok');
    return summary;
  } catch (e) {
    console.error('[summarize] layer3 failed:', e.message);
    return `⚠️ 今日 Gemini 繁忙，未生成摘要\n\n标题：${video.title}\n链接：${video.link}`;
  }
}

// ==================== 字幕获取（多源轮询）====================
async function getTranscript(videoId) {
  for (let i = 0; i < TRANSCRIPT_SOURCES.length; i++) {
    const makeUrl = TRANSCRIPT_SOURCES[i];
    const url = makeUrl(videoId);
    try {
      console.log('[transcript] trying source', i + 1, url);
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) {
        console.warn('[transcript] source', i + 1, 'http', res.status);
        continue;
      }
      const data = await res.json();
      let text = '';

      // 适配不同源的结构
      if (typeof data === 'string') {
        text = data;
      } else if (data.transcript) {
        text = data.transcript;
      } else if (Array.isArray(data)) {
        // invidious: [{start, text}]
        text = data.map((s) => s.text || s).join(' ');
      } else if (data.content) {
        text = data.content;
      }

      // 过滤限流提示页
      if (
        text &&
        text.length > 50 &&
        !/高频|rate limit|too many requests|contact|合作方案/i.test(text)
      ) {
        console.log('[transcript] source', i + 1, 'ok, length:', text.length);
        return text.slice(0, 12000);
      }
      console.warn('[transcript] source', i + 1, 'empty or rate-limited');
    } catch (e) {
      console.warn('[transcript] source', i + 1, 'error:', e.message);
    }
  }
  throw new Error('all transcript sources failed');
}

// ==================== Gemini 调用 ====================
// 模型兜底链：依次尝试，某模型 503/429 就换下一个
async function callGeminiWithModelChain(env, buildBody) {
  const models = getModels(env);
  let lastError = '';

  for (const model of models) {
    try {
      const data = await geminiWithRetry(env, model, buildBody(model));
      console.log('[gemini] model', model, 'ok');
      return data;
    } catch (e) {
      console.warn('[gemini] model', model, 'failed:', e.message);
      lastError = e.message;
      // 继续尝试下一个模型
    }
  }
  throw new Error(`all models failed: ${lastError}`);
}

// 单模型 + 指数退避重试
async function geminiWithRetry(env, model, body, attempt = 0) {
  const url = `${GEMINI_ENDPOINT}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error(`timeout after ${REQUEST_TIMEOUT}ms`);
    throw e;
  }
  clearTimeout(timer);

  if (res.ok) return await res.json();

  const status = res.status;
  let detail = '';
  try {
    detail = (await res.json())?.error?.message || '';
  } catch {}

  console.warn(`[gemini] ${model} http ${status} attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${detail}`);

  // 不可重试的错误（key/model 配置错）
  if (!RETRYABLE.has(status)) {
    throw new Error(`Gemini http ${status}: ${detail}`);
  }

  // 重试耗尽
  if (attempt >= MAX_RETRIES) {
    throw new Error(`Gemini retry exhausted: ${status} ${detail}`);
  }

  // 指数退避 + jitter（503 容量问题，短睡 + 随机偏移即可）
  const wait = Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 8000);
  console.log(`[gemini] retry after ${wait}ms`);
  await sleep(wait);
  return geminiWithRetry(env, model, body, attempt + 1);
}

// ---- 纯文本总结（字幕/标题描述通用）----
async function summarizeText(text, video, env) {
  const prompt =
    buildSummaryPrompt() +
    `\n\n以下是视频的字幕/文本内容，请据此总结：\n\n${text}\n\n视频标题：${video.title}`;
  const data = await callGeminiWithModelChain(env, () => ({
    contents: [{ parts: [{ text: prompt }] }],
  }));
  return extractText(data);
}

// ---- Gemini 直连 YouTube ----
async function summarizeViaGemini(video, env) {
  const data = await callGeminiWithModelChain(env, () => ({
    contents: [
      {
        parts: [
          { text: buildSummaryPrompt() },
          { file_data: { file_uri: video.link } },
        ],
      },
    ],
  }));
  return extractText(data);
}

// ---- 标题 + 描述 降级 ----
async function summarizeTextFallback(video, env) {
  const title = video.title?.trim() || '未知标题';
  const description = video.description?.trim() || '';
  const published = video.published || '未知时间';
  const channelName = video.channelName || '未知频道';

  if (title === '未知标题' && !description) {
    return `⚠️ 无法获取视频信息\n\n链接：${video.link}\n请手动观看原视频。`;
  }

  const prompt =
    buildSummaryPrompt() +
    `\n\n注意：仅提供元信息（未直接读取视频内容），请在"一句话结论"后标注"（基于标题与描述整理）"。\n\n` +
    `频道：${channelName}\n发布时间：${published}\n视频标题：${title}\n视频描述：${description || '（无描述）'}\n链接：${video.link}`;

  const data = await callGeminiWithModelChain(env, () => ({
    contents: [{ parts: [{ text: prompt }] }],
  }));
  return extractText(data);
}

function extractText(data) {
  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned empty content');
  return text.trim();
}

// ==================== Prompt ====================
function buildSummaryPrompt() {
  return `你是一个专业的视频内容分析师。请对以下 YouTube 视频进行深度总结，输出中文。

## 第一步：自动识别视频分类
先判断视频属于哪类（财经/经济、社会/时政、科技/互联网、生活/知识、其他），后续侧重点随之调整：
- 财经/经济：数字、趋势、影响范围、政策/市场背景
- 社会/时政：时间线、人物关系、法律/政策背景、后续影响
- 科技/互联网：产品/技术细节、对比、行业影响
- 其他：按核心逻辑提取要点

## 第二步：按固定格式输出（严格使用 Markdown）

### 📌 一句话结论
用一句话概括视频核心观点、事件结果或最重要信息。

### 📋 核心要点（3-5 个）
每个要点：
**要点标题**
- 详细说明（2-3 句，含关键数据、人物、因果关系）
- 时间标记：有明确时间戳才标 [MM:SS]，没有则省略（不要编造）

### 🔍 关键信息 / 值得关注
2-3 条容易被忽略但重要的细节（背景、后续影响、相关方立场、不确定性等）。

### 💬 延伸思考（可选）
仅在适用时输出：不同立场分歧，或给观众的实用建议。

## 全局要求
- 简体中文，不复述标题和链接（消息头部已展示）
- 不要"根据视频内容""以下是总结"等废话前缀，直接给内容
- 区块间空行分隔，便于手机阅读
- 篇幅 500-900 字`;
}

// ==================== RSS ====================
async function fetchRSS(channelId) {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  console.log('[fetchRSS] url:', rssUrl);
  const res = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  console.log('[fetchRSS] xml length:', xml.length);
  console.log('[fetchRSS] preview:', xml.slice(0, 1500));
  return parseFeed(xml);
}

function parseFeed(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries.map((e) => {
    const title = e.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || '';
    const idRaw = e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || '';
    const videoId = idRaw.includes('yt:video:') ? idRaw.split('yt:video:')[1] : idRaw;
    const published =
      e.match(/<published>([\s\S]*?)<\/published>/)?.[1]?.trim() ||
      e.match(/<updated>([\s\S]*?)<\/updated>/)?.[1]?.trim() ||
      '';
    const link = e.match(/<link rel="alternate" href="([^"]+)/)?.[1]?.trim() || '';
    const mediaGroup = e.match(/<media:group>([\s\S]*?)<\/media:group>/)?.[1] || '';
    let description = '';
    if (mediaGroup) {
      description =
        mediaGroup
          .match(/<media:description[^>]*>([\s\S]*?)<\/media:description>/)?.[1]
          ?.trim() || '';
    }
    if (!description) {
      description =
        e.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() ||
        e.match(/<content>([\s\S]*?)<\/content>/)?.[1]?.trim() ||
        '';
    }
    const channelName =
      e.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/)?.[1]?.trim() || '';

    return { id: idRaw, videoId, title, description: description.slice(0, 3000), published, link, channelName };
  });
}

// ==================== 企业微信 ====================
async function pushWeCom(video, summary, env) {
  const webhook = env.WECOM_WEBHOOK;
  if (!webhook) throw new Error('WECOM_WEBHOOK not set');

  const content =
    `## 📺 ${escapeMd(video.title || '（无标题）')}\n` +
    `> 👤 频道：${escapeMd(video.channelName || '未知')}\n` +
    `> 🕐 发布：${formatDate(video.published)}\n` +
    `\n---\n` +
    `${summary}\n` +
    `\n---\n` +
    `[▶️ 观看原视频](${video.link})`;

  const r = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
  });
  const j = await r.json();
  if (j.errcode && j.errcode !== 0) {
    throw new Error(`WeCom push failed: ${JSON.stringify(j)}`);
  }
  return j;
}

function escapeMd(str) {
  if (!str) return '';
  return str.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

function formatDate(iso) {
  if (!iso) return '未知';
  try {
    const d = new Date(iso);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String((d.getUTCHours() + 8) % 24).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch {
    return iso;
  }
}

// ==================== 工具 ====================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureConfig(env) {
  if (!env.GEMINI_API_KEY) console.error('[config] GEMINI_API_KEY 未设置');
  if (!env.WECOM_WEBHOOK) console.error('[config] WECOM_WEBHOOK 未设置');
  if (!env.API_TOKEN) console.error('[config] API_TOKEN 未设置');
}

function getModels(env) {
  try {
    const arr = JSON.parse(env.GEMINI_MODELS || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {}
  return ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
}

function safeParseChannels(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function getBatchSize(env) {
  const n = parseInt(env.BATCH_SIZE, 10);
  return isNaN(n) || n < 1 ? 3 : n;
}

function getThrottleMs(env) {
  const n = parseInt(env.THROTTLE_MS, 10);
  return isNaN(n) || n < 0 ? 2000 : n;
}
