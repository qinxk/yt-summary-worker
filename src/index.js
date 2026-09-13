// ============================================================
//  YouTube Digest → Gemini 总结 → 企业微信 Bot  (Cloudflare Worker)
//  稳定版 v2026-09-13   （模型链已对齐你账号实测可用清单）
// ============================================================
//
//  数据流：
//    RSS 拉新视频
//      → L1 字幕优先（多源轮询，纯文本喂 Gemini，最稳）
//      → L2 Gemini 直连 YouTube（视频理解，兜底）
//      → L3 标题 + 描述（无内容时降级）
//      → 全失败：发简版提示（绝不静默）
//    企业微信 markdown 推送
//
//  稳定性：
//    - 严格串行 + 节流（不打爆免费层 RPM）
//    - 单模型 15s 硬超时；单视频总预算 55s（超时立即降级，不卡死 Worker）
//    - 429/5xx 指数退避 + jitter（每模型最多 3 次）
//    - 400/404/410 立即跳过该模型（不浪费重试）
//    - 字幕源先读 text，拦截 HTML 错误页（避免 JSON.parse 崩溃）
//    - 分批 BATCH_SIZE，KV 逐步推进去重
//
// ============================================================
//  路由：
//    GET /health              免鉴权
//    GET /debug/env?token=x   查看当前配置（变量是否齐全）
//    GET /run-once?token=x    手动触发（同步，限 BATCH_SIZE 个）
//    GET /?token=x            兼容入口
// ============================================================
//
//  加密变量（wrangler secret put）：
//    GEMINI_API_KEY / WECOM_WEBHOOK / API_TOKEN
//  [vars]（wrangler.toml 明文）：
//    CHANNELS / GEMINI_MODELS / GEMINI_MODEL / BATCH_SIZE / THROTTLE_MS

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT = 15000;      // 单次 Gemini 请求硬超时
const PER_VIDEO_BUDGET = 55000;     // 单视频总结总预算(ms)，到点直接降级
const MAX_RETRIES = 3;              // 每模型重试次数（429/5xx）

// 429/500/502/503/504 → 指数退避重试
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// 400/404/410 → 该模型不可用，立即跳过、绝不重试
const SKIP_MODEL_STATUS = new Set([400, 404, 410]);

// ============================================================
//  入口
// ============================================================
export default {
  async scheduled(controller, env, ctx) {
    // Cron：全量分批（最长 15 分钟，交给 waitUntil）
    ctx.waitUntil(
      runDigest(env, { limit: Infinity }).then((results) => {
        console.log('[scheduled] done', JSON.stringify(results));
      })
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 健康检查（免鉴权）
    if (path === '/health') {
      return Response.json({ status: 'ok', time: new Date().toISOString() });
    }

    // 查看配置（调试用）
    if (path === '/debug/env') {
      if (url.searchParams.get('token') !== env.API_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      return Response.json({
        hasKV: !!env.KV,
        hasGeminiKey: !!env.GEMINI_API_KEY,
        geminiModel: env.GEMINI_MODEL || '(未设置，用链首)',
        models: getModels(env),
        channels: safeParseChannels(env.CHANNELS),
        batchSize: getBatchSize(env),
        throttleMs: getThrottleMs(env),
        hasWeCom: !!env.WECOM_WEBHOOK,
        hasAPIToken: !!env.API_TOKEN,
      });
    }

    // 其余接口均需 token
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

// ============================================================
//  主流程
// ============================================================
async function runDigest(env, opts = {}) {
  const limit = opts.limit != null ? opts.limit : Infinity;
  console.log('[runDigest] start, limit:', limit);
  ensureConfig(env);

  const channels = safeParseChannels(env.CHANNELS);
  const results = [];

  if (!channels.length) {
    console.error('[runDigest] CHANNELS 为空，请在 wrangler.toml 配置');
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

      // 调试：打印前 3 条解析结果，确认 title/published/desc/channel 都拿到
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

      const todo = newVideos.slice(0, Math.min(limit, getBatchSize(env)));
      console.log('[runDigest] newVideos:', newVideos.length, 'todo:', todo.length);

      for (const video of todo) {
        console.log('[runDigest] processing:', video.title);

        // 单视频加总预算：超时直接降级，绝不让 Worker 跑到 60s 被取消
        const summary = await runWithBudget(
          () => summarizeWithFallback(video, env),
          {
            budgetMs: PER_VIDEO_BUDGET,
            fallback: () => buildFallbackMessage(video),
          }
        );

        await pushWeCom(video, summary, env);
        console.log('[pushWeCom] ok');
        results.push({ title: video.title, status: 'ok' });

        await sleep(getThrottleMs(env));
      }

      // 仅 Cron 全量跑完才推进 lastId；手动触发不推进，剩余留给下次
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

// 给单个视频总结加"总预算"，超时立即走兜底，避免拖垮整个 Worker
async function runWithBudget(fn, { budgetMs, fallback }) {
  const timer = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`per-video budget ${budgetMs}ms exceeded`)), budgetMs)
  );
  try {
    return await Promise.race([fn(), timer]);
  } catch (e) {
    console.warn('[runWithBudget] timeout/failed:', e.message);
    return fallback();
  }
}

function buildFallbackMessage(video) {
  return `⚠️ Gemini 当前繁忙，暂未生成摘要，请稍后查看或观看原视频。\n\n标题：${video.title || '（无标题）'}\n链接：${video.link}`;
}

// ============================================================
//  总结（三层兜底）
// ============================================================
async function summarizeWithFallback(video, env) {
  // L1：字幕优先（纯文本，最稳、最省、最不易 503）
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

  // L2：Gemini 直连 YouTube（视频理解）
  try {
    const summary = await summarizeViaGemini(video, env);
    console.log('[summarize] layer2(gemini-direct) ok');
    return summary;
  } catch (e) {
    console.warn('[summarize] layer2 failed:', e.message);
  }

  // L3：标题 + 描述
  try {
    const summary = await summarizeTextFallback(video, env);
    console.log('[summarize] layer3(fallback) ok');
    return summary;
  } catch (e) {
    console.error('[summarize] layer3 failed:', e.message);
    return buildFallbackMessage(video);
  }
}

// ============================================================
//  字幕获取（多源 + HTML 拦截）
// ============================================================
function buildTranscriptSources(videoId) {
  return [
    // 按需替换为你验证可用的字幕服务；公共实例稳定性参差不齐
    `https://yt-transcript-prod.onrender.com/transcript?videoId=${videoId}&lang=zh-Hans,zh,en`,
    `https://youtube-captions-api.vercel.app/api/captions?videoId=${videoId}&lang=zh-Hans,zh,en`,
    `https://invidious.io.lol/api/v1/captions/${videoId}?lang=zh-Hans,zh,en`,
    `https://yewtu.be/api/v1/captions/${videoId}?lang=zh-Hans,zh,en`,
    `https://invidious.privacydev.net/api/v1/captions/${videoId}?lang=zh-Hans,zh,en`,
  ];
}

async function getTranscript(videoId) {
  const sources = buildTranscriptSources(videoId);
  for (let i = 0; i < sources.length; i++) {
    const url = sources[i];
    try {
      console.log('[transcript] trying source', i + 1, url);
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) {
        console.warn('[transcript] source', i + 1, 'http', res.status);
        continue;
      }

      // ✅ 关键：先读文本，拦截 HTML 错误页，避免 JSON.parse("<!DOCTYPE...") 崩溃
      const text = await res.text();
      if (looksLikeHtml(text)) {
        console.warn('[transcript] source', i + 1, 'returned html, skip');
        continue;
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.warn('[transcript] source', i + 1, 'invalid json:', e.message);
        continue;
      }

      let transcript = '';
      if (typeof data === 'string') {
        transcript = data;
      } else if (data.transcript) {
        transcript = data.transcript;
      } else if (Array.isArray(data)) {
        transcript = data.map((s) => (typeof s === 'string' ? s : s.text || '')).join(' ');
      } else if (data.content) {
        transcript = data.content;
      } else if (data.captions) {
        transcript = (Array.isArray(data.captions) ? data.captions : [])
          .map((s) => s.text || '')
          .join(' ');
      }

      transcript = (transcript || '').trim();

      // 过滤限流提示 / 占位页
      if (
        transcript.length > 50 &&
        !/高频|rate limit|too many requests|contact|合作方案|access denied/i.test(transcript)
      ) {
        console.log('[transcript] source', i + 1, 'ok, length:', transcript.length);
        return transcript.slice(0, 12000);
      }
      console.warn('[transcript] source', i + 1, 'empty or rate-limited');
    } catch (e) {
      console.warn('[transcript] source', i + 1, 'error:', e.message);
    }
  }
  throw new Error('all transcript sources failed');
}

function looksLikeHtml(text) {
  if (!text) return true;
  const t = text.trim().toLowerCase();
  return t.startsWith('<!doctype') || t.startsWith('<html');
}

// ============================================================
//  Gemini 调用（模型链 + 退避 + 超时 + 404 跳过）
// ============================================================

// 依次尝试链上每个模型；某个模型 404 → 立即换下一个，不重试
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
      if (e.skipModel) {
        console.log('[gemini] skip model', model, '(unsupported)');
        continue; // 400/404/410 → 直接下一个
      }
      // 5xx/429 → geminiWithRetry 内部已重试耗尽 → 换模型
    }
  }
  throw new Error(`all models failed: ${lastError}`);
}

// 单模型 + 指数退避（仅对 429/5xx）
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

  console.warn(
    `[gemini] ${model} http ${status} attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${detail}`
  );

  // 400/404/410：模型不可用，标记跳过（不重试）
  if (SKIP_MODEL_STATUS.has(status)) {
    const err = new Error(`Gemini http ${status}: ${detail}`);
    err.skipModel = true;
    throw err;
  }

  // 其他非重试错误（鉴权/参数错误）
  if (!RETRYABLE.has(status)) {
    throw new Error(`Gemini http ${status}: ${detail}`);
  }

  // 429/5xx：重试耗尽则抛（交给模型链换下一个）
  if (attempt >= MAX_RETRIES) {
    throw new Error(`Gemini retry exhausted: ${status} ${detail}`);
  }

  // 指数退避 + jitter（短睡，容量问题睡久也没用）
  const wait = Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 8000);
  console.log(`[gemini] retry after ${wait}ms`);
  await sleep(wait);
  return geminiWithRetry(env, model, body, attempt + 1);
}

// ---- L1：纯文本（字幕）总结 ----
async function summarizeText(text, video, env) {
  const prompt =
    buildSummaryPrompt() +
    `\n\n以下是视频的字幕/文本内容，请据此总结：\n\n${text}\n\n视频标题：${video.title}`;
  const data = await callGeminiWithModelChain(env, () => ({
    contents: [{ parts: [{ text: prompt }] }],
  }));
  return extractText(data);
}

// ---- L2：Gemini 直连 YouTube ----
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

// ---- L3：仅标题 + 描述 ----
async function summarizeTextFallback(video, env) {
  const title = video.title?.trim() || '未知标题';
  const description = video.description?.trim() || '';
  const published = video.published || '未知时间';
  const channelName = video.channelName || '未知频道';

  // 连标题都没有，直接发简版，不浪费调用
  if (title === '未知标题' && !description) {
    return buildFallbackMessage(video);
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

// ============================================================
//  Prompt（结构化 + 自动分类）
// ============================================================
function buildSummaryPrompt() {
  return `你是一个专业的视频内容分析师。请对以下 YouTube 视频进行深度总结，输出中文。

## 第一步：自动识别视频分类
先判断视频属于哪类（财经/经济、社会/时政、科技/互联网、生活/知识、其他），侧重点随之调整：
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

// ============================================================
//  RSS 解析
// ============================================================
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

    return {
      id: idRaw,
      videoId,
      title,
      description: description.slice(0, 3000),
      published,
      link,
      channelName,
    };
  });
}

// ============================================================
//  企业微信推送
// ============================================================
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

// ============================================================
//  工具函数
// ============================================================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureConfig(env) {
  if (!env.GEMINI_API_KEY) console.error('[config] GEMINI_API_KEY 未设置');
  if (!env.WECOM_WEBHOOK) console.error('[config] WECOM_WEBHOOK 未设置');
  if (!env.API_TOKEN) console.error('[config] API_TOKEN 未设置');
}

// 模型链：对齐你账号实测可用清单（2026-09）
//   主力 2.5-flash（最稳）→ lite（省）→ flash-latest（跟随官方）→ 3.x 预览（最后兜底）
//   ⚠️ 不要放 3.5/3.6/3.7 在首位：晚高峰免费层限流严重，易 timeout
function getModels(env) {
  try {
    const arr = JSON.parse(env.GEMINI_MODELS || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {}
  // 兜底默认值（与 wrangler.toml 保持一致）
  return [
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
    'gemini-flash-latest',
    'gemini-3-flash-preview',
  ];
}

// CHANNELS 支持两种写法：
//   字符串数组  ["UCxxx","UCyyy"]
//   逗号分隔  "UCxxx,UCyyy"（无空格）
function safeParseChannels(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch {}
  return String(raw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getBatchSize(env) {
  const n = parseInt(env.BATCH_SIZE, 10);
  return isNaN(n) || n < 1 ? 3 : n;
}

function getThrottleMs(env) {
  const n = parseInt(env.THROTTLE_MS, 10);
  return isNaN(n) || n < 0 ? 2000 : n;
}
