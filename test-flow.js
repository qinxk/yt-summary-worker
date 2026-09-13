// 端到端流程验证：mock fetch + mock KV，不发真实请求
// 用法：node test-flow.js
// 验证点：去重不重复推送 / 首次运行只推1条 / 字幕源降级 / 缺变量短路 / 推送失败不标记已读

const RSS = `<?xml version="1.0"?><feed>
<entry><id>yt:video:AAA</id><title>视频 A &amp; 测试</title>
<published>2026-09-13T16:30:00Z</published>
<link rel="alternate" href="https://www.youtube.com/watch?v=AAA"/>
<author><name>某频道</name></author>
<media:group><media:description>描述 A</media:description></media:group></entry>
<entry><id>yt:video:BBB</id><title>视频 B</title>
<published>2026-09-12T10:00:00Z</published>
<link rel="alternate" href="https://www.youtube.com/watch?v=BBB"/>
<author><name>某频道</name></author>
<media:group><media:description>描述 B</media:description></media:group></entry>
<entry><id>yt:video:CCC</id><title>视频 C</title>
<published>2026-09-11T10:00:00Z</published>
<link rel="alternate" href="https://www.youtube.com/watch?v=CCC"/>
<author><name>某频道</name></author>
<media:group><media:description>描述 C</media:description></media:group></entry>
</feed>`;

const VTT = `WEBVTT

00:00:01.000 --> 00:00:05.000
这是第一段字幕内容，足够长以通过校验检查

00:00:06.000 --> 00:00:10.000
这是第二段字幕内容，继续增加长度确保超过阈值

00:01:00.000 --> 00:01:05.000
第三段用于验证时间戳标记功能正常工作`;

function makeKV() {
  const store = new Map();
  return {
    store,
    get: async (k) => store.get(k) ?? null,
    put: async (k, v) => void store.set(k, v),
  };
}

// scenario 决定各类请求的响应
function installFetch(scenario, log) {
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    log.push(u.slice(0, 60));

    if (u.includes('feeds/videos.xml')) {
      return new Response(RSS, { status: 200 });
    }
    if (u.includes('/api/timedtext')) {
      if (scenario.timedtext === 'ok') {
        return new Response(
          `<timedtext><body><p t="1000">带时间戳的字幕内容足够长以通过阈值校验检查确保能用</p><p t="60000">第二段内容同样需要足够的长度来满足最小字符数要求</p></body></timedtext>`,
          { status: 200 }
        );
      }
      return new Response('', { status: 200 }); // 空 = 该语言无字幕
    }
    if (u.includes('/api/v1/captions/')) {
      if (scenario.invidious === 'html') {
        return new Response('<!DOCTYPE html><html>error</html>', { status: 200 });
      }
      if (scenario.invidious === 'ok') {
        // 第一步返回清单，第二步返回 VTT
        if (u.includes('label=') || u.includes('.vtt')) {
          return new Response(VTT, { status: 200 });
        }
        return new Response(
          JSON.stringify({
            captions: [{ label: 'Chinese', language_code: 'zh-Hans', url: '/api/v1/captions/X?label=Chinese' }],
          }),
          { status: 200 }
        );
      }
      return new Response('nope', { status: 503 });
    }
    if (u.includes('generativelanguage')) {
      if (scenario.gemini === 'down') {
        return new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503 });
      }
      if (scenario.gemini === 'badkey') {
        return new Response(JSON.stringify({ error: { message: 'invalid key' } }), { status: 403 });
      }
      // 配额耗尽：日志里的真实文案
      if (scenario.gemini === 'quota') {
        return new Response(
          JSON.stringify({
            error: {
              message:
                'You exceeded your current quota, please check your plan and billing details.',
            },
          }),
          { status: 429 }
        );
      }
      // 所有模型都 404（日志里 2.5-flash-lite 的真实情况）
      if (scenario.gemini === 'all404') {
        return new Response(
          JSON.stringify({
            error: { message: 'this model is no longer available to new users' },
          }),
          { status: 404 }
        );
      }
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: '### 📌 一句话结论\n这是摘要' }] } }] }),
        { status: 200 }
      );
    }
    if (u.includes('qyapi.weixin')) {
      if (scenario.wecom === 'fail') {
        return new Response(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook' }), { status: 200 });
      }
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    }
    return new Response('not mocked', { status: 404 });
  };
}

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} ${extra}`);
  }
}

function baseEnv(kv) {
  return {
    KV: kv,
    CHANNELS: 'UCtest',
    GEMINI_API_KEY: 'fake-key',
    WECOM_WEBHOOK: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=x',
    API_TOKEN: 'tok',
    BATCH_SIZE: '3',
    THROTTLE_MS: '0',
    GEMINI_MODELS: '["gemini-2.5-flash","gemini-2.5-flash-lite"]',
    TRANSCRIPT_APIS: '[]',
  };
}

// 静音 worker 内部日志，只保留测试输出
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
function mute() {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}
function unmute() {
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
}

const { default: worker } = await import('./src/index.js');

async function run(env, opts = {}) {
  const req = new Request('https://x/run-once?token=tok');
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
  mute();
  try {
    const res = await worker.fetch(req, env, ctx);
    return await res.json();
  } finally {
    unmute();
  }
}

console.log('\n[1] 正常流程：timedtext 拿到字幕 → 推送');
{
  const kv = makeKV();
  const log = [];
  installFetch({ timedtext: 'ok', gemini: 'ok', wecom: 'ok' }, log);
  const out = await run(baseEnv(kv));

  const pushed = log.filter((u) => u.includes('qyapi')).length;
  ok('首次运行只推 1 条（不刷屏）', pushed === 1, `实际 ${pushed}`);
  ok('用了 timedtext 源', log.some((u) => u.includes('timedtext')));
  ok('没走 Invidious（第一源就成功）', !log.some((u) => u.includes('/api/v1/captions')));
  ok('KV 写入 seen', !!kv.store.get('seen:UCtest'));
  const seen = JSON.parse(kv.store.get('seen:UCtest'));
  ok('3 条都标记已读（2 条跳过 + 1 条推送）', seen.length === 3, `实际 ${seen.length}`);
}

console.log('\n[2] 幂等：同样的 feed 再跑一次');
{
  const kv = makeKV();
  const log1 = [];
  installFetch({ timedtext: 'ok', gemini: 'ok', wecom: 'ok' }, log1);
  await run(baseEnv(kv));

  const log2 = [];
  installFetch({ timedtext: 'ok', gemini: 'ok', wecom: 'ok' }, log2);
  const out = await run(baseEnv(kv));
  const pushed = log2.filter((u) => u.includes('qyapi')).length;
  ok('第二次不重复推送', pushed === 0, `实际 ${pushed}`);
  ok('返回 processed=0', JSON.stringify(out).includes('"processed":0'));
}

console.log('\n[3] 字幕源降级：timedtext 空 → Invidious VTT');
{
  const kv = makeKV();
  kv.store.set('seen:UCtest', JSON.stringify(['yt:video:BBB', 'yt:video:CCC']));
  const log = [];
  installFetch({ timedtext: 'empty', invidious: 'ok', gemini: 'ok', wecom: 'ok' }, log);
  await run(baseEnv(kv));

  ok('试过 timedtext', log.some((u) => u.includes('timedtext')));
  ok('降级到 Invidious', log.some((u) => u.includes('/api/v1/captions')));
  ok('取了 VTT 文件', log.some((u) => u.includes('label=')));
  ok('最终推送成功', log.some((u) => u.includes('qyapi')));
}

console.log('\n[4] Invidious 返回 HTML 错误页（旧代码 JSON.parse 崩溃点）');
{
  const kv = makeKV();
  kv.store.set('seen:UCtest', JSON.stringify(['yt:video:BBB', 'yt:video:CCC']));
  const log = [];
  installFetch({ timedtext: 'empty', invidious: 'html', gemini: 'ok', wecom: 'ok' }, log);
  const out = await run(baseEnv(kv));

  ok('没有崩溃，仍然推送（走 L2/L3 降级）', log.some((u) => u.includes('qyapi')));
  ok('结果标记 ok', JSON.stringify(out).includes('"status":"ok"'));
}

console.log('\n[5] Gemini 全挂 → 仍然推送兜底消息（绝不静默）');
{
  const kv = makeKV();
  kv.store.set('seen:UCtest', JSON.stringify(['yt:video:BBB', 'yt:video:CCC']));
  const log = [];
  installFetch({ timedtext: 'ok', gemini: 'down', wecom: 'ok' }, log);
  await run(baseEnv(kv));
  ok('Gemini 503 也发了微信', log.some((u) => u.includes('qyapi')));
}

console.log('\n[6] API key 无效（403）→ 不空转整条模型链');
{
  const kv = makeKV();
  kv.store.set('seen:UCtest', JSON.stringify(['yt:video:BBB', 'yt:video:CCC']));
  const log = [];
  installFetch({ timedtext: 'ok', gemini: 'badkey', wecom: 'ok' }, log);
  await run(baseEnv(kv));

  const geminiCalls = log.filter((u) => u.includes('generativelanguage')).length;
  ok('403 后立即放弃，不逐个试模型', geminiCalls <= 2, `实际调用 ${geminiCalls} 次`);
  ok('仍然推送提示消息', log.some((u) => u.includes('qyapi')));
}

console.log('\n[7] 推送失败 → 不标记已读，下次能重试');
{
  const kv = makeKV();
  kv.store.set('seen:UCtest', JSON.stringify(['yt:video:BBB', 'yt:video:CCC']));
  const log = [];
  installFetch({ timedtext: 'ok', gemini: 'ok', wecom: 'fail' }, log);
  const out = await run(baseEnv(kv));

  const seen = JSON.parse(kv.store.get('seen:UCtest') || '[]');
  ok('AAA 未被标记已读', !seen.includes('yt:video:AAA'));
  ok('结果里报错', JSON.stringify(out).includes('"status":"error"'));
}

console.log('\n[8] 缺 WECOM_WEBHOOK → 直接短路，不调模型');
{
  const kv = makeKV();
  const log = [];
  installFetch({ timedtext: 'ok', gemini: 'ok', wecom: 'ok' }, log);
  const env = baseEnv(kv);
  delete env.WECOM_WEBHOOK;
  const out = await run(env);

  ok('没有任何 Gemini 调用', !log.some((u) => u.includes('generativelanguage')));
  ok('没有拉 RSS', !log.some((u) => u.includes('feeds/videos')));
  ok('返回缺变量错误', JSON.stringify(out).includes('缺少必需变量'));
}

console.log('\n[9] 旧版 last: 键迁移');
{
  const kv = makeKV();
  kv.store.set('last:UCtest', 'yt:video:BBB');
  const log = [];
  installFetch({ timedtext: 'ok', gemini: 'ok', wecom: 'ok' }, log);
  await run(baseEnv(kv));

  const seen = JSON.parse(kv.store.get('seen:UCtest') || '[]');
  ok('旧锚点被迁移进 seen', seen.includes('yt:video:BBB'));
  const pushed = log.filter((u) => u.includes('qyapi')).length;
  ok('BBB 不重复推送，只推新的', pushed <= 2, `实际 ${pushed}`);
}

console.log('\n[10] 配额 429 → 整轮中止，不逐个视频重烧');
{
  // 预置 seen 里放一个无关 ID，绕开「首次运行只推 1 条」，让 3 个视频都待处理
  const kv = makeKV();
  kv.store.set('seen:UCtest', JSON.stringify(['yt:video:ZZZ']));
  const log = [];
  installFetch({ timedtext: 'ok', gemini: 'quota', wecom: 'ok' }, log);
  const env = baseEnv(kv);
  env.BATCH_SIZE = '3';
  const out = await run(env);

  const geminiCalls = log.filter((u) => u.includes('generativelanguage')).length;
  // 关键：3 个待处理视频，配额错误只应触发 1 次调用（而非每个视频各烧一轮）
  ok('配额错误只调 1 次 Gemini', geminiCalls === 1, `实际 ${geminiCalls} 次`);
  ok('剩余视频标记 skipped', JSON.stringify(out).includes('quota exhausted'));

  const skipped = out.results.filter((r) => r.status === 'skipped').length;
  ok('2 个视频被跳过', skipped === 2, `实际 ${skipped}`);
  ok('推送次数 = 1（只有第一个发了兜底）',
    log.filter((u) => u.includes('qyapi')).length === 1);
}

console.log('\n[11] 降级结果不标记已读（下次能重试）');
{
  const kv = makeKV();
  kv.store.set('seen:UCtest', JSON.stringify(['yt:video:BBB', 'yt:video:CCC']));
  const log = [];
  installFetch({ timedtext: 'ok', gemini: 'quota', wecom: 'ok' }, log);
  const out = await run(baseEnv(kv));

  const seen = JSON.parse(kv.store.get('seen:UCtest') || '[]');
  ok('AAA 未标记已读', !seen.includes('yt:video:AAA'));
  ok('仍然推送了兜底提示', log.some((u) => u.includes('qyapi')));
  ok('结果标记 degraded', JSON.stringify(out).includes('degraded'));
  ok('标记 willRetry', JSON.stringify(out).includes('willRetry'));

  // 配额恢复后再跑，应该拿到真摘要并标记已读
  const log2 = [];
  installFetch({ timedtext: 'ok', gemini: 'ok', wecom: 'ok' }, log2);
  await run(baseEnv(kv));
  const seen2 = JSON.parse(kv.store.get('seen:UCtest') || '[]');
  ok('配额恢复后重试成功并标记已读', seen2.includes('yt:video:AAA'));
}

console.log('\n[12] 模型黑名单：404 模型不在 L2/L3 重复尝试');
{
  const kv = makeKV();
  kv.store.set('seen:UCtest', JSON.stringify(['yt:video:BBB', 'yt:video:CCC']));
  const log = [];
  // 两个模型都 404 → 都该被拉黑；L1 拿到字幕后调 1 次，L2/L3 不再重复试同一模型
  installFetch({ timedtext: 'ok', invidious: 'dead', gemini: 'all404', wecom: 'ok' }, log);
  await run(baseEnv(kv));

  const calls = log.filter((u) => u.includes('generativelanguage'));
  const perModel = {};
  for (const c of calls) {
    const m = c.match(/models\/([^:]+):/)?.[1];
    if (m) perModel[m] = (perModel[m] || 0) + 1;
  }
  ok('每个模型全程只试 1 次（黑名单生效）',
    Object.values(perModel).every((n) => n === 1),
    JSON.stringify(perModel));
  // 2 个模型 × 1 次 = 2；旧实现是 3 层 × 2 模型 = 6
  ok('总调用 = 模型数（而非 3 层各试一遍）', calls.length === 2, `实际 ${calls.length} 次`);
  ok('仍然推送兜底', log.some((u) => u.includes('qyapi')));
}

console.log(`\n${'='.repeat(46)}`);
console.log(fail === 0 ? `✅ 全部通过 (${pass})` : `❌ ${fail} 失败 / ${pass} 通过`);
console.log('='.repeat(46));
process.exit(fail === 0 ? 0 : 1);

