// YouTube Digest → Gemini Summary → WeCom Bot Worker
//
// 架构：RSS 拿新视频 → Gemini 直连 YouTube 总结（不爬字幕）→ 企业微信推送
// Prompt：结构化分段 + 尽量带时间戳 + 自动识别分类
//
// 路由：
//   GET /health             免鉴权
//   GET /debug/env?token=x  查变量（不暴露密钥明文）
//   GET /run-once?token=x   手动触发（同步、限1个）
//   GET /?token=x           兼容入口
//
// 加密变量（wrangler secret put）：
//   GEMINI_API_KEY  Google AI Studio 申请的 key
//   WECOM_WEBHOOK   企业微信机器人 webhook
//   API_TOKEN       手动触发用的 token
// [vars]（wrangler.toml 明文）：
//   GEMINI_MODEL = "gemini-2.5-flash"
//   CHANNELS     = '["UCxxx"]'

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT = 20000; // 单次 Gemini 请求 20s 超时

export default {
  async scheduled(controller, env, ctx) {
    // Cron：全量处理（Cron 最长 15 分钟，无 30s 限制）
    ctx.waitUntil(
      runDigest(env, { limit: Infinity }).then((results) => {
        console.log('[scheduled] done', JSON.stringify(results));
      })
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1) 健康检查
    if (path === '/health') {
      return Response.json({
        status: 'ok',
        time: new Date().toISOString(),
        kv: !!env.KV,
        model: env.GEMINI_MODEL || null,
      });
    }

    // 2) 变量自查（不暴露密钥明文）
    if (path === '/debug/env') {
      if (url.searchParams.get('token') !== env.API_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      return Response.json({
        hasKV: !!env.KV,
        hasGeminiKey: !!env.GEMINI_API_KEY,
        geminiModel: env.GEMINI_MODEL || null,
        channels: safeParseChannels(env.CHANNELS),
        hasWeCom: !!env.WECOM_WEBHOOK,
        hasAPIToken: !!env.API_TOKEN,
      });
    }

    // 3) Token 校验
    if (url.searchParams.get('token') !== env.API_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 4) 手动触发：同步跑，只处理最新 1 个（避免 30s 超时掐断推送）
    if (path === '/run-once' || path === '/') {
      const start = Date.now();
      const results = await runDigest(env, { limit: 1 });
      const cost = Date.now() - start;
      return Response.json({
        status: 'done',
        costMs: cost,
        note: '已处理最新 1 个视频（全量由 Cron 自动触发），查看企业微信 / wrangler tail',
        results,
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ---------- 主流程 ----------
async function runDigest(env, opts = {}) {
  const limit = opts.limit != null ? opts.limit : Infinity;
  console.log('[runDigest] start, limit:', limit);
  ensureConfig(env);

  const channels = safeParseChannels(env.CHANNELS);
  const results = [];

  if (!channels.length) {
    console.error('[runDigest] CHANNELS 为空');
    return [{ status: 'error', error: 'CHANNELS 为空' }];
  }
  console.log('[runDigest] channels:', JSON.stringify(channels));

  for (const channelId of channels) {
    try {
      console.log('[runDigest] processing channel:', channelId);

      const feed = await fetchRSS(channelId);
      console.log('[runDigest] feed count:', feed.length);
      if (!feed.length) {
        results.push({ channel: channelId, status: 'noop', reason: 'feed 为空' });
        continue;
      }

      const lastId = await env.KV.get(`last:${channelId}`);
      console.log('[runDigest] lastId:', lastId);
      const newVideos = [];
      for (const v of feed) {
        if (v.id === lastId) break;
        newVideos.push(v);
      }
      const todo = newVideos.slice(0, limit);
      console.log('[runDigest] newVideos count:', newVideos.length, 'todo:', todo.length);

      for (const video of todo) {
        console.log('[runDigest] summarizing:', video.title);

        // 串行：逐条总结+推送，避免并发打爆 Gemini 免费层
        let summary = '';

        // 方式1：Gemini 直连 YouTube（带 503 立即重试 + 超时控制）
        try {
          summary = await summarizeViaGemini(video, env);
          console.log('[summarize] gemini-direct ok, length:', summary.length);
        } catch (e) {
          console.error('[summarize] gemini-direct failed:', e.message);
          // 方式2：标题+描述 降级（同样带重试 + 超时）
          try {
            summary = await summarizeTextFallback(video, env);
            console.log('[summarize] fallback ok, length:', summary.length);
          } catch (e2) {
            console.error('[summarize] fallback failed:', e2.message);
            summary = `⚠️ 今日 Gemini 繁忙，未生成摘要\n\n标题：${video.title}\n链接：${video.link}`;
          }
        }

        try {
          await pushWeCom(video, summary, env);
          console.log('[pushWeCom] ok');
        } catch (e) {
          console.error('[pushWeCom] failed:', e.message);
        }

        results.push({ title: video.title, status: 'ok' });
      }

      if (feed[0]) {
        // 仅全量（Cron, limit=Infinity）时推进去重标记
        // 手动触发（limit=1）不更新，剩余视频留给下次 Cron
        if (limit === Infinity) {
          await env.KV.put(`last:${channelId}`, feed[0].id);
          console.log('[runDigest] updated lastId:', feed[0].id);
        } else {
          console.log('[runDigest] skip update lastId (partial run)');
        }
      }
      results.push({ channel: channelId, status: 'done', processed: todo.length });
    } catch (err) {
      console.error('[runDigest] channel error:', channelId, err.message);
      results.push({ channel: channelId, status: 'error', error: err.message });
    }
  }

  console.log('[runDigest] finished, results:', JSON.stringify(results));
  return results;
}

// ---------- Gemini：超时控制 + 503 立即重试（不延迟）----------
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 2; // 总共最多 3 次（首次 + 2 次重试）

async function geminiGenerate(env, body, attempt = 0) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `${GEMINI_ENDPOINT}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  // 20 秒超时，防止单次请求挂死
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
    if (e.name === 'AbortError') {
      throw new Error(`Gemini request timeout after ${REQUEST_TIMEOUT}ms`);
    }
    throw e;
  }
  clearTimeout(timer);

  if (res.ok) {
    return await res.json();
  }

  const status = res.status;
  let detail = '';
  try {
    detail = (await res.json())?.error?.message || '';
  } catch {}

  console.warn(`[gemini] http ${status} attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${detail}`);

  // 503/5xx：立即重试，不做延迟（免费层延迟几秒也没用）
  if (RETRYABLE.has(status) && attempt < MAX_RETRIES) {
    console.log(`[gemini] retry ${attempt + 1}/${MAX_RETRIES} immediately`);
    return geminiGenerate(env, body, attempt + 1);
  }

  // 不可重试（key/model 错）或重试耗尽 → 抛出
  const err = new Error(`Gemini http ${status}: ${detail}`);
  err.status = status;
  throw err;
}

// ---------- Prompt：结构化分段 + 时间戳 + 自动分类 ----------
function buildSummaryPrompt() {
  return `你是一个专业的视频内容分析师。请对以下 YouTube 视频进行深度总结，输出中文。

## 第一步：自动识别视频分类
先判断该视频属于哪类内容（财经/经济、社会/时政、科技/互联网、生活/知识、其他），后续总结侧重点随之调整：
- 财经/经济类：重点标注数字、趋势、影响范围、政策/市场背景
- 社会/时政类：重点标注时间线、人物关系、法律/政策背景、后续影响
- 科技/互联网类：重点标注产品/技术细节、对比、行业影响
- 其他：按内容核心逻辑提取要点

## 第二步：按以下固定格式输出（严格使用 Markdown）

### 📌 一句话结论
用一句话概括视频核心观点、事件结果或最重要信息。

### 📋 核心要点（3-5 个）
每个要点按以下结构：
**要点标题**
- 详细说明（2-3 句，包含关键数据、人物、因果关系）
- 时间标记：若该处内容在视频中有明确时间戳，标注 [MM:SS]；若没有则省略不写

> 提示：只有能确定时间戳时才写 [MM:SS]，不要编造时间。无法确认时用"开头/中段/结尾"等相对位置描述。

### 🔍 关键信息 / 值得关注
列出 2-3 条容易被忽略但重要的细节，例如：
- 背景信息或前置事件
- 后续影响或可能的发展
- 相关方立场或数据来源
- 不确定性 / 存在争议的部分

### 💬 延伸思考（可选，仅在适用时输出）
简要说明不同立场的观点分歧，或给观众的实用建议。

## 全局要求
- 语言：简体中文
- 不要复述视频标题和链接（消息头部已展示）
- 不要输出"根据视频内容""以下是总结"等废话前缀，直接给内容
- 每个区块之间用空行分隔，便于手机阅读
- 总篇幅控制在 500-900 字
- 如果视频涉及敏感/争议话题，保持客观中立，不站队`;
}

// ---------- Gemini：YouTube 链接直连总结 ----------
async function summarizeViaGemini(video, env) {
  const data = await geminiGenerate(env, {
    contents: [
      {
        parts: [
          { text: buildSummaryPrompt() },
          { file_data: { file_uri: video.link } },
        ],
      },
    ],
  });

  const text =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned empty content');
  return text.trim();
}

// ---------- Gemini：标题+描述 降级总结 ----------
async function summarizeTextFallback(video, env) {
  const prompt =
    buildSummaryPrompt() +
    `\n\n注意：以下仅提供视频的标题、发布时间、描述等元信息（未能直接读取视频内容），请基于这些信息生成简版摘要，并在"一句话结论"后标注"（基于标题与描述整理，未读取视频内容）"。\n\n` +
    `视频标题：${video.title}\n` +
    `发布时间：${video.published}\n` +
    `视频描述：${video.description || '无'}\n` +
    `视频链接：${video.link}`;

  const data = await geminiGenerate(env, {
    contents: [{ parts: [{ text: prompt }] }],
  });

  const summary =
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!summary) throw new Error('Gemini fallback returned empty content');
  return summary.trim();
}

// ---------- 工具 ----------
function ensureConfig(env) {
  if (!env.GEMINI_API_KEY) console.error('[config] GEMINI_API_KEY 未设置');
  if (!env.WECOM_WEBHOOK) console.error('[config] WECOM_WEBHOOK 未设置');
  if (!env.API_TOKEN) console.error('[config] API_TOKEN 未设置');
}

function safeParseChannels(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[CHANNELS] parse failed:', raw);
    return [];
  }
}

// ---------- RSS ----------
async function fetchRSS(channelId) {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  console.log('[fetchRSS] url:', rssUrl);
  const res = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  return parseFeed(xml);
}

function parseFeed(xml) {
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  return entries.map((e) => {
    const get = (tag) =>
      e.match(new RegExp(`<${tag}>([\\s\S]*?)<\\/${tag}>`))?.[1] || '';
    const videoId = e.match(/<yt:videoId>([^<]+)/)?.[1] || '';
    const link = e.match(/<link rel="alternate" href="([^"]+)/)?.[1] || '';
    return {
      id: get('id'),
      videoId,
      title: get('title'),
      description: get('summary'),
      published: get('published'),
      link,
      author: get('author'),
    };
  });
}

// ---------- 企业微信推送（结构化排版） ----------
async function pushWeCom(video, summary, env) {
  const webhook = env.WECOM_WEBHOOK;
  if (!webhook) throw new Error('WECOM_WEBHOOK not set');

  const content =
    `## 📺 ${escapeMarkdown(video.title)}\n` +
    `> 👤 频道：${escapeMarkdown(video.author || '')}\n` +
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

// 转义企业微信 markdown 特殊字符
function escapeMarkdown(str) {
  if (!str) return '';
  return str.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

// 格式化发布时间为北京时间（UTC+8）
function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours() + 8).padStart(2, '0');
    const min = String(d.getUTCMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${h}:${min}`;
  } catch {
    return iso;
  }
}
