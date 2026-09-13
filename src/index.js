/* ============================================================
 * Gemini 调用模块 —— 最终稳定版
 * 依据：GET /v1beta/models 返回的当前账号可用模型清单
 *
 * 设计原则：
 * 1. 主模型用 gemini-2.5-flash（稳定、免费层友好、会 thinking）
 * 2. 模型链顺序：稳 > 省 > 新，绝不把 preview/新版本放第一
 * 3. 404/410 等"模型不存在"立即跳过，不浪费重试
 * 4. 429/5xx 才做指数退避（但总预算受外层控制）
 * 5. 单次请求硬超时，绝不拖死 Worker
 * ============================================================ */

// ---------- 配置（与 wrangler.toml [vars] 对齐） ----------
// GEMINI_MODEL  : 主模型，默认 gemini-2.5-flash
// GEMINI_MODELS : 降级链，JSON 数组字符串
//   => 推荐 '["gemini-2.5-flash","gemini-2.5-flash-lite","gemini-flash-latest","gemini-3-flash-preview"]'
// MODEL_TIMEOUT_MS : 单次 generateContent 硬超时，默认 15000

const DEFAULT_CHAIN = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-flash-latest",
  "gemini-3-flash-preview", // 列表里真实存在的名字（带 -preview）
];

// 致命错误：模型不存在/不可用 → 立刻换下一个，绝不重试
const FATAL_STATUS = new Set([400, 401, 403, 404, 410, 422]);
// 可重试错误：限流 / 服务器忙 / 网关错
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * 对一个 model 做一次 generateContent，带硬超时。
 * 返回 { ok:true, data } 或 { ok:false, status, message, fatal }
 */
async function generateOnce(env, model, body, signal) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${model}` +
    `:generateContent?key=${env.GEMINI_API_KEY}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal, // AbortSignal，外层控制总预算
  });

  if (res.ok) {
    return { ok: true, data: await res.json() };
  }

  // 读错误体（不抛，统一在调用层处理）
  let message = "";
  try {
    message = (await res.json())?.error?.message || res.statusText;
  } catch {
    message = res.statusText;
  }

  return {
    ok: false,
    status: res.status,
    message,
    // 404/410 等说明这个 model 名不可用 → 标记为 fatal，换模型不重试
    fatal: FATAL_STATUS.has(res.status),
  };
}

/**
 * 走模型链调用 Gemini，返回最后一条成功 data；全部失败抛聚合错误。
 * body: { contents, generationConfig, ... }
 *
 * 重试策略（在「单个模型」内）：
 *   - fatal(404/410)       → 立即跳过该模型
 *   - retryable(429/5xx)   → 指数退避最多 RETRIES 次
 * 外层「模型链」逐一下去，直到成功或全部 fatal。
 */
export async function callGemini(env, body, opts = {}) {
  const chain = parseChain(env.GEMINI_MODELS) || DEFAULT_CHAIN;
  const perModelTimeout = Number(env.MODEL_TIMEOUT_MS) || 15000;
  const RETRIES = 2; // 每个模型最多重试 2 次（含首次共 3 次）

  const errors = [];

  for (const model of chain) {
    let attempts = 0;
    while (attempts <= RETRIES) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), perModelTimeout);

      let result;
      try {
        result = await generateOnce(env, model, body, controller.signal);
      } catch (e) {
        // fetch 本身抛错（网络/超时/abort）
        result = {
          ok: false,
          status: 0,
          message: e.name === "AbortError" ? `timeout after ${perModelTimeout}ms` : e.message,
          fatal: false,
        };
      } finally {
        clearTimeout(timer);
      }

      if (result.ok) {
        console.log(`[gemini] model ${model} ok`);
        return result.data; // ✅ 成功，直接返回
      }

      errors.push(`${model}:${result.status} ${truncate(result.message, 120)}`);

      // 模型不存在 → 立刻换下一个模型，不重试
      if (result.fatal) {
        console.warn(`[gemini] skip ${model} (fatal ${result.status})`);
        break;
      }

      attempts++;
      if (attempts > RETRIES) {
        console.warn(`[gemini] ${model} exhausted after ${RETRIES} retries`);
        break;
      }

      // 指数退避 + 抖动（仅限 429/5xx）
      const delay = Math.min(500 * 2 ** (attempts - 1) + Math.random() * 300, 3000);
      console.log(`[gemini] ${model} retry ${attempts}/${RETRIES} after ${Math.round(delay)}ms`);
      await sleep(delay);
    }
  }

  // 全部模型、全部重试都失败
  const err = new Error(`all Gemini models failed: ${errors.join(" | ")}`);
  err.name = "GeminiAllFailed";
  throw err;
}

/* ==================== 便捷封装：视频总结 ==================== */

/**
 * 用字幕文本总结（Layer1，最稳、最便宜）。
 * transcript: { text, source }
 */
export async function summarizeByTranscript(video, transcript, env) {
  const prompt = buildSummaryPrompt(video, { hasTranscript: true });
  const contents = {
    contents: [
      { role: "user", parts: [{ text: prompt }, { text: `\n\n以下是该视频的字幕/文稿内容：\n\n${transcript.text}` }] },
    ],
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
  };
  const data = await callGemini(env, contents);
  return extractText(data);
}

/**
 * Gemini 直连 YouTube 视频（Layer2，走 file_data/file_uri）。
 * 仅在拿到可访问的 videoUri 时用。
 */
export async function summarizeByVideoUri(video, videoUri, env) {
  const prompt = buildSummaryPrompt(video, { hasTranscript: false });
  const contents = {
    contents: [
      { role: "user", parts: [{ text: prompt }, { file_data: { file_uri: videoUri } }] },
    ],
    generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
  };
  const data = await callGemini(env, contents);
  return extractText(data);
}

/**
 * 降级：仅用标题 + 描述（Layer3）。
 */
export async function summarizeByMetadata(video, env) {
  const title = video.title || "未知标题";
  const description = video.description || "无描述";
  if (title === "未知标题" && description === "无描述") {
    return null; // 连标题都没有，别浪费调用
  }

  const prompt = buildSummaryPrompt(video, { fallback: true });
  const contents = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            text:
              `\n\n以下是该视频的标题与描述（未获取到字幕/文稿）：\n` +
              `频道：${video.channelName || "未知频道"}\n` +
              `标题：${title}\n` +
              `发布：${video.published || "未知时间"}\n` +
              `描述：${description}`,
          },
        ],
      },
    ],
    generationConfig: { temperature: 0.7, maxOutputTokens: 1200 },
  };
  const data = await callGemini(env, contents);
  return extractText(data);
}

/* ==================== Prompt ==================== */

function buildSummaryPrompt(video, ctx = {}) {
  const { hasTranscript, fallback } = ctx;
  const lines = [];

  lines.push("你是一个专业的视频内容分析师，请用中文对以下 YouTube 视频进行深度总结。");

  if (fallback) {
    lines.push("⚠️ 注意：以下仅基于标题与描述整理，未读取字幕或视频内容，请在开头明确标注这一点。");
  }

  lines.push("\n## 第一步：识别分类");
  lines.push("根据内容判断类别，侧重不同维度：");
  lines.push("- 财经/经济：数字、趋势、影响范围、政策背景");
  lines.push("- 社会/时政：时间线、人物关系、法律/政策背景");
  lines.push("- 科技/互联网：技术原理、行业影响、竞争格局");
  lines.push("- 其他：按主题自行定义侧重方向");

  lines.push("\n## 第二步：按以下固定格式输出（Markdown）");
  lines.push("### 📌 一句话结论");
  lines.push("用一句话概括视频核心观点或事件结果。");
  lines.push("\n### 📋 核心要点（3-5 个）");
  lines.push("每个要点包含：");
  lines.push("- **要点标题**（简短概括）");
  lines.push("- **详细说明**（2-3 句话，含关键数据、人物、因果关系）");
  lines.push("- **时间标记**（仅当能确定时标注 [MM:SS]，不确定就省略，绝不编造）");
  lines.push("\n### 🔍 关键信息 / 值得关注");
  lines.push("2-3 条容易被忽略但重要的细节（背景、后续影响、立场分歧、数据来源）。");
  lines.push("\n### 💬 延伸思考（可选）");
  lines.push("若涉及争议性话题，简述不同立场的观点分歧。");

  lines.push("\n## 约束");
  lines.push("- 简体中文，不要复述标题和链接（已在消息头部展示）");
  lines.push("- 禁止输出「根据视频内容…」等废话前缀");
  lines.push("- 总长度 500-900 字");
  lines.push("- 要点之间用空行分隔，便于手机阅读");
  if (hasTranscript) {
    lines.push("- 你下方收到的是字幕/文稿文本，请据此总结");
  }

  return lines.join("\n");
}

/* ==================== 工具函数 ==================== */

function extractText(data) {
  return (
    data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text)
      .join("")
      ?.trim() || ""
  );
}

function parseChain(raw) {
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

function truncate(str, n) {
  str = String(str || "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ==================== 健康检查（可选） ==================== */

/**
 * 启动时调一次，打印当前 key 能用的模型链，便于排查。
 * 用法：在 fetch 入口 await healthCheck(env)
 */
export async function healthCheck(env) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) {
      console.warn("[gemini] health: cannot list models", res.status);
      return;
    }
    const { models } = await res.json();
    const textModels = (models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace("models/", ""));
    console.log("[gemini] available text models:", textModels.join(", "));
  } catch (e) {
    console.warn("[gemini] health check failed:", e.message);
  }
}
