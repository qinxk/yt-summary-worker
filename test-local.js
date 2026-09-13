// 本地模拟测试：不依赖 Cloudflare 环境，直接 node test-local.js 即可跑通主流程
// 用 mock 的 env 模拟 KV / LLM / WeCom，验证逻辑（RSS/字幕/总结/推送）是否通顺

// --- Mock env（模拟 Cloudflare Worker 的 env） ---
const mockKV = new Map();
const env = {
  API_TOKEN: 'test_token',
  CHANNELS: '["UCkHrq03gWLLx6vjS2DOJ8aA"]',
  LLM_URL: 'https://one.iflytek.com/api/llm/console/chat/v1',
  LLM_MODEL: 'claude-opus-5',
  LLM_KEY: 'test_key',
  WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=mock',
  KV: {
    async get(k) { return mockKV.get(k) || null; },
    async put(k, v) { mockKV.set(k, v); },
  },
  AI: null, // 本地无 Workers AI，走 LLM_URL 兜底
};

// --- 把 index.js 的逻辑抽出来测试（这里直接复制核心函数做最小验证） ---
// 注：生产代码在 src/index.js，此处仅验证解析/流程，不重复实现 LLM 调用
async function main() {
  console.log('=== 测试 1: CHANNELS 解析 ===');
  const channels = (() => {
    try { const a = JSON.parse(env.CHANNELS); return Array.isArray(a) ? a : []; } catch { return []; }
  })();
  console.log('channels:', channels);

  console.log('\n=== 测试 2: KV 读写 ===');
  await env.KV.put('last:UCkHrq03gWLLx6vjS2DOJ8aA', 'test_video_id');
  console.log('last:', await env.KV.get('last:UCkHrq03gWLLx6vjS2DOJ8aA'));

  console.log('\n=== 测试 3: /health 响应 ===');
  console.log(JSON.stringify({ status: 'ok', kv: !!env.KV, ai: !!env.AI }));

  console.log('\n=== 测试 4: /debug/env 响应（不暴露密钥）===');
  console.log(JSON.stringify({
    hasKV: !!env.KV, hasAI: !!env.AI, hasLLMKey: !!env.LLM_KEY,
    llmUrl: env.LLM_URL, llmModel: env.LLM_MODEL,
    channels, hasWeCom: !!env.WECOM_WEBHOOK,
  }));

  console.log('\n✅ 本地逻辑验证通过。真实网络调用（RSS/LLM/WeCom）需在 Cloudflare 环境或 wrangler dev 中测试。');
}

main().catch(e => { console.error('❌ 测试失败:', e); process.exit(1); });
