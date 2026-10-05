/**
 * 引擎端到端测试：起一个本地假 API，验证请求发送与各种响应格式的解析。
 *   node tools/test-engine.mjs
 */

import http from 'node:http';
import { runRequest } from '../lib/engine.js';
import { setBingBase, resetBingSession } from '../lib/adapters.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log('  ok   ' + name);
  } else {
    failed += 1;
    console.log('  FAIL ' + name + (detail !== undefined ? '\n       ' + JSON.stringify(detail) : ''));
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, { actual, expected });
}

const received = [];

/** Bing 重试测试用：第一次翻译请求故意返回空响应 */
let bingEmptyOnce = true;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  let body = '';
  for await (const c of req) body += c;
  received.push({ path: url.pathname, search: url.search, method: req.method, headers: req.headers, body });

  const path = url.pathname;

  // 1. 标准 SSE（OpenAI 流式）
  if (path === '/sse') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
    // 故意把一个事件拆成两块，测跨块拼接
    res.write('data: {"choices":[{"delta":{"cont');
    await new Promise((r) => setTimeout(r, 20));
    res.write('ent":"好"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // 2. 全量替换式 SSE（每帧给完整文本）
  if (path === '/sse-replace') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"你好"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"你好世界"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"你好世界！"}}]}\n\n');
    res.end();
    return;
  }

  // 2.5 带「思考内容」的 SSE（模拟 reasoning_effort 没生效）
  if (path === '/reasoning') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"reasoning_content":"先想一下…"}}]}\n\n');
    await new Promise((r) => setTimeout(r, 30));
    res.write('data: {"choices":[{"delta":{"reasoning_content":"想完了。"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"译文"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // ---- Bing 适配器用的假接口（正常版 bing.com 是两步：先页面后翻译）----

  // 翻译页：带鉴权参数
  if (path === '/translator') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><html><head><script>var IG:"AABBCCDD11223344";</script></head>' +
        '<body data-iid="translator.5023">' +
        '<script>var params_AbusePreventionHelper = [1700000000000,"tokentokentoken",3600000];</script>' +
        '</body></html>'
    );
    return;
  }

  // 翻译接口：要求 form-urlencoded
  if (path === '/ttranslatev3') {
    const form = new URLSearchParams(body);
    const text = form.get('text') || '';

    // 第一次空响应，逼出「token 过期 → 重抓再试」的逻辑
    if (text === 'RETRY_ME' && bingEmptyOnce) {
      bingEmptyOnce = false;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('');
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([
      {
        translations: [{ text: '【译】' + text, to: form.get('to') || '' }],
        detectedLanguage: { language: 'en' }
      }
    ]));
    return;
  }

  // 3. SSE 但 Content-Type 是 application/json（有些中转这么干）
  if (path === '/sse-wrongtype') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('data: {"choices":[{"delta":{"content":"偏"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":"移"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // 4. 整体 JSON（非流式）
  if (path === '/json') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '整体返回' } }] }));
    return;
  }

  // 5. NDJSON（Ollama 风格）
  if (path === '/ndjson') {
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.write(JSON.stringify({ message: { content: '本' } }) + '\n');
    res.write(JSON.stringify({ message: { content: '地' } }) + '\n');
    res.write(JSON.stringify({ message: { content: '模' } }) + '\n');
    res.write(JSON.stringify({ message: { content: '型' }, done: true }) + '\n');
    res.end();
    return;
  }

  // 6. 纯文本
  if (path === '/text') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.write('纯文本');
    res.write('结果');
    res.end();
    return;
  }

  // 7. 没有 Content-Type，靠第一块猜
  if (path === '/unknown') {
    res.writeHead(200, {});
    res.flushHeaders();
    res.write('data: {"choices":[{"delta":{"content":"猜"}}]}\n\n');
    await new Promise((r) => setTimeout(r, 20));
    res.write('data: {"choices":[{"delta":{"content":"中"}}]}\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // 8. 无 Content-Type 的整体 JSON
  if (path === '/unknown-json') {
    res.writeHead(200, {});
    res.end(JSON.stringify({ result: '无类型头' }));
    return;
  }

  // 9. Anthropic 结构
  if (path === '/anthropic') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('event: content_block_delta\n');
    res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"克"}}\n\n');
    res.write('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"劳"}}\n\n');
    res.end();
    return;
  }

  // 10. 报错响应
  if (path === '/error') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    return;
  }

  // 11. 结构对不上
  if (path === '/weird') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ foo: { bar: [1, 2, 3] } }));
    return;
  }

  res.writeHead(404);
  res.end('not found');
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const vars = { text: 'Hello, world!', target: '简体中文', apiKey: 'sk-test-123' };

function curlFor(path, extra = '') {
  return `curl ${base}${path} \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{apiKey}}" \\
  -d '{"model":"m","messages":[{"role":"user","content":"{{text}}"}]${extra}}'`;
}

/* ------------------------------------------------------------------ */

console.log('\n1. 标准 SSE 流式');
{
  const deltas = [];
  const r = await runRequest({
    requestText: curlFor('/sse', ',"stream":true'),
    vars,
    onDelta: (current) => deltas.push(current)
  });
  eq('最终文本', r.text, '你好');
  check('过程中有多次增量回调', deltas.length >= 2, deltas);
  check('跨块的 JSON 事件被正确拼回', r.text.includes('好'), r.text);
  eq('状态码', r.status, 200);
  check('记录了耗时', typeof r.ms === 'number' && r.ms >= 0, r.ms);
  eq('自动识别的路径', r.usedPath, 'choices[0].delta.content');
  eq('响应格式判定', r.request.style, 'curl');
}

console.log('\n2. 全量替换式 SSE');
{
  const r = await runRequest({ requestText: curlFor('/sse-replace'), vars });
  eq('每帧全量时不会被重复拼接', r.text, '你好世界！');
}

console.log('\n3. Content-Type 写成 application/json 的 SSE');
{
  const r = await runRequest({ requestText: curlFor('/sse-wrongtype'), vars });
  eq('靠 data: 前缀兜底识别', r.text, '偏移');
}

console.log('\n4. 整体 JSON');
{
  const r = await runRequest({ requestText: curlFor('/json'), vars });
  eq('一次性取到', r.text, '整体返回');
  eq('路径', r.usedPath, 'choices[0].message.content');
}

console.log('\n5. NDJSON（Ollama 风格）');
{
  const r = await runRequest({ requestText: curlFor('/ndjson'), vars });
  eq('逐行拼接', r.text, '本地模型');
  eq('路径', r.usedPath, 'message.content');
}

console.log('\n6. 纯文本响应');
{
  const r = await runRequest({ requestText: curlFor('/text'), vars });
  eq('直接给原文', r.text, '纯文本结果');
}

console.log('\n7. 无 Content-Type —— 靠第一块猜');
{
  const r = await runRequest({ requestText: curlFor('/unknown'), vars });
  eq('猜出是 SSE', r.text, '猜中');
}
{
  const r = await runRequest({ requestText: curlFor('/unknown-json'), vars });
  eq('猜出是整体 JSON', r.text, '无类型头');
  eq('路径', r.usedPath, 'result');
}

console.log('\n8. Anthropic 结构');
{
  const r = await runRequest({ requestText: curlFor('/anthropic'), vars });
  eq('content[0].text', r.text, '克劳');
}

console.log('\n9. 自定义提取路径');
{
  const r = await runRequest({
    requestText: curlFor('/json'),
    vars,
    path: 'choices[0].message.content'
  });
  eq('按指定路径取', r.text, '整体返回');
}

console.log('\n10. 请求是否原样送达');
{
  const r = await runRequest({ requestText: curlFor('/json'), vars });
  const last = received[received.length - 1];
  eq('方法', last.method, 'POST');
  eq('自定义 header 送达', last.headers['authorization'], 'Bearer sk-test-123');
  eq('Content-Type 送达', last.headers['content-type'], 'application/json');
  eq('body 里的变量已替换', JSON.parse(last.body).messages[0].content, 'Hello, world!');
  check('请求体没有被多加字段', Object.keys(JSON.parse(last.body)).length === 2,
    Object.keys(JSON.parse(last.body)));
  void r;
}

console.log('\n11. 带 # 注释的 curl（就是用户给的那个例子）');
{
  const src = `curl ${base}/json \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{apiKey}}" \\
  -d '{
  "model": "Ling-3.0-flash",
  # 此处以“Ling-3.0-flash”调用为例，可按需调整为“Ling-2.6-1T”
  "messages": [
    {"role": "user", "content": "{{text}}"}
  ],
  "stream": true
}'`;
  const r = await runRequest({ requestText: src, vars });
  eq('注释行不影响请求', r.text, '整体返回');
  check('给出了自动修复的提示', r.warnings.some((w) => w.includes('#')), r.warnings);
  const last = received[received.length - 1];
  check('实际发出的 body 是干净 JSON',
    !last.body.includes('#') && JSON.parse(last.body).model === 'Ling-3.0-flash', last.body);
}

console.log('\n12. 报错与异常');
{
  const r = await runRequest({ requestText: curlFor('/error'), vars });
  eq('状态码', r.status, 401);
  eq('ok 为 false', r.ok, false);
  check('错误信息里带上了服务端返回', (r.error || '').includes('Invalid API key'), r.error);
  check('原始响应可查看', r.raw.includes('Invalid API key'), r.raw);
}
{
  const r = await runRequest({ requestText: curlFor('/weird'), vars });
  check('结构对不上时给出结构说明', (r.error || '').includes('foo'), r.error);
}
{
  const r = await runRequest({ requestText: 'curl http://127.0.0.1:1/nope', vars });
  eq('连不上时 ok=false', r.ok, false);
  check('错误可读', !!r.error, r.error);
}
{
  const r = await runRequest({ requestText: 'curl not-a-url', vars });
  check('没有 URL 时直接报错', (r.error || '').includes('URL'), r.error);
}

console.log('\n13. 取消');
{
  const controller = new AbortController();
  const p = runRequest({
    requestText: curlFor('/sse'),
    vars,
    signal: controller.signal,
    onDelta: () => controller.abort()
  });
  const r = await p;
  check('中断后仍保留已收到的内容', r.text.length > 0, r);
}

console.log('\n14. 诊断信息（首字耗时 / 有没有在思考）');
{
  const r = await runRequest({ requestText: curlFor('/sse'), vars });
  eq('记录下响应格式', r.mode, 'sse');
  check('记录下首字节耗时', typeof r.ttfbMs === 'number' && r.ttfbMs >= 0, r.ttfbMs);
  check('记录下首字耗时', typeof r.firstDeltaMs === 'number' && r.firstDeltaMs >= 0, r.firstDeltaMs);
  check('首字不早于首字节', r.firstDeltaMs >= r.ttfbMs, { ttfb: r.ttfbMs, first: r.firstDeltaMs });
  check('记录下分片数', r.chunks > 0, r.chunks);
  check('记录下响应大小', r.bytes > 0, r.bytes);
  eq('普通响应统计不到思考内容', r.reasoningChars, 0);
}
{
  const r = await runRequest({ requestText: curlFor('/reasoning'), vars });
  eq('思考内容不会被当成译文', r.text, '译文');
  eq('统计出思考字数', r.reasoningChars, '先想一下…想完了。'.length);
}
{
  const r = await runRequest({ requestText: curlFor('/json'), vars });
  eq('整体 JSON 的格式判定', r.mode, 'json');
  check('非流式也有耗时', typeof r.ms === 'number' && r.ms >= 0, r.ms);
  eq('非流式不会误报思考', r.reasoningChars, 0);
}
{
  const r = await runRequest({ requestText: 'curl not-a-url', vars });
  check('解析就失败时也返回统计字段', typeof r.ms === 'number' && r.mode !== undefined, r);
}

console.log('\n15. 内置适配器（Bing 免费通道）');
{
  setBingBase(base);
  resetBingSession();
  const before = received.length;

  const r = await runRequest({
    adapter: 'bing',
    vars: { text: 'Hello adapter', targetLang: '简体中文' }
  });

  eq('译文取回', r.text, '【译】Hello adapter');
  eq('格式标成 adapter', r.mode, 'adapter');
  eq('HTTP 200', r.status, 200);
  check('记录了首字耗时', typeof r.firstDeltaMs === 'number' && r.firstDeltaMs >= 0, r.firstDeltaMs);

  const calls = received.slice(before);
  eq('一共发了两次请求（先页面后翻译）', calls.length, 2);
  eq('第一次抓翻译页', calls[0].path, '/translator');
  eq('第二次打翻译接口', calls[1].path, '/ttranslatev3');
  check('IG 带在查询串上', /[?&]IG=AABBCCDD11223344/.test(calls[1].search), calls[1].search);

  const form = new URLSearchParams(calls[1].body);
  eq('用的是 form-urlencoded', calls[1].headers['content-type'], 'application/x-www-form-urlencoded');
  eq('fromLang=auto-detect', form.get('fromLang'), 'auto-detect');
  eq('简体中文映射成 zh-Hans', form.get('to'), 'zh-Hans');
  eq('带上了 token', form.get('token'), 'tokentokentoken');
  eq('带上了 key', form.get('key'), '1700000000000');
  eq('原文进了 text', form.get('text'), 'Hello adapter');
}
{
  // 第二次：token 还在有效期内，不该再抓页面
  const before = received.length;
  const r = await runRequest({ adapter: 'bing', vars: { text: 'Second', targetLang: 'en' } });
  eq('第二次也有译文', r.text, '【译】Second');
  const calls = received.slice(before);
  eq('复用了 token，只发一次请求', calls.length, 1);
  eq('直接打翻译接口', calls[0].path, '/ttranslatev3');
  eq('英文目标语言映射成 en', new URLSearchParams(calls[0].body).get('to'), 'en');
}
{
  // 空响应 → 自动重抓 token 再试
  resetBingSession();
  const before = received.length;
  const r = await runRequest({ adapter: 'bing', vars: { text: 'RETRY_ME', targetLang: 'zh-Hans' } });
  eq('重试后拿到了译文', r.text, '【译】RETRY_ME');
  check('给出了自动重试的提示', r.warnings.some((w) => w.includes('token')), r.warnings);
  eq('重试过程共四次请求', received.slice(before).length, 4);
}
{
  // 目标语言的映射
  resetBingSession();
  await runRequest({ adapter: 'bing', vars: { text: 'A', targetLang: '日语' } });
  eq('「日语」映射成 ja',
    new URLSearchParams(received[received.length - 1].body).get('to'), 'ja');

  resetBingSession();
  await runRequest({ adapter: 'bing', vars: { text: 'B', targetLang: '日本語' } });
  eq('认不出的语言名回退到 zh-Hans',
    new URLSearchParams(received[received.length - 1].body).get('to'), 'zh-Hans');
}
{
  // 强制直连：Node 里没有 chrome.proxy，应该静默降级，请求照发
  resetBingSession();
  const r = await runRequest({
    adapter: 'bing',
    vars: { text: 'Direct', targetLang: 'en' },
    direct: true
  });
  eq('开着直连开关也能正常翻译', r.text, '【译】Direct');
  eq('拿不到代理权限时不谎报「已直连」', r.direct, false);
}
{
  // 自定义请求 + 直连：同样该降级成普通请求，不能因为切代理失败就发不出去
  const r = await runRequest({
    requestText: `curl ${base}/json`,
    direct: true
  });
  eq('直连开关不影响自定义请求', r.text, '整体返回');
  eq('同样不谎报', r.direct, false);
}
{
  const r = await runRequest({ adapter: 'nope', vars: { text: 'x' } });
  eq('未知适配器返回失败', r.ok, false);
  check('错误信息里点出了名字', (r.error || '').includes('nope'), r.error);
  check('返回结构仍然完整', typeof r.ms === 'number' && r.text === '', r);
}

/* ------------------------------------------------------------------ */

server.close();

console.log('\n' + '='.repeat(46));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(46));
process.exit(failed === 0 ? 0 : 1);
