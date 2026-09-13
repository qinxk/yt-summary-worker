// YouTube Digest → LLM Summary → WeCom Bot Worker
// 路由：
//   GET /health             免鉴权
//   GET /debug/env?token=x  查变量
//   GET /run-once?token=x   手动触发
//   GET /?token=x           兼容入口

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
        ai: !!env.AI,
      });
    }

    // 2) 变量自查
    if (path === '/debug/env') {
      if (url.searchParams.get('token') !== env.API_TOKEN) {
        return new Response('Unauthorized', { status: 401 });
      }
      return Response.json({
        hasKV: !!env.KV,
        hasAI: !!env.AI,
        hasLLMKey: !!env.LLM_KEY,
        llmUrl: env.LLM_URL || null,
        llmModel: env.LLM_MODEL || null,
        channels: safeParseChannels(env.CHANNELS),
        hasWeCom: !!env.WECOM_WEBHOOK,
        hasAPIToken: !!env.API_TOKEN,
      });
    }

    // 3) Token 校验
    if (url.searchParams.get('token') !== env.API_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 4) 手动触发
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

      // 1. RSS
      const feed = await fetchRSS(channelId);
      console.log('[runDigest] feed count:', feed.length);
      if (!feed.length) {
        results.push({ channel: channelId, status: 'noop', reason: 'feed 为空' });
        continue;
      }

      // 2. KV 去重
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

        // 3. 字幕
        let transcript = '';
        try {
          transcript = await getTranscript(video.videoId);
          console.log('[transcript] ok, length:', transcript.length);
        } catch (e) {
          console.warn('[transcript] failed, fallback to description:', e.message);
          transcript = video.description || '';
        }

        // 4. 总结
        let summary = '';
        try {
          summary = await summarize(transcript, env);
          console.log('[summarize] ok, length:', summary.length);
        } catch (e) {
          console.error('[summarize] failed:', e.message);
          summary = `摘要生成失败: ${e.message}`;
        }

        // 5. 推送
        try {
          await pushWeCom(video, summary, env);
          console.log('[pushWeCom] ok');
        } catch (e) {
          console.error('[pushWeCom] failed:', e.message);
        }

        results.push({ title: video.title, status: 'ok' });
      }

      // 6. 更新去重标记
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

// ---------- 工具 ----------
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
    const get = (tag) => e.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] || '';
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

// ---------- 字幕 ----------
async function getTranscript(videoId) {
  // 方案1：使用 youtube-captions 的公开接口
  const res = await fetch(
    `https://youtube-captions-api.vercel.app/api/captions?videoId=${videoId}&lang=zh-Hans,zh,en`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error(`transcript fetch failed: ${res.status}`);
  const data = await res.json();
  if (data.transcript) return data.transcript.slice(0, 12000);
  throw new Error('no transcript in response');
}

// ---------- LLM 总结 ----------
async function summarize(transcript, env) {
  const prompt = `请用中文把以下 YouTube 视频字幕整理成摘要，输出：1)一句话结论；2)3-5个要点（带大致时间）；3)值得关注的关键信息。\n\n字幕：\n${transcript}`;

  // 方式A：Workers AI
  if (env.AI) {
    try {
      const { text } = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { prompt });
      if (text) return text;
    } catch (e) {
      console.warn('[summarize] Workers AI failed, fallback:', e.message);
    }
  }

  // 方式B：中转站 / OpenAI 兼容接口
  if (env.LLM_URL) {
    const url = `${env.LLM_URL}/chat/completions`;
    console.log('[summarize] LLM request to:', url);
    console.log('[summarize] model:', env.LLM_MODEL);

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.LLM_KEY}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 800,
      }),
    });

    const respText = await r.text();
    console.log('[summarize] LLM response status:', r.status);
    console.log('[summarize] LLM response body:', respText);

    if (!r.ok) {
      throw new Error(`LLM http ${r.status}: ${respText}`);
    }

    const j = JSON.parse(respText);
    return j.choices?.[0]?.message?.content || '';
  }

  return transcript.slice(0, 500);
}

// ---------- 企业微信 ----------
async function pushWeCom(video, summary, env) {
  const webhook = env.WECOM_WEBHOOK;
  if (!webhook) throw new Error('WECOM_WEBHOOK not set');

  const content = `## 📺 ${video.title}\n> 发布：${video.published}\n> 链接：${video.link}\n\n**摘要：**\n${summary}`;

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