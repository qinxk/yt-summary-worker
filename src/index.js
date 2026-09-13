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
//    CHANNELS / GEMINI_MODELS / BATCH_SIZE / THROTTLE_MS
//    INVIDIOUS_HOSTS / TRANSCRIPT_APIS

const GEMINI_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta';
const REQUEST_TIMEOUT = 15000;      // 单次 Gemini 请求硬超时（纯文本）
// L2 要 Gemini 自己拉取并理解整段视频，15s 结构上不可能完成（实测两个模型都超时）。
// 单独给宽松超时；预算不足 L2_MIN_BUDGET 时直接跳过 L2，把时间留给 L3。
const VIDEO_REQUEST_TIMEOUT = 40000;
const L2_MIN_BUDGET = 25000;
const TRANSCRIPT_TIMEOUT = 8000;    // 单个字幕源硬超时（原来是裸 fetch，会吃光预算）
const WECOM_TIMEOUT = 10000;        // 企业微信推送硬超时
const PER_VIDEO_BUDGET = 55000;     // 单视频总结总预算(ms)，到点直接降级
const MIN_ATTEMPT_MS = 6000;        // 剩余预算不足这个数就不再发起新请求
// ⚠️ 必须让「单模型最坏耗时 × 模型数」能塞进 PER_VIDEO_BUDGET，
//    否则第一个模型持续 5xx 时会烧光预算，模型链后面几个永远轮不到。
//    当前：1 次重试 → 最坏 15+1.5+15 ≈ 32s，配合剩余预算检查可换到第 2 个模型。
const MAX_RETRIES = 1;              // 每模型重试次数（429/5xx）
const MAX_TRANSCRIPT_ATTEMPTS = 6;  // 单视频最多尝试几个字幕源（Workers subrequest 有上限）

const TRANSCRIPT_MAX_CHARS = 12000; // 喂给模型的字幕上限
const TS_MARK_EVERY_SEC = 45;       // 每隔多少秒插一个 [MM:SS] 标记，供 prompt 引用
const SEEN_MAX = 60;                // KV 里保留多少个已处理视频 ID
const WECOM_MAX_BYTES = 4096;       // 企业微信 markdown 硬上限

// 429/500/502/503/504 → 指数退避重试
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// 400/404/410 → 该模型不可用，立即跳过、绝不重试
const SKIP_MODEL_STATUS = new Set([400, 404, 410]);
// 401/403 → key 无效或被封，换模型也没用，整条链立即放弃
const FATAL_STATUS = new Set([401, 403]);

// 字幕语言优先级：简中 → 中文 → 繁中 → 英文
const LANG_PRIORITY = ['zh-hans', 'zh-cn', 'zh', 'zh-hant', 'zh-tw', 'en'];

// Invidious 公共实例（存活率不稳，可用 INVIDIOUS_HOSTS 覆盖）
const DEFAULT_INVIDIOUS = [
  'https://invidious.privacydev.net',
  'https://yewtu.be',
  'https://invidious.io.lol',
];

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
        models: getModels(env),
        channels: safeParseChannels(env.CHANNELS),
        batchSize: getBatchSize(env),
        throttleMs: getThrottleMs(env),
        hasWeCom: !!env.WECOM_WEBHOOK,
        hasAPIToken: !!env.API_TOKEN,
        invidiousHosts: parseList(env.INVIDIOUS_HOSTS, DEFAULT_INVIDIOUS),
        transcriptApis: parseList(env.TRANSCRIPT_APIS, []).length,
        missing: ensureConfig(env),
      });
    }

    // 其余接口均需 token
    if (url.searchParams.get('token') !== env.API_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    // 查账号实际可用的模型 —— 别靠猜。
    // 日志里 gemini-2.5-flash-lite 已对新用户下线，用这个接口核对后再改 GEMINI_MODELS。
    if (path === '/debug/models') {
      const r = await fetchWithTimeout(`${GEMINI_ENDPOINT}/models`, {
        timeoutMs: REQUEST_TIMEOUT,
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
      });
      const j = await r.json();
      if (!r.ok) return Response.json({ status: r.status, error: j?.error?.message }, { status: 502 });

      const usable = (j.models || [])
        .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
        .map((m) => m.name.replace('models/', ''));
      const configured = getModels(env);

      return Response.json({
        configured,
        // 配置了但账号不可用 —— 这些是白烧调用的死条目，从 GEMINI_MODELS 删掉
        deadInConfig: configured.filter((m) => !usable.includes(m)),
        usableFlash: usable.filter((m) => /flash/.test(m) && !/thinking|image|audio|tts/.test(m)),
        usableAll: usable,
      });
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

  // 没有 webhook 就算总结出来也发不掉，直接停跑，别浪费模型调用
  const missing = ensureConfig(env);
  if (!env.WECOM_WEBHOOK) {
    return [{ status: 'error', error: `缺少必需变量: ${missing.join(', ')}` }];
  }

  const channels = safeParseChannels(env.CHANNELS);
  const results = [];
  const run = createRunState();   // 模型黑名单 + 配额标记，本轮所有频道/视频共享

  if (!channels.length) {
    console.error('[runDigest] CHANNELS 为空，请在 wrangler.toml 配置');
    return [{ status: 'error', error: 'CHANNELS 为空' }];
  }

  for (const channelId of channels) {
    // 配额耗尽：后面的频道也跑不出结果，直接停
    if (run.quotaExhausted) {
      results.push({ channel: channelId, status: 'skipped', reason: 'quota exhausted' });
      continue;
    }

    try {
      const feed = await fetchRSS(channelId);
      console.log('[runDigest] feed count:', feed.length);
      if (!feed.length) {
        results.push({ channel: channelId, status: 'noop', reason: 'feed 为空' });
        continue;
      }

      // 已处理 ID 集合。旧实现用单个 lastId 做锚点：
      // 该视频被删、或两次运行间隔超过 15 条时锚点失效 → 整个 feed 被当成新视频全量重推。
      const seen = await loadSeen(env, channelId);
      console.log('[runDigest] seen count:', seen.size);

      const newVideos = feed.filter((v) => v.id && !seen.has(v.id));

      // 首次运行（KV 为空）只处理最新 1 个，避免一次性推 15 条
      if (!seen.size && newVideos.length > 1) {
        const skipped = newVideos.slice(1);
        await saveSeen(env, channelId, seen, skipped.map((v) => v.id));
        skipped.forEach((v) => seen.add(v.id));
        console.log('[runDigest] first run, marked', skipped.length, 'as seen without pushing');
      }

      // 按发布时间正序处理最旧的一批：
      // 旧实现取最新 N 个却把 lastId 推到 feed[0]，积压时会永久丢弃中间的视频。
      const pending = feed
        .filter((v) => v.id && !seen.has(v.id))
        .sort((a, b) => new Date(a.published || 0) - new Date(b.published || 0));

      const batchSize = Math.min(limit, getBatchSize(env));
      const todo = pending.slice(0, batchSize);
      console.log('[runDigest] pending:', pending.length, 'todo:', todo.length);

      let processed = 0;
      let degraded = 0;
      for (const video of todo) {
        // 配额耗尽后剩余视频不再处理：继续跑只会给每个视频重复一遍
        // 「429 → 换模型 → 超时」的无效流程，还会推一堆兜底提示。
        if (run.quotaExhausted) {
          console.warn('[runDigest] quota exhausted, stop processing remaining videos');
          results.push({ title: video.title, status: 'skipped', reason: 'quota exhausted' });
          continue;
        }

        console.log('[runDigest] processing:', video.title);

        // 单视频加总预算：超时直接降级，绝不让 Worker 跑到 60s 被取消
        const deadline = Date.now() + PER_VIDEO_BUDGET;
        const result = await runWithBudget(
          () => summarizeWithFallback(video, env, deadline, run),
          {
            budgetMs: PER_VIDEO_BUDGET,
            fallback: () => buildFallbackMessage(video, '处理超时'),
          }
        );

        try {
          await pushWeCom(video, result.text, env);
          console.log('[pushWeCom] ok', result.degraded ? '(degraded)' : '');
        } catch (e) {
          // 推送失败不标记已读，下次重试；但不要中断整批
          console.error('[pushWeCom] failed:', e.message);
          results.push({ title: video.title, status: 'error', error: e.message });
          continue;
        }

        // 只有拿到真摘要才标记已读。
        // 兜底提示（配额耗尽/超时/全模型失败）是临时故障，标记了这个视频就
        // 永远失去摘要机会 —— 留给下次运行重试。
        if (result.degraded) {
          degraded++;
          console.warn('[runDigest] degraded, NOT marking as seen:', video.title);
          results.push({
            title: video.title,
            status: 'degraded',
            reason: result.reason,
            willRetry: true,
          });
        } else {
          await saveSeen(env, channelId, seen, [video.id]);
          seen.add(video.id);
          processed++;
          results.push({ title: video.title, status: 'ok' });
        }

        await sleep(getThrottleMs(env));
      }

      results.push({
        channel: channelId,
        status: 'done',
        processed,
        degraded,
        remaining: pending.length - processed,
      });
    } catch (err) {
      console.error('[runDigest] channel error:', channelId, err.message);
      results.push({ channel: channelId, status: 'error', error: err.message });
    }
  }

  if (run.deadModels.size) {
    console.log('[runDigest] models blacklisted this run:', JSON.stringify([...run.deadModels]));
  }
  if (run.quotaExhausted) {
    console.error('[runDigest] ABORTED: Gemini 配额耗尽，降级视频未标记已读，下次运行会重试');
  }
  console.log('[runDigest] finished');
  return results;
}

// ---------- KV 去重（已处理 ID 集合）----------
async function loadSeen(env, channelId) {
  if (!env.KV) {
    console.warn('[kv] KV 未绑定，无法去重（每次运行都会重复推送）');
    return new Set();
  }
  try {
    const raw = await env.KV.get(`seen:${channelId}`);
    const arr = raw ? JSON.parse(raw) : [];
    const set = new Set(Array.isArray(arr) ? arr : []);

    // 兼容旧版单锚点键，迁移后不再使用
    if (!set.size) {
      const legacy = await env.KV.get(`last:${channelId}`);
      if (legacy) {
        set.add(legacy);
        console.log('[kv] migrated legacy last: ->', legacy);
      }
    }
    return set;
  } catch (e) {
    console.warn('[kv] loadSeen failed:', e.message);
    return new Set();
  }
}

// 只保留最近 SEEN_MAX 个，防止 KV value 无限增长
async function saveSeen(env, channelId, seen, addIds) {
  if (!env.KV) return;
  const merged = [...seen, ...addIds.filter(Boolean)];
  const trimmed = merged.slice(-SEEN_MAX);
  try {
    await env.KV.put(`seen:${channelId}`, JSON.stringify(trimmed));
  } catch (e) {
    console.error('[kv] saveSeen failed:', e.message);
  }
}

// 给单个视频总结加"总预算"，超时立即走兜底，避免拖垮整个 Worker
async function runWithBudget(fn, { budgetMs, fallback }) {
  let timerId;
  const timer = new Promise((_, reject) => {
    timerId = setTimeout(
      () => reject(new Error(`per-video budget ${budgetMs}ms exceeded`)),
      budgetMs
    );
  });
  try {
    return await Promise.race([fn(), timer]);
  } catch (e) {
    console.warn('[runWithBudget] timeout/failed:', e.message);
    return fallback();
  } finally {
    clearTimeout(timerId);   // 否则每个视频都留一个 55s 悬空定时器
  }
}

// 兜底文案。degraded 标记让上层知道「这不是真摘要」，从而不标记已读。
function buildFallbackMessage(video, reason = 'Gemini 当前繁忙') {
  const text =
    `⚠️ ${reason}，暂未生成摘要，请直接观看原视频。\n\n` +
    `标题：${video.title || '（无标题）'}`;
  return { text, degraded: true, reason };
}

function buildSummaryResult(text) {
  return { text, degraded: false };
}

// ---------- run 级共享状态 ----------
// 一次运行内所有视频、所有降级层共享。解决日志里暴露的三个浪费：
//   1. 同一模型在 L2/L3 各报一次 404/429（本轮不可能恢复）
//   2. 同一模型反复 15s 超时（一次超时说明它这会儿就是慢）
//   3. 配额耗尽后继续处理剩余视频，每个再烧一遍
function createRunState() {
  return {
    deadModels: new Map(),  // model -> 失效原因
    quotaExhausted: false,  // 配额型 429：整轮中止
  };
}

// 配额耗尽 vs 普通限速：前者等一天，后者等几秒。必须区别对待。
function isQuotaError(detail) {
  return /exceeded your current quota|quota exceeded|billing|free tier|per day|daily limit/i.test(
    detail || ''
  );
}

// ============================================================
//  总结（三层兜底）
// ============================================================
async function summarizeWithFallback(video, env, deadline = Infinity, run = null) {
  // 鉴权变量缺失时，三层都会 400/403 空转 → 直接短路
  if (!env.GEMINI_API_KEY) {
    console.error('[summarize] GEMINI_API_KEY 未设置，跳过所有模型调用');
    return buildFallbackMessage(video, '未配置 GEMINI_API_KEY');
  }

  // 本轮配额已耗尽，直接兜底（不标记已读，配额恢复后会重试）
  if (run?.quotaExhausted) {
    return buildFallbackMessage(video, 'API 配额已耗尽');
  }

  // L1：字幕优先（纯文本，最稳、最省、最不易 503）
  // 给字幕获取留一半预算，剩下的留给 L2/L3
  try {
    const l1Deadline = Math.min(deadline, Date.now() + (deadline - Date.now()) / 2);
    // 长度校验已在 getTranscript → isUsableTranscript 里做过，这里不再设第二道阈值
    // （原来内层 80 / 外层 100 两个阈值不一致，中间区间的字幕会被静默丢弃）
    const transcript = await getTranscript(video.videoId, env, l1Deadline);
    console.log('[summarize] transcript ok, length:', transcript.length);
    const summary = await summarizeText(transcript, video, env, deadline, run);
    console.log('[summarize] layer1(transcript) ok');
    return buildSummaryResult(summary);
  } catch (e) {
    console.warn('[summarize] layer1 failed:', e.message);
    if (e.fatal) return buildFallbackMessage(video, 'API key 无效');
    if (e.quota) return buildFallbackMessage(video, 'API 配额已耗尽');
  }

  // L2：Gemini 直连 YouTube（视频理解）
  // 让 Gemini 自己去拉取并理解整段视频，耗时远超纯文本请求 —— 日志里两个模型
  // 都是 15s 超时。给它单独的宽松超时，否则等于保证失败还白烧 30s 预算。
  const l2Budget = deadline - Date.now();
  if (l2Budget < L2_MIN_BUDGET) {
    console.warn('[summarize] skip layer2, budget too low:', l2Budget, 'ms');
  } else {
    try {
      const summary = await summarizeViaGemini(video, env, deadline, run);
      console.log('[summarize] layer2(gemini-direct) ok');
      return buildSummaryResult(summary);
    } catch (e) {
      console.warn('[summarize] layer2 failed:', e.message);
      if (e.fatal) return buildFallbackMessage(video, 'API key 无效');
      if (e.quota) return buildFallbackMessage(video, 'API 配额已耗尽');
    }
  }

  // L3：标题 + 描述
  try {
    const summary = await summarizeTextFallback(video, env, deadline, run);
    console.log('[summarize] layer3(fallback) ok');
    // L3 只看得到元信息，算「基于标题描述整理」的降级摘要，但内容有效 → 标记已读
    return buildSummaryResult(summary);
  } catch (e) {
    console.error('[summarize] layer3 failed:', e.message);
    if (e.quota) return buildFallbackMessage(video, 'API 配额已耗尽');
    return buildFallbackMessage(video);
  }
}

// ============================================================
//  字幕获取（多源 + HTML 拦截）
// ============================================================
// 带超时的 fetch：Workers 的 fetch 没有默认超时，挂住的源会吃光整个预算
async function fetchWithTimeout(url, { timeoutMs, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`timeout after ${timeoutMs}ms`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 字幕源清单：每项是一个 async 探针，返回 {segments} 或 {text}
// 顺序 = 优先级。YouTube 官方 timedtext 放最前（无需第三方、最稳）
function buildTranscriptSources(videoId, env) {
  const sources = [];

  // 源 1：YouTube 官方 timedtext。人工字幕 + 自动字幕（asr）各试一遍
  for (const lang of ['zh-Hans', 'zh', 'en']) {
    sources.push({
      name: `timedtext:${lang}`,
      run: () => fetchTimedText(videoId, lang, false),
    });
  }
  sources.push({
    name: 'timedtext:asr-en',
    run: () => fetchTimedText(videoId, 'en', true),
  });

  // 源 2：Invidious —— 先列可用字幕，再按语言优先级取对应的 VTT
  for (const host of parseList(env.INVIDIOUS_HOSTS, DEFAULT_INVIDIOUS)) {
    sources.push({
      name: `invidious:${host.replace(/^https?:\/\//, '')}`,
      run: () => fetchInvidiousCaptions(host, videoId),
    });
  }

  // 源 3：自定义字幕 API（{id} 占位符替换为 videoId）
  for (const tpl of parseList(env.TRANSCRIPT_APIS, [])) {
    sources.push({
      name: `api:${tpl.slice(0, 40)}`,
      run: () => fetchGenericApi(tpl.replace(/\{id\}/g, videoId)),
    });
  }

  return sources;
}

// ---- 源 1：YouTube timedtext ----
// 返回 XML（<text start="12.34">…</text>），不是 JSON —— 旧代码在这里直接 JSON.parse 崩掉
async function fetchTimedText(videoId, lang, asr) {
  const params = new URLSearchParams({ v: videoId, lang, fmt: 'srv3' });
  if (asr) {
    params.set('kind', 'asr');
    params.set('tlang', lang);
  }
  const res = await fetchWithTimeout(
    `https://www.youtube.com/api/timedtext?${params}`,
    { timeoutMs: TRANSCRIPT_TIMEOUT, headers: { 'User-Agent': UA } }
  );
  if (!res.ok) throw new Error(`http ${res.status}`);
  const text = await res.text();
  // 无字幕时 YouTube 返回 200 + 空 body
  if (!text.trim()) throw new Error('empty body (no captions in this lang)');
  return { segments: parseTimedTextXml(text) };
}

// ---- 源 2：Invidious ----
// 两步：GET /api/v1/captions/{id} 拿 JSON 清单 → 按语言取 VTT 纯文本
async function fetchInvidiousCaptions(host, videoId) {
  const listRes = await fetchWithTimeout(`${host}/api/v1/captions/${videoId}`, {
    timeoutMs: TRANSCRIPT_TIMEOUT,
    headers: { 'User-Agent': UA },
  });
  if (!listRes.ok) throw new Error(`list http ${listRes.status}`);

  const listText = await listRes.text();
  if (looksLikeHtml(listText)) throw new Error('list returned html');

  const list = JSON.parse(listText);
  const captions = Array.isArray(list?.captions) ? list.captions : [];
  if (!captions.length) throw new Error('no captions listed');

  const picked = pickCaption(captions);
  if (!picked) throw new Error('no matching language');

  // 关键：这里返回的是 WebVTT 纯文本，不能 JSON.parse
  const url = picked.url?.startsWith('http') ? picked.url : `${host}${picked.url}`;
  const vttRes = await fetchWithTimeout(url, {
    timeoutMs: TRANSCRIPT_TIMEOUT,
    headers: { 'User-Agent': UA },
  });
  if (!vttRes.ok) throw new Error(`vtt http ${vttRes.status}`);

  const vtt = await vttRes.text();
  if (looksLikeHtml(vtt)) throw new Error('vtt returned html');
  return { segments: parseVtt(vtt) };
}

// 按 LANG_PRIORITY 选字幕轨；都不匹配时退回第一条
function pickCaption(captions) {
  for (const want of LANG_PRIORITY) {
    const hit = captions.find((c) => {
      const code = String(c.language_code || c.languageCode || '').toLowerCase();
      const label = String(c.label || c.name || '').toLowerCase();
      return code === want || code.startsWith(want) || label.includes(want);
    });
    if (hit?.url) return hit;
  }
  return captions.find((c) => c.url) || null;
}

// ---- 源 3：通用第三方 API（格式各家不同，尽量兼容）----
async function fetchGenericApi(url) {
  const res = await fetchWithTimeout(url, {
    timeoutMs: TRANSCRIPT_TIMEOUT,
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`http ${res.status}`);

  const text = await res.text();
  if (looksLikeHtml(text)) throw new Error('returned html');

  // 按内容嗅探格式，而不是假定 JSON
  if (/^WEBVTT/i.test(text.trim()) || /-->/.test(text)) {
    return { segments: parseVtt(text) };
  }
  if (text.trim().startsWith('<')) {
    return { segments: parseTimedTextXml(text) };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // 既不是 VTT/XML/JSON，当纯文本用（长度校验交给上层）
    return { text };
  }
  return { segments: normalizeJsonSegments(data), text: pickJsonText(data) };
}

// deadline: 到点就停止尝试新源，把剩余预算留给 L2/L3
async function getTranscript(videoId, env, deadline = Infinity) {
  const sources = buildTranscriptSources(videoId, env);
  const tried = Math.min(sources.length, MAX_TRANSCRIPT_ATTEMPTS);

  for (let i = 0; i < tried; i++) {
    const { name, run } = sources[i];

    if (Date.now() + MIN_ATTEMPT_MS > deadline) {
      console.warn('[transcript] budget low, stop trying more sources');
      break;
    }

    try {
      console.log('[transcript] trying', name);
      const out = await run();

      // 有 segments 就带时间戳渲染，否则退回纯文本
      const transcript = out.segments?.length
        ? renderSegments(out.segments)
        : cleanText(out.text || '');

      if (!isUsableTranscript(transcript)) {
        console.warn('[transcript]', name, 'empty / too short / rate-limited');
        continue;
      }

      console.log('[transcript]', name, 'ok, chars:', transcript.length);
      return transcript.slice(0, TRANSCRIPT_MAX_CHARS);
    } catch (e) {
      console.warn('[transcript]', name, 'failed:', e.message);
    }
  }
  throw new Error('all transcript sources failed');
}

// 限流提示页 / 占位内容会伪装成正常返回，这里挡掉。
// 中文信息密度约为英文 3 倍，统一按字符数判定会误杀短中文字幕，故分开取阈值。
function isUsableTranscript(t) {
  if (!t) return false;

  const stripped = t.replace(/\[\d+:\d{2}(?::\d{2})?\]/g, '').trim();
  const cjk = (stripped.match(/[一-鿿぀-ヿ]/g) || []).length;
  const minLen = cjk > stripped.length * 0.3 ? 30 : 80;
  if (stripped.length < minLen) return false;

  return !/高频访问|rate limit|too many requests|合作方案|access denied|sign in to confirm/i.test(stripped);
}

function looksLikeHtml(text) {
  if (!text) return true;
  const t = text.trim().toLowerCase();
  return t.startsWith('<!doctype') || t.startsWith('<html');
}

// ============================================================
//  字幕格式解析（VTT / timedtext XML / JSON）
// ============================================================

// WebVTT → segments。跳过 WEBVTT 头、NOTE 块、纯序号行，解析 00:01:02.345 --> ... 时间轴
function parseVtt(vtt) {
  const segments = [];
  const blocks = vtt.replace(/\r/g, '').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0]) || /^NOTE\b/i.test(lines[0])) continue;

    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) continue;

    const start = parseVttTime(lines[tsIdx].split('-->')[0].trim());
    // 时间轴之后是正文；剥掉 <c>/<v> 之类内联标签
    const body = lines
      .slice(tsIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim();

    if (body) segments.push({ start, text: decodeEntities(body) });
  }
  return dedupeSegments(segments);
}

// "00:01:02.345" / "01:02.345" → 秒
function parseVttTime(str) {
  const parts = str.split(':').map((p) => parseFloat(p.replace(',', '.')) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

// YouTube timedtext：srv3 用 <p t="12340" d="...">，旧版用 <text start="12.34">
function parseTimedTextXml(xml) {
  const segments = [];

  for (const m of xml.matchAll(/<p\b[^>]*\bt="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
    const text = stripTags(m[2]);
    if (text) segments.push({ start: Number(m[1]) / 1000, text });
  }
  if (segments.length) return dedupeSegments(segments);

  for (const m of xml.matchAll(/<text\b[^>]*\bstart="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    const text = stripTags(m[2]);
    if (text) segments.push({ start: Number(m[1]), text });
  }
  return dedupeSegments(segments);
}

// srv3 的 <p> 里嵌 <s> 逐词节点，需要拼接而不是丢弃
function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// 各家 JSON 字幕结构不同，尽量抽出 {start, text}
function normalizeJsonSegments(data) {
  const arr = Array.isArray(data)
    ? data
    : Array.isArray(data?.transcript)
      ? data.transcript
      : Array.isArray(data?.captions)
        ? data.captions
        : Array.isArray(data?.segments)
          ? data.segments
          : Array.isArray(data?.events)
            ? data.events
            : [];

  const segments = [];
  for (const item of arr) {
    if (typeof item === 'string') {
      segments.push({ start: null, text: decodeEntities(item) });
      continue;
    }
    const text = item?.text ?? item?.snippet ?? item?.content ?? '';
    if (!text) continue;
    // offset/tStartMs 常见为毫秒，start/dur 为秒
    const raw = item.start ?? item.offset ?? item.tStartMs ?? item.startMs ?? null;
    let start = raw == null ? null : Number(raw);
    if (start != null && (item.offset != null || item.tStartMs != null || item.startMs != null)) {
      start = start / 1000;
    }
    segments.push({ start, text: decodeEntities(String(text)) });
  }
  return dedupeSegments(segments);
}

function pickJsonText(data) {
  if (typeof data === 'string') return data;
  for (const k of ['transcript', 'content', 'text']) {
    if (typeof data?.[k] === 'string') return data[k];
  }
  return '';
}

// 自动字幕（asr）常见滚动重复：后一条完整包含前一条
function dedupeSegments(segments) {
  const out = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && (prev.text === s.text || s.text.startsWith(prev.text))) {
      out[out.length - 1] = s;   // 用更完整的替换
      continue;
    }
    out.push(s);
  }
  return out;
}

// segments → 带 [MM:SS] 标记的文本。
// prompt 里要求引用时间戳，之前 join(' ') 把 offset 全丢了，模型只能编造。
function renderSegments(segments) {
  const parts = [];
  let nextMark = 0;

  for (const s of segments) {
    if (s.start != null && s.start >= nextMark) {
      parts.push(`[${formatTimestamp(s.start)}]`);
      nextMark = s.start + TS_MARK_EVERY_SEC;
    }
    parts.push(s.text);
  }
  return cleanText(parts.join(' '));
}

function formatTimestamp(sec) {
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(h > 0 ? m : m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

// ============================================================
//  Gemini 调用（模型链 + 退避 + 超时 + 404 跳过）
// ============================================================

// 依次尝试链上每个模型；某个模型 404 → 立即换下一个，不重试
async function callGeminiWithModelChain(
  env,
  buildBody,
  deadline = Infinity,
  run = null,
  timeoutMs = REQUEST_TIMEOUT
) {
  if (!env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY not set');

  // 配额已确认耗尽：本轮任何模型都不可能成功，别再发请求
  if (run?.quotaExhausted) {
    const err = new Error('quota exhausted for this run');
    err.quota = true;
    throw err;
  }

  const models = getModels(env);
  let lastError = '';
  let attempted = 0;

  for (const model of models) {
    // 本轮已确认失效的模型直接跳过（404 / 配额 / 超时都不会自己恢复）
    const dead = run?.deadModels.get(model);
    if (dead) {
      console.log('[gemini] skip', model, '(dead this run:', dead + ')');
      lastError = lastError || `${model} dead: ${dead}`;
      continue;
    }

    // 剩余预算不够发一次请求就别发了，留时间给降级路径
    if (Date.now() + MIN_ATTEMPT_MS > deadline) {
      throw new Error(`budget exhausted before ${model}; last: ${lastError || 'n/a'}`);
    }

    attempted++;
    try {
      const data = await geminiWithRetry(env, model, buildBody(model), 0, deadline, timeoutMs);
      console.log('[gemini] model', model, 'ok');
      return data;
    } catch (e) {
      console.warn('[gemini] model', model, 'failed:', e.message);
      lastError = e.message;

      // 401/403：key 无效，换模型也一样失败，立即整链放弃。
      // 必须原样抛出以保留 e.fatal —— 重新包装会让上层三层降级各自再试一遍。
      if (e.fatal) throw e;

      // 配额型 429：整轮中止，剩余视频不再尝试
      if (e.quota) {
        if (run) {
          run.quotaExhausted = true;
          console.error('[gemini] quota exhausted, aborting this run');
        }
        throw e;
      }

      // 404/410/400 或超时：本轮拉黑，L2/L3 及后续视频都不再试
      if (e.skipModel) {
        run?.deadModels.set(model, `http error: ${e.message.slice(0, 60)}`);
        console.log('[gemini] blacklist', model, '(unsupported)');
        continue;
      }
      if (/timeout after/.test(e.message)) {
        run?.deadModels.set(model, 'timeout');
        console.log('[gemini] blacklist', model, '(timeout)');
        continue;
      }
      // 限速型 429 / 5xx：可能恢复，不拉黑，换下一个模型
    }
  }

  if (!attempted) throw new Error(`all models dead this run; last: ${lastError}`);
  throw new Error(`all models failed: ${lastError}`);
}

// 单模型 + 指数退避（仅对 429/5xx）
async function geminiWithRetry(
  env,
  model,
  body,
  attempt = 0,
  deadline = Infinity,
  maxTimeout = REQUEST_TIMEOUT
) {
  const url = `${GEMINI_ENDPOINT}/models/${model}:generateContent`;

  // 超时取「上限」与「剩余预算」的较小值，避免单次请求越界
  const budgetLeft = deadline - Date.now();
  const timeoutMs = Math.max(1000, Math.min(maxTimeout, budgetLeft));

  const res = await fetchWithTimeout(url, {
    timeoutMs,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // key 放 header，不进 URL —— 避免出现在日志/错误信息里
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (res.ok) return await res.json();

  const status = res.status;
  let detail = '';
  try {
    detail = (await res.json())?.error?.message || '';
  } catch {}

  console.warn(
    `[gemini] ${model} http ${status} attempt ${attempt + 1}/${MAX_RETRIES + 1}: ${detail}`
  );

  // 401/403：key 无效/被拒，整条模型链都别试了
  if (FATAL_STATUS.has(status)) {
    const err = new Error(`Gemini http ${status}: ${detail}`);
    err.fatal = true;
    throw err;
  }

  // 400/404/410：模型不可用，标记跳过（不重试）
  if (SKIP_MODEL_STATUS.has(status)) {
    const err = new Error(`Gemini http ${status}: ${detail}`);
    err.skipModel = true;
    throw err;
  }

  // 其他非重试错误
  if (!RETRYABLE.has(status)) {
    throw new Error(`Gemini http ${status}: ${detail}`);
  }

  // 429 要分两种：配额耗尽（等一天）vs 瞬时限速（等几秒）。
  // 配额耗尽时重试和换模型都是纯浪费 —— 免费层配额是账号级、跨模型共享的。
  if (status === 429 && isQuotaError(detail)) {
    const err = new Error(`Gemini quota exhausted: ${detail}`);
    err.quota = true;
    throw err;
  }

  // 429/5xx：重试耗尽则抛（交给模型链换下一个）
  if (attempt >= MAX_RETRIES) {
    throw new Error(`Gemini retry exhausted: ${status} ${detail}`);
  }

  // 指数退避 + jitter（短睡，容量问题睡久也没用）
  const wait = Math.min(1000 * 2 ** attempt + Math.floor(Math.random() * 500), 8000);

  // 睡完加重试一次就超预算的话，直接换模型
  if (Date.now() + wait + MIN_ATTEMPT_MS > deadline) {
    throw new Error(`Gemini ${status}, no budget to retry`);
  }

  console.log(`[gemini] retry after ${wait}ms`);
  await sleep(wait);
  return geminiWithRetry(env, model, body, attempt + 1, deadline, maxTimeout);
}

// ---- L1：纯文本（字幕）总结 ----
async function summarizeText(text, video, env, deadline, run) {
  const prompt =
    buildSummaryPrompt({ hasTimestamps: /\[\d+:\d{2}/.test(text) }) +
    `\n\n以下是视频的字幕内容（[MM:SS] 为该段的真实时间戳），请据此总结：\n\n${text}` +
    `\n\n视频标题：${video.title}`;
  const data = await callGeminiWithModelChain(
    env,
    () => ({ contents: [{ parts: [{ text: prompt }] }] }),
    deadline,
    run
  );
  return extractText(data);
}

// ---- L2：Gemini 直连 YouTube ----
async function summarizeViaGemini(video, env, deadline, run) {
  const data = await callGeminiWithModelChain(
    env,
    () => ({
      contents: [
        {
          parts: [
            { text: buildSummaryPrompt({ hasTimestamps: true }) },
            { file_data: { file_uri: video.link } },
          ],
        },
      ],
    }),
    deadline,
    run,
    VIDEO_REQUEST_TIMEOUT   // 视频理解用宽松超时
  );
  return extractText(data);
}

// ---- L3：仅标题 + 描述 ----
async function summarizeTextFallback(video, env, deadline, run) {
  const title = video.title?.trim() || '未知标题';
  const description = video.description?.trim() || '';
  const published = video.published || '未知时间';
  const channelName = video.channelName || '未知频道';

  // 连标题都没有，直接发简版，不浪费调用
  if (title === '未知标题' && !description) {
    throw new Error('no metadata to summarize');
  }

  const prompt =
    buildSummaryPrompt({ hasTimestamps: false }) +
    `\n\n注意：仅提供元信息（未直接读取视频内容），请在"一句话结论"后标注"（基于标题与描述整理）"。\n\n` +
    `频道：${channelName}\n发布时间：${published}\n视频标题：${title}\n视频描述：${description || '（无描述）'}`;

  const data = await callGeminiWithModelChain(
    env,
    () => ({ contents: [{ parts: [{ text: prompt }] }] }),
    deadline,
    run
  );
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
function buildSummaryPrompt({ hasTimestamps = false } = {}) {
  // 没有时间戳数据时绝不要求模型标注 —— 否则它只能编造
  const tsRule = hasTimestamps
    ? '- 时间标记：仅可引用原文中已出现的 [MM:SS]，不得推算或编造；无法确定则省略'
    : '- 不要输出任何时间戳（本次输入不含时间信息，编造即错误）';

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
${tsRule}

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
  const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`;
  console.log('[fetchRSS] url:', rssUrl);
  const res = await fetchWithTimeout(rssUrl, {
    timeoutMs: TRANSCRIPT_TIMEOUT,
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);
  const xml = await res.text();
  console.log('[fetchRSS] xml length:', xml.length);
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

    // RSS 里是转义过的（&amp; &#39; &quot;），不解码会原样显示在微信里，
    // 模型看到的也是转义文本。
    return {
      id: idRaw,
      videoId,
      title: decodeEntities(title),
      description: decodeEntities(description).slice(0, 3000),
      published,
      link,
      channelName: decodeEntities(channelName),
    };
  });
}

// XML/HTML 实体解码。命名实体只覆盖 XML 预定义 5 个 + nbsp，其余走数字实体。
// 注意 &amp; 必须最后解，否则 "&amp;lt;" 会被二次解码成 "<"。
function decodeEntities(str) {
  if (!str) return '';
  return String(str)
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeCodePoint(n) {
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return '';
  try {
    return String.fromCodePoint(n);
  } catch {
    return '';
  }
}

// ============================================================
//  企业微信推送
// ============================================================
async function pushWeCom(video, summary, env) {
  const webhook = env.WECOM_WEBHOOK;
  if (!webhook) throw new Error('WECOM_WEBHOOK not set');

  // 企业微信 markdown 不支持 --- 水平线（会原样显示），用空行分隔
  const header =
    `## 📺 ${escapeMd(video.title || '（无标题）')}\n` +
    `> 👤 ${escapeMd(video.channelName || '未知')}　🕐 ${formatDate(video.published)}\n\n`;
  const footer = `\n\n[▶️ 观看原视频](${video.link})`;

  const content = header + clampForWeCom(summary, header, footer) + footer;

  const r = await fetchWithTimeout(webhook, {
    timeoutMs: WECOM_TIMEOUT,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
  });

  if (!r.ok) throw new Error(`WeCom http ${r.status}`);

  const j = await r.json();
  if (j.errcode && j.errcode !== 0) {
    throw new Error(`WeCom push failed: ${JSON.stringify(j)}`);
  }
  return j;
}

// 企业微信 markdown 上限 4096 字节（按 UTF-8 计，中文 3 字节/字）。
// 超限会整条推送失败，这里按字节截断并留出省略提示。
function clampForWeCom(summary, header, footer) {
  const enc = new TextEncoder();
  const reserved = enc.encode(header + footer).length;
  const notice = '\n\n…（内容过长已截断）';
  const budget = WECOM_MAX_BYTES - reserved - enc.encode(notice).length;

  const body = String(summary || '');
  if (enc.encode(body).length <= WECOM_MAX_BYTES - reserved) return body;
  if (budget <= 0) return '';

  // 二分找最大可容纳的字符数，避免逐字符 encode
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(body.slice(0, mid)).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  console.warn('[pushWeCom] summary truncated to', lo, 'chars');
  return body.slice(0, lo) + notice;
}

function escapeMd(str) {
  if (!str) return '';
  return str.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
}

// 北京时间。旧实现 (getUTCHours()+8)%24 只回绕小时不进位日期，
// UTC 16:00 之后发布的视频日期会少一天。正确做法：先加偏移再取字段。
function formatDate(iso) {
  if (!iso) return '未知';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;

  const d = new Date(t + 8 * 3600 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}`;
}

// ============================================================
//  工具函数
// ============================================================
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 解析 JSON 数组或逗号分隔字符串。
// 合法 JSON 数组按原样返回（显式写 [] 就是「一个都不要」），
// 只有变量未设置/空字符串才回退 fallback。
function parseList(raw, fallback = []) {
  if (!raw || !String(raw).trim()) return fallback;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch {}
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

// 返回缺失的必需变量；缺 KV/webhook 时直接停跑，不做无用调用
function ensureConfig(env) {
  const missing = [];
  if (!env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (!env.WECOM_WEBHOOK) missing.push('WECOM_WEBHOOK');
  if (!env.API_TOKEN) missing.push('API_TOKEN');
  if (!env.KV) missing.push('KV(binding)');
  if (missing.length) console.error('[config] 缺少变量:', missing.join(', '));
  return missing;
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
