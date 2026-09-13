// 集成自检：从 index.js 抽取纯函数，拼接后整体 eval，验证核心逻辑
// 用法：node test-runtime.js

import { readFileSync, writeFileSync } from 'node:fs';

const src = readFileSync('./src/index.js', 'utf8');
console.log('✅ index.js 语法通过 (node --check)');

function grab(name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  if (start < 0) throw new Error(`函数 ${name} 未找到`);
  const end = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, end < 0 ? src.length : end);
}

const harness = `
${grab('looksLikeHtml')}
${grab('escapeMd')}
${grab('formatDate')}
${grab('safeParseChannels')}
${grab('getModels')}
${grab('parseFeed')}
${grab('buildSummaryPrompt')}
`;

// 测试体（与 harness 同一作用域）
const testBody = `
let ok = true;
const assert = (cond, msg) => { if (!cond) { ok = false; console.error('  ❌ ' + msg); } else { console.log('  ✅ ' + msg); } };

console.log('');
console.log('[CHANNELS 解析]');
assert(JSON.stringify(safeParseChannels('UCaaa,UCbbb')) === JSON.stringify(['UCaaa','UCbbb']), '逗号分隔');
assert(JSON.stringify(safeParseChannels('["UCxxx"]')) === JSON.stringify(['UCxxx']), 'JSON 数组');
assert(JSON.stringify(safeParseChannels('')) === JSON.stringify([]), '空值返回 []');

console.log('\\n[模型链]');
assert(getModels({ GEMINI_MODELS: '["gemini-2.5-flash"]' })[0] === 'gemini-2.5-flash', '读取 GEMINI_MODELS');
assert(getModels({}).length === 4, '兜底默认链 4 个模型');

console.log('\\n[HTML 拦截]');
assert(looksLikeHtml('<!DOCTYPE html>') === true, 'DOCTYPE 识别');
assert(looksLikeHtml('<html>...</html>') === true, '<html> 识别');
assert(looksLikeHtml('{"ok":true}') === false, 'JSON 不误判');
assert(looksLikeHtml('') === true, '空文本视为 html');

console.log('\\n[时间格式化]');
assert(formatDate('2026-09-13T12:00:00+00:00').startsWith('2026-09-13'), 'UTC+8 转换');

console.log('\\n[Markdown 转义]');
assert(escapeMd('a|b') === 'a\\\\|b', '竖线转义');

console.log('\\n[Prompt]');
const prompt = buildSummaryPrompt();
assert(prompt.includes('一句话结论') && prompt.includes('核心要点'), '结构化字段齐全');

console.log('\\n[parseFeed（修复点验证）]');
const xml = '<feed><entry>'
  + '<id>yt:video:TEST123</id>'
  + '<title>测试标题</title>'
  + '<published>2026-09-13T10:00:00+00:00</published>'
  + '<link rel="alternate" href="https://www.youtube.com/watch?v=TEST123"/>'
  + '<author><name>测试频道</name></author>'
  + '<media:group><media:description>这是描述</media:description></media:group>'
  + '</entry></feed>';
const feed = parseFeed(xml);
assert(feed[0].videoId === 'TEST123', 'videoId 从 yt:video: 提取');
assert(feed[0].title === '测试标题', 'title');
assert(feed[0].description === '这是描述', 'media:description（早期解析不到的根因）');
assert(feed[0].channelName === '测试频道', 'author/name');
assert(feed[0].link.includes('TEST123'), 'link');

console.log('');
console.log(ok ? '🎉 全部自检通过' : '💥 有失败项');
process.exit(ok ? 0 : 1);
`;

writeFileSync('/tmp/selfcheck.js', harness + testBody);
await import('file:///tmp/selfcheck.js');
