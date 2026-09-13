// YouTube Digest → LLM Summary → WeCom Bot Worker
// 部署：Cloudflare Workers + KV，Cron Trigger 每日触发
// 依赖（在 package.json / wrangler.toml 中声明）：
//   - youtube-transcript-api (npm)  提取字幕
//   - Workers AI 绑定（可选，env.AI）

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runDigest(env));
  },

  // 手动触发入口：GET /?token=xxx
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('token') !== env.API_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }
    const result = await runDigest(env);
    return new Response(JSON.stringify(result, null, 2), {
      headers: { 'Content-Type': 'application/json' },
    });
  },
};

async function runDigest(env) {
  const channels = JSON.parse(env.CHANNELS || '[]');
  // CHANNELS 格式：["UCxxxx","UCyyyy"]
  const results = [];

  for (const channelId of channels) {
    try {
      // 1. 抓取频道 RSS
      const feed = await fetchRSS(channelId);
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
          transcript = video.description || ''; // 降级：用描述
        }

        // 4. LLM 总结（优先 Workers AI，兜底拼接）
        const summary = transcript
          ? await summarize(transcript, env)
          : '（该视频无字幕，无法生成摘要）';

        // 5. 推送到企业微信
        await pushWeCom(video, summary, env);

        results.push({ title: video.title, status: 'ok' });
      }

      // 6. 更新 KV 为最新一条（去重）
      if (feed.length) {
        await env.KV.put(`last:${channelId}`, feed[0].id);
      }
    } catch (err) {
      results.push({ channel: channelId, status: 'error', error: err.message });
    }
  }
  return results;
}

// ---------- RSS 抓取 ----------
async function fetchRSS(channelId) {
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const xml = await res.text();
  return parseFeed(xml);
}

function parseFeed(xml) {
  // 简易 XML 解析，抽取 entry
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  return entries.map(e => {
    const get = (tag) => e.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`))?.[1] || '';
    const videoId = (e.match(/<yt:videoId>([^<]+)/) || [])[1] || '';
    const link = (e.match(/<link rel="alternate" href="([^"]+)/) || [])[1] || '';
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

// ---------- 字幕提取（Node 版 youtube-transcript-api 思路） ----------
async function getTranscript(videoId) {
  // 直接调用第三方免 key 字幕接口（避免 Workers 内嵌复杂依赖）
  const res = await fetch(`https://youtube-transcript.ai/transcript/${videoId}.txt?lang=zh-Hans,zh,en`);
  if (!res.ok) throw new Error('no transcript');
  const text = await res.text();
  // 只取正文，限制长度（LLM 输入有上限）
  return text.split('\n').slice(0, 80).join(' ').slice(0, 12000);
}

// ---------- LLM 总结 ----------
async function summarize(transcript, env) {
  const prompt = `请用中文把以下 YouTube 视频字幕整理成摘要，输出：1)一句话结论；2)3-5个要点（带大致时间）；3)值得关注的关键信息。\n\n字幕：\n${transcript}`;

  // 方式A：Workers AI（同平台，无网络限制，推荐）
  if (env.AI) {
    try {
      const { text } = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        prompt,
      });
      if (text) return text;
    } catch (e) { /* 降级 */ }
  }

  // 方式B：OpenAI 兼容接口（env.LLM_URL / LLM_KEY）
  if (env.LLM_URL) {
    const r = await fetch(env.LLM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${env.LLM_KEY}`,
      },
      body: JSON.stringify({
        model: env.LLM_MODEL || 'gpt-4o-mini',
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const j = await r.json();
    return j.choices?.[0]?.message?.content || '';
  }

  // 兜底：无模型时返回字幕前 500 字
  return transcript.slice(0, 500);
}

// ---------- 企业微信推送（群机器人 Webhook，无需 token/固定IP）----------
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
  return r.json();
}
