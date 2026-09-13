// 本地验证：字幕解析 / 实体解码 / 时区 / 截断 / 配置解析
// 用法：node test-local.js
//
// 这些是纯函数，从 src/index.js 复制过来做回归验证。
// 改了 src 里的对应实现，请同步这里。

let pass = 0;
let fail = 0;

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}\n     期望: ${e}\n     实际: ${a}`);
  }
}

function ok(name, cond) {
  eq(name, !!cond, true);
}

// ============ 被测实现（与 src/index.js 保持一致）============

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

function cleanText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function stripTags(s) {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function dedupeSegments(segments) {
  const out = [];
  for (const s of segments) {
    const prev = out[out.length - 1];
    if (prev && (prev.text === s.text || s.text.startsWith(prev.text))) {
      out[out.length - 1] = s;
      continue;
    }
    out.push(s);
  }
  return out;
}

function parseVttTime(str) {
  const parts = str.split(':').map((p) => parseFloat(p.replace(',', '.')) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

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
    const body = lines.slice(tsIdx + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (body) segments.push({ start, text: decodeEntities(body) });
  }
  return dedupeSegments(segments);
}

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

function formatTimestamp(sec) {
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderSegments(segments, everySec = 45) {
  const parts = [];
  let nextMark = 0;
  for (const s of segments) {
    if (s.start != null && s.start >= nextMark) {
      parts.push(`[${formatTimestamp(s.start)}]`);
      nextMark = s.start + everySec;
    }
    parts.push(s.text);
  }
  return cleanText(parts.join(' '));
}

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

function safeParseChannels(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch {}
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function parseList(raw, fallback = []) {
  if (!raw || !String(raw).trim()) return fallback;
  try {
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
  } catch {}
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function clampForWeCom(summary, header, footer, MAX = 4096) {
  const enc = new TextEncoder();
  const reserved = enc.encode(header + footer).length;
  const notice = '\n\n…（内容过长已截断）';
  const budget = MAX - reserved - enc.encode(notice).length;
  const body = String(summary || '');
  if (enc.encode(body).length <= MAX - reserved) return body;
  if (budget <= 0) return '';
  let lo = 0;
  let hi = body.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (enc.encode(body.slice(0, mid)).length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return body.slice(0, lo) + notice;
}

function isUsableTranscript(t) {
  if (!t) return false;
  const stripped = t.replace(/\[\d+:\d{2}(?::\d{2})?\]/g, '').trim();
  const cjk = (stripped.match(/[一-鿿぀-ヿ]/g) || []).length;
  const minLen = cjk > stripped.length * 0.3 ? 30 : 80;
  if (stripped.length < minLen) return false;
  return !/高频访问|rate limit|too many requests|合作方案|access denied|sign in to confirm/i.test(stripped);
}

// ============ 测试 ============

console.log('\n[1] WebVTT 解析（Invidious 返回格式，旧代码在这里 JSON.parse 崩掉）');
{
  const vtt = `WEBVTT
Kind: captions
Language: zh-Hans

00:00:01.000 --> 00:00:04.000
大家好 今天聊聊<c.colorE5E5E5>美联储</c>

00:00:04.500 --> 00:00:08.000
利率决议 &amp; 市场反应

00:01:30.000 --> 00:01:34.000
这是第三段`;

  const segs = parseVtt(vtt);
  eq('段数', segs.length, 3);
  eq('剥掉内联标签', segs[0].text, '大家好 今天聊聊美联储');
  eq('实体解码', segs[1].text, '利率决议 & 市场反应');
  eq('时间解析(1:30 → 90s)', segs[2].start, 90);
  ok('渲染后带时间戳', renderSegments(segs).includes('[00:01]'));
  ok('45s 后插新标记', renderSegments(segs).includes('[01:30]'));
}

console.log('\n[2] timedtext XML 解析（YouTube 官方源）');
{
  const srv3 = `<?xml version="1.0"?><timedtext><body>
<p t="1200" d="3000"><s>Hello</s><s> world</s></p>
<p t="5000" d="2000">second &#39;line&#39;</p>
</body></timedtext>`;
  const segs = parseTimedTextXml(srv3);
  eq('srv3 段数', segs.length, 2);
  eq('拼接 <s> 逐词节点', segs[0].text, 'Hello world');
  eq('毫秒转秒', segs[0].start, 1.2);
  eq('数字实体解码', segs[1].text, "second 'line'");

  const legacy = `<transcript><text start="7.5" dur="2">old format</text></transcript>`;
  eq('旧版 <text start=>', parseTimedTextXml(legacy), [{ start: 7.5, text: 'old format' }]);
}

console.log('\n[3] 自动字幕滚动去重');
{
  const segs = dedupeSegments([
    { start: 0, text: '今天' },
    { start: 1, text: '今天我们' },
    { start: 2, text: '今天我们聊' },
    { start: 5, text: '另一句' },
  ]);
  eq('滚动重复合并为最完整的一条', segs.map((s) => s.text), ['今天我们聊', '另一句']);
}

console.log('\n[4] HTML 实体解码');
{
  eq('&amp; 最后解，不二次解码', decodeEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
  eq('组合实体', decodeEntities('A &amp; B &#39;C&#39; &quot;D&quot;'), `A & B 'C' "D"`);
  eq('十六进制实体', decodeEntities('&#x4e2d;&#x6587;'), '中文');
  eq('非法码点丢弃', decodeEntities('&#99999999;'), '');
}

console.log('\n[5] 北京时间换算（旧实现跨天少一天）');
{
  eq('UTC 16:30 → 次日 00:30', formatDate('2026-09-13T16:30:00Z'), '2026-09-14 00:30');
  eq('UTC 23:00 → 次日 07:00', formatDate('2026-09-13T23:00:00Z'), '2026-09-14 07:00');
  eq('月末跨月', formatDate('2026-09-30T20:00:00Z'), '2026-10-01 04:00');
  eq('年末跨年', formatDate('2026-12-31T18:00:00Z'), '2027-01-01 02:00');
  eq('上午不受影响', formatDate('2026-09-13T02:00:00Z'), '2026-09-13 10:00');
  eq('非法输入原样返回', formatDate('not-a-date'), 'not-a-date');
}

console.log('\n[6] 企业微信 4096 字节截断');
{
  const header = '## 标题\n> 频道\n\n';
  const footer = '\n\n[观看](https://x)';
  eq('短内容不截断', clampForWeCom('短摘要', header, footer), '短摘要');

  const long = '中'.repeat(2000); // 6000 字节，超限
  const out = clampForWeCom(long, header, footer);
  const bytes = new TextEncoder().encode(header + out + footer).length;
  ok('截断后不超 4096 字节', bytes <= 4096);
  ok('带截断提示', out.includes('已截断'));
  ok('不切坏多字节字符', !out.includes('�'));
}

console.log('\n[7] 限流页/占位内容识别');
{
  ok('正常字幕通过', isUsableTranscript('这是一段足够长的正常字幕内容'.repeat(8)));
  ok('太短拒绝', !isUsableTranscript('太短了'));
  ok('限流提示拒绝', !isUsableTranscript('Rate limit exceeded, please contact us'.repeat(4)));
  ok('空值拒绝', !isUsableTranscript(''));
  ok('英文边界：79 字符拒绝', !isUsableTranscript('a'.repeat(79)));
  ok('英文边界：80 字符通过', isUsableTranscript('a'.repeat(80)));
  // 中文密度高，30 字就够总结
  ok('中文 33 字通过（旧的 80 门槛会误杀）', isUsableTranscript('这是一段足够长的字幕内容用于测试确保能够通过最小长度阈值校验'));
  ok('中文 20 字拒绝', !isUsableTranscript('太短的中文字幕内容不够用'));
  ok('时间戳不计入长度', !isUsableTranscript('[00:01] [00:45] [01:30] 很短'));
}

console.log('\n[8] 配置解析');
{
  eq('JSON 数组', safeParseChannels('["UCa","UCb"]'), ['UCa', 'UCb']);
  eq('逗号分隔', safeParseChannels('UCa,UCb'), ['UCa', 'UCb']);
  eq('单个', safeParseChannels('UCkHrq03gWLLx6vjS2DOJ8aA'), ['UCkHrq03gWLLx6vjS2DOJ8aA']);
  eq('空值', safeParseChannels(''), []);
  // 显式 [] 表示「一个都不要」，不能回退默认，也不能被当成字面量 URL
  eq('parseList 显式空数组', parseList('[]', ['d1']), []);
  eq('parseList 未设置回退默认', parseList(undefined, ['d1']), ['d1']);
  eq('parseList 空串回退默认', parseList('  ', ['d1']), ['d1']);
  eq('parseList 正常解析', parseList('["a","b"]', []), ['a', 'b']);
  eq('parseList 逗号分隔', parseList('https://a,https://b', []), ['https://a', 'https://b']);
}

console.log('\n[9] 时间戳格式化');
{
  eq('秒 → MM:SS', formatTimestamp(65), '01:05');
  eq('跨小时 → H:MM:SS', formatTimestamp(3725), '1:02:05');
  eq('零', formatTimestamp(0), '00:00');
}

console.log(`\n${'='.repeat(46)}`);
console.log(fail === 0 ? `✅ 全部通过 (${pass})` : `❌ ${fail} 失败 / ${pass} 通过`);
console.log('='.repeat(46));
process.exit(fail === 0 ? 0 : 1);


