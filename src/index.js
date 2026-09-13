// YouTube Digest → LLM Summary → WeCom Bot Worker
// 部署：Cloudflare Workers + KV，Cron Trigger 每日触发
//
// 路由：
//   GET /health             免鉴权健康检查（用于确认 Worker 是否在线）
//   GET /debug/env          需 Token，打印环境变量绑定情况（不暴露密钥明文）
//   GET /run-once?token=xxx 需 Token，手动触发一次 digest
//   GET /?token=xxx         同上，兼容旧入口

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDigest(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1) 健康检查：免鉴权
    if (path === '/health') {
      return Response.json({
        status: 'ok',
        time: new Date().toISOString(),
        kv: !!env.KV,
        ai: !!env.AI,
      });
    }

    // 2) 环境变量自查：需 Token（不打印密钥明文）
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
      });
    }

    // 3) 其余所有请求必须带有效 token
    if (url.searchParams.get('token') !== env.API_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 4) 手动触发 digest
    if (path === '/run-once' || path === '/') {
      // 用 waitUntil 让请求立即返回，任务在后台跑
      const task = runDigest(env).then((results) => {
        // 结果仅记录到日志，不直接阻塞响应
        console.log('[runDigest] done', JSON.stringify(results));
      });
      // 如果 env 支持 ctx，用 waitUntil；这里通过 Promise 简单处理
      return new Response(
        JSON.stringify({ status: 'triggered', note: '任务已在后台执行，稍后查看企业微信 / Worker 日志' }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ---------- 主流程 ----------
async function runDigest(env) {
  const channels = safeParseChannels(env.CHANNELS);
  const results = [];

  if (!channels.length) {
    console.warn('[runDigest] CHANNELS 为空，请检查 wrangler.toml 或 Dashboard 变量');
    return [{ status: 'error', error: 'CHANNELS 为空' }];
  }

  for (const channelId of channels) {
    try {
      // 1. 抓取频道 RSS
      const feed = await fetchRSS(channelId);
      if (!feed.length) {
        results.push({ channel: channelId, status: 'noop', reason: 'feed 为空' });
        continue;
      }

      // 2. 从 KV 取上次处理到的最新 videoId
      const lastId = await env.KV.get(`last:${channelId}`);
      const newVideos = [];
      for (const v of feed) {
        if (v.id === lastId) break; // 已处理过，之后的都是旧的
        newVideos.push(v);
      }

      for (const video of newVideos) {
        // 3. 提取字幕
        let transcript = '';
        try {
          transcript = await getTranscript(video.videoId);
        } catch (e) {
          console.warn('[transcript] 失败，降级用描述', video.videoId, e.message);
          transcript = video.description || '';
        }

        // 4. LLM 总结（Workers AI 优先，LLM_URL 兜底）
        const summary = transcript
          ? await summarize(transcript, env)
          : '（该视频无字幕，无法生成摘要）';

        // 5. 推送到企业微信
        await pushWeCom(video, summary, env);

        results.push({ title: video.title, status: 'ok' });
      }

      // 6. 更新 KV 为最新一条（去重）
      await env.KV.put(`last:${channelId}`, feed[0].id);
      results.push({ channel: channelId, status: 'done', processed: newVideos.length });
    } catch (err) {
      console.error('[runDigest] channel error', channelId, err.message);
      results.push({ channel: channelId, status: 'error', error: err.message });
    }
  }
  return results;
}

// ---------- 工具 ----------
function safeParseChannels(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    console.error('[CHANNELS] 解析失败，值应为 JSON 数组字符串', raw);
    return [];
  }
}

// ---------- RSS 抓取 ----------
async function fetchRSS(channelId) {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
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

// ---------- 字幕提取 ----------
async function getTranscript(videoId) {
  // 第三方免 key 字幕接口；失败时上层会降级用 description
  const res = await fetch(
    `https://youtube-transcript.ai/transcript/${videoId}.txt?lang=zh-Hans,zh,en`,
    { headers: { 'User-Agent': 'Mozilla/5.0' } }
  );
  if (!res.ok) throw new Error('no transcript');
  const text = await res.text();
  return text.split('\n').slice(0, 80).join(' ').slice(0, 12000);
}

// ---------- LLM 总结 ----------
async function summarize(transcript, env) {
  const prompt = `请用中文把以下 YouTube 视频字幕整理成摘要，输出：1)一句话结论；2)3-5个要点（带大致时间）；3)值得关注的关键信息。\n\n字幕：\n${transcript}`;

  // 方式A：Workers AI（同平台，无网络限制，推荐）
  if (env.AI) {
    try {
      const { text } = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { prompt });
      if (text) return text;
    } catch (e) {
      console.warn('[summarize] Workers AI 失败，降级', e.message);
    }
  }

  // 方式B：兼容 OpenAI 的接口（env.LLM_URL / LLM_KEY）
  if (env.LLM_URL) {
    const r = await fetch(`${env.LLM_URL}/chat/completions`, {
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
    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`LLM http ${r.status}: ${errText}`);
    }
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }

  // 兜底：无模型时返回字幕前 500 字
  return transcript.slice(0, 500);
}

// ---------- 企业微信推送 ----------
async function pushWeCom(video, summary, env) {
  const webhook = env.WECOM_WEBHOOK; // https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
  if (!webhook) throw new Error('WECOM_WEBHOOK not set');
  const content = `## 📺 ${video.title}
> 发布：${video.published}
> 链接：${video.link}

**摘要：**
${summary}`;

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
