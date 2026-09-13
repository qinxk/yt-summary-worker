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

    // 4) 手动触发（用 ctx.waitUntil 保证后台任务跑完、日志完整）
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

        // 1) 多源轮询拿字幕
        let transcript = await getTranscriptWithFallback(video.videoId);
        console.log('[transcript] final length:', transcript.length);

        // 2) 字幕太短/无效 → 用标题+描述兜底，并标注原因
        let noSubtitle = false;
        if (transcript.trim().length < 30) {
          noSubtitle = true;
          transcript =
            `标题：${video.title}\n` +
            `发布：${video.published}\n` +
            `描述：${video.description || '无'}\n` +
            `（说明：未获取到字幕，以下基于标题与描述生成）`;
        }

        // 3. 组装给 LLM 的正文
        const body = noSubtitle
          ? transcript
          : `视频标题：${video.title}\n\n字幕：\n${transcript}`;

        let summary = '';
        try {
          summary = await summarize(body, env);
          console.log('[summarize] ok, length:', summary.length);
        } catch (e) {
          console.error('[summarize] failed:', e.message);
          summary = `摘要生成失败: ${e.message}`;
        }

        // 4. 推送（无字幕时在开头注明）
        const prefix = noSubtitle ? '⚠️ 该视频无可用字幕，以下基于标题/描述整理\n\n' : '';
        try {
          await pushWeCom(video, prefix + summary, env);
          console.log('[pushWeCom] ok');
        } catch (e) {
          console.error('[pushWeCom] failed:', e.message);
        }

        results.push({ title: video.title, status: 'ok', noSubtitle });
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

// ---------- 字幕：多源轮询 + 兜底 ----------
async function getTranscriptWithFallback(videoId) {
  // 每个 source 返回字幕文本（纯字符串），失败抛错
  const sources = [
    // 源1：原 youtube-transcript.ai
    async () => {
      const res = await fetch(
        `https://youtube-transcript.ai/transcript/${videoId}.txt?lang=zh-Hans,zh,en`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!res.ok) throw new Error(`src1 status ${res.status}`);
      const text = await res.text();
      // 若返回的是“限流提示页”，当无效处理
      if (/高频调用|速率|rate limit|请联系|联系我/i.test(text)) {
        throw new Error('src1 returned limit page');
      }
      return text;
    },
    // 源2：vercel 中转
    async () => {
      const res = await fetch(
        `https://youtube-captions-api.vercel.app/api/captions?videoId=${videoId}&lang=zh-Hans,zh,en`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!res.ok) throw new Error(`src2 status ${res.status}`);
      const data = await res.json();
      const t = data && (data.transcript || data.text || '');
      if (!t) throw new Error('src2 empty');
      return typeof t === 'string' ? t : JSON.stringify(t);
    },
    // 源3：Invidious 实例轮询
    async () => {
      const instances = [
        'https://invidious.io.lol',
        'https://yewtu.be',
        'https://invidious.privacydev.net',
      ];
      let lastErr = '';
      for (const base of instances) {
        try {
          const res = await fetch(
            `${base}/api/v1/captions/${videoId}?lang=zh-Hans,zh,en`,
            { headers: { 'User-Agent': 'Mozilla/5.0' } }
          );
          if (!res.ok) {
            lastErr = `src3 ${base} status ${res.status}`;
            continue;
          }
          const list = await res.json();
          if (!Array.isArray(list) || !list.length) {
            lastErr = `src3 ${base} empty`;
            continue;
          }
          // 不同实例字段可能不同：text / content
          return list
            .map((s) => s.text || s.content || '')
            .join(' ')
            .trim();
        } catch (e) {
          lastErr = `src3 ${base}: ${e.message}`;
          continue;
        }
      }
      throw new Error(lastErr || 'src3 all failed');
    },
  ];

  for (let i = 0; i < sources.length; i++) {
    try {
      const text = await sources[i]();
      if (text && text.trim().length >= 30) {
        console.log(`[transcript] source ${i + 1} ok`);
        return text.trim().slice(0, 12000);
      }
      console.warn(`[transcript] source ${i + 1} too short`);
    } catch (e) {
      console.warn(`[transcript] source ${i + 1} failed:`, e.message);
    }
  }

  // 所有源都失败 → 返回空，由上层用标题+描述兜底
  return '';
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

// ---------- LLM 总结 ----------
async function summarize(transcript, env) {
  const prompt = `请用中文把以下 YouTube 视频内容整理成摘要，输出：1)一句话结论；2)3-5个要点（若内容带时间戳请标注，否则按内容顺序给大致位置区间）；3)值得关注的关键信息。\n\n${transcript}`;

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
        Authorization: `Bearer ${env.LLM_KEY}`,
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

  // 兜底：无模型时用字幕/描述前 500 字
  return transcript.slice(0, 500);
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
