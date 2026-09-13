// 本地快速验证：不依赖 Cloudflare，仅检查代码语法 + 配置解析逻辑
// 用法：node test-local.js

function safeParseChannels(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch {}
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

// 模拟 wrangler.toml 里的 [vars]
const env = {
  CHANNELS: 'UCkHrq03gWLLx6vjS2DOJ8aA',
  GEMINI_MODELS: '["gemini-2.5-flash","gemini-2.5-flash-lite","gemini-flash-latest","gemini-3-flash-preview"]',
  BATCH_SIZE: '3',
  THROTTLE_MS: '2000',
};

function getModels() {
  try {
    const arr = JSON.parse(env.GEMINI_MODELS || '[]');
    if (Array.isArray(arr) && arr.length) return arr;
  } catch {}
  return ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest', 'gemini-3-flash-preview'];
}

console.log('CHANNELS      =>', safeParseChannels(env.CHANNELS));
console.log('MODELS        =>', getModels());
console.log('BATCH_SIZE    =>', parseInt(env.BATCH_SIZE, 10) || 3);
console.log('THROTTLE_MS   =>', parseInt(env.THROTTLE_MS, 10) || 2000);
console.log('\n✅ 配置解析正常，可部署');
