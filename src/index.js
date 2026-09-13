// YouTube Digest → Gemini Summary → WeCom Bot Worker
// 方案 A：不爬字幕，直接把 YouTube 链接交给 Gemini 总结
//
// 路由：
//   GET /health             免鉴权
//   GET /debug/env?token=x  查变量
//   GET /run-once?token=x   手动触发
//   GET /?token=x           兼容入口
//
// 所需变量（Cloudflare Dashboard / wrangler secret）：
//   GEMINI_API_KEY  (加密)   Google AI Studio 申请的 key
//   WECOM_WEBHOOK    (加密)  企业微信机器人 webhook
//   API_TOKEN        (加密)  手动触发用的 token
// [vars]（写进 wrangler.toml，明文，非敏感）：
//   GEMINI_MODEL = "gemini-2.5-flash"
//   CHANNELS     = '["UCxxx"]'

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDigest(env));
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

    // 4) 手动触发（ctx.waitUntil 保证后台跑完、日志完整）
    if (path === '/run-once' || path === '/') {
      ctx.waitUntil(
        runDigest(env).then((results) => {
          console.log('[runDigest] done', JSON.stringify(results));
        })
      );
      return Response.json({
        status: 'triggered',
        note: '任务已在后台执行，查看企业微信 / wrangler tail',
      });
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ---------- 主流程 ----------
async function runDigest(env) {
  console.log('[runDigest] start');
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
      console.log('[runDigest] newVideos count:', newVideos.length);

      for (const video of newVideos) {
        console.log('[runDigest] summarizing:', video.title);

        // 直接用 YouTube 链接让 Gemini 总结（方案 A）
        let summary = '';
        try {
          summary = await summarizeViaGemini(video, env);
          console.log('[summarize] ok, length:', summary.length);
        } catch (e) {
          console.error('[summarize] Gemini failed:', e.message);
          // 降级：标题 + 描述 再让 Gemini 出简版
          try {
            summary = await summarizeTextFallback(video, env);
            console.log('[summarize] fallback ok, length:', summary.length);
          } catch (e2) {
            console.error('[summarize] fallback failed:', e2.message);
            summary = `摘要生成失败：${e.message}`;
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
        await env.KV.put(`last:${channelId}`, feed[0].id);
        console.log('[runDigest] updated lastId:', feed[0].id);
      }
      results.push({ channel: channelId, status: 'done', processed: newVideos.length });
    } catch (err) {
      console.error('[runDigest] channel error:', channelId, err.message);
      results.push({ channel: channelId, status: 'error', error: err.message });
    }
  }

  console.log('[runDigest] finished, results:', JSON.stringify(results));
  return results;
}

// ---------- Gemini：YouTube 链接直连总结 ----------
async function summarizeViaGemini(video, env) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `${GEMINI_ENDPOINT}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const prompt =
    '请用中文总结这个 YouTube 视频，输出三部分：\n' +
    '1) 一句话结论；\n' +
    '2) 3-5 个要点（若视频有时间戳请标注，否则按内容顺序给大致位置区间）；\n' +
    '3) 值得关注的关键信息。';

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { file_data: { file_uri: video.link } },
        ],
      },
    ],
  };

  console.log('[gemini] request model:', model, 'video:', video.videoId);

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const respText = await r.text();
  console.log('[gemini] response status:', r.status);
  console.log('[gemini] response body:', respText.slice(0, 1000));

  if (!r.ok) {
    throw new Error(`Gemini http ${r.status}: ${respText.slice(0, 500)}`);
  }

  const j = JSON.parse(respText);
  const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
  if (!text) throw new Error('Gemini returned empty content');
  return text;
}

// ---------- Gemini：无链接内容时，用标题+描述降级 ----------
async function summarizeTextFallback(video, env) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `${GEMINI_ENDPOINT}/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const text =
    `以下是一段 YouTube 视频的元信息（未能直接读取视频内容），请用中文整理成简版摘要：\n` +
    `标题：${video.title}\n` +
    `发布：${video.published}\n` +
    `描述：${video.description || '无'}\n` +
    `链接：${video.link}\n\n` +
    `要求：1)一句话结论；2)3-5个要点；3)关键信息。（开头注明：基于标题与描述整理，未读取视频内容）`;

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }] }),
  });

  const respText = await r.text();
  if (!r.ok) throw new Error(`Gemini fallback http ${r.status}: ${respText.slice(0, 500)}`);
  const j = JSON.parse(respText);
  return j.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
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

// ---------- RSS（只拿新视频列表 + 去重，不再爬字幕） ----------
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
      e.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] || '';
    const videoId = e.match(/<yt:videoId>([^<]+)/)?.[1] || '';
    const link = e.match(/<link rel="alternate" href="([^"]+)/)?.[1] || '';
    return {
      id: get('id'),
      videoId,
      title: get('title'),
      description: get('summary'),
      published: get('published'),
      link,
    };
  });
}

// ---------- 企业微信 ----------
async function pushWeCom(video, summary, env) {
  const webhook = env.WECOM_WEBHOOK;
  if (!webhook) throw new Error('WECOM_WEBHOOK not set');

  const content =
    `## 📺 ${video.title}\n` +
    `> 发布：${video.published}\n` +
    `> 链接：${video.link}\n\n` +
    `**摘要：**\n${summary}`;

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
