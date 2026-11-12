/**
 * 核心库测试：node tools/test-lib.mjs
 */

import { readFileSync } from 'node:fs';

// store.js 依赖 chrome.storage，先给个最小 mock
globalThis.chrome = {
  storage: {
    local: {
      get: async () => ({}),
      set: async () => {},
      remove: async () => {}
    },
    onChanged: { addListener() {} }
  }
};

const { tokenize, parseRequest, parseCurl, parseRawHttp, repairJsonBody } = await import('../lib/request-parser.js');
const {
  renderTemplate, escapeJsonString, imageContentPart, targetCodeOf, TARGET_PRESETS,
  splitVarValues, modelCandidates, modelVarFor, firstModelVars, isSecretVar
} = await import('../lib/template.js');
const { parsePath, getByPath, extractContent, describeShape } = await import('../lib/extract.js');
const {
  DEFAULT_CONFIGS, DEFAULT_SETTINGS, moveItem, moveVisibleItem, dropIndex, buildVars,
  pickRequestConfig, canTranslateImage, freshConfigs, loadState, exportState, importState
} = await import('../lib/store.js');
// 「主请求 + 后备」那套链函数住在 lib/requests.js —— 配置和 OCR 供应商共用（见该文件头注）
const { uid, normalizeRequestItem, mainRequest, allRequests, requestChain, requestTemplateFor } = await import('../lib/requests.js');
// 导出文件口令加密（node 22 自带 webcrypto，和扩展里的 Web Crypto 同源同 API）
const { encryptExport, decryptExport, isEncryptedExport } = await import('../lib/crypto.js');
const { previewRequest, maskRequest, readResponseBody } = await import('../lib/engine.js');
const { adoptPanelOwned, PANEL_OWNED_SETTING_KEYS } = await import('../lib/store.js');
const { toBingLang, hasAdapter } = await import('../lib/adapters.js');
const {
  OCR_MENU_ID, OCR_MENU_TITLE, OCR_PROVIDERS, BUILTIN_OCR_IDS,
  SHOT_MENU_ID, SHOT_MENU_TITLE,
  DEFAULT_OCR_PROMPT,
  normalizeOcrProvider, normalizeOcrItem, normalizeOcrState, defaultOcrState, activeOcrProvider,
  buildOcrBody, pickOcrText, describeOcrError, ocrErrorHint,
  normalizeMaxTokens, previewOcrRequest, runOcr, runImageTranslate, shotMenuItem,
  fillOcrTemplate, ocrProviderToTemplate
} = await import('../lib/ocr.js');
const {
  isImageMime, pickImageMime, sniffImageMime, bytesToBase64, toDataUrl, NO_IMAGE_MESSAGE
} = await import('../lib/clipboard.js');

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
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, { actual, expected });
}

/**
 * 造一个**带流**的 Response 桩。
 *
 * 真 fetch 里 SSE / NDJSON 是 `res.body.getReader()` 一段段给的；只打桩 `text()`
 * 会走「没有流，整体读一次」那条兜底路 —— 流式分支（也就是实机上踩到的那个
 * 「stream: true 的接口报返回的不是 JSON」）就永远测不到。
 *
 * parts 是**按分片喂**的原文，可以故意把一个事件切两半。
 */
function streamResponse(parts, ctype = 'text/event-stream') {
  const enc = new TextEncoder();
  let i = 0;
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? ctype : null) },
    body: {
      getReader() {
        return {
          read: async () =>
            i < parts.length
              ? { done: false, value: enc.encode(parts[i++]) }
              : { done: true, value: undefined }
        };
      }
    },
    text: async () => parts.join('')
  };
}

function section(title) {
  console.log('\n' + title);
}

/* ------------------------------------------------------------------ */

section('1. tokenize —— 引号 / 续行 / 注释');
{
  eq('单引号内的空格保留',
    tokenize("curl -d 'a b c'"), ['curl', '-d', 'a b c']);

  eq('双引号内支持 \\" 转义',
    tokenize('curl -H "X: a\\"b"'), ['curl', '-H', 'X: a"b']);

  eq('单引号内反斜杠是字面量',
    tokenize("curl -d 'a\\nb'"), ['curl', '-d', 'a\\nb']);

  eq('反斜杠换行 = 续行',
    tokenize('curl \\\n  -X POST'), ['curl', '-X', 'POST']);

  eq('token 起始处的 # 是注释',
    tokenize('# 说明\ncurl https://x'), ['curl', 'https://x']);

  eq('token 中间的 # 不是注释',
    tokenize('curl https://x/a#b'), ['curl', 'https://x/a#b']);
}

{
  // tokenize 只负责分词，-d{...} 分不开是正常的 shell 行为；
  // 真正把它拆成「选项 + 值」的是 parseCurl。
  const req = parseCurl(`curl -d'{"a":1}' https://x.com`);
  eq('-d 与引号紧贴时 parseCurl 能切开', req.body, '{"a":1}');
  eq('并且 URL 不受影响', req.url, 'https://x.com');

  /* 组合短选项里**跟了有值旗标**的情况（kniph 2026-10-18 用覆盖率扫出来的真 bug）：
     守卫原来写成 `inlineValue === null && tok.length > 2` —— **恒为假**，整段是死代码。
     后果不是「少个优化」而是解析错：`-sd 'a=1'` 里 `d` 被丢掉，`a=1` 变成了 URL。 */
  {
    const r = parseCurl("curl -sd 'a=1' https://x");
    eq('组合短选项 -sd：d 仍然算有值旗标（body 拿到值）', r.body, 'a=1');
    eq('-sd：URL 不受污染', r.url, 'https://x');
    eq('-sd：方法推断成 POST', r.method, 'POST');
  }
  {
    const r = parseCurl("curl -sH 'A: b' https://x");
    eq('组合短选项 -sH：H 仍然算有值旗标', r.headers.A, 'b');
    eq('-sH：URL 不受污染', r.url, 'https://x');
  }
  {
    const r = parseCurl('curl -sX POST https://x -d \'a=1\'');
    eq('组合短选项 -sX：X 仍然算有值旗标', r.method, 'POST');
  }
  {
    const r = parseCurl('curl -su user:pass https://x');
    eq('组合短选项 -su：装上 Basic 鉴权', r.headers.Authorization, 'Basic ' + Buffer.from('user:pass').toString('base64'));
  }
  /* 反向：不能因为修了这个就把其它写法弄坏 */
  eq('全无值旗标的组合 -sSL 仍然只当开关', parseCurl('curl -sSL https://x').url, 'https://x');
  eq('单旗标 -d 不受影响', parseCurl("curl -d 'a=1' https://x").body, 'a=1');
  eq('黏着写 -d{...} 不受影响', parseCurl(`curl -d'{"a":1}' https://x`).body, '{"a":1}');
  eq('有值旗标吃掉余下字符（curl 语义）', parseCurl('curl -sdd https://x').body, 'd');

  /* 裸参数（不带 `-` 的）里**只有第一个**当 URL，其余忽略。
     这一条钉住的是：带 `-` 的选项在更早的分支就被接走了，能落到「裸参数」
     那一行的必然不带 `-` —— 所以那里**不需要**再判「它是不是某个 flag」。
     （原来那儿挂着一个判 `CURL_BOOL_FLAGS` 的空分支，2026-10-18 通读删掉。） */
  const bareExtra = parseCurl('curl https://x.com 多余的东西');
  eq('裸参数里只有第一个当 URL', bareExtra.url, 'https://x.com');
  eq('多余的裸参数被忽略（不覆盖 URL，也不变成 body）', bareExtra.body, null);
  const dashed = parseCurl('curl -sS https://x.com');
  eq('带 - 的选项不会掉进「裸参数」那条路', dashed.url, 'https://x.com');
}

/* ------------------------------------------------------------------ */

section('2. 用户给的 ant-ling 例子（JSON 里夹了一行 # 注释）');
{
  const src = `curl https://api.ant-ling.com/v1/chat/completions \\
-H "Content-Type: application/json" \\
-H "Authorization: Bearer YOUR_API_KEY" \\
-d '{
"model": "Ling-3.0-flash",
# 此处以“Ling-3.0-flash”调用为例，可按需调整为“Ling-2.6-1T”
"messages": [
{"role": "user", "content": "请写一首关于春天的诗"}
],
"stream": true
}'`;

  const req = parseRequest(src);
  eq('URL', req.url, 'https://api.ant-ling.com/v1/chat/completions');
  eq('方法', req.method, 'POST');
  eq('识别为 curl 写法', req.style, 'curl');
  eq('Content-Type', req.headers['Content-Type'], 'application/json');
  eq('Authorization', req.headers['Authorization'], 'Bearer YOUR_API_KEY');
  check('body 保留了注释行（原样交给修复环节）', req.body.includes('# 此处'), req.body);

  const fixed = repairJsonBody(req.body);
  check('注释行被识别为需要修复', fixed !== null);
  const obj = JSON.parse(fixed.text);
  eq('model', obj.model, 'Ling-3.0-flash');
  eq('messages[0].content', obj.messages[0].content, '请写一首关于春天的诗');
  eq('stream', obj.stream, true);
}

/* ------------------------------------------------------------------ */

section('3. 原始 HTTP 报文');
{
  const src = `POST https://api.anthropic.com/v1/messages
x-api-key: sk-ant-xxx
anthropic-version: 2023-06-01
content-type: application/json

{"model":"claude-3-5-haiku-latest","messages":[{"role":"user","content":"hi"}]}`;

  const req = parseRequest(src);
  eq('识别为原始报文', req.style, 'raw');
  eq('URL', req.url, 'https://api.anthropic.com/v1/messages');
  eq('方法', req.method, 'POST');
  eq('x-api-key', req.headers['x-api-key'], 'sk-ant-xxx');
  check('body 是 JSON', JSON.parse(req.body).model === 'claude-3-5-haiku-latest', req.body);
}

{
  const src = `POST https://x.com/a
Content-Type: application/json

{"a":1}`;
  const req = parseRawHttp(src);
  eq('不带 HTTP/1.1 版本号也能解析', req.method, 'POST');
}

/* ------------------------------------------------------------------ */

section('4. 占位符渲染与转义');
{
  const r1 = renderTemplate('"content": "{{text}}"', { text: '他说"你好"\n第二行' });
  eq('JSON 字符串内自动转义',
    r1.text, '"content": "他说\\"你好\\"\\n第二行"');
  check('转义后是合法 JSON', (() => {
    try { JSON.parse('{' + r1.text + '}'); return true; } catch { return false; }
  })(), r1.text);

  const r2 = renderTemplate("'{{text}}'", { text: "it's" });
  eq('shell 单引号内转义', r2.text, "'it'\\''s'");

  const r3 = renderTemplate('{{text}}', { text: '原样插入' });
  eq('无引号时原样插入', r3.text, '原样插入');

  const r4 = renderTemplate('Bearer {{apiKey}} to {{target}}', { apiKey: 'sk-1', target: '简体中文' });
  eq('多个变量', r4.text, 'Bearer sk-1 to 简体中文');

  const r5 = renderTemplate('{{nope}}', {});
  eq('未定义变量替换为空', r5.text, '');
  eq('并记录下来', r5.missing, ['nope']);

  const r6 = renderTemplate('" {{text}} "', { text: 'x"y' });
  eq('跨空白的引号仍然转义', r6.text, '" x\\"y "');

  eq('escapeJsonString 处理控制字符', escapeJsonString('\u0001'), '\\u0001');
}

/* ------------------------------------------------------------------ */

section('5. 响应提取');
{
  eq('parsePath 基本', parsePath('choices[0].message.content'), ['choices', 0, 'message', 'content']);
  eq('parsePath $ 前缀', parsePath('$.a.b'), ['a', 'b']);
  eq('parsePath 引号键', parsePath('["weird key"].value'), ['weird key', 'value']);

  const openai = { choices: [{ message: { role: 'assistant', content: '你好' } }] };
  eq('OpenAI 整体', extractContent(openai, '').text, '你好');

  const delta = { choices: [{ delta: { content: '你' } }] };
  eq('OpenAI 流式', extractContent(delta, '').text, '你');

  const anthropic = { content: [{ type: 'text', text: 'こんにちは' }] };
  eq('Anthropic', extractContent(anthropic, '').text, 'こんにちは');

  const gemini = { candidates: [{ content: { parts: [{ text: '你好' }] } }] };
  eq('Gemini', extractContent(gemini, '').text, '你好');

  const ollama = { message: { role: 'assistant', content: '嗨' } };
  eq('Ollama', extractContent(ollama, '').text, '嗨');

  const google = { data: { translations: [{ translatedText: '早安' }] } };
  eq('Google 翻译', extractContent(google, '').text, '早安');

  // DeepL 官方 API 的壳，自建 DLX 的 /v2/translate 也是这个形状
  const deepl = { translations: [{ detected_source_language: 'EN', text: '你好' }] };
  eq('DeepL 官方 API', extractContent(deepl, '').text, '你好');
  eq('DeepL —— 走预设里写死的路径', extractContent(deepl, 'translations[0].text').text, '你好');

  eq('自定义路径', extractContent({ a: { b: [{ c: '深' }] } }, 'a.b[0].c').text, '深');
  eq('路径不存在返回 null', extractContent({ a: 1 }, 'x.y').text, null);

  const parts = { parts: [{ text: 'a' }, { text: 'b' }] };
  eq('数组拼 text', extractContent(parts, 'parts').text, 'ab');

  eq('number 转字符串', extractContent({ result: 42 }, '').text, '42');

  check('describeShape 能描述结构',
    describeShape(openai).includes('choices'), describeShape(openai));
}

/* ------------------------------------------------------------------ */

section('6. 内置配置全部可解析');
{
  for (const cfg of DEFAULT_CONFIGS) {
    if (cfg.adapter) {
      // 适配器类配置没有请求文本，走的是代码通道（见 lib/adapters.js）
      check(`[${cfg.name}] 标了适配器且没有请求文本`,
        !!cfg.adapter && cfg.request === '', { adapter: cfg.adapter, request: cfg.request });
      continue;
    }
    const info = previewRequest(cfg.request, {
      text: 'Hello',
      target: '简体中文',
      targetLang: '简体中文',
      targetCode: 'ZH-HANS',
      apiKey: 'sk-test'
    });

    check(`[${cfg.name}] URL 解析正确`, /^https?:\/\//.test(info.request.url), info.request);
    check(`[${cfg.name}] 没有校验问题`, info.problems.length === 0, info.problems);
    check(`[${cfg.name}] 没有未定义变量`, info.missing.length === 0, info.missing);
    check(`[${cfg.name}] 没有 JSON 修复提示`, info.notes.length === 0, info.notes);

    let body = info.request.body;
    check(`[${cfg.name}] 有请求体`, !!body);

    if (body) {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* 非 JSON */ }
      check(`[${cfg.name}] 请求体是合法 JSON`, parsed !== null, body.slice(0, 200));

      if (parsed) {
        const { text } = extractContent(
          { choices: [{ message: { content: JSON.stringify(parsed) } }] }, ''
        );
        check(`[${cfg.name}] 提示词里的 {{text}} 已被替换`,
          !body.includes('{{') && !body.includes('}}'), body.match(/\{\{[^}]*\}\}/g));
        // 只有真的用了 {{target}} 的配置才要求请求体里出现「简体中文」。
        // DeepL 那种「目标语言必须是代码」的接口把语言写死在模板里（ZH-HANS），不该被这条卡住。
        const usesTarget = /\{\{\s*target(Lang)?\s*\}\}/.test(cfg.request);
        check(`[${cfg.name}] ${usesTarget ? '{{target}} 已被替换为简体中文' : '目标语言走映射，不要求请求体里出现「简体中文」'}`,
          !usesTarget || (text || '').includes('简体中文'));
      }
    }
  }
}

/* ------------------------------------------------------------------ */

section('7. 提示词渲染后的实际样子');
{
  const openaiCfg = DEFAULT_CONFIGS.find((c) => c.id === 'builtin-openai') || DEFAULT_CONFIGS[0];
  const info = previewRequest(openaiCfg.request, {
    text: 'Good morning, world!',
    target: '简体中文',
    targetLang: '简体中文',
    targetCode: 'ZH-HANS',
    apiKey: 'sk-test'
  });
  const body = JSON.parse(info.request.body);
  const content = body.messages[0].content;
  check('提示词里出现了三引号', content.includes('"""'), content);
  check('提示词里出现了换行', content.includes('\n'), content);
  check('原文被放进三引号之间', content.includes('"""\nGood morning, world!\n"""'), content);
  check('预览的请求头是打码的（设置页会把 headers 摊开显示）',
    !String(info.request.headers.Authorization).includes('sk-test'),
    info.request.headers.Authorization);
  console.log('\n--- 模型实际收到的 content ---');
  console.log(content);
  console.log('------------------------------');
}

/* ------------------------------------------------------------------ */

section('8. 边界情况');
{
  const r = parseRequest('');
  check('空模板有提示', r.warnings.length > 0, r);

  const r2 = parseRequest('curl -X POST https://x.com -d "a=1"');
  eq('表单式 body', r2.body, 'a=1');
  eq('未写 -X 但有 body 推断为 POST',
    parseRequest('curl https://x.com -d "a=1"').method, 'POST');
  eq('没有 body 推断为 GET',
    parseRequest('curl https://x.com').method, 'GET');

  const r3 = parseCurl('curl -G https://x.com -d "q=hi"');
  eq('-G 把数据并进 query', r3.url, 'https://x.com?q=hi');
  eq('-G 后没有 body', r3.body, null);

  eq('-u 生成 Basic 头',
    parseCurl('curl -u user:pass https://x.com').headers['Authorization'],
    'Basic ' + Buffer.from('user:pass', 'utf-8').toString('base64'));

  /* 注意：下面这个 -sSL 是**全无值旗标**的组合，-H 是**独立的 token**。
     所以它测的是「组合开关不会把下一个 token 当自己的值吞掉」——
     不是「组合里带 -H」。真正的「组合里跟有值旗标」见文件靠后的
     「组合短选项 -sd / -sH / -sX」那几条（2026-10-18 才发现原来那版是坏的）。 */
  const r4 = parseRequest('curl -sSL -H "A: 1" https://x.com -o /dev/null');
  eq('全开关的组合（-sSL）不吞掉后面的 token', r4.url, 'https://x.com');
  eq('组合开关后面的独立 -H 仍然生效', r4.headers['A'], '1');

  const r5 = previewRequest('curl "https://x.com/a" -H "K: v"', {});
  eq('URL 加引号也能解析', r5.request.url, 'https://x.com/a');

  const r6 = previewRequest(
    'curl https://x.com -d \'{"t":"{{text}}"}\'',
    { text: '引号"测试"' }
  );
  check('含引号的选中文本不会破坏 JSON',
    (() => { try { return JSON.parse(r6.request.body).t === '引号"测试"'; } catch { return false; } })(),
    r6.request.body);

  const r7 = previewRequest(
    "curl https://x.com -d '{\n\"content\": \"第一行\n第二行\"\n}'",
    {}
  );
  check('裸换行会被修复', r7.notes.some((n) => n.includes('裸换行')), r7.notes);
  check('修复后是合法 JSON',
    (() => { try { return JSON.parse(r7.request.body).content === '第一行\n第二行'; } catch { return false; } })(),
    r7.request.body);
}

section('9. 内置适配器：语言代码映射');
{
  /* Bing 的接口不挑代码大小写 —— 真机实测（2026-10-05）：
     zh-Hans / ZH-HANS / ZH-hans / zh-hans 四种写法都是 HTTP 200，
     译文一模一样；ZH-Hant 也正常给出繁体。所以这里统一给大写形式就够，
     不为它单独写一层「变形回 zh-Hans」的代码。 */
  eq('简体中文 → ZH-HANS', toBingLang('简体中文'), 'ZH-HANS');
  eq('繁體中文 → ZH-HANT', toBingLang('繁體中文'), 'ZH-HANT');
  eq('英文 → EN', toBingLang('英文'), 'EN');
  eq('日语 → JA', toBingLang('日语'), 'JA');
  eq('韩文 → KO', toBingLang('韩文'), 'KO');
  eq('大写英文名也认', toBingLang('English'), 'EN');
  eq('本来就是代码就原样用', toBingLang('zh-Hant'), 'ZH-HANT');
  eq('两字母代码也认', toBingLang('de'), 'DE');
  eq('小写代码也不挑', toBingLang('zh-hans'), 'ZH-HANS');
  eq('区域代码照样过', toBingLang('EN-US'), 'EN-US');
  eq('空值走默认兜底', toBingLang(''), 'zh-Hans');
  eq('认不出的走默认兜底', toBingLang('克林贡语'), 'zh-Hans');
  eq('兜底值可以指定', toBingLang('', 'en'), 'en');
  eq('null 也不会炸', toBingLang(null), 'zh-Hans');

  /* ---- 同一张表还给模板用：{{targetCode}} ---- */
  eq('中文 → ZH-HANS', targetCodeOf('中文'), 'ZH-HANS');
  eq('繁體中文 → ZH-HANT', targetCodeOf('繁體中文'), 'ZH-HANT');
  eq('日语 → JA', targetCodeOf('日语'), 'JA');
  eq('小写代码自动大写', targetCodeOf('pt-br'), 'PT-BR');
  eq('认不出的回退成简体中文', targetCodeOf('克林贡语'), 'ZH-HANS');
  eq('要「不兜底」就传空 fallback（Bing 靠这个判断该不该回退）',
    targetCodeOf('克林贡语', ''), '');
  eq('空值也走兜底', targetCodeOf(''), 'ZH-HANS');

  const picked = buildVars({ settings: { targetLang: '日语' }, vars: [] }, 'Hello');
  eq('{{target}} 原样搬：日语', picked.target, '日语');
  eq('{{targetCode}} 映射成接口代码：JA', picked.targetCode, 'JA');

  check('bing 适配器已注册', hasAdapter('bing'));
  check('没注册的适配器返回 false', !hasAdapter('not-there'));
}

section('10. 老存档迁移：开关归位 / 补预设 / OCR 供应商换模型');
{
  const { loadState, STORAGE_VERSION } = await import('../lib/store.js');
  const original = globalThis.chrome.storage.local;
  let written = null;

  const load = async (stored) => {
    written = null;
    globalThis.chrome.storage.local = {
      get: async () => ({ state: JSON.parse(JSON.stringify(stored)) }),
      set: async (o) => { written = o.state; },
      remove: async () => {}
    };
    return loadState();
  };

  /* v2 存档：那时候「临时直连」的总开关默认是开的，老用户手里存的就是 true。
     功能已经整块删掉了，迁移得把这个键**删掉** —— 留个 false 也算残渣。 */
  const v2 = await load({
    version: 2,
    configs: [{ id: 'builtin-bing', name: 'Bing', adapter: 'bing' }],
    activeConfigId: 'builtin-bing',
    vars: [],
    settings: { ...DEFAULT_SETTINGS, directAdapter: true, theme: 'dark' }
  });
  eq('版本号升到最新', v2.version, STORAGE_VERSION);
  eq('老存档里的 directAdapter 被彻底删掉', 'directAdapter' in v2.settings, false);
  eq('顺手改了的东西不会丢', v2.settings.theme, 'dark');
  eq('已有的配置不会被迁移动到，新预设只是追加在后面', v2.configs.length, 2);
  eq('追加进来的正好是 DeepL 预设', v2.configs[1].id, 'builtin-deepl');
  check('迁移结果落了盘，落盘的那份也没有这个键',
    !!written && !('directAdapter' in written.settings));

  /* v1 存档：字段全靠默认值补，还得自动补上内置 Bing 通道 */
  const v1 = await load({
    version: 1,
    configs: [{ id: 'builtin-openai', name: 'OpenAI' }],
    activeConfigId: 'builtin-openai',
    vars: [],
    settings: { theme: 'auto' }
  });
  eq('v1 也升到最新版本号', v1.version, STORAGE_VERSION);
  eq('补上了内置 Bing 通道', v1.configs[0].id, 'builtin-bing');
  eq('v1 一路补到最新：原有 1 条 + Bing + DeepL', v1.configs.length, 3);
  eq('也补上了 DeepL 预设', v1.configs[2].id, 'builtin-deepl');
  eq('v1 存档里也不会冒出那个已经删掉的键', 'directAdapter' in v1.settings, false);

  /* v3 存档：DeepL 预设要插在内置 DeepSeek 后面，用户自己排的顺序和设置一点都不能动 */
  const v3 = await load({
    version: 3,
    configs: [
      { id: 'builtin-bing', name: 'Bing', adapter: 'bing' },
      { id: 'builtin-deepseek', name: 'DeepSeek' },
      { id: 'cfg-mine', name: '我自己的接口' }
    ],
    activeConfigId: 'cfg-mine',
    vars: [],
    settings: { ...DEFAULT_SETTINGS, directAdapter: true, theme: 'dark' }
  });
  eq('v3 升到最新', v3.version, STORAGE_VERSION);
  eq('DeepL 插在 DeepSeek 后面', v3.configs[2].id, 'builtin-deepl');
  eq('整张列表的顺序没被打乱', v3.configs.map((c) => c.id).join(','),
    'builtin-bing,builtin-deepseek,builtin-deepl,cfg-mine');
  eq('选中的还是用户自己那条', v3.activeConfigId, 'cfg-mine');
  eq('v3 存档里残留的那个键同样被清掉', 'directAdapter' in v3.settings, false);
  eq('顺手改了的东西也不会丢', v3.settings.theme, 'dark');

  /* v4 存档：内置那条「硅基流动」还停在 PaddleOCR-VL，v4→v5 要归位成 DeepSeek-OCR。
     换模型就得换提示词 —— 这两件事是一套的，所以一起断言。 */
  const v4ocr = await load({
    version: 4,
    configs: [{ id: 'builtin-deepseek', name: 'DeepSeek' }],
    activeConfigId: 'builtin-deepseek',
    vars: [],
    settings: { ...DEFAULT_SETTINGS },
    ocr: {
      activeId: 'builtin-siliconflow',
      providers: [
        {
          id: 'builtin-siliconflow',
          name: '硅基流动 · PaddleOCR-VL',
          note: 'PaddleOCR-VL-1.5 在硅基流动上免费。只需要一个 API Key，去 cloud.siliconflow.cn 拿。',
          endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
          model: 'PaddlePaddle/PaddleOCR-VL-1.5',
          prompt: 'OCR:',
          apiKey: 'sk-keep-me'
        }
      ]
    }
  });
  const v4sf = v4ocr.ocr.providers.find((p) => p.id === 'builtin-siliconflow');
  /* v7 起模板化：老字段不再被强制换成 DeepSeek-OCR，而是**无损转成等价模板** ——
     用户手里的 PaddleOCR 原样保留成一段可编辑的请求文本，想换模型自己改。 */
  eq('老存档那条的模型原样留着（不强制换 DeepSeek-OCR）',
    v4sf.model, 'PaddlePaddle/PaddleOCR-VL-1.5');
  eq('提示词也原样', v4sf.prompt, 'OCR:');
  eq('名称没动', v4sf.name, '硅基流动 · PaddleOCR-VL');
  check('request 模板里带着原来的模型和提示词',
    v4sf.request.includes('PaddlePaddle/PaddleOCR-VL-1.5') && v4sf.request.includes('OCR:'),
    v4sf.request);
  eq('用户自己填的 key 一点没动', v4sf.apiKey, 'sk-keep-me');
  eq('选中的还是那条', v4ocr.ocr.activeId, 'builtin-siliconflow');

  /* 关键的另一半：用户自己换过模型 / 改过提示词的那条**不能**被归位。
     判据是「逐字还等于老默认值」，所以这里两个变体都得原样留着。 */
  const v4kept = await load({
    version: 4,
    configs: [{ id: 'builtin-deepseek' }],
    activeConfigId: 'builtin-deepseek',
    vars: [],
    settings: { ...DEFAULT_SETTINGS },
    ocr: {
      activeId: 'builtin-siliconflow',
      providers: [
        { id: 'builtin-siliconflow', model: 'PaddlePaddle/PaddleOCR-VL-1.5', prompt: '请原样输出文字', apiKey: 'k' }
      ]
    }
  });
  eq('提示词被自己改过 → 那条一律不碰（模型名留着）',
    v4kept.ocr.providers[0].model, 'PaddlePaddle/PaddleOCR-VL-1.5');
  eq('它自己写的提示词也原样留着',
    v4kept.ocr.providers[0].prompt, '请原样输出文字');

  const v4model = await load({
    version: 4,
    configs: [{ id: 'builtin-deepseek' }],
    activeConfigId: 'builtin-deepseek',
    vars: [],
    settings: { ...DEFAULT_SETTINGS },
    ocr: {
      activeId: 'builtin-siliconflow',
      providers: [
        { id: 'builtin-siliconflow', model: 'some/other-vl', prompt: 'OCR:' }
      ]
    }
  });
  eq('模型被自己换过 → 也不碰', v4model.ocr.providers[0].model, 'some/other-vl');

  /* 用户自己起的名字不能被冲掉（说明在设置页是只读的，名字可编辑） */
  const v4named = await load({
    version: 4,
    configs: [{ id: 'builtin-deepseek' }],
    activeConfigId: 'builtin-deepseek',
    vars: [],
    settings: { ...DEFAULT_SETTINGS },
    ocr: {
      activeId: 'builtin-siliconflow',
      providers: [
        { id: 'builtin-siliconflow', name: '我的硅基', model: 'PaddlePaddle/PaddleOCR-VL-1.5', prompt: 'OCR:' }
      ]
    }
  });
  const v4namedP = v4named.ocr.providers.find((p) => p.id === 'builtin-siliconflow');
  eq('模型和提示词原样留着（v7 起不再强制换模型，转成模板）', v4namedP.prompt, 'OCR:');
  eq('但用户自己起的名字留着', v4namedP.name, '我的硅基');

  /* 用户把这条删了（记在 hidden 里）→ 迁移也别把它变出来 */
  const v4hidden = await load({
    version: 4,
    configs: [{ id: 'builtin-deepseek' }],
    activeConfigId: 'builtin-deepseek',
    vars: [],
    settings: { ...DEFAULT_SETTINGS },
    ocr: { activeId: 'builtin-openai-vl', hidden: ['builtin-siliconflow'], providers: [] }
  });
  check('删过的内置条目迁移后也不会自己冒出来',
    !v4hidden.ocr.providers.some((p) => p.id === 'builtin-siliconflow'),
    v4hidden.ocr.providers.map((p) => p.id));

  /* v7 存档（= 1.1.2，第一个模板形状的版本）：两条内置供应商的默认模板后来改过 ——
     硅基流动的提示词补了 `<image>\n` 前缀，百度的 body 补了 language_type=auto_detect
     （不写就是 CHN_ENG，日文假名会被当成中文读）。
     判据是「逐字还等于老默认值」，所以把老默认值整段抄进来当输入。
     这两段必须和 store.js 里 OLD_DEFAULT_REQUEST 冻死的那份逐字一致 —— 改默认模板时别动它们。 */
  const OLD_SF_REQUEST = `# DeepSeek-OCR 在硅基流动上免费；Key 在「变量」页签的 apiKey 里填，和翻译配置共用
curl https://api.siliconflow.cn/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{apiKey}}" \\
  -d '{
  "model": "deepseek-ai/DeepSeek-OCR",
  "messages": [
    {"role": "user", "content": [
      {"type": "image_url", "image_url": {"url": "{{image}}"}},
      {"type": "text", "text": "Free OCR."}
    ]}
  ],
  "temperature": 0.01
}'`;
  const OLD_BD_REQUEST = `# 百度高精度版：个人认证每月 1000 次免费，QPS 2/秒
# access_token = API Key + Secret Key 换来的（30 天过期）：
#   https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=你的AK&client_secret=你的SK
# 换到后把 token 粘进下面 URL，过期了重换一次
POST https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=把access_token粘到这里
Content-Type: application/x-www-form-urlencoded

image={{imageUrlEncoded}}`;

  const v7 = await load({
    version: 7,
    configs: [{ id: 'builtin-deepl', name: 'DeepL' }],
    activeConfigId: 'builtin-deepl',
    vars: [],
    settings: { ...DEFAULT_SETTINGS },
    ocr: {
      activeId: 'builtin-baidu-ocr',
      providers: [
        { id: 'builtin-siliconflow', name: '硅基流动', note: 'n', request: OLD_SF_REQUEST, responsePath: '' },
        { id: 'builtin-baidu-ocr', name: '百度 OCR（高精度版）', note: 'n', request: OLD_BD_REQUEST, responsePath: '' }
      ]
    }
  });
  const v7sf = v7.ocr.providers.find((p) => p.id === 'builtin-siliconflow');
  const v7bd = v7.ocr.providers.find((p) => p.id === 'builtin-baidu-ocr');
  check('硅基流动那条归位：提示词补上 <image> 前缀（老写法会退化）',
    v7sf.request.includes('"<image>\\nFree OCR."'), v7sf.request);
  check('百度那条归位：body 带上 language_type=auto_detect',
    v7bd.request.includes('&language_type=auto_detect'), v7bd.request);
  eq('两条的 key / token 之类用户自己填的东西一个都没动', v7bd.request.includes('把access_token粘到这里'), true);
  eq('选中的还是那条', v7.ocr.activeId, 'builtin-baidu-ocr');

  /* 用户自己动过模板就一律不碰 —— 差一个字节就不算「还停在老默认值」。
     第二条正是日语用户会做的事：自己把 language_type 钉成 JAP，升级时不能被 auto_detect 顶掉。 */
  const v7kept = await load({
    version: 7,
    configs: [{ id: 'builtin-deepl', name: 'DeepL' }],
    activeConfigId: 'builtin-deepl',
    vars: [],
    settings: { ...DEFAULT_SETTINGS },
    ocr: {
      activeId: 'builtin-siliconflow',
      providers: [
        { id: 'builtin-siliconflow', name: '我的硅基', note: 'n', request: OLD_SF_REQUEST + '\n# 我自己加的注释' },
        {
          id: 'builtin-baidu-ocr',
          name: '百度 OCR（高精度版）',
          note: 'n',
          request: OLD_BD_REQUEST.replace('image={{imageUrlEncoded}}', 'image={{imageUrlEncoded}}&language_type=JAP')
        }
      ]
    }
  });
  const v7keptSf = v7kept.ocr.providers.find((p) => p.id === 'builtin-siliconflow');
  const v7keptBd = v7kept.ocr.providers.find((p) => p.id === 'builtin-baidu-ocr');
  check('硅基流动那条被自己加过字 → 整段原样留着', v7keptSf.request.endsWith('# 我自己加的注释'));
  check('也还是老提示词（没有被塞进 <image> 前缀）', !v7keptSf.request.includes('<image>'));
  check('百度那条已经自己钉了 JAP → 不被 auto_detect 顶掉',
    v7keptBd.request.endsWith('&language_type=JAP'), v7keptBd.request);

  /* 已经是 v8 的存档不再走这条迁移（和 v4→v5 一样吃版本号） */
  const v8now = await load({
    version: STORAGE_VERSION,
    configs: [{ id: 'builtin-deepl', name: 'DeepL' }],
    activeConfigId: 'builtin-deepl',
    vars: [],
    settings: { ...DEFAULT_SETTINGS },
    ocr: {
      activeId: 'builtin-baidu-ocr',
      providers: [
        { id: 'builtin-baidu-ocr', name: '百度 OCR（高精度版）', note: 'n', request: OLD_BD_REQUEST, responsePath: '' }
      ]
    }
  });
  check('版本已是最新的存档不会被再迁一次',
    v8now.ocr.providers.find((p) => p.id === 'builtin-baidu-ocr').request === OLD_BD_REQUEST);

  /* 已经是最新版本的存档：不会再插一次 */
  const vNow = await load({
    version: STORAGE_VERSION,
    configs: [{ id: 'builtin-deepl', name: 'DeepL' }],
    activeConfigId: 'builtin-deepl',
    vars: [],
    settings: { ...DEFAULT_SETTINGS }
  });
  eq('最新版本的存档不会被重复插入', vNow.configs.length, 1);

  /* 1.1.0 去掉了「笔尖」这个预设：老存档里留着 nib 的话要写正成默认那个。
     注意这不吃版本号 —— 没有新增字段、没改默认值，只是把认不出的值归一化，
     所以一个 version 已经是最新的存档同样要过这一关。 */
  const vNib = await load({
    version: STORAGE_VERSION,
    configs: [{ id: 'builtin-deepl', name: 'DeepL' }],
    activeConfigId: 'builtin-deepl',
    vars: [],
    settings: { ...DEFAULT_SETTINGS, triggerStyle: 'nib', triggerSize: 60 }
  });
  eq('删掉的「笔尖」被写正成默认预设', vNib.settings.triggerStyle, 'badge');
  eq('同一块里别的按钮设置一点都不动', vNib.settings.triggerSize, 60);
  check('归一化的结果落了盘', !!written && written.settings.triggerStyle === 'badge');

  const vGood = await load({
    version: STORAGE_VERSION,
    configs: [{ id: 'builtin-deepl', name: 'DeepL' }],
    activeConfigId: 'builtin-deepl',
    vars: [],
    settings: { ...DEFAULT_SETTINGS, triggerStyle: 'globe' }
  });
  eq('认得出的预设原样留着', vGood.settings.triggerStyle, 'globe');
  check('没改东西就不写盘', written === null);

  /* settings.hiddenHints（2026-10-14）：说明文字「不再显示」从 boolean 换成一张表。
     老存档那个 `ocrHintHidden` 要读成 `['ocr']`，并把老键抹掉 ——
     `{...默认, ...stored}` 那套合并救不了「改字段类型」，只能在这儿映射一次。 */
  const freshHints = await load({ version: STORAGE_VERSION, settings: {} });
  eq('新存档：hiddenHints 默认空表',
    JSON.stringify(freshHints.settings.hiddenHints), JSON.stringify([]));
  const oldHintOn = await load({ version: 8, settings: { ocrHintHidden: true } });
  eq('老存档：ocrHintHidden=true 映射成 [\'ocr\']',
    JSON.stringify(oldHintOn.settings.hiddenHints), JSON.stringify(['ocr']));
  eq('老键抹掉了（别留在存档里）', 'ocrHintHidden' in oldHintOn.settings, false);
  const oldHintOff = await load({ version: 8, settings: { ocrHintHidden: false } });
  eq('老存档里没点过 → 还是空表',
    JSON.stringify(oldHintOff.settings.hiddenHints), JSON.stringify([]));
  const keptHints = await load({ version: STORAGE_VERSION, settings: { hiddenHints: ['vars', 'cfg-test'] } });
  eq('已经是新表的原样保留',
    JSON.stringify(keptHints.settings.hiddenHints), JSON.stringify(['vars', 'cfg-test']));
  const dirtyHints = await load({ version: STORAGE_VERSION, settings: { hiddenHints: ['vars', 3, null] } });
  eq('表里的垃圾值丢掉（只留字符串）',
    JSON.stringify(dirtyHints.settings.hiddenHints), JSON.stringify(['vars']));

  globalThis.chrome.storage.local = original;
}

const {
  TRIGGER_STYLES,
  TRIGGER_SVG_SAMPLE,
  SVG_GUARDS,
  getTriggerStyle,
  clampTriggerSize,
  parseTriggerSvg,
  sanitizeTriggerSvg,
  DEFAULT_TRIGGER_STYLE
} = await import('../lib/trigger-styles.js');

/* 两个样式表的唯一真相源在 lib/panel-core.js（2026-11-09 合并）。
   它是普通脚本、把 CSS 挂到 window.RTPanelCore 上 —— 这里 import 它只为触发副作用，
   然后从全局取。为什么不能直接 export：content script 不能 import，样式表必须两边共用。 */
/* panel-core.js 是给浏览器写的普通脚本（最后一步 window.RTPanelCore = {...}），
   Node 里没有 window —— 造一个最小的再 import，只为拿到那两个 CSS 常量。
   这不算「在 Node 里跑浏览器代码」：本文件从不调用它的 DOM 函数，只读字符串。 */
globalThis.window = globalThis.window || {};
await import('../lib/panel-core.js');
const { TRIGGER_CSS, PANEL_CSS } = globalThis.window.RTPanelCore;

section('11. 翻译按钮：样式预设与尺寸');
{
  eq('三个预设', TRIGGER_STYLES.length, 3);
  eq('默认是「译字方块」', DEFAULT_TRIGGER_STYLE, 'badge');
  eq('id 不重复', new Set(TRIGGER_STYLES.map((s) => s.id)).size, TRIGGER_STYLES.length);
  eq('预设清单是 方块 / 地球 / 自定义', TRIGGER_STYLES.map((s) => s.id).join(), 'badge,globe,custom');
  check('每个预设都有名字和说明', TRIGGER_STYLES.every((s) => s.name && s.hint));

  const badge = getTriggerStyle('badge');
  check('译字方块 = 圆角方块 + 文字', badge.round === true && badge.text === '译');

  const globe = getTriggerStyle('globe');
  check('地球 = 正圆 + SVG', globe.round === false && /^<svg /.test(globe.svg || ''));
  check('地球画了经纬线', globe.svg.includes('<ellipse') && globe.svg.includes('<path d="M3.6 9.1'));

  const custom = getTriggerStyle('custom');
  check('自定义 = 无底座', custom.round === false && custom.bare === true);
  // 设置页那张卡上画的是「你实际会用的图标」，没填就该空着 —— 塞个示例图标进去
  // 会让人以为这个预设就长三条线加箭头的样子（kniph 提的）
  check('自定义不带占位图标（卡片留空，等用户自己填）', !custom.svg, String(custom.svg));
  check('只有「自定义」不给底座', TRIGGER_STYLES.filter((s) => s.bare).length === 1);

  // 1.1.0 把「笔尖」换成了「自定义」。老存档里的 nib 认不出来 → 回退到第一个预设
  eq('删掉的「笔尖」认不出来，回退到默认', getTriggerStyle('nib').id, 'badge');

  eq('认不出的 id 回退到第一个', getTriggerStyle('nope').id, 'badge');
  eq('undefined 也回退', getTriggerStyle(undefined).id, 'badge');

  eq('尺寸下限 20', clampTriggerSize(5), 20);
  eq('尺寸上限 96', clampTriggerSize(999), 96);
  eq('非数字回退到 45', clampTriggerSize('abc'), 45);
  eq('四舍五入', clampTriggerSize(44.6), 45);

  eq('默认设置里的样式', DEFAULT_SETTINGS.triggerStyle, 'badge');
  eq('默认设置里的大小', DEFAULT_SETTINGS.triggerSize, 28);
  eq('默认没有自定义图标', DEFAULT_SETTINGS.triggerSvg, '');

  check('预设规则用 :where() 压低了优先级',
    TRIGGER_CSS.includes('.rt-trigger:where(.s-badge)'), TRIGGER_CSS.slice(0, 60));
  check('尺寸走 CSS 变量而不是写死', TRIGGER_CSS.includes('var(--rt-tr-size'));

  // 「自定义」那条必须把底座显式清零 —— 不写的话以后基础样式一加底色就漏出来了
  const customRule = TRIGGER_CSS.slice(TRIGGER_CSS.indexOf('.rt-trigger:where(.s-custom)'));
  check('自定义把底色 / 描边 / 阴影都清零了',
    /background:\s*none/.test(customRule) && /border:\s*0/.test(customRule) &&
      /box-shadow:\s*none/.test(customRule), customRule.split('}')[0]);
  check('自定义不留内边距（图标撑满整块）',
    TRIGGER_CSS.replace(/\s+/g, '').includes('.s-custom).rt-ico{padding:0;}'));
  check('笔尖那套规则已经删干净', !TRIGGER_CSS.includes('s-nib'));
}

section('12. 自定义 SVG：该放行的放行，该拦的拦住');
{
  const ok = '<svg viewBox="0 0 24 24"><path d="M4 12h16"/></svg>';
  const bad = (input) => check(`拦下：${input.slice(0, 46)}`, parseTriggerSvg(input).svg === '');

  eq('正常 SVG 原样通过', parseTriggerSvg(ok).svg, ok);
  eq('前后空白会 trim', parseTriggerSvg('  ' + ok + '\n').svg, ok);
  eq('没填 = 用预设（空串）', parseTriggerSvg('').svg, '');
  eq('没填时没有原因', parseTriggerSvg('').reason, '');
  eq('只填空格也算没填', parseTriggerSvg('   ').svg, '');
  eq('undefined 不会炸', parseTriggerSvg(undefined).svg, '');

  bad('<div>' + ok + '</div>');                     // 不以 <svg 开头
  bad('<svg><path/></svg');                          // 没收尾
  bad('<svg><script>alert(1)</script></svg>');
  bad('<svg><foreignObject><b>x</b></foreignObject></svg>');
  bad('<svg><style>*{display:none}</style></svg>');
  bad('<svg><use xlink:href="#x"/></svg>');
  bad('<svg><image src="x"/></svg>');
  bad('<svg onload="alert(1)"></svg>');
  bad('<svg ONLOAD="alert(1)"></svg>');              // 大小写绕过
  bad('<svg><a href="javascript:alert(1)">x</a></svg>');

  const r = parseTriggerSvg('<div></div>');
  check('拒的时候会给出原因', typeof r.reason === 'string' && r.reason.length > 0, r.reason);

  eq('示例图标本身合法', sanitizeTriggerSvg(TRIGGER_SVG_SAMPLE), TRIGGER_SVG_SAMPLE);
  eq('示例图标是三条线 + 一个箭头',
    (TRIGGER_SVG_SAMPLE.match(/<path/g) || []).length, 3);

  check('检查规则至少 5 条', SVG_GUARDS.length >= 5);
  check('每条规则都带原因', SVG_GUARDS.every((g) => g.re instanceof RegExp && g.reason));
  // 「必须长这样」和「不能出现」是相反的语义，靠 negate 区分（写反过一次，钉住它）
  eq('前两条是形状要求（negate）', SVG_GUARDS.filter((g) => g.negate).length, 2);
  check('后面几条是「命中即拒绝」', SVG_GUARDS.slice(2).every((g) => !g.negate));
}

section('13. 按钮样式：content.js 里的副本必须和 lib 一致');
{
  // content script 不能 import，所以 content.js 里手抄了一份 CSS、两个预设 SVG
  // 和那一组安全检查正则。抄漏一个字就会「设置页预览和实际按钮长得不一样」，
  // 或者「设置页说合格、页面上却不显示」，这里逐字比对兜住。
  const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  const squash = (s) => s.replace(/\s+/g, '');

  check('content.js 不再手抄按钮样式表（改从 RTPanelCore 取）',
    /window\.RTPanelCore\.TRIGGER_CSS/.test(src) && !squash(src).includes(squash(TRIGGER_CSS).slice(0, 200)),
    '合并后应只剩一行引用');

  for (const s of TRIGGER_STYLES) {
    if (!s.svg) continue;
    check(`预设「${s.name}」的 SVG 逐字一致`, squash(src).includes(squash(s.svg)));
  }

  check('预设名都对得上（badge/globe/custom）',
    ['badge', 'globe', 'custom'].every((id) => squash(src).includes(id + ':{')));
  // 「自定义」的占位图标也得抄过去 —— 设置页卡片可以不画，页面按钮不能空。
  check('页面按钮的占位图标（示例图标）在 content.js 里',
    squash(src).includes(squash(TRIGGER_SVG_SAMPLE)));
  check('content.js 里也没留下笔尖', !src.includes('s-nib') && !src.includes('M8.3 3.1h7.4'));

  for (const g of SVG_GUARDS) {
    check(`安全检查带过去了：${g.re}`, squash(src).includes(squash(g.re.toString())));
  }
}

section('14. 配置排序：moveItem 的下标口径 / dropIndex 的落点换算');
{
  /* 上下移和拖动排序共用同一套数学，而这里最容易错的只有一件事：
     `to` 到底是「移除前」还是「移除后」的坐标。往下挪时两者差一位。
     下面用 id 数组把两条路径都走一遍，全按「移除后」的口径钉死。 */

  const A = ['a', 'b', 'c', 'd'];

  eq('往下挪一位', moveItem(A, 0, 1), ['b', 'a', 'c', 'd']);
  eq('往上挪一位', moveItem(A, 2, 1), ['a', 'c', 'b', 'd']);
  eq('挪到最前', moveItem(A, 3, 0), ['d', 'a', 'b', 'c']);
  eq('挪到最后', moveItem(A, 0, 3), ['b', 'c', 'd', 'a']);
  eq('原数组没被改（纯函数）', A, ['a', 'b', 'c', 'd']);
  eq('下标越界会夹住', moveItem(A, 0, 99), ['b', 'c', 'd', 'a']);
  eq('负数也夹住', moveItem(A, 3, -5), ['d', 'a', 'b', 'c']);

  // 注意是 ===：调用方靠这个引用判等来跳过重渲染
  check('原地不动时返回的是同一个数组', moveItem(A, 2, 2) === A);
  eq('单个元素 / 空数组不出事', [moveItem(['x'], 0, 3), moveItem([], 0, 1)], [['x'], []]);
  check('不是数组也不炸', moveItem(null, 0, 1).length === 0);

  /* dropIndex：指针压在哪一行的上/下半区 → 目标下标 */
  eq('压在下半区 = 插到它后面', dropIndex(A, 'a', 'b', true), 1);
  eq('压在上半区 = 插到它前面', dropIndex(A, 'a', 'b', false), 0);
  eq('拖到自己上半区 = 原位', dropIndex(A, 'b', 'b', false), 1);
  eq('拖到自己下半区 = 原位', dropIndex(A, 'b', 'b', true), 1);
  eq('往回拖要减掉一位（这就是 off-by-one 藏的地方）', dropIndex(A, 'd', 'b', true), 2);
  check('认不出的 id 给 -1，调用方直接放弃',
    dropIndex(A, 'zz', 'a', true) === -1 && dropIndex(A, 'a', 'zz', true) === -1);

  /* 两个函数拼起来 = 界面上真正发生的事 */
  const dragTo = (ids, dragId, overId, after) =>
    moveItem(ids, ids.indexOf(dragId), dropIndex(ids, dragId, overId, after));

  eq('把第一条拖到第三条后面', dragTo(A, 'a', 'c', true), ['b', 'c', 'a', 'd']);
  eq('把第一条拖到第二条后面', dragTo(A, 'a', 'b', true), ['b', 'a', 'c', 'd']);
  eq('把最后一条拖到最前面', dragTo(A, 'd', 'a', false), ['d', 'a', 'b', 'c']);
  eq('把最后一条拖到第二条后面', dragTo(A, 'd', 'b', true), ['a', 'b', 'd', 'c']);
  eq('拖到自己身上 = 一点没动', dragTo(A, 'b', 'b', false), A);
  eq('手抖拖到自己下半区也 = 没动', dragTo(A, 'b', 'b', true), A);

  /* ---- moveVisibleItem：过滤视图里的排序，落到完整数组上 ----
     OCR 栏那份「图片配置」是 state.configs 的过滤视图，在那儿拖动的下标是
     **过滤视图**的，得换算回完整数组。看不见的那些一条都不该动。 */
  const obj = (ids) => ids.map((id) => ({ id }));
  const idOf = (list) => list.map((c) => c.id);

  // 全都能看见时，就该和 moveItem 一模一样
  const all4 = obj(['a', 'b', 'c', 'd']);
  eq('全可见时 = moveItem',
    idOf(moveVisibleItem(all4, ['a', 'b', 'c', 'd'], 0, 3)), ['b', 'c', 'd', 'a']);
  eq('全可见时（往下挪一位）',
    idOf(moveVisibleItem(all4, ['a', 'b', 'c', 'd'], 0, 1)), ['b', 'a', 'c', 'd']);

  /* 完整：a b c d，可见：a c（b、d 藏起来）
     把 c 挪到最前 → 可见变成 c a，b、d 原地不动 */
  const mixed = obj(['a', 'b', 'c', 'd']);
  eq('可见项往前挪，看不见的那条不动',
    idOf(moveVisibleItem(mixed, ['a', 'c'], 1, 0)), ['c', 'a', 'b', 'd']);
  eq('可见项往后挪到末尾（插在最后一条可见项后面）',
    idOf(moveVisibleItem(mixed, ['a', 'c'], 0, 1)), ['b', 'c', 'a', 'd']);

  /* 「拖到末尾」那条分流：b 越过 rest 的长度时要插在**最后一条可见项后面**，
     不是锚点前面 —— 少这一脚就会差一位（和 dropIndex 那个坑同源）。 */
  const three = obj(['a', 'x', 'b', 'y', 'c']); // 可见 a b c，x y 藏起来
  eq('可见三条，把第一条拖到最后',
    idOf(moveVisibleItem(three, ['a', 'b', 'c'], 0, 2)), ['x', 'b', 'y', 'c', 'a']);
  eq('可见三条，把最后一条拖到最前',
    idOf(moveVisibleItem(three, ['a', 'b', 'c'], 2, 0)), ['c', 'a', 'x', 'b', 'y']);

  // 引用判等：调用方靠 `next === arr` 跳过重渲染
  check('原地不动时返回同一个数组', moveVisibleItem(all4, ['a', 'b', 'c', 'd'], 1, 1) === all4);
  check('可见项不足两条 = 没得排，原样返回',
    moveVisibleItem(all4, ['a'], 0, 1) === all4 && moveVisibleItem(all4, [], 0, 1) === all4);
  check('提交上来的 id 全不认识也原样返回',
    moveVisibleItem(all4, ['zz', 'yy'], 0, 1) === all4);
  eq('不是数组也不炸',
    [moveVisibleItem(null, ['a'], 0, 1).length, moveVisibleItem(all4, null, 0, 1).length].join(),
    '0,' + all4.length);
  eq('下标越界会夹住（拖到列表外的空白处就是这个）',
    idOf(moveVisibleItem(all4, ['a', 'b', 'c', 'd'], 0, 99)), ['b', 'c', 'd', 'a']);
}

/* ------------------------------------------------------------------ */

section('15. 截图 OCR：供应商状态 / 请求体 / 取文字');
{
  const d = defaultOcrState();
  check('全新状态下内置供应商都在', d.providers.length === OCR_PROVIDERS.length,
    d.providers.map((p) => p.id));
  eq('默认选中硅基流动那条', d.activeId, 'builtin-siliconflow');
  eq('全新的供应商没有 key', d.providers[0].apiKey, '');
  check('内置条目都带 request 模板（模板化之后的形状）',
    d.providers.every((p) => String(p.request).trim() !== ''),
    d.providers.map((p) => [p.id, p.request]));

  /* 老存档（压根没有 ocr 字段）走的就是这条路 */
  const saved = normalizeOcrState({
    activeId: 'my-own',
    providers: [
      { id: 'builtin-siliconflow', endpoint: 'https://my.proxy/v1/chat/completions', apiKey: 'sk-abc' },
      { id: 'my-own', name: '自建', endpoint: 'http://127.0.0.1:8000/v1/chat/completions', model: 'qwen-vl', apiKey: 'k' }
    ]
  });
  const sf = saved.providers.find((p) => p.id === 'builtin-siliconflow');
  check('改过的内置条目：改了的字段保住了',
    sf.endpoint === 'https://my.proxy/v1/chat/completions' && sf.apiKey === 'sk-abc', sf);
  check('老形状条目就地转成等价模板（Key 原样进模板，不能被内置默认的 {{apiKey}} 顶掉）',
    sf.request.includes('https://my.proxy/v1/chat/completions') && sf.request.includes('sk-abc'),
    sf.request);
  check('内置没被删的那条也补齐了', saved.providers.some((p) => p.id === 'builtin-openai-vl'));
  eq('自己新建的排在内置后面', saved.providers[saved.providers.length - 1].id, 'my-own');
  eq('activeId 指向自己新建的那条', saved.activeId, 'my-own');

  const del = normalizeOcrState({ hidden: ['builtin-openai-vl'] });
  check('删掉的内置条目不会又被补回来',
    !del.providers.some((p) => p.id === 'builtin-openai-vl'), del.providers.map((p) => p.id));

  const gone = normalizeOcrState({ activeId: 'nope' });
  eq('activeId 认不出来时退回第一条', gone.activeId, gone.providers[0].id);

  eq('一条都不剩时兜底给一条（功能不至于死掉）',
    normalizeOcrState({ providers: [], hidden: BUILTIN_OCR_IDS.slice() }).providers.length, 1);

  eq('activeOcrProvider 认 activeId', activeOcrProvider(saved).id, 'my-own');
  eq('activeOcrProvider 认不出来时退第一条', activeOcrProvider(gone).id, gone.providers[0].id);
  check('providers 空时给 null', activeOcrProvider({ providers: [] }) === null);
  check('normalizeOcrProvider 会给没 id 的补一个',
    /^ocr-/.test(normalizeOcrProvider({ name: 'x' }).id));

  /* ---- 请求体 ---- */
  // 顺序是「先内置、后自建」，所以别按下标取，认 id 稳
  const mine = saved.providers.find((p) => p.id === 'my-own');
  const body = buildOcrBody(mine, 'data:image/png;base64,AAA');
  eq('model 用供应商里填的那个', body.model, 'qwen-vl');
  eq('content 是 [图片, 文字] 两段',
    body.messages[0].content.map((c) => c.type), ['image_url', 'text']);
  eq('图片走 image_url.url 的 data URL',
    body.messages[0].content[0].image_url.url, 'data:image/png;base64,AAA');
  eq('没填提示词就用默认的那句', body.messages[0].content[1].text, '<image>\nFree OCR.');
  eq('提示词留空时退回默认',
    buildOcrBody({ model: 'm', prompt: '   ' }, 'data:x').messages[0].content[1].text, '<image>\nFree OCR.');

  /* ---- 设置页那个「这次会发出去的请求」预览 ---- */
  /* OCR 栏不开放手写模板（形状固定），但接口地址 / 模型 / 提示词都是用户填的 ——
     所以设置页要把**整条请求**摊出来。预览和真正 fetch 的是同一个函数：
     runOcr 直接拿 previewOcrRequest 的产物当 body 发（下面那条「一模一样」就是证据）。 */
  const pv = previewOcrRequest(
    {
      endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
      model: 'deepseek-ai/DeepSeek-OCR',
      apiKey: 'sk-abcdefghijklmn',
      prompt: ''
    },
    'data:image/png;base64,SAMPLE'
  );
  eq('预览：方法是 POST', pv.method, 'POST');
  eq('预览：地址就是填的接口地址', pv.url, 'https://api.siliconflow.cn/v1/chat/completions');
  eq('预览：Content-Type', pv.headers['Content-Type'], 'application/json');
  check('预览：Authorization 打码了（设置页截图不至于泄 key）',
    !pv.headers.Authorization.includes('sk-abcdefghijklmn') &&
      pv.headers.Authorization.startsWith('Bearer sk-abc'),
    pv.headers.Authorization);
  const pvBody = JSON.parse(pv.body);
  eq('预览：body 里就是那张图',
    pvBody.messages[0].content[0].image_url.url, 'data:image/png;base64,SAMPLE');
  eq('预览：提示词留空 → 发默认那句（和真发出去的一致）',
    pvBody.messages[0].content[1].text, DEFAULT_OCR_PROMPT);
  eq('预览：接口地址没填时 url 是空串（设置页据此写「还没填」）',
    previewOcrRequest({ model: 'm' }, 'data:x').url, '');

  /* ---- 模板路径（v7）：三个图片占位符 ---- */
  const ft = fillOcrTemplate('{{image}}|{{imageBase64}}|{{imageUrlEncoded}}', 'data:image/png;base64,A+b/c', {});
  eq('{{image}} 是 data URL 原文', ft.text.split('|')[0], 'data:image/png;base64,A+b/c');
  eq('{{imageBase64}} 是裸 base64', ft.text.split('|')[1], 'A+b/c');
  eq('{{imageUrlEncoded}} 过了 URL 编码（+ 不转会叫服务端当空格）', ft.text.split('|')[2], 'A%2Bb%2Fc');
  check('提示词不是占位符，原样留在模板里',
    fillOcrTemplate('{"text":"请原样输出图片里的文字"}', 'data:x').text,
    '{"text":"请原样输出图片里的文字"}');

  /* ---- 老字段 → 模板的无损搬家 ---- */
  const legacy = { endpoint: 'https://api.x.cn/v1/chat/completions', model: 'm-1', apiKey: 'sk-k', prompt: 'OCR:', maxTokens: 2048 };
  const tplReq = parseRequest(fillOcrTemplate(ocrProviderToTemplate(legacy), 'data:image/png;base64,AAA', {}).text);
  eq('搬家：地址一致', tplReq.url, legacy.endpoint);
  eq('搬家：body 和老 buildOcrBody 逐字节一致（键序 / 引号转义都不漂）',
    tplReq.body, JSON.stringify(buildOcrBody(legacy, 'data:image/png;base64,AAA')));

  /* ---- 模板路径预览：Authorization 照样打码 ---- */
  const pvT = previewOcrRequest(
    { request: "curl https://x/y \\\n  -H \"Authorization: Bearer {{apiKey}}\" \\\n  -d '{\"model\":\"m\"}'" },
    'data:x',
    { apiKey: 'sk-secret123456' }
  );
  check('模板路径的 Authorization 也打码了（设置页截图不至于泄 key）',
    !pvT.headers.Authorization.includes('sk-secret123456'), pvT.headers.Authorization);
  eq('模板路径预览的 body 就是解析出来的那份', pvT.body, '{"model":"m"}');

  /* ---- max_tokens：默认**不发**这个字段 ---- */
  /* 写死一个数会在上下文窄的模型上直接 400：
     DeepSeek-OCR 的 max_seq_len 只有 8192，而「提示词 + max_tokens」是加在一起算的
     → `max_tokens (8192) have exceeded max_seq_len (8192) limit`。 */
  check('默认不发送 max_tokens（交给服务端按模型上限定）',
    !('max_tokens' in body), Object.keys(body));
  check('空串 / null / 0 / 负数 / 垃圾值都不发',
    [undefined, '', null, 0, -5, 'abc', NaN].every(
      (v) => !('max_tokens' in buildOcrBody({ model: 'm', maxTokens: v }, 'data:x'))),
    [undefined, '', null, 0, -5, 'abc'].map((v) => buildOcrBody({ model: 'm', maxTokens: v }, 'data:x')));
  eq('填了正经数字才发出去', buildOcrBody({ model: 'm', maxTokens: 2048 }, 'data:x').max_tokens, 2048);
  eq('字符串数字也认', buildOcrBody({ model: 'm', maxTokens: '4096' }, 'data:x').max_tokens, 4096);
  eq('小数往下取整', buildOcrBody({ model: 'm', maxTokens: '2048.9' }, 'data:x').max_tokens, 2048);
  check('temperature 还在（两个字段互不影响）',
    buildOcrBody({ model: 'm' }, 'data:x').temperature === 0.01);
  eq('内置供应商默认也是不发', normalizeOcrProvider(OCR_PROVIDERS[0]).maxTokens, 0);
  eq('老存档没这个字段 → 0 = 不发', normalizeOcrState(null).providers[0].maxTokens, 0);
  eq('normalizeMaxTokens 把垃圾值归零', normalizeMaxTokens('  '), 0);

  /* ---- 取文字 ---- */
  eq('取 choices[0].message.content',
    pickOcrText({ choices: [{ message: { content: ' 你好 ' } }] }), '你好');
  eq('content 给成分段数组也认',
    pickOcrText({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { text: 'b' }] } }] }), 'ab');
  eq('返回结构不对时给空串',
    [pickOcrText({}), pickOcrText({ choices: [] }), pickOcrText(null)], ['', '', '']);

  /* ---- 报错信息 ---- */
  const e401 = describeOcrError(401, '{"message":"Invalid token"}');
  check('HTTP 错带上状态码和响应体', e401.includes('401') && e401.includes('Invalid token'), e401);
  check('响应体太长会截一刀', describeOcrError(500, 'x'.repeat(999)).length < 260);

  /* 撞过的几种 400，要说出「接下来改哪儿」，不是只丢一句原始报文 */
  const eMax = describeOcrError(400, '{"code":20015,"message":"max_tokens (8192) have exceeded max_seq_len (8192) limit."}');
  check('max_seq_len 那种 400 会提示去模板里删 max_tokens',
    eMax.includes('max_tokens'), eMax);
  check('认不出来的报错不动手，原样给用户看', ocrErrorHint('{"message":"boom"}') === '');
  check('模型名不对时提示去核对模型名',
    /模型名/.test(ocrErrorHint('{"error":{"message":"Model does not exist"}}')));

  /* ---- 缺字段时直接报错，别真发请求出去 ---- */
  const err = await runOcr({ provider: { endpoint: 'https://x/y', model: 'm', apiKey: '' }, dataUrl: 'data:x' })
    .then(() => '', (e) => e.message);
  check('没填 API Key 时直接报错', /API Key/.test(err), err);

  /* ---- 真跑一次（fetch 打桩）：设置页那个「测试」靠这些字段显示诊断 ---- */
  const realFetch = globalThis.fetch;
  try {
    let sent = null;
    globalThis.fetch = async (url, init) => {
      sent = { url, init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: ' 认出来的字 ' } }] })
      };
    };

    const okRes = await runOcr({
      provider: { endpoint: 'https://x/y', model: 'm', apiKey: 'sk-1234567890' },
      dataUrl: 'data:image/png;base64,AAA'
    });
    eq('成功时取到文字', okRes.text, '认出来的字');
    eq('带上 HTTP 状态', okRes.status, 200);
    check('带上耗时', typeof okRes.ms === 'number');
    eq('request.url 就是填的接口地址', okRes.request.url, 'https://x/y');
    eq('request.body 和真正发出去的一模一样（设置页预览 = 真发的那份）',
      okRes.request.body, sent.init.body);
    eq('真发出去的那份 header 用真 key',
      sent.init.headers.Authorization, 'Bearer sk-1234567890');
    check('展示用的那份 header 把 key 打码了（设置页截图不至于泄 key）',
      !String(okRes.request.headers.Authorization).includes('sk-1234567890'),
      okRes.request.headers.Authorization);
    check('原始响应原样留着', String(okRes.raw).includes('认出来的字'));
  } finally {
    globalThis.fetch = realFetch;
  }

  /* ---- 失败时把状态码 / 原始响应挂在 Error 上 ---- */
  try {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => '{"message":"Invalid token"}'
    });
    const bad = await runOcr({
      provider: { endpoint: 'https://x/y', model: 'm', apiKey: 'sk-1234567890' },
      dataUrl: 'data:image/png;base64,AAA'
    }).then(() => null, (e) => e);
    check('HTTP 不 OK 时抛错', !!bad);
    eq('错误里带 HTTP 状态', bad.status, 401);
    check('错误里带原始响应', String(bad.raw).includes('Invalid token'), String(bad.raw));
    eq('错误里也带那份打码的请求', bad.request.url, 'https://x/y');
    check('报错文案还是原来那一句', /HTTP 401/.test(bad.message), bad.message);
  } finally {
    globalThis.fetch = realFetch;
  }

  /* ---- 主 + 后备：主请求挂了自动试后备（和「配置」栏**同一套链**，kniph 2026-10-14）---- */
  const ocrChainProvider = (extra) => normalizeOcrProvider({
    name: '链',
    request: 'curl http://127.0.0.1/bad -d "{}"',
    responsePath: '',
    ...extra
  });
  try {
    const hits = [];
    globalThis.fetch = async (url) => {
      hits.push(String(url));
      if (String(url).includes('/bad')) {
        return { ok: false, status: 503, text: async () => '{"error":{"message":"overloaded"}}' };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '后备认出来的字' } }] })
      };
    };

    const withFb = await runOcr({
      provider: ocrChainProvider({
        fallbacks: [{ id: 'fb1', enabled: true, request: 'curl http://127.0.0.1/good -d "{}"', path: '' }]
      }),
      dataUrl: 'data:image/png;base64,AAA'
    });
    eq('主请求挂了 → 拿到后备认出来的字', withFb.text, '后备认出来的字');
    check('先发主请求、挂了才发后备（顺序对）',
      hits.length === 2 && hits[0].includes('/bad') && hits[1].includes('/good'), JSON.stringify(hits));
    eq('报一声是哪一条成的', withFb.from, '后备 1');

    hits.length = 0;
    const mainOk = await runOcr({
      provider: ocrChainProvider({
        fallbacks: [{ id: 'fb1', enabled: true, request: 'curl http://127.0.0.1/good -d "{}"', path: '' }]
      }),
      dataUrl: 'data:image/png;base64,AAA',
      // 主请求换成能通的
    });
    check('（脚手架）主请求这条路本来是坏的', hits[0].includes('/bad'), JSON.stringify(hits));

    // 主请求能通 → 一条后备都不发
    hits.length = 0;
    const goodMain = normalizeOcrProvider({
      name: '主通',
      request: 'curl http://127.0.0.1/good -d "{}"',
      fallbacks: [{ id: 'fb1', enabled: true, request: 'curl http://127.0.0.1/never -d "{}"', path: '' }]
    });
    const only = await runOcr({ provider: goodMain, dataUrl: 'data:image/png;base64,AAA' });
    eq('主请求就通 → 只用主请求', only.text, '后备认出来的字');
    check('一条后备都没发（拿到结果就停，和配置栏一个规矩）',
      hits.length === 1 && hits[0].includes('/good'), JSON.stringify(hits));
    eq('主请求成的也报一声', only.from, '主请求');

    // 主请求没勾、后备勾着 → 只跑后备（启用勾是唯一开关，和配置栏一个规矩）
    hits.length = 0;
    const mainOff = normalizeOcrProvider({
      name: '主没勾',
      request: 'curl http://127.0.0.1/bad -d "{}"',
      mainEnabled: false,
      fallbacks: [{ id: 'fb1', enabled: true, request: 'curl http://127.0.0.1/good -d "{}"', path: '' }]
    });
    const onlyFb = await runOcr({ provider: mainOff, dataUrl: 'data:image/png;base64,AAA' });
    check('主请求没勾 → 只发勾上的那条后备（主请求一次都不发）',
      hits.length === 1 && hits[0].includes('/good'), JSON.stringify(hits));
    eq('照样报一声是哪一条成的', onlyFb.from, '后备 1');

    // 一条都没勾 → 退回主请求（别让「什么都不发」成为没人看得懂的死状态）
    hits.length = 0;
    const noneOn = normalizeOcrProvider({
      name: '全不勾',
      request: 'curl http://127.0.0.1/bad -d "{}"',
      mainEnabled: false,
      fallbacks: [{ id: 'fb1', enabled: false, request: 'curl http://127.0.0.1/good -d "{}"', path: '' }]
    });
    const dead2 = await runOcr({ provider: noneOn, dataUrl: 'data:image/png;base64,AAA' })
      .then(() => null, (e) => e);
    check('全不勾 = 只跑主请求（和配置栏的 requestChain 同一个规矩）',
      hits.length === 1 && hits[0].includes('/bad'), JSON.stringify(hits));
    check('主请求也挂了就把错误抛出来（不静默返回空）', !!dead2, String(dead2 && dead2.message));

    // 全挂 → 抛最后一个错（detail 里带着那一条的请求）
    hits.length = 0;
    const allBad = normalizeOcrProvider({
      name: '全挂',
      request: 'curl http://127.0.0.1/bad -d "{}"',
      fallbacks: [{ id: 'fb1', enabled: true, request: 'curl http://127.0.0.1/bad2 -d "{}"', path: '' }]
    });
    const dead = await runOcr({ provider: allBad, dataUrl: 'data:image/png;base64,AAA' })
      .then(() => null, (e) => e);
    check('两条都挂了就抛错（不静默返回空）', !!dead, String(dead && dead.message));
    check('错误里带着最后那一条的请求（对得上页面上摊开的那份）',
      String(dead && dead.request && dead.request.url).includes('/bad2'),
      String(dead && dead.request && dead.request.url));
  } finally {
    globalThis.fetch = realFetch;
  }

  /* normalizeOcrItem 和 requests.js 的 normalizeRequestItem 必须同一个口径 */
  eq('两个归一化函数：缺字段 = 勾上',
    normalizeOcrItem({}).enabled, normalizeRequestItem({}).enabled);
  eq('两个归一化函数：显式 false 都认',
    normalizeOcrItem({ enabled: false }).enabled, normalizeRequestItem({ enabled: false }).enabled);
  eq('OCR 条目只存它用得上的字段（别往导出文件里塞 adapter/imageRequest/responseMode）',
    JSON.stringify(Object.keys(normalizeOcrItem({})).sort()),
    JSON.stringify(['enabled', 'id', 'path', 'request']));

  /* ---- 模板路径真跑一次（百度形状：token 挂 URL + form 体 + 行数组响应）---- */
  try {
    let sentT = null;
    globalThis.fetch = async (url, init) => {
      sentT = { url: String(url), init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ words_result: [{ words: '你好' }, { words: '世界' }], log_id: 1 })
      };
    };
    const baidu = normalizeOcrProvider(
      OCR_PROVIDERS.find((p) => p.id === 'builtin-baidu-ocr')
    );
    const token = baidu.request.replace('把access_token粘到这里', 'TOKEN-1');
    const okT = await runOcr({ provider: { ...baidu, request: token }, dataUrl: 'data:image/png;base64,AAA', vars: {} });
    eq('百度模板：token 在 URL 上', sentT.url, 'https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=TOKEN-1');
    eq('百度模板：form 体就是 urlencode 过的 base64', sentT.init.body, 'image=AAA&language_type=auto_detect');
    eq('百度模板：Content-Type 是表单', sentT.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
    eq('行数组响应按 \\n 拼成一段', okT.text, '你好\n世界');
    check('模板路径也带原始响应和状态', okT.status === 200 && String(okT.raw).includes('words_result'));
  } finally {
    globalThis.fetch = realFetch;
  }

  /* ---- 模板路径：OpenAI 形状 + 变量里的 Key ---- */
  try {
    let sentV = null;
    globalThis.fetch = async (url, init) => {
      sentV = { url: String(url), init };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '认出来的字' } }] })
      };
    };
    const vl = normalizeOcrProvider(OCR_PROVIDERS.find((p) => p.id === 'builtin-openai-vl'));
    const okV = await runOcr({ provider: vl, dataUrl: 'data:image/png;base64,AAA', vars: { apiKey: 'sk-vars' } });
    eq('内置 OpenAI 模板：Key 从用户变量进来', sentV.init.headers.Authorization, 'Bearer sk-vars');
    eq('图片占位符填进 image_url.url', sentV.init.body.includes('"url": "data:image/png;base64,AAA"'), true);
    eq('走 choices 提取', okV.text, '认出来的字');
  } finally {
    globalThis.fetch = realFetch;
  }

  /* ---- 模板路径 + stream:true（SSE）：实机踩过的那种 ----
     用户图片模板里带 `"stream": true` 时接口回的是 SSE，而设置页那个「测试」
     原来自己写了个 JSON.parse(res.text())，于是当场报「返回的不是 JSON」——
     可实际用（面板走引擎）明明是好的。现在读响应收口在引擎的 readResponseBody，
     这里钉住「SSE 也要能读出来」+「切两半的事件照样拼得回来」。 */
  try {
    let sentS = null;
    globalThis.fetch = async (url, init) => {
      sentS = { url: String(url), init };
      return streamResponse([
        'data: {"choices":[{"delta":{"content":"现在是"}}]}\n\n' +
          'data: {"choices":[{"delta":{"con',
        'tent":"图片直传"}}]}\n\n',
        'data: [DONE]\n\n'
      ]);
    };
    const sseVl = normalizeOcrProvider(OCR_PROVIDERS.find((p) => p.id === 'builtin-openai-vl'));
    const okS = await runOcr({ provider: sseVl, dataUrl: 'data:image/png;base64,AAA', vars: { apiKey: 'sk-vars' } });
    eq('OCR 模板 + SSE：逐帧攒出来的文字', okS.text, '现在是图片直传');
    check('OCR 模板 + SSE：真发出去的那份没变（还是模板渲出来的）',
      String(sentS.init.body).includes('data:image/png;base64,AAA'), String(sentS.init.body).slice(0, 120));
    check('OCR 模板 + SSE：原始响应原样留着', String(okS.raw).includes('[DONE]'), okS.raw);
  } finally {
    globalThis.fetch = realFetch;
  }

  /* ---- 图片直传那个「测试」：一条翻译配置的图片请求模板跑不跑得通 ----
     勾了「禁用外置 OCR」之后右键截一张图才知道配没配对，太贵 —— 设置页那块「测试」
     走的就是这个函数（和 OCR 那个共用同一套图片占位符装配）。 */
  {
    const imgTpl =
      "curl -X POST 'https://api.example.com/v1/chat/completions' \\\n" +
      '  -H "Content-Type: application/json" \\\n' +
      '  -H "Authorization: Bearer {{apiKey}}" \\\n' +
      '  -d \'{"model":"see","messages":[{"role":"user","content":[' +
      '{"type":"image_url","image_url":{"url":"{{image}}"}},' +
      '{"type":"text","text":"翻成{{target}}"}]}]}\'';

    // 没填图片模板：不发包，直接把「去哪填」说清楚
    let noTpl = null;
    try {
      await runImageTranslate({ config: { id: 'x', name: '甲', imageRequest: '   ' }, dataUrl: 'data:x' });
    } catch (e) {
      noTpl = e;
    }
    check('没填图片请求模板时直接说清楚，不发请求',
      !!noTpl && /图片请求模板/.test(noTpl.message), noTpl && noTpl.message);
    check('空模板那条也没带 request（没发出去自然没有）', !noTpl || !noTpl.request);

    const cfg = { id: 'x', name: '看图那条', imageRequest: imgTpl, responsePath: 'choices[0].message.content' };

    // 成功：图片 / 变量 / 目标语言都填进去了，返回值按 responsePath 提取
    try {
      let sent = null;
      globalThis.fetch = async (url, init) => {
        sent = { url: String(url), init };
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ choices: [{ message: { content: '译文在这' } }] })
        };
      };
      const okR = await runImageTranslate({
        config: cfg,
        dataUrl: 'data:image/png;base64,AAA',
        vars: { apiKey: 'sk-vars', target: '简体中文' }
      });
      eq('图片直传测试：发到模板里的地址', sent.url, 'https://api.example.com/v1/chat/completions');
      eq('图片直传测试：变量里的 Key 进了请求头', sent.init.headers.Authorization, 'Bearer sk-vars');
      check('图片直传测试：{{image}} 换成了那张 data URL',
        sent.init.body.includes('data:image/png;base64,AAA'), sent.init.body.slice(0, 120));
      check('图片直传测试：{{target}} 也换了', sent.init.body.includes('翻成简体中文'), sent.init.body.slice(0, 160));
      eq('图片直传测试：结果按 responsePath 提取', okR.text, '译文在这');
      /* 打码的请求是给人看的，真发的那份别拿它发 —— 这里对一下 Authorization 确实被打码了 */
      check('图片直传测试：记下来给人看的请求里 Key 已打码',
        !String(okR.request.headers.Authorization || '').includes('sk-vars'),
        String(okR.request.headers.Authorization));
    } finally {
      globalThis.fetch = realFetch;
    }

    /* stream: true 的图片模板 —— 就是实机上那个 bug：
       Ling 那种模型的响应是 SSE，面板那头（走引擎）翻得好好的，设置页这个
       「测试」却报「返回的不是 JSON」。读响应现在收口在 readResponseBody。
       （这条配置**不写** responsePath —— 流式的分片是 delta.content，
         写死了 message.content 就谁也取不出来，那是模板作者自己的事，
         留空会按常见结构自动探测。用户那条 Ling 配置也是留空的。） */
    try {
      let sentSse = null;
      globalThis.fetch = async (url, init) => {
        sentSse = { url: String(url), init };
        return streamResponse([
          'data: {"choices":[{"delta":{"content":"图片直传"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"：截图"}}]}\n\n' +
            'data: {"choices":[{"delta":{"content":"不再过"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" OCR"}}]}\n\n',
          'data: [DONE]\n\n'
        ]);
      };
      const okSse = await runImageTranslate({
        config: { id: 'y', name: '流式那条', imageRequest: imgTpl },
        dataUrl: 'data:image/png;base64,AAA',
        vars: { apiKey: 'sk-vars', target: '简体中文' }
      });
      eq('图片直传测试：stream:true 的 SSE 也读得出来（不再误报「不是 JSON」）',
        okSse.text, '图片直传：截图不再过 OCR');
      check('图片直传测试：SSE 那次真发出去的还是模板渲出来的那份',
        String(sentSse.init.body).includes('翻成简体中文'), String(sentSse.init.body).slice(0, 160));
      check('图片直传测试：SSE 的原始响应留着（诊断要看全帧）',
        String(okSse.raw).includes('[DONE]'), okSse.raw);
    } finally {
      globalThis.fetch = realFetch;
    }

    // 失败：HTTP 状态、原始响应、请求都挂到 Error 上（设置页那三块靠它）
    try {
      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        text: async () => '{"error":{"message":"bad key"}}'
      });
      let bad = null;
      try {
        await runImageTranslate({ config: cfg, dataUrl: 'data:image/png;base64,AAA', vars: {} });
      } catch (e) {
        bad = e;
      }
      check('图片直传测试：失败时 HTTP 状态原样带出来', !!bad && bad.status === 401, bad && String(bad.status));
      check('图片直传测试：失败时原始响应也带出来（定位靠它）',
        !!bad && /bad key/.test(String(bad.raw)), bad && String(bad.raw));
      check('图片直传测试：失败时请求也带出来（知道发到哪去了）',
        !!bad && !!bad.request && bad.request.url === 'https://api.example.com/v1/chat/completions');
    } finally {
      globalThis.fetch = realFetch;
    }

    // 回来了但不是 JSON：说人话，别糊一个 "Unexpected token"
    try {
      globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => '<html>502</html>' });
      let notJson = null;
      try {
        await runImageTranslate({ config: cfg, dataUrl: 'data:x', vars: {} });
      } catch (e) {
        notJson = e;
      }
      check('图片直传测试：返回不是 JSON 时说清并附上原文',
        !!notJson && /不是 JSON/.test(notJson.message) && /<html>/.test(notJson.message),
        notJson && notJson.message);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  /* ---- 右键菜单那一条 ---- */
  eq('菜单 id', OCR_MENU_ID, 'rt-ocr-clipboard');
  eq('菜单文案', OCR_MENU_TITLE, '翻译剪切板中的截图');
  check('右键菜单开关默认开', DEFAULT_SETTINGS.ocrMenu === true);
  /* ---- 右键菜单「框选截图翻译」那条：和剪切板那条并存，各自独立开关 ---- */
  eq('框选菜单 id', SHOT_MENU_ID, 'rt-shot-translate');
  eq('框选菜单文案', SHOT_MENU_TITLE, '框选截图翻译');
  check('框选菜单开关默认开', DEFAULT_SETTINGS.shotMenu === true);
  check('框选菜单开着时给一条能直接 create 的描述',
    (() => { const it = shotMenuItem(DEFAULT_SETTINGS); return !!it && it.id === SHOT_MENU_ID && it.title === SHOT_MENU_TITLE; })());
  check('框选菜单关掉时返回 null（background 就不建它）',
    shotMenuItem({ shotMenu: false }) === null);
  check('两条截图菜单的 id 不一样（并存才不会互相顶掉）', SHOT_MENU_ID !== OCR_MENU_ID);
  check('内置那条默认还是硅基流动的 DeepSeek-OCR（在模板里）',
    String(OCR_PROVIDERS[0].request).includes('deepseek-ai/DeepSeek-OCR'),
    OCR_PROVIDERS[0].request);
  check('内置多了百度那条（模板化之后 form 协议也是一段模板）',
    OCR_PROVIDERS.some((p) => p.id === 'builtin-baidu-ocr' && p.request.includes('access_token=')));
  check('默认提示词是 DeepSeek-OCR 官方那串（`<image>` + 换行 + `Free OCR.`，一个字都别少）',
    DEFAULT_OCR_PROMPT === '<image>\nFree OCR.', JSON.stringify(DEFAULT_OCR_PROMPT));
  /* 提示词**不内置成预设**：各家格式互不相通，而且 DeepSeek-OCR 只认训练时那几个固定写法 ——
     换成普通措辞（哪怕意思一模一样的中文）就把它推出训练分布，输出会退化（实测会跑去生成
     `<table>` 表格，识别率也掉）。所以设置页摆一排「预设按钮」是误导：内置那条只兜一个默认值，
     换模型时用户自己去翻官方文档。设置页里那句说明由 e2e 第 10 节盯着。 */
  check('内置那条用的就是默认提示词',
    normalizeOcrProvider(OCR_PROVIDERS[0]).prompt === DEFAULT_OCR_PROMPT,
    normalizeOcrProvider(OCR_PROVIDERS[0]).prompt);
  eq('用户自己填的提示词原样发出去（不被默认值盖掉）',
    buildOcrBody({ model: 'm', prompt: 'OCR:' }, 'data:x').messages[0].content[1].text, 'OCR:');
}

section('15b. 禁用外置 OCR：勾上后图片直传模型');
{
  /* 「禁用外置 OCR」是 ocr 这一块上的一个全局开关，不是某条供应商的属性。
     它只可能有两种存档形态：老存档没这个字段（→ false），和用户勾过（→ true）。
     别的乱七八糟的值（字符串 / 数字 / null）一律当没勾，别把请求搞坏。 */
  check('全新状态下没勾', defaultOcrState().disabled === false);
  check('老存档没这个字段时当没勾', normalizeOcrState({}).disabled === false);
  check('勾过就记住', normalizeOcrState({ disabled: true }).disabled === true);
  /* 开关的写法跟项目里其它开关一致：!!v 的真值语义。
     这里只钉住「哪些值算关」——老存档的 undefined / 显式 false / null / 0 / 空串 */
  check('表示「关」的那几种值都不会被当成勾上',
    [normalizeOcrState({ disabled: false }), normalizeOcrState({ disabled: null }),
     normalizeOcrState({ disabled: 0 }), normalizeOcrState({ disabled: '' }),
     normalizeOcrState(undefined)]
      .every((o) => o.disabled === false));
  check('归一化后一定是布尔，不是原样透传',
    [normalizeOcrState({ disabled: 1 }), normalizeOcrState({ disabled: 'yes' })]
      .every((o) => typeof o.disabled === 'boolean'));

  /* 勾上之后照样得有一份完整的 providers —— 用户随时会把它取消勾选，
     那时候下面那些供应商不能是空的。 */
  const off = normalizeOcrState({ disabled: true });
  check('勾上也不影响供应商列表（取消勾选后还得能用）',
    off.providers.length === OCR_PROVIDERS.length, off.providers.length);

  /* ---- {{image}} 占位符 ---- */
  const st = {
    vars: [],
    settings: { targetLang: '简体中文' }
  };
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  eq('普通翻译时 {{image}} 是空串（模板里那句会变成空）',
    buildVars(st, 'hello', { url: 'https://x', title: 'T' }).image, '');
  eq('直传模式下 {{image}} 就是那张图的 data URL',
    buildVars(st, '', { image: dataUrl }).image, dataUrl);
  eq('直传时 text 是空串（图片就是原文）', buildVars(st, '', { image: dataUrl }).text, '');
  eq('内置变量优先：用户自己也叫 image 时以内置的为准',
    buildVars({ vars: [{ name: 'image', value: '我自己写的' }], settings: {} }, 'x', { image: dataUrl }).image,
    dataUrl);

  /* ---- {{imagePart}}：让一段模板同时能翻文字、能翻图 ---- */
  eq('没图时 imagePart 是空串（什么都不加）', imageContentPart(''), '');
  eq('给 null / undefined 也是空串',
    [imageContentPart(null), imageContentPart(undefined)], ['', '']);
  eq('有图时是一整段 content 元素，前面带逗号',
    imageContentPart('data:image/png;base64,AA'),
    ',{"type":"image_url","image_url":{"url":"data:image/png;base64,AA"}}');

  /* 用户实际会写成的形状：content 是数组，末尾挂一个裸的 {{imagePart}}。
     这一段是本节的重点 —— 「同一段模板两种用法」到底成不成立，就看这两次
     renderTemplate 的结果能不能被 JSON.parse 吃下去。 */
  const tpl =
    '{"role":"user","content":[' +
    '{"type":"text","text":"仅输出{{target}}译文：\\n\\"\\"\\"\\n{{text}}\\n\\"\\"\\"\\n输出示例：\\nThe translated text itself"}' +
    '{{imagePart}}]}';

  const textOut = renderTemplate(tpl, buildVars(st, 'Hello', {})).text;
  let textJson = null;
  let textOk = true;
  try {
    textJson = JSON.parse(textOut);
  } catch {
    textOk = false;
  }
  check('纯文字翻译：渲染出来还是合法 JSON', textOk, textOut);
  eq('纯文字翻译：content 里只有一个 text 段（没多出空图片项）',
    (textJson.content || []).map((c) => c.type), ['text']);
  check('纯文字翻译：原文照常进去了', String(textJson.content[0].text).includes('Hello'),
    textJson.content[0].text);

  const imgOut = renderTemplate(tpl, buildVars(st, '', { image: dataUrl })).text;
  let imgJson = null;
  let imgOk = true;
  try {
    imgJson = JSON.parse(imgOut);
  } catch {
    imgOk = false;
  }
  check('截图直传：渲染出来也是合法 JSON', imgOk, imgOut);
  eq('截图直传：content 自动多出 image_url 段',
    (imgJson.content || []).map((c) => c.type), ['text', 'image_url']);
  eq('截图直传：data URL 原样带过去了',
    imgJson.content[1].image_url.url, dataUrl);
  check('截图直传：那段是裸插的，没被套上引号',
    !imgOut.includes('"imagePart"') && !imgOut.includes('\\"imagePart\\"'), imgOut);
}

section('15c. 一条配置两段模板：文本一段、图片一段');
{
  const st = { vars: [], settings: { targetLang: '简体中文' } };

  const cfg = { request: 'TEXT_TPL', imageRequest: 'IMG_TPL' };
  eq('没有图时用文字那段', requestTemplateFor(cfg, {}), 'TEXT_TPL');
  eq('有图时用图片那段', requestTemplateFor(cfg, { image: 'data:image/png;base64,AA' }), 'IMG_TPL');
  eq('图片那段留空 → 回退到文字那段',
    requestTemplateFor({ request: 'TEXT_TPL', imageRequest: '' }, { image: 'data:x' }), 'TEXT_TPL');
  eq('图片那段只有空白也算留空',
    requestTemplateFor({ request: 'TEXT_TPL', imageRequest: '   \n ' }, { image: 'data:x' }), 'TEXT_TPL');
  eq('老配置（压根没这个字段）行为不变',
    requestTemplateFor({ request: 'TEXT_TPL' }, { image: 'data:x' }), 'TEXT_TPL');
  eq('没有配置时给空串', requestTemplateFor(null, { image: 'data:x' }), '');
  eq('context 缺省也不炸', requestTemplateFor(cfg), 'TEXT_TPL');

  /* 用户实际会写的两段（重点是：文字那次 content 还是字符串，图片那次才是数组） */
  const textTpl = '{"role":"user","content":"仅输出{{target}}译文：\\n{{text}}"}';
  const imgTpl =
    '{"role":"user","content":[' +
    '{"type":"image_url","image_url":{"url":"{{image}}"}},' +
    '{"type":"text","text":"仅输出{{target}}译文"}]}';
  const two = { request: textTpl, imageRequest: imgTpl };
  const img = 'data:image/png;base64,iVBORw0KGgo=';

  const j1 = JSON.parse(renderTemplate(requestTemplateFor(two, {}), buildVars(st, 'Hello', {})).text);
  eq('文字那次：content 还是字符串（没被图片模板改坏）', typeof j1.content, 'string');
  check('文字那次：原文进去了', j1.content.includes('Hello'), j1.content);

  const j2 = JSON.parse(
    renderTemplate(requestTemplateFor(two, { image: img }), buildVars(st, '', { image: img })).text
  );
  eq('图片那次：content 变成数组，图片在最前', j2.content.map((c) => c.type), ['image_url', 'text']);
  eq('图片那次：data URL 原样带过去', j2.content[0].image_url.url, img);

  /* ---- 字段补齐：老存档走 normalize，全新存档走 freshConfigs ---- */
  /* imageRequest 原来断言「全是空串」—— 那时所有内置配置都不带图片模板。
     2026-11-08 起 bilibili 那条**故意**带了图片模板（它内置视觉编码器，
     图片翻译不需要 OCR），所以判据改成：每条配置都得有 imageRequest 这个字段
     （类型是字符串），且**至少有一条**带模板（否则图片直传等于死功能）。 */
  const fresh = freshConfigs();
  check('全新的内置配置都带 imageRequest 字段（类型是字符串）',
    fresh.every((c) => typeof c.imageRequest === 'string'), fresh.map((c) => c.name));
  check('至少有一条内置配置带图片模板（bilibili 那条）',
    fresh.some((c) => c.imageRequest && c.imageRequest.trim()),
    fresh.filter((c) => c.imageRequest).map((c) => c.name));
  check('bilibili 那条的图片模板能真的翻图（canTranslateImage 为真）',
    fresh.some((c) => c.id === 'builtin-bilibili' && canTranslateImage(c)));
  /* 其余配置仍然保持空串 —— 这条钉住「别顺手给别人也塞模板」 */
  check('除 bilibili 外，其它内置配置的 imageRequest 都是空串',
    fresh.filter((c) => c.id !== 'builtin-bilibili').every((c) => c.imageRequest === ''),
    fresh.filter((c) => c.id !== 'builtin-bilibili' && c.imageRequest).map((c) => c.name));
  check('freshConfigs 每次都给新对象（改一条不会污染 DEFAULT_CONFIGS）', (() => {
    const a = freshConfigs();
    a[0].request = '被我改过了';
    return freshConfigs()[0].request !== '被我改过了';
  })());

  const origGet = globalThis.chrome.storage.local.get;
  globalThis.chrome.storage.local.get = async () => ({
    state: { version: 3, configs: [{ id: 'old', name: '老配置', request: 'R' }], settings: {}, vars: [] }
  });
  const oldState = await loadState();
  globalThis.chrome.storage.local.get = origGet;
  eq('老存档里的配置读出来被补上空的 imageRequest', oldState.configs[0].imageRequest, '');
  eq('老配置的请求模板一个字没动', oldState.configs[0].request, 'R');
  eq('老配置的 id / 名字也都在', [oldState.configs[0].id, oldState.configs[0].name], ['old', '老配置']);
}

section('15d. 谁去翻译这一条：文字用顶栏那条，图片可另指一条');
{
  /* 三条配置：A 只有文字模板、B 两段都有、C 只有文字模板（用来试「指过去但没填图片模板」） */
  const mk = () => ({
    activeConfigId: 'A',
    settings: { targetLang: '简体中文' },
    vars: [],
    configs: [
      { id: 'A', name: '甲', request: 'TEXT_A', imageRequest: '' },
      { id: 'B', name: '乙', request: 'TEXT_B', imageRequest: 'IMG_B' },
      { id: 'C', name: '丙', request: 'TEXT_C', imageRequest: '   \n ' }
    ]
  });

  const idOf = (st, id) => (pickRequestConfig(st, id, false) || {}).id;

  /* 文字：永远走传进来的 / 存档里记的那条，跟图片选中项无关 */
  const st1 = mk();
  st1.ocr = { imageConfigId: 'B' };
  eq('划文字：用传进来的那条', idOf(st1, 'A'), 'A');
  eq('划文字：传了别的 id 就用那个', idOf(st1, 'C'), 'C');
  eq('划文字：哪怕图片选中项指着别人，也不受影响', idOf(st1, 'B'), 'B');
  eq('划文字：没传 id → 用存档里的 activeConfigId', idOf(st1, ''), 'A');

  eq('划文字：imageConfigId 指向不存在的 id 也不炸', idOf(st1, 'NOPE'), 'A');

  /* 图片：只有「勾了禁用外置 OCR + 有 imageConfigId + 那条的 imageRequest 非空」三件事齐了才改道 */
  const st2 = mk();
  st2.ocr = { imageConfigId: 'B' };
  eq('图片直传：改道到图片配置那条', (pickRequestConfig(st2, 'A', true) || {}).id, 'B');
  eq('图片直传：改道过去的正是那条模板', pickRequestConfig(st2, 'A', true).imageRequest, 'IMG_B');

  const st3 = mk();
  st3.ocr = { imageConfigId: 'C' }; // 丙的图片模板只有空白
  eq('图片直传：指着一条没填图片模板的 → 回退到顶栏那条',
    (pickRequestConfig(st3, 'A', true) || {}).id, 'A');

  const st4 = mk();
  st4.ocr = { imageConfigId: 'NOPE' };
  eq('图片直传：指着不存在的 id → 回退到顶栏那条',
    (pickRequestConfig(st4, 'A', true) || {}).id, 'A');

  const st5 = mk();
  eq('图片直传：老存档（压根没 imageConfigId）行为不变',
    (pickRequestConfig(st5, 'A', true) || {}).id, 'A');

  const st6 = mk();
  st6.ocr = { imageConfigId: 'B' };
  eq('图片直传：没勾禁用外置 OCR（hasImage=false）就不改道',
    (pickRequestConfig(st6, 'A', false) || {}).id, 'A');

  eq('没有存档时给 null', pickRequestConfig(null, 'A', true), null);
  eq('传进来的 id 是空的、存档 activeConfigId 也空 → 兜底第一条',
    (pickRequestConfig({ activeConfigId: '', configs: [{ id: 'Z', request: 'r' }] }, '', false) || {}).id, 'Z');

  /* ---- canTranslateImage：三处共用的唯一判据 ----
     设置页那份「图片配置」列表、面板顶栏图片模式下的下拉、pickRequestConfig 的入围条件。 */
  check('填了图片模板才算能翻图', canTranslateImage({ imageRequest: 'curl x' }) === true);
  check('只有空白也算没填（和设置页列表、pickRequestConfig 一个口径）',
    canTranslateImage({ imageRequest: '   \n\t ' }) === false);
  check('留空 / 没这个字段 / 传 null 都给 false',
    [canTranslateImage({ imageRequest: '' }), canTranslateImage({ request: 'r' }), canTranslateImage(null)]
      .join(',') === 'false,false,false');
  check('非字符串（老存档里手改坏的）不炸',
    canTranslateImage({ imageRequest: 123 }) === true && canTranslateImage({ imageRequest: null }) === false);

  /* content script 不能 import，content.js 里那份 imageCapable() 必须是同一句 ——
     这条钉的是「别只改一边」。**不比对源码字面量**（改个空格就误报），
     而是把 content.js 那个函数抠出来真跑一遍，和 canTranslateImage 逐例对答案。 */
  const contentSrc = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  const capSrc = /function imageCapable\(c\) \{[\s\S]*?\n  \}/.exec(contentSrc);
  const imageCapable = capSrc ? new Function('return (' + capSrc[0] + ')')() : null;
  check('能从 content.js 里抠出 imageCapable()', typeof imageCapable === 'function');

  const capSamples = [
    ['只有文字模板', { id: 'a', request: 'r' }],
    ['主请求有图片模板', { id: 'b', request: 'r', imageRequest: 'img' }],
    ['主请求的图片模板只有空白', { id: 'c', request: 'r', imageRequest: '  \n' }],
    ['图片模板在后备上', { id: 'd', request: 'r', fallbacks: [{ request: 'r2', imageRequest: 'img' }] }],
    ['那条后备被勾掉了', { id: 'e', request: 'r', fallbacks: [{ imageRequest: 'img', enabled: false }] }],
    ['两条后备，有图片模板那条没勾', {
      id: 'f', request: 'r',
      fallbacks: [{ imageRequest: '', enabled: true }, { imageRequest: 'img', enabled: false }]
    }],
    ['两条后备，有图片模板那条勾着', {
      id: 'g', request: 'r',
      fallbacks: [{ imageRequest: '', enabled: true }, { imageRequest: 'img', enabled: true }]
    }],
    ['主请求不勾、后备有图片模板', { id: 'h', request: 'r', mainEnabled: false, fallbacks: [{ imageRequest: 'img' }] }],
    /* 主请求有图片模板但被取消勾选、后备没有 —— 旧版 imageCapable 无条件把主请求算进
       「on」，会说能翻图；requestChain 里根本没有主请求，说不能。两边的「图片配置」
       列表跟着最后一次 storage 变化漂。这条样例就是钉这个口径差的。 */
    ['主请求有图片模板但被取消勾选、后备没有', { id: 'h2', request: 'r', imageRequest: 'img', mainEnabled: false, fallbacks: [{ request: 'r2' }] }],
    ['主请求有图片模板但不勾、一条后备都没勾（requestChain 退回第一条）', { id: 'h3', request: 'r', imageRequest: 'img', mainEnabled: false, fallbacks: [{ request: 'r2', enabled: false }] }],
    ['fallbacks 不是数组（手改坏的存档）', { id: 'i', request: 'r', fallbacks: null }],
    ['不是字符串的 imageRequest', { id: 'j', request: 'r', imageRequest: 123 }],
    ['整条都是 null', null]
  ];
  for (const [label, c] of capSamples) {
    eq('同形 · ' + label, imageCapable(c), canTranslateImage(c));
  }
  check('后台随 ready 发 img 标志，面板照着它过滤 —— 别退回「页面自己猜一份」',
    /img: canTranslateImage\(c\)/.test(readFileSync(new URL('../background.js', import.meta.url), 'utf8')));
}

section('15e. 后备请求：一个配置里挂几条请求，主请求挂了往下试');
{
  /* 形状：主请求还是配置顶层那几个字段（零迁移），后备躺在 config.fallbacks[] 里。
     「勾」是唯一的开关；一条都没勾时退回主请求（配置存在却什么都不发是个死状态）。 */
  const cfg = (extra = {}) => ({
    id: 'c1', name: '甲', adapter: '', request: '主', imageRequest: '', path: '', responseMode: 'auto',
    ...extra
  });
  // 后备**没有 name 字段** —— 名字由 allRequests 按位置现算（见下面那几条断言）
  const fb = (extra = {}) => ({
    id: 'f-' + Math.random().toString(36).slice(2, 6), enabled: true,
    adapter: '', request: '备', imageRequest: '', path: '', responseMode: 'auto', ...extra
  });

  const main = mainRequest(cfg());
  eq('主请求的字段从配置顶层包出来', main.request, '主');
  eq('主请求标着 main（状态行靠它决定要不要加「后备」前缀）', main.main, true);
  eq('老存档没有 mainEnabled → 主请求算启用的', main.enabled, true);
  eq('mainEnabled 显式 false 才算不勾', mainRequest(cfg({ mainEnabled: false })).enabled, false);

  eq('一条后备都没有时，链就是主请求一条', allRequests(cfg()).length, 1);
  eq('allRequests 按「主 + 后备」的顺序', allRequests(cfg({ fallbacks: [fb({ request: 'A' }), fb({ request: 'B' })] }))
    .map((r) => r.request).join(''), '主AB');
  eq('链只收勾上的', requestChain(cfg({ fallbacks: [fb({ request: 'A' }), fb({ request: 'B', enabled: false })] }))
    .map((r) => r.request).join(''), '主A');
  eq('主请求不勾就从第一条后备开始',
    requestChain(cfg({ mainEnabled: false, fallbacks: [fb({ request: 'A' })] })).map((r) => r.request).join(''), 'A');
  eq('全都不勾 → 退回主请求（不然这条配置什么都不发）',
    requestChain(cfg({ mainEnabled: false, fallbacks: [fb({ enabled: false })] })).map((r) => r.request).join(''), '主');
  eq('传 null 给空数组，别炸', requestChain(null).length, 0);

  /* 每一块自带类型 / 响应格式 / 提取路径 —— 「每条后备是完整的一条请求」。 */
  const mixed = requestChain(cfg({
    fallbacks: [fb({ adapter: 'bing', responseMode: 'text', path: 'a.b', request: '' })]
  }));
  eq('后备带着自己的适配器', mixed[1].adapter, 'bing');
  eq('后备带着自己的响应格式', mixed[1].responseMode, 'text');
  eq('后备带着自己的提取路径', mixed[1].path, 'a.b');
  eq('适配器型后备没有请求模板也照样入链', mixed.length, 2);

  /* 模板挑哪一段：一个**条目**两段模板（老规则，只是从 config 挪到了条目上） */
  eq('没图就用普通那段', requestTemplateFor({ request: 'T', imageRequest: 'I' }, {}), 'T');
  eq('有图优先用图片那段', requestTemplateFor({ request: 'T', imageRequest: 'I' }, { image: 'data:' }), 'I');
  eq('图片那段留空就回退普通那段', requestTemplateFor({ request: 'T', imageRequest: '  ' }, { image: 'data:' }), 'T');
  eq('条目是 null 给空串', requestTemplateFor(null), '');

  /* 归一化：老存档（只有顶层字段）读进来不许多出东西，新字段各就各位。
     走真正的 loadState（把 mock 的 storage 临时换成一份老存档），别绕开迁移那条路。 */
  const realGet = globalThis.chrome.storage.local.get;
  globalThis.chrome.storage.local.get = async () => ({
    state: {
      version: 8,
      configs: [
        { id: 'old', request: '主' },
        { id: 'new', request: '主', fallbacks: [{ request: '备' }] },
        { id: 'bad', request: '主', fallbacks: [{ request: '备', responseMode: '乱写' }] }
      ],
      settings: {},
      ocr: {}
    }
  });
  const loaded = await loadState();
  globalThis.chrome.storage.local.get = realGet;

  const oldCfg = loaded.configs.find((c) => c.id === 'old');
  eq('老存档读出来 fallbacks 是空数组', JSON.stringify(oldCfg.fallbacks), '[]');
  eq('老存档读出来 mainEnabled 是 true', oldCfg.mainEnabled, true);
  eq('老存档那条的链只有主请求一条', requestChain(oldCfg).length, 1);

  const newCfg = loaded.configs.find((c) => c.id === 'new');
  check('后备**不带** name 字段（名字按位置现算，不进存档）', !('name' in newCfg.fallbacks[0]),
    JSON.stringify(newCfg.fallbacks[0]));
  eq('名字由 allRequests 现算：第一条叫「后备 1」', allRequests(newCfg)[1].name, '后备 1');
  eq('名字跟着位置走（两条 → 后备 1 / 后备 2，主请求用自己的配置名）',
    allRequests(cfg({ name: '甲', fallbacks: [fb({ request: 'A' }), fb({ request: 'B' })] }))
      .map((r) => r.name).join('/'), '甲/后备 1/后备 2');
  eq('后备默认是勾上的', newCfg.fallbacks[0].enabled, true);
  eq('后备的响应格式非法值兜回 auto',
    loaded.configs.find((c) => c.id === 'bad').fallbacks[0].responseMode, 'auto');
  check('后备各自有 id（增删 / 折叠状态都按它认）', !!newCfg.fallbacks[0].id);

  /* 后台那两层循环：外层请求链、内层 model 候选 —— 两个 for 都在，且顺序是对的 */
  const bgSrc = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  check('外层按 requestChain 走', bgSrc.includes('requestChain(config)'));
  check('外层循环写在 model 循环外面',
    bgSrc.indexOf('for (let r = 0; r < runnable.length') < bgSrc.indexOf('for (let i = 0; i < attempts.length'));
  check('每换一条请求都重挑模板（图片那次才用得上图片模板）',
    /const requestText = requestTemplateFor\(item, msg\.context \|\| \{\}\)/.test(bgSrc));
  check('每条请求跑自己的适配器 / 路径 / 响应格式',
    bgSrc.includes('adapter: item.adapter') && bgSrc.includes('path: item.path') &&
    bgSrc.includes('responseMode: item.responseMode'));
  check('这条请求拿到译文就跳出外层（不再试后面的后备）',
    /for \(let i = 0; i < attempts\.length[\s\S]{0,4000}?if \(result && result\.text\) break;\s*\}\s*\n\s*\/\/[^\n]*\n\s*if \(result && result\.text\) break;/.test(bgSrc),
    '外层那个 break 或者它的注释没了');
  check('状态行只在后备那几条上带名字（主请求还是老样子「请求中…（model）」）',
    bgSrc.includes("const label = item.main ? '' : (item.name || '');") &&
    bgSrc.includes("const bits = [label, model].filter(Boolean).join(' · ');"));
  check('setState 不会写错：试每一轮都不写存档', !/chrome\.storage\.local\.set\(\{ state \}\)/.test(bgSrc.split('if (msg.type === \'translate\')')[1] || ''));
}

section('15f. 设置页的「图片配置」那条线也认后备');
{
  /* 设置页原来自己写 `c.imageRequest` 判「能不能翻图」—— 图片模板挂在**后备**上的配置
     在「图片配置」列表里会看不见，预览和「测试图片配置」也会摊错那一段。
     现在一律走链：判据用 store 的 canTranslateImage，取模板用 imageItem。 */
  const opt = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const ocr = readFileSync(new URL('../lib/ocr.js', import.meta.url), 'utf8');

  check('列表的入围判据直接用 canTranslateImage（没自己抄一份 c.imageRequest）',
    opt.includes('return state.configs.filter(canTranslateImage);'));
  check('canTranslateImage 真的 import 进来了',
    /import\s*\{[\s\S]*?\bcanTranslateImage\b[\s\S]*?\}\s*from\s*'\.\/lib\/store\.js'/.test(opt));
  check('找图片模板只有一个入口 imageItem（链里第一条填了图片模板的条目）',
    /function imageItem\(c\) \{[\s\S]{0,220}requestChain\(c\)\.find\(/.test(opt));
  check('列表副标题摊的是 imageItem 那条（不是主请求那段）',
    opt.includes('sub: it ? summarizeUrl(it.imageRequest,'));
  check('预览的直传分支摊的也是 imageItem，字段用 path',
    opt.includes('const it = imageItem(imageTestConfig());') &&
    opt.includes('return it ? { request: it.imageRequest, responsePath: it.path } : null;'));
  check('「测试图片配置」传的是**条目**（runImageTranslate 要 imageRequest / path）',
    opt.includes('await runImageTranslate({ config: item || target,'));
  check('测到的是后备那条时把它名字也报出来（不然不知道是谁成的）',
    opt.includes('const label = item && !item.main ? `${target.name} · ${item.name}` : target.name;'));

  /* runImageTranslate 认的是**条目**的 path。原来读 `c.responsePath` —— 配置上压根
     没这个字段（提取路径在顶层叫 path），所以那条一直是 undefined（等于没指定路径）。 */
  check('runImageTranslate 读条目的 path', ocr.includes('responsePath: c.path'));
  /* （注意 `responsePath` 这个名字在 OCR 供应商那边是另一个字段，是真字段 ——
     这里钉的只是「从配置 / 条目上读」的那种写法不许再出现。） */
  check('那个不存在的 c.responsePath 已经清干净（配置条目上只有 path）',
    !ocr.includes('responsePath: c.responsePath') && !/(^|[^a-z])c\.responsePath/.test(opt));

  /* 块头那个「主请求 / 后备 N」**是只读标签**，不是输入框 —— 这条是防回归。
     原来那儿是一条 `<input type="text" class="rb-name">`，被 options.css 里
     `input[type="text"] { width: 100% }`（权重 0,1,1 > 单类 0,1,0）撑满整行，
     把右边的 ↑↓×▾ 顶出块外、再被 `.req-block` 的 overflow:hidden 裁掉 ——
     kniph 实测「收不起、删不掉」就是这个。名字改成按位置现算之后那个 input 必须消失。 */
  check('块头是只读标签 .rb-tag（主请求 / 后备 N）', opt.includes('class="rb-tag"'));
  /* 只查**代码**里有没有 `.rb-name`（注释里留一段根因说明是允许的 —— 那段正是「别再把它加回来」
     的告诫）。所以先把注释扒掉再比。 */
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  check('块头里那条 `.rb-name` 输入框没再长回来（代码里 js 与 css 都不许有）',
    !stripComments(opt).includes('rb-name') && !stripComments(css).includes('rb-name'));
  check('collectEditor 不再往存档里写后备的 name',
    !/item\.name\s*=/.test(opt) && !opt.includes('name: node.querySelector'));

  /* 「类型」下拉（自定义请求 / 内置适配器）已删（kniph 2026-10-13）：内置适配器只有 Bing 一个、
     而且只有内置预设会用上它，用户自己加的配置全是自定义请求 —— 一个「只有一个非默认值的
     二选一」不值得占一行控件。类型改成**从数据上看**：块上 `data-adapter` 有值就是内置通道。 */
  check('块里没有「类型」下拉了（rb-kind / 会变的适配器下拉 / syncBlockMode 都清干净）',
    !opt.includes('rb-kind') && !opt.includes('syncBlockMode') &&
    !opt.includes('class="rb-adapter"') && !opt.includes('KIND_OPTIONS'));
  check('类型改成从数据上看：块上带 data-adapter，readBlock 从它取',
    opt.includes('data-adapter="${escapeHtml(item.adapter') &&
    /const adapter = node\.dataset\.adapter \|\| ''/.test(opt));
  check('内置通道那条只摊一行只读的 .rb-adapter-note（不再给下拉）',
    opt.includes('class="rb-adapter-note"') && opt.includes('adapterLabel('));

  /* 请求块默认**全收起**（含主请求，kniph 2026-10-13 定的）。 */
  check('折叠默认值是「收起」（没记过就是 false，不再有「主请求默认展开」那条特例）',
    /function foldOpen\(id\) \{\s*return blockFold\.get\(id\) === true;/.test(opt));
  /* 收起时块体是 display:none：点标签要先把那块摊开，不然字插到看不见的框里、还插在最前头。 */
  /* 标签现在长在**块里面**（配置栏 / OCR 栏同一套 bindChips）：插之前要把块摊开，
     不然收起的 <details> 里 selectionStart 恒为 0、focus() 是空操作。 */
  check('点标签会先把收着的块摊开（bindChips，两栏共用）',
    /function bindChips\(container\)/.test(opt) &&
      /block\.classList\.add\('open'\);\s*\n\s*blockFold\.set\(block\.dataset\.id, true\);/.test(opt) &&
      (opt.match(/bindChips\(els\.\w+\);/g) || []).length === 2);

  /* 测试结果的徽章：原来的「按顺序试 2 条」会被读成「2 条都会发」，而实际拿到译文就停。 */
  check('徽章说「链上共 N 条请求」，不再写「按顺序试 N 条」',
    /T\('opt_chain'/.test(opt) && /String\(chain\.length\)/.test(opt) && !/按顺序试 \$\{/.test(opt));
  check('成功徽章报清「第几条成的 / 后面几条没跑」',
    opt.includes('第 ${i + 1} 条拿到译文') && opt.includes('，后面 ${left} 条没跑'));
  check('一条都没成时也给个交代（不是只留一排失败块）', opt.includes('条都没拿到译文'));

  /* ---- 两段模板共用一套骨架（kniph 2026-10-14：「完全是两套布局结构，明明可以复用一套代码」）----
     原来是：一条 `.field` + `<label>` + 裸 textarea，另一条 `<details>` + `<summary>` + `.fold-body`，
     连带字号 / hint 间距 / 文本框最小高度都各写一份。现在只有 `templateFieldHtml` 一处渲染。 */
  check('两段模板由同一个函数渲染（定义 1 处 + 调用 2 处，图片那条带 ocr 开关）',
    /function templateFieldHtml\(\{ wrapAttrs/.test(opt) &&
      (opt.match(/templateFieldHtml\(\{/g) || []).length === 3 &&
      (opt.match(/\$\{ocr \? '' : templateFieldHtml\(\{/g) || []).length === 1);
  /* 骨架 = details > summary + .fold-body > （标签排 → 文本框 → 说明）。
     标签排 2026-10-14 从「浮在框上面」搬进 .fold-body（kniph：「变量是在请求模板内的…你就不能都统一到里面吗」），
     说明行多了个可选的 data-hint（「不再显示」的键），所以末尾那段不能用 `>` 死锚。 */
  check('两段模板的骨架一样（details > summary + .fold-body > 标签排 + textarea + .hint）',
    /<summary>\$\{escapeHtml\(title\)\}<\/summary>[\s\S]{0,240}class="fold-body"/.test(opt) &&
      /class="fold-body"[\s\S]{0,120}\$\{chips \? chipsHtml\(chips\) : ''\}[\s\S]{0,120}<textarea \$\{boxAttrs\}/.test(opt) &&
      /<textarea \$\{boxAttrs\}[\s\S]{0,220}<p class="hint"[\s\S]{0,90}>\$\{hint\}/.test(opt));
  /* 两段模板**一项都不差**：标签排和「不再显示」那段说明两处都有（图片那条原来两样都没有 ——
     kniph：「变量是在请求模板内的…你就不能都统一到里面吗」）。 */
  check('两段模板都带标签排、说明都能收（chips ×2 + img-tpl 那个键）',
    (opt.match(/chips: opts\.chips/g) || []).length === 2 &&
      /dismiss: 'img-tpl'/.test(opt) && /dismiss: ocr \? 'ocr-tpl' : 'cfg-tpl'/.test(opt));
  check('折叠样式只有一份（.tpl-fold），.img-tpl 只剩「这是图片那条」这个身份',
    /\.tpl-fold \.fold-body \{/.test(css) && /\.tpl-fold \.hint \{/.test(css) && !/\.img-tpl\s*\{/.test(css));
  check('两段文本框共用一条样式，最小高度也一样（原来一个 300 一个 150）',
    /\.rb-request,\s*\n\.rb-image-request,\s*\n#o-request \{[\s\S]{0,300}min-height: 300px/.test(css) &&
      !/\.rb-image-request \{ min-height/.test(css));

  /* ---- 折叠手势统一：**点块头**（整条标题栏）就折，角落那个 ▾ 只是指示器 ----
     kniph 2026-10-14 报的「有的地方点一下顶部收起，有的地方点一下角落的按钮」。 */
  check('点块头折叠，并且放过块头里的控件（勾选框 / ↑↓×）',
    /const head = e\.target\.closest\('\.rb-head'\);[\s\S]{0,120}if \(head && !e\.target\.closest\('\.rb-on, \.rb-mini'\)\)/.test(opt));
  check('▾ 不再是独立手势（它自己那条 toggle 分支已经删掉）',
    !/btn\.classList\.contains\('rb-fold'\)/.test(opt));
  check('块头 cursor: pointer + 文字不可选（拖选文字会顺手把块折了）',
    /\.rb-head \{[\s\S]{0,260}cursor: pointer;[\s\S]{0,80}user-select: none;/.test(css));
  check('▾ 不再带按钮的底 / hover（免得看着像个独立手势）',
    /\.rb-mini:hover:not\(:disabled\) \{/.test(css) && !/\.rb-mini:hover:not\(:disabled\),\s*\n\.rb-fold:hover/.test(css));
  check('往框里插标签前先把模板那层折块摊开（收起时 selectionStart 恒为 0）',
    /textarea\.closest\('details\.tpl-fold'\)[\s\S]{0,80}fold\.open = true/.test(opt));

  /* ---- 同样的推进也要覆盖到 OCR 栏（kniph 2026-10-14）----
     OCR 那栏只有一段模板，所以是「换骨架」：原来 `.field` + label + 裸 textarea，现在和配置栏
     一样是 `details.preview.tpl-fold`（折叠手势、字号、内边距、高度全共用一条 CSS）。 */
  const optHtml = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  /* OCR 栏的请求块是 JS 画的（renderOcrBlocks）—— 和配置栏同一个 blockHtml，
     只差 chips / ocr 两个参数。所以断言落在「HTML 里有容器 + JS 里有渲染函数」上。 */
  check('OCR 栏也是同一套请求块（HTML 里 #ocr-blocks 容器，JS 里 renderOcrBlocks 复用 blockHtml）',
    /<div id="ocr-blocks"><\/div>/.test(optHtml) &&
      /* 两栏都调同一个 `renderBlocksInto`，块 HTML 只有它一处在画（抄第二遍必然分叉） */
      /function renderBlocksInto\(host, owner, opts\) \{[\s\S]{0,200}blockHtml\(it, i, all\.length - 1, opts\)/.test(opt) &&
      /function renderOcrBlocks\(p\) \{\s*renderBlocksInto\(els\.ocrBlocks, p, \{ chips: OCR_CHIPS, ocr: true \}\);/.test(opt) &&
      /<button type="button" id="btn-ocr-add-fallback"/.test(optHtml));
  check('两栏都走同一个 renderBlocksInto（配置栏传 CHIPS，OCR 栏传 OCR_CHIPS + ocr）',
    /function renderBlocks\(cfg\) \{\s*renderBlocksInto\(els\.blocks, cfg, \{ chips: CHIPS \}\);/.test(opt) &&
      opt.includes('OCR_CHIPS') &&
      /* 别把绘制逻辑又搬回两栏各自里 */
      (opt.match(/blockHtml\(it, i, all\.length - 1/g) || []).length === 1);
  check('OCR 的条目没有「图片模板 / 响应格式」两项（用不到，别摆出来）',
    (opt.match(/\$\{ocr \? '' : templateFieldHtml\(\{/g) || []).length === 1 &&
      /mode-field rb-only-request"\$\{hideReq\}>/.test(opt) &&
      (opt.match(/\$\{ocr \? '' : `<div class="field mode-field/g) || []).length === 1);
  check('OCR 供应商也能加后备（#btn-ocr-add-fallback + normalizeOcrItem）',
    opt.includes('els.btnOcrAddFallback.addEventListener') &&
      opt.includes('normalizeOcrItem({ request: p.request })') &&
      /export function normalizeOcrItem\(f\)/.test(ocr));
  check('折块体里那排占位符标签有自己的间距（.tpl-fold .fold-body > .chips）',
    /\.tpl-fold \.fold-body > \.chips \{ margin-bottom/.test(css));
  check('直传模式的隐藏清单里有它（用后代选择器 —— 头部那组在 #ocr-head 里，是孙代，> 会落空）',
    /#ocr-editor\.is-imgcfg #ocr-blocks[,{]/.test(css) &&
      // 别再改回 > 直接子代：.editor-head / #o-hint / #o-note 都在 #ocr-head（孙代）里
      !/#ocr-editor\.is-imgcfg > (\.editor-head|#o-hint|#o-note)/.test(css));
  check('OCR 的测试结果也走同一个外壳（resultBlockHtml）',
    /els\.ocrTestResult\.innerHTML = resultBlockHtml\(\{/.test(opt));

  /* ---- 三处左栏**同一套行**（kniph 2026-10-14：「把它们统一成同样的操作逻辑，尽量复用代码」）----
     原来 OCR 供应商那份是自己拼的裸 <button class="cfg-item">：没有手柄 / ↑↓ 那两列，
     和另外两处的行宽不一致（同一个栏里切模式都能看出列表"跳一下"）。 */
  check('三处左栏都走 sortableRow（定义 1 处 + 调用 3 处：配置 / OCR 供应商 / 图片配置）',
    (opt.match(/sortableRow\(\{/g) || []).length === 4);
  /* 「连排序的用处也统一」（kniph 2026-10-14 在「三个部分都要复用同一套逻辑」上挑的那一条）：
     三处一律可拖 / 可上下移 ⇒ `canSort` 那个分支和它对齐用的 `.cfg-slot` 空位**整块删掉** ——
     留着就是「同一套逻辑里还藏着一个特例」。 */
  check('三处都能排：canSort 分支和它那个同宽空位（.cfg-slot）都清掉了',
    !opt.includes('canSort') && !opt.includes('cfg-slot') && !/\.cfg-slot/.test(css));
  check('OCR 供应商那栏也有自己的排序入口（moveOcrProvider + bindSortDrag）',
    /function moveOcrProvider\(id, to\)/.test(opt) &&
      /bindSortDrag\(els\.ocrList, moveOcrProvider\)/.test(opt) &&
      /onMove: moveOcrProvider/.test(opt));
  check('↑↓ 那两枚按钮有固定宽度（三类行才对得齐）',
    /\.cfg-mv \{[\s\S]{0,160}width: 39px/.test(css));
  /* 三处共用一套行 ⇒ CSS 里**不许再按 id 给某一处开特例**。以前那两条补丁
     （OCR 列表没有 .cfg-row 时的宽度 / 间距）统一之后一条是死的、另一条给条目加了 3px
     下外边距 —— 行高因此比另外两处高 3px（63 vs 60），肉眼就是「三个列表不一样高」。 */
  check('CSS 里没有按 id 给左栏行开特例（#ocr-list .cfg-item / .list-body > .cfg-item 都删掉）',
    !stripComments(css).includes('#ocr-list .cfg-item') &&
      !stripComments(css).includes('.list-body > .cfg-item'));
  /* 那句「照着内置那条改…」从 OCR 栏的新建预填里删掉之后（2026-10-14 上半轮），
     kniph 又要它回到**配置栏**（那才是「照着内置那条改」的地方），并且它顺手把两栏的
     上三行凑成一样高 —— 详见下面「两栏上三行同构」。所以判据是：
     ① 这句话在 HTML 里、挂在 data-hint 上（能「不再显示」）；② JS 里不再往备注里预填它。 */
  check('「照着内置那条改…」挪到配置栏当一句静态说明（不再预填进新建那条的备注）',
    /hint: 'cfg-intro',[\s\S]{0,140}照着内置那条改/.test(opt) &&
      !/normalizeOcrProvider\(\{[\s\S]{0,400}照着内置那条改/.test(opt));

  /* ---- 两栏上三行同构：一句说明 → 名称 → 一句说明 → 请求块 ----
     kniph 2026-10-14 的「强迫症」：配置栏原来少上面那一句，请求块比 OCR 栏高 76px
     （140 vs 216），切页签时上下跳。三行必须**同款**（都 .hint.wide），否则又差 19px。 */
  /* 头部**只能是同一个函数画出来的**（kniph 2026-10-14：「你完全可以把代码进行一个
     复用啊」）—— 定义 1 处 + 调用 2 处，HTML 里两栏各留一个空容器。手抄两份的话，
     「配置栏多加一句话 / OCR 栏给备注留 min-height」这种一边一套的补丁就长出来了。 */
  check('两栏头部由同一个函数画（定义 1 处 + 调用 2 处，HTML 里只有两个空容器）',
    (opt.match(/editorHeadHtml\(\{/g) || []).length === 3 &&
      /<div id="cfg-head"><\/div>/.test(optHtml) &&
      /<div id="ocr-head"><\/div>/.test(optHtml) &&
      !stripComments(optHtml).includes('editor-head') &&
      !stripComments(optHtml).includes('data-hint="cfg-intro"'));
  check('头部那几个输入框是画完才取的（按 id 直接取会让 check-dom 报「HTML 里没有」）',
    /els\.name = els\.cfgHead\.querySelector\('#f-name'\)/.test(opt) &&
      /els\.oName = els\.ocrHead\.querySelector\('#o-name'\)/.test(opt) &&
      /els\.oNote = els\.ocrHead\.querySelector\('#o-note'\)/.test(opt));
  /* ⚠️ 靠「文字自然高度」凑对齐是不行的：说明**能被用户收掉**（.hint-off = display:none），
     备注**时有时无**（自建那条为空）—— 一收一空，两栏的行数就不对称了（kniph 一点
     「不再显示」就不齐，截图回来问「改了没」）。所以两处说明各包一个**固定占位的槽**。 */
  check('四段说明各待在一个**定死高度**的槽里（height + 裁剪，不是 min-height）',
    (opt.match(/class="hint-slot"/g) || []).length === 2 &&
      /\.hint-slot \{[\s\S]{0,240}height: 39px;[\s\S]{0,60}overflow: hidden;[\s\S]{0,20}\}/.test(css) &&
      /\.hint-slot > \.hint \{[\s\S]{0,240}margin-bottom: 0;[\s\S]{0,200}-webkit-line-clamp: 1/.test(css));
  check('槽里的说明被收掉也不塌（槽自己撑高，不靠文字）',
    !/#o-note \{[^}]*min-height/.test(css));
  check('OCR 栏的备注（#o-note）跟在名称后面那一槽，不在整栏最底下',
    /bottom: { id: 'o-note' }/.test(opt));
  check('两栏页脚各有一个「已保存」，setSaveStatus 一起写（两栏共用一个存档）',
    /querySelectorAll\('\.save-status'\)/.test(opt) &&
      (optHtml.match(/class="save-status"/g) || []).length === 2);
  /* 三处都能排了（kniph 2026-10-14 定的「连排序的用处也统一」），所以那句
     「可拖动排序」在两种模式下都挂着 —— 不再跟着模式 hidden。 */
  check('左栏那句「可拖动排序」两种模式都挂着（三处都能排了）',
    /<span class="list-tip" id="ocr-list-tip"[^>]*>可拖动排序<\/span>/.test(optHtml) &&
      !/ocrListTip/.test(opt));
  /* 名称那一行也是同一个模板出来的（`for="${nameId}"`）—— 两栏只有 id 不同。
     原来在 HTML 里各写一份，改一处漏一处就是「两个栏长得不一样」的开端。 */
  /* 抽 key 之后 label 里是 ${T('opt_label_name', '名称')}，判据跟着改成「两栏都用同一个
     模板出来的 label，且模板里走的是查表」—— 断言意图不变（不许手抄两份）。 */
  check('两栏的「名称」label 是同一个模板出来的（只有 id 不同）',
    /<label for="\$\{nameId\}">\$\{T\('opt_label_name'/.test(opt) &&
      !stripComments(optHtml).includes('<label for="f-name">'));
  /* 「供应商」这个说法只在 OCR 栏有，配置栏叫「配置」 —— 同一个东西两个名字
     （kniph 2026-10-14：「『供应商』也改成『配置』」）。判据：HTML 里再没有这个词。 */
  check('OCR 栏不再说「供应商」，统一叫「配置」',
    !stripComments(optHtml).includes('供应商') &&
      // 抽 key 后标签上多了 data-i18n，判据放宽成「标签文字还是「配置」那一族」
      /id="ocr-list-title"[^>]*>OCR 配置</.test(optHtml) &&
      /id="btn-ocr-new"[^>]*>＋ 新建配置</.test(optHtml) &&
      /id="btn-ocr-delete"[^>]*>删除配置</.test(optHtml) &&
      opt.includes("'OCR 配置'"));

  /* ---- 说明文字的「不再显示」（kniph 2026-10-14：「这种注释太多了」）---- */
  /* 头部那几句现在由 `editorHeadHtml()` 拼出来（两栏共用），id 写在调用参数里
     （`hint: 'cfg-intro'`）—— 所以静态收集要把这两处合起来看。 */
  const hintIds = [
    ...[...optHtml.matchAll(/data-hint="([^"]+)"/g)].map((m) => m[1]),
    ...[...opt.matchAll(/\bhint:\s*'([a-z-]+)'/g)].map((m) => m[1])
  ];
  check('每条静态说明都挂了 data-hint，且 id 不重复（id 要稳定：它进存档）',
    hintIds.length >= 15 && new Set(hintIds).size === hintIds.length, `${hintIds.length} 条`);
  check('按钮由 applyHintHides 统一补（HTML 里不再手写「不再显示」按钮）',
    !optHtml.includes('id="o-hint-hide"') && /function applyHintHides\(\)/.test(opt) &&
      opt.includes("b.textContent = T('opt_hint_dismiss', '不再显示')"));
  check('收起用 .hint-off 类，不用 hidden 属性（有几条的 hidden 归模式逻辑管，一个属性不能两个主人）',
    /\.hint-off \{ display: none !important; \}/.test(css) &&
      /classList\.toggle\('hint-off'/.test(opt) && /classList\.add\('hint-off'\)/.test(opt));
  check('点过就落盘（settings.hiddenHints）', /hiddenHints = \[\.\.\.new Set\(\[\.\.\.\(state\.settings\.hiddenHints/.test(opt));

  /* 字段顺序：**两段模板挨着、两个「响应」字段挨着收尾**。
     响应格式原来夹在两段模板中间 —— 读起来像「只管上面那一段」，而它管的是整条请求回来的东西
     （两段模板共用，见 `readResponseBody` 收的 `item.responseMode` / `item.path`）。kniph 2026-10-14 报的。 */
  {
    const iReq = opt.indexOf(`boxAttrs: 'class="rb-request"'`);
    const iImg = opt.indexOf(`boxAttrs: 'class="rb-image-request"'`);
    const iMode = opt.indexOf('class="field mode-field rb-only-request"');
    const iPath = opt.indexOf('响应提取路径（留空自动识别）');
    check('块里字段顺序：请求模板 → 图片模板 → 响应格式 → 提取路径（响应那两项挨在一起）',
      iReq > 0 && iReq < iImg && iImg < iMode && iMode < iPath,
      JSON.stringify({ iReq, iImg, iMode, iPath }));
  }
}

section('16. 剪切板图片：类型识别 / data URL / base64');
{
  check('image/* 才算图片',
    isImageMime('image/png') && !isImageMime('text/plain') && !isImageMime(''));

  eq('从类型列表里挑出第一张图', pickImageMime(['text/html', 'image/png', 'image/jpeg']), 'image/png');
  eq('一个图都没有时给空串', pickImageMime(['text/plain', 'text/html']), '');
  eq('没有类型列表也不炸', [pickImageMime(null), pickImageMime(undefined)], ['', '']);

  const bytes = (...a) => new Uint8Array(a);
  eq('PNG 魔数', sniffImageMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  eq('JPEG 魔数', sniffImageMime(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  eq('GIF 魔数', sniffImageMime(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), 'image/gif');
  eq('BMP 魔数', sniffImageMime(bytes(0x42, 0x4d, 0x00, 0x00)), 'image/bmp');
  eq('WEBP 魔数',
    sniffImageMime(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50)), 'image/webp');
  eq('认不出来给空串，不瞎猜', sniffImageMime(bytes(1, 2, 3, 4)), '');
  eq('空数组也不炸', sniffImageMime(new Uint8Array(0)), '');

  /* 这几条是给「Windows 截图工具丢出来的 type 是空串」准备的：
     直接读 blob.type 会拼出 data:;base64,...，接口那边直接拒 */
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
  eq('给了类型就用给的', toDataUrl(png, 'image/jpeg').startsWith('data:image/jpeg;base64,'), true);
  eq('类型是空串时按魔数猜', toDataUrl(png, '').startsWith('data:image/png;base64,'), true);
  eq('类型填了非图片时也按魔数猜', toDataUrl(png, 'text/plain').startsWith('data:image/png;base64,'), true);
  eq('实在猜不出来兜底 png', toDataUrl(bytes(1, 2, 3)).startsWith('data:image/png;base64,'), true);

  /* 分块 base64：几十万字节一次性 apply 会把调用栈撑爆（RangeError） */
  const big = new Uint8Array(300000);
  for (let i = 0; i < big.length; i += 1) big[i] = i % 251;
  eq('大图 base64 的结果和 Buffer 一致', bytesToBase64(big), Buffer.from(big).toString('base64'));
  eq('空数组给空串', bytesToBase64(new Uint8Array(0)), '');

  eq('「没有图片」那句话在库里定好了', NO_IMAGE_MESSAGE, '剪切板里没有图片');
}

section('17. 模板转义：占位符落在几层引号里，就逐层转义');
{
  /* 这条是真实踩出来的：模板写成 curl 的常态 `-d '{…JSON…}'`（外层 shell 单引号、
     内层 JSON 字符串），占位符两侧既不是 " 也不是 ' —— 老规则按「两侧引号」判断，
     于是当裸插；OCR 出来的英文里一个撇号就把外层单引号提前闭合，
     请求体从那儿被截断，服务端报 JSON parse 的 end-of-input。 */
  const vars = (text) => ({ text, target: '简体中文' });
  // 真实截图里 OCR 出来的英文：撇号 + 双引号 + 换行，一个不落
  const EN = 'Pixeldrain\'s free tier: "6.00 GB per day"\nours is already 9.96 GB.';

  /* ---- 一层：JSON 字符串里 ---- */
  const one = renderTemplate('{"content":"{{text}}"}', vars(EN)).text;
  eq('一层 JSON：值原样还原（JSON 里撇号不用转义）', JSON.parse(one).content, EN);

  /* ---- 两层：shell 单引号里嵌 JSON ---- */
  const tpl = "curl -d '{\"content\":\"{{text}}\"}' https://x/y";
  const two = renderTemplate(tpl, vars(EN)).text;
  check("两层：撇号按 shell 规则转成 '\\''（否则会把外层单引号提前闭合）",
    two.includes("'\\''"), two);
  eq('两层：body 依旧是合法 JSON，文本一字不差地还原',
    JSON.parse(parseRequest(two).body).content, EN);

  /* ---- 裸插：不在任何引号里，就一个字都不动 ---- */
  eq('裸插：不转义',
    renderTemplate('curl -d {{text}} https://x/y', vars('a b')).text,
    'curl -d a b https://x/y');

  /* ---- 只有一层 shell 单引号 ---- */
  check("一层 shell：撇号按 shell 规则转义",
    renderTemplate("curl -H 'X: {{text}}' https://x/y", vars("it's")).text.includes("it'\\''s"),
    'it\\\'s');

  /* ---- JSON 字符串里的撇号（don't）不该被当成 shell 引号 ---- */
  check('JSON 字符串里的撇号不当 shell 引号：照旧按 JSON 转义',
    renderTemplate("curl -d '{\"a\":\"don't {{text}}\"}' https://x/y", vars('say "hi"')).text
      .includes('say \\"hi\\"'),
    'say "hi"');

  /* ---- tokenize 得认得 '\\'' 这种拼接（复合转义的产物） ---- */
  eq("tokenize 认得转义的单引号（'\\'' 拼回一个字面撇号）",
    tokenize("a 'b'\\''c' d").join('|'), "a|b'c|d");

  /* ---- 整条链路走一遍：渲染 → shell 解析 → JSON.parse ---- */
  const chain = parseRequest(renderTemplate(tpl, vars(EN)).text).body;
  check('整条链路：渲染 → shell 解析 → JSON，全程没有裸换行漏出去',
    !/[\r\n\t]/.test(chain) && JSON.parse(chain).content === EN, chain.slice(0, 140));

  // 这条模板在设置页的「渲染预览」里不该报任何警
  eq('同一条模板的预览一条警告都没有', previewRequest(tpl, vars(EN)).notes.length, 0);

  /* ---- 真写坏了的时候，提示要指出大概位置（只说「不合法」没法下手） ---- */
  const broken = previewRequest("curl -d '{\"content\": \"\"\"\"}\"' https://x/y", {});
  check('坏 JSON 的提示里带「大概是这里」',
    broken.notes.some((n) => /大概是这里/.test(n)), broken.notes.join(' / '));
}

/* ------------------------------------------------------------------ */

section('18. 目标语言：下拉挑语言，接口要的代码自动转');
{
  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../options.js', import.meta.url), 'utf8');

  /* 早先是 <input list="…"> + datalist —— 输入框里已经有值时，
     点开只列出「匹配当前文字」的那几项（默认「简体中文」就只剩一项），
     看着像「下拉里没几个选项」。改成正经的 <select>。 */
  const sel = (html.match(/<select[^>]*id="s-lang"[^>]*>/) || [])[0];
  check('目标语言是个下拉框，不是输入框', !!sel, sel);
  check('页面上不再拿 datalist 糊',
    !html.includes('s-lang-presets') && !html.includes('<datalist'), 'datalist');

  const selStart = sel ? html.indexOf(sel) : -1;
  const selBody = selStart < 0 ? '' : html.slice(selStart, html.indexOf('</select>', selStart));
  check('HTML 里那个下拉是空容器（不手抄第二份候选）',
    !!sel && !/<option/i.test(selBody), selBody);

  const other = (html.match(/<input[^>]*id="s-lang-other"[^>]*>/) || [])[0];
  check('旁边有个「自己填」的输入框', !!other, other);
  check('它默认是藏着的（挑了「其他」才露出来）', !!other && /\bhidden\b/.test(other), other);

  check('脚本把 TARGET_PRESETS 填进那个下拉',
    js.includes('TARGET_PRESETS') && js.includes('els.langSelect.appendChild'));
  check('「其他」那一项有哨兵 value', /LANG_OTHER\s*=\s*'__other__'/.test(js));
  check('存档里不在预设里的值会还原成「其他」+ 输入框',
    js.includes('function renderTargetLang') && js.includes('TARGET_PRESETS.includes(cur)'));

  const values = TARGET_PRESETS;
  check('列表不是空的', values.length > 0, values.length);
  check('够挑（至少 20 个）', values.length >= 20, values.length);
  check('有「名字」那种：简体中文', values.includes('简体中文'), values.slice(0, 6).join(','));
  check('常用语言都在：英语 / 日语', values.includes('英语') && values.includes('日语'));
  check('映射不了的地区变体才留代码：EN-GB / PT-BR',
    values.includes('EN-GB') && values.includes('PT-BR'));
  check('没有空值', values.every((v) => v.trim() !== ''));
  eq('没有重复项', new Set(values).size, values.length);

  /* 列表和映射表必须同步 —— 挑得到却转不出代码，等于骗人 */
  const unmapped = values.filter((v) => !targetCodeOf(v, ''));
  check('候选里每个都能映射出代码', unmapped.length === 0, unmapped.join(','));
  eq('以前挑「荷兰语」会静默回退成 ZH-HANS，现在给 NL', targetCodeOf('荷兰语'), 'NL');
  eq('挪威语给的是 DeepL 认的 NB（不是通用 ISO 的 NO）', targetCodeOf('挪威语'), 'NB');

  /* 划词面板顶栏也有一个一样的选择框（想临时换语言不用回设置页）。
     content script import 不了模块，候选只能由后台随 ready 捎过去 ——
     这两件事缺哪一件，那个下拉都是空的或者错的。 */
  const bgJs = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const panelJs = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  /* 面板骨架 2026-11-01 搬去 lib/panel-core.js（网页与设置页预览共用同一份），
     所以「下拉存在」要在那份里找、「谁在用它」仍看 content.js。 */
  const coreJs = readFileSync(new URL('../lib/panel-core.js', import.meta.url), 'utf8');
  check('后台把语言候选随 ready 一起发给页面',
    /import\s*\{[^}]*\bTARGET_PRESETS\b[^}]*\}\s*from\s*'\.\/lib\/template\.js'/.test(bgJs) &&
      /targetLangs:\s*TARGET_PRESETS/.test(bgJs));
  check('面板顶栏有一个目标语言下拉',
    /class='rt-lang'/.test(coreJs) && panelJs.includes("querySelector('.rt-lang')"));
  check('面板的候选来自后台，没在 content.js / panel-core.js 里手抄一份',
    !panelJs.includes('TARGET_PRESETS') && !coreJs.includes('TARGET_PRESETS'));
  check('面板换语言后会把各配置的旧译文作废（那是上一门语言的）',
    /langSelect\.addEventListener\('change'/.test(panelJs) &&
      /resultCache\.clear\(\)/.test(panelJs));
  /* 流式输出不自动跟随滚动：有些模型吐字快，视口被一路拉着往下跑就没法读了。
     文本是往后接的，视口原地不动就能从头读（要跟尾巴自己拖滚动条）。
     **判据要精确**：要禁的是「跟着尾巴跑」那种赋值（= scrollHeight），
     不是一切 scrollTop 写入 —— 重画后「保持原位」是正当用途
     （kniph 2026-10-17：多条对比时一重试就被弹回顶部）。 */
  check('流式输出不把滚动条带着跑（没有「跟到尾部」的赋值）',
    !/outBox\.scrollTop\s*=\s*[^=]*scrollHeight/.test(panelJs));
  check('重画之后会把滚动位置还回去（多条对比时不被弹回顶部）',
    /const keepTop = outBox\.scrollTop/.test(panelJs) &&
      /outBox\.scrollTop = keepTop/.test(panelJs));

  /* 挑了语言名之后：{{target}} 原样喂聊天模型，{{targetCode}} 喂只认代码的接口 */
  const picked = buildVars({ settings: { targetLang: '英语' }, vars: [] }, 'Hello');
  eq('{{target}} 原样是「英语」', picked.target, '英语');
  eq('{{targetCode}} 自动是 EN', picked.targetCode, 'EN');
  const codeLiteral = buildVars({ settings: { targetLang: 'ZH-HANS' }, vars: [] }, 'Hello');
  eq('直接填代码也认（原样大写）', codeLiteral.targetCode, 'ZH-HANS');

  /* DeepL 那条预设必须靠映射，不能把语言写死在模板里 */
  const deeplCfg = DEFAULT_CONFIGS.find((c) => c.id === 'builtin-deepl');
  check('DeepL 预设用的是 {{targetCode}}',
    /\{\{\s*targetCode\s*\}\}/.test(deeplCfg.request), deeplCfg.request.slice(0, 70));
  check('没有把语言写死在 target_lang 里',
    !/"target_lang":\s*"[A-Z][A-Z-]*"/.test(deeplCfg.request));
  /* 换成日语时，DeepL 拿到的应该是 JA 而不是「日语」 */
  const jp = previewRequest(deeplCfg.request, buildVars(
    { settings: { targetLang: '日语' }, vars: [{ name: 'apiKey', value: 'k:fx' }] }, 'Hello'
  ));
  eq('设置成日语后，DeepL 收到的是 JA', JSON.parse(jp.request.body).target_lang, 'JA');
  eq('DeepL 那条一次警告都不该有', jp.notes.length, 0);

  /* ---- 请求文本里自带的语言代码表：#@lang ---- */
  const langVars = { target: '简体中文', targetCode: 'ZH-HANS', text: 'hi' };
  const rl = (tpl) => renderTemplate(tpl, langVars).text;

  eq('配置里声明了 zh 就用它的',
    rl('#@lang\n# 简体中文 = zh\ncurl {{targetCode}}'), 'curl zh');
  eq('写在尾部也一样（请求在前、词表在后）',
    rl('curl {{targetCode}}\n\n#@lang\n# 简体中文 = zh'), 'curl zh\n');
  eq('键写代码也认（ZH-HANS）',
    rl('#@lang\n# ZH-HANS = zh-cn\ncurl {{targetCode}}'), 'curl zh-cn');
  eq('大小写不挑（zh-hans 也命中）',
    rl('#@lang\n# zh-hans = zh-cn\ncurl {{targetCode}}'), 'curl zh-cn');
  /* 键写成语言名时，顶栏手打别名也要认 —— 不然会悄悄落回内置表，
     而百度那类接口会直接报「译文语言方向不支持」 */
  eq('键是语言名时，顶栏打别名「日文」也命中表里的「日语」',
    renderTemplate('#@lang\n# 日语 = jp\ncurl {{targetCode}}', { target: '日文', targetCode: 'JA' }).text,
    'curl jp');
  eq('认不出来的名字不会乱命中（照旧回落内置）',
    rl('#@lang\n# 顺手记 = 别当真\ncurl {{targetCode}}'), 'curl ZH-HANS');
  eq('表里没这个语言就落回内置默认（所以不用抄全）',
    rl('#@lang\n# 英语 = en\ncurl {{targetCode}}'), 'curl ZH-HANS');
  eq('空行就结束这张表，后面的 # 行不算表里的',
    rl('#@lang\n# 简体中文 = zh\n\n# 顺手记 = 别当真\ncurl {{targetCode}}'),
    '\n# 顺手记 = 别当真\ncurl zh');
  eq('没写 #@lang 的配置一个字都不变（老配置零改动）',
    rl('curl {{targetCode}}'), 'curl ZH-HANS');
  check('整块连同 #@lang 那行一起被吃掉，不进渲染结果',
    !/#@lang/.test(rl('#@lang\n# 简体中文 = zh\ncurl {{targetCode}}')));

  /* 原始 HTTP 报文风格把「空行之后的全部」当请求体（request-parser.js），
     所以尾巴上的声明块必须**在渲染时就吃掉**，不能留给解析器 */
  const rawTpl =
    'POST https://x.test/t\nContent-Type: application/json\n\n{"a":"{{targetCode}}"}\n\n#@lang\n# 简体中文 = zh';
  const rawRendered = rl(rawTpl);
  check('原始 HTTP 报文风格下，末尾那段 #@lang 被整块吃掉（不然会被吞进请求体）',
    !/#@lang/.test(rawRendered) && rawRendered.trimEnd().endsWith('{"a":"zh"}'),
    JSON.stringify(rawRendered));

  /* 内置表兼作兜底：DeepL 那段示范只列了几行，没列到的语言照样能翻 */
  const ko = previewRequest(deeplCfg.request, buildVars(
    { settings: { targetLang: '韩语' }, vars: [{ name: 'apiKey', value: 'k:fx' }] }, 'Hello'
  ));
  eq('示范表没列到的语言（韩语）落回内置兜底，还是 KO',
    JSON.parse(ko.request.body).target_lang, 'KO');
  check('DeepL 预设自己带了一张 #@lang 表示范（用户照着改就行）',
    /#@lang/.test(deeplCfg.request) && /#[ \t]*简体中文[ \t]*=[ \t]*ZH-HANS/.test(deeplCfg.request));
}

/* ------------------------------------------------------------------ */

section('19. 导出 / 导入：换台设备能把配置原样搬过去');
{
  /* 导的是整份存档（配置 + 顺序 + 变量 + 设置 + OCR），导入是整体替换。
     换设备就靠这条路，所以往返一次必须一模一样 —— 顺序也得原样。 */
  const state = {
    version: 5,
    configs: [
      { id: 'cfg-b', name: '第二条', note: '', adapter: '', request: 'curl https://b', imageRequest: '', path: '', responseMode: 'auto' },
      { id: 'cfg-a', name: '第一条', note: '说明', request: 'POST https://a\nx-k: {{apiKey}}\n\n{}', responseMode: 'json' }
    ],
    activeConfigId: 'cfg-a',
    vars: [{ name: 'apiKey', value: 'sk-秘密' }],
    settings: { ...DEFAULT_SETTINGS, triggerStyle: 'globe', theme: 'light', panelWidth: 700 },
    ocr: { activeId: 'builtin-siliconflow', providers: [{ id: 'builtin-siliconflow', apiKey: 'sk-ocr' }] }
  };

  const text = exportState(state);
  const parsed = JSON.parse(text);
  eq('导出的是合法 JSON', typeof parsed, 'object');
  eq('带一个认得出的 kind', parsed.kind, 'request-translate');
  eq('带导出时间（人类可读）', typeof parsed.exportedAt, 'string');
  check('导出时间长得像 ISO', /^\d{4}-\d{2}-\d{2}T/.test(parsed.exportedAt), parsed.exportedAt);
  eq('四条主线数据一样不少',
    ['configs', 'vars', 'settings', 'ocr'].filter((k) => k in parsed), ['configs', 'vars', 'settings', 'ocr']);
  check('缩进过的（人要看/手改得动）', text.includes('\n  "configs"'));
  // 明文 key 会被带走 —— 设置页写了这句提醒，这里钉住这个事实（没打算「贴心」地删掉）
  check('API Key 照原样在文件里（文档明说了）', text.includes('sk-秘密') && text.includes('sk-ocr'));

  const back = importState(text);
  eq('导入回来的配置条数一致', back.configs.length, 2);
  eq('顺序也是导出的那个顺序', back.configs.map((c) => c.id), ['cfg-b', 'cfg-a']);
  eq('配置内容原样', back.configs[1].request, state.configs[1].request);
  eq('变量里的 key 也回来了', back.vars[0].value, 'sk-秘密');
  eq('设置跟着回来了', back.settings.panelWidth, 700);
  eq('主题这种「看起来像界面状态」的也一起走', back.settings.theme, 'light');
  eq('导出时间单独拎出来（给确认框用）', back.exportedAt, parsed.exportedAt);
  check('OCR 供应商补齐了内置条目',
    back.ocr.providers.some((p) => p.id === 'builtin-siliconflow'));

  /* 二次导出：不能让导进来的旧 exportedAt 顶掉新的（那会让「导出于」一直是老日期） */
  const second = JSON.parse(exportState({ ...state, exportedAt: '2000-01-01T00:00:00.000Z' }));
  check('再次导出会写成当下的时间，不吃上次那个', second.exportedAt !== '2000-01-01T00:00:00.000Z');

  /* 缺字段的老文件 / 手写的文件：该补的补，该拒的拒 */
  const minimal = importState(JSON.stringify({ configs: [{ id: 'x', name: 'X', request: 'GET https://x' }] }));
  eq('只有 configs 也能导', minimal.configs.length, 1);
  eq('缺席的字段按默认值补（imageRequest）', minimal.configs[0].imageRequest, '');
  eq('缺席的设置按默认值补', minimal.settings.fontSize, DEFAULT_SETTINGS.fontSize);
  eq('没有 exportedAt 就是空串', minimal.exportedAt, '');

  const boom = (name, input, re) => {
    let msg = '';
    try { importState(input); } catch (e) { msg = String(e && e.message); }
    check(`拦下：${name}`, !!msg && (!re || re.test(msg)), msg || '(没报错)');
  };
  boom('不是 JSON', '{ 这不是 json');
  boom('JSON 但不是对象', '"hello"');
  boom('没有 configs', JSON.stringify({ settings: {} }), /configs/);
  boom('configs 是空数组', JSON.stringify({ configs: [] }), /configs/);
  boom('别的软件导出的文件（kind 对不上）',
    JSON.stringify({ kind: 'some-other-app', configs: [{ id: 'a' }] }), /kind/);

  /* 老版本（1.0.0 起其实就带 kind）和手写文件可能没有 kind —— 不能因为这个就拒 */
  const noKind = importState(JSON.stringify({ configs: [{ id: 'a', name: 'A' }] }));
  eq('没有 kind 也放行（手写的文件）', noKind.configs.length, 1);
}

section('20. 「临时直连」已彻底移除：权限 / 模块 / 调用点都不留');
{
  /* 功能是整块拿掉的（kniph 要求），这里钉住「别哪天又被捡回来」。
     光删文件不够 —— 调用点留着会直接抛 "does not provide an export"。 */
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const manifest = JSON.parse(read('../manifest.json'));

  check('manifest 里不再要 proxy 权限',
    !(manifest.permissions || []).includes('proxy'), (manifest.permissions || []).join(','));

  const srcFiles = [
    'background.js', 'content.js', 'options.js', 'popup.js', 'offscreen.js',
    'lib/engine.js', 'lib/store.js', 'lib/adapters.js', 'lib/ocr.js'
  ];
  const allSrc = srcFiles.map((f) => read('../' + f)).join('\n');
  check('源码里没有任何 chrome.proxy 调用', !/chrome\.proxy/.test(allSrc));
  check('源码里没有人再引用 lib/network.js', !/network\.js/.test(allSrc));

  let gone = false;
  try { read('../lib/network.js'); } catch { gone = true; }
  check('lib/network.js 这个文件已经不在', gone);

  /* 三个只服务直连的辅助函数也一并删了 */
  check('wantDirect 不见了', !/export function wantDirect/.test(read('../lib/store.js')));
  check('adapterDirectHosts 不见了', !/export function adapterDirectHosts/.test(read('../lib/adapters.js')));
  check('endpointHost 不见了', !/export function endpointHost/.test(read('../lib/ocr.js')));

  /* 设置页上那三个开关也得消失（配置 / 供应商 / 网络各一个） */
  const html = read('../options.html');
  for (const id of ['f-direct', 'o-direct', 's-direct']) {
    check(`设置页里没有 #${id} 这个开关了`, !html.includes(`id="${id}"`));
  }
}

/* ---- 全局快捷键 + 导入导出挪到设置页签底部（kniph 2026-10-15）---- */
{
  const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
  const manifest = JSON.parse(read('../manifest.json'));
  const content = read('../content.js');
  const background = read('../background.js');
  const options = read('../options.js');
  const html = read('../options.html');

  /* 两条截图快捷键**故意不设默认键**（kniph 2026-10-16）：不给用户预设，去浏览器的
     快捷键设置页自己挑 —— Edge 还会静默拒绝它不喜欢的建议键（Alt+C 实测被拒），干脆不猜。 */
  /* iframe 薄桥接（2026-10-16）：协议两端各存一份（frame-bridge.js 发 / content.js 收），
     type 字符串必须对得上 —— 钉住，别哪天一边改了另一边不知道。 */
  check('manifest 两条注入：content.js 只在顶层，frame-bridge.js 全 frame + about:blank',
    Array.isArray(manifest.content_scripts) && manifest.content_scripts.length === 2 &&
      manifest.content_scripts[0].all_frames === false &&
      manifest.content_scripts[1].all_frames === true &&
      manifest.content_scripts[1].match_about_blank === true &&
      /frame-bridge.js/.test(manifest.content_scripts[1].js.join(',')));



  /* 图片直传只播种一条槽位（kniph 2026-10-18 报的两条：
     ①「不能多选配置」= 槽位一进来就装满，选谁都只是挪位置；
     ②「实际直传把所有配置全发出去」= targets = slots.map(...)。 */
  {
    const csrcSeed = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
    check('图片模式不再「按 N 条把图片配置全铺开」',
      !/\[primary, \.\.\.rest\]/.test(csrcSeed));
    const hasListPath = csrcSeed.includes("seeded = ordered.slice(0, slotLimit());");
    const hasSinglePath = csrcSeed.includes("seeded = ids.includes(primary) ? [primary] : (ids[0] ? [ids[0]] : []);");
    check('initSlots 的兜底只有「单条」这一条路径（不再按 N 铺开）', hasListPath && hasSinglePath,
      JSON.stringify({ hasListPath, hasSinglePath }));
    check('槽位池子按模式取（图片那屏只列图片配置）',
      /const slotPool = \(\) => \(cfgMode === 'image' && imageConfigs\.length > 0 \? imageConfigs : configs\)/.test(csrcSeed));
    check('两个模式的槽位各存一份，不会互相顶掉',
      /const slotsByMode = \{ text: \[\], image: \[\] \}/.test(csrcSeed) &&
        /slotsByMode\[cfgMode\] = slots/.test(csrcSeed));
  }
  /* 自定义面板样式（2026-10-18）：面板在 shadow DOM 里，页面级 CSS 进不来，
     所以必须由我们注入到**同一个 shadow root 的末尾** —— 排在预设主题之后，
     同优先级靠「后出现」胜出，形成「默认 < 预设 < 自定义」三层，不用 !important。
     同时要暴露稳定钩子（#rt-panel / [data-rt-theme]），否则用户写不出选择器。 */
  {
    const csrcCss = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
    const osrcCss = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
    const ssrcCss = readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8');
    check('真面板把用户 CSS 追加到 shadow root 末尾',
      /userCssEl\.id = 'rt-user-css'/.test(csrcCss) && /shadow\.appendChild\(userCssEl\)/.test(csrcCss));
    check('设置页预览也注入同一份（否则「预览和实际不一致」）',
      /rt-user-css/.test(osrcCss) && /sh\.appendChild\(ucss\)/.test(osrcCss));
    check('面板有稳定 id #rt-panel（用户能吃到 id 优先级）',
      /panel\.id = 'rt-panel'/.test(csrcCss));
    check('面板有 data-rt-theme（按主题分别写的钩子）',
      /panel\.dataset\.rtTheme = light \? 'light' : 'dark'/.test(csrcCss));
    check('预览面板也有同样的 id + data-rt-theme',
      /panel\.id = "rt-panel"/.test(osrcCss) && /panel\.dataset\.rtTheme/.test(osrcCss));
    check('theme 有白名单校验（原来是任意字符串照收）',
      /\['auto', 'light', 'dark'\]\.includes\(settings\.theme\)/.test(ssrcCss));
    check('panelCss 有长度上限（防 20 万字符把面板卡死）',
      /panelCss.*\.slice\(0, 20000\)/.test(ssrcCss));
    check('设置页有「填入示例」和「清空」两个按钮',
      /btnPanelCssWarm\.addEventListener/.test(osrcCss) && /btnPanelCssClear\.addEventListener/.test(osrcCss));
    /* 内置的 warm 示例：只覆盖颜色变量、不碰布局，而且对比度得达标 */
    const warmBlock = (() => {
      const i = osrcCss.indexOf('const PANEL_CSS_WARM');
      if (i < 0) return '';
      return osrcCss.slice(i, osrcCss.indexOf('].join', i));
    })();
    check('内置 warm 示例存在且只改颜色变量',
      !!warmBlock && /--rt-bg/.test(warmBlock) && !/width\s*:/.test(warmBlock));
    const warmBg = /--rt-bg: (#[0-9a-f]{6})/i.exec(warmBlock);
    const warmText = ['--rt-text', '--rt-text-out'];
    check('warm 示例没有改文字色（复用 dark 那套，避免破坏对比度）',
      !warmBlock.includes('--rt-text '));
  }
  /* 深色主题的**对比度阶梯**（kniph 2026-10-18：「对比度太高累眼」+「首字…太浅看困难」）。
     以前正文 17.1:1（刺眼）、diag 标签 2.8:1（远低于 WCAG AA 4.5，看不清）——
     同一个主题里最亮的太亮、最暗的太暗。现在压到 5.1~13.0，每一档都可读又不刺眼。 */
  {
    const css = PANEL_CSS   /* 唯一真相源：lib/panel-core.js（2026-11-09 合并） */;
    const darkBlock = css.slice(css.indexOf('.rt-panel {'), css.indexOf('.rt-panel.light'));
    const lightBlock = css.slice(css.indexOf('.rt-panel.light'), css.indexOf('/* ---- 头部'));
    const grabVars = (b) => {
      const o = {};
      for (const m of b.matchAll(/--rt-([a-z-]+):\s*([^;]+);/g)) o[m[1]] = m[2].trim();
      return o;
    };
    const rgbOf = (c) => { const t = String(c).replace('#', ''); return [0, 2, 4].map((i) => parseInt(t.substr(i, 2), 16)); };
    const lumOf = (rgb) => {
      const a = rgb.map((v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
      return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    };
    const contrast = (fg, bg) => {
      const a = lumOf(rgbOf(fg)), b = lumOf(rgbOf(bg));
      const hi = Math.max(a, b), lo = Math.min(a, b);
      return (hi + 0.05) / (lo + 0.05);
    };
    const D = grabVars(darkBlock), L = grabVars(lightBlock);
    const dk = (k) => contrast(D[k], D.bg);
    const lt = (k) => contrast(L[k], L.bg);

    check('深色：每一档文字都不低于 WCAG AA（4.5:1）',
      ['text', 'text-dim', 'text-out', 'text-foot', 'placeholder'].every((k) => dk(k) >= 4.5),
      ['text', 'text-dim', 'text-out', 'text-foot', 'placeholder'].map((k) => k + '=' + dk(k).toFixed(1)).join(' '));
    check('深色：正文不再刺眼（≤14:1）', dk('text-out') <= 14, dk('text-out').toFixed(1));
    check('深色：diag 标签（首字/总耗时…）看得清（≥4.5:1）', dk('placeholder') >= 4.5, dk('placeholder').toFixed(1));
    check('亮色：diag 标签同样不低于 4.5:1', lt('placeholder') >= 4.5, lt('placeholder').toFixed(1));
    check('深色的「亮→暗」阶梯是单调的（正文最亮、占位最暗）',
      dk('text-out') >= dk('text') && dk('text') >= dk('text-dim') &&
        dk('text-dim') >= dk('text-foot') && dk('text-foot') >= dk('placeholder'),
      ['text-out', 'text', 'text-dim', 'text-foot', 'placeholder'].map((k) => dk(k).toFixed(1)).join(' > '));
  }
  /* 面板 CSS 现在是**一份**（2026-11-09 合并）：唯一真相源是 lib/panel-core.js 的
     window.RTPanelCore.PANEL_CSS，content.js 和 options.js 都从全局取。
     原来那条「两份内容一致」的逐字比对断言，做完合并后就成了恒真的死测试，已删除。
     换成下面三条，钉住「确实只有一份、且两边都从它取」这个新事实。 */
  check('样式表只有一处定义（panel-core.js），旧副本不再各自 export',
    /const PANEL_CSS = `/.test(read('../lib/panel-core.js')) &&
      !/export const PANEL_CSS/.test(read('../lib/panel-styles.js')) &&
      !/export const TRIGGER_CSS/.test(read('../lib/trigger-styles.js')),
    'panel-core 该有一份、两个旧 lib 该没有');
  check('content.js 与 options.js 都从 window.RTPanelCore 取样式（不是手抄）',
    /window\.RTPanelCore\.PANEL_CSS/.test(read('../content.js')) &&
      /window\.RTPanelCore\.TRIGGER_CSS/.test(read('../content.js')) &&
      /* options.js 用的是解构写法 const { TRIGGER_CSS, PANEL_CSS } = window.RTPanelCore;
         所以这里不能找 `.PANEL_CSS` 字面 —— 找解构里同时出现两个名字。 */
      /\{\s*TRIGGER_CSS\s*,\s*PANEL_CSS\s*\}\s*=\s*window\.RTPanelCore/.test(read('../options.js')),
    '两边都应走全局对象');
  check('content.js 里不再有内联的面板 CSS 大块（合并后只剩一行引用）',
    !/style\.textContent = `/.test(read('../content.js')),
    '没有就地贴样式表了');


  /* 滚动条不能把右边距撑大、也不能让左右不一样（kniph 2026-11-01 报的）。
     做法：scrollbar-gutter: stable 让槽位**始终**占着（出现/消失都不跳），
     再从右内边距扣掉这 8px（自绘滚动条宽度）—— 这样 .7em 的左右才真正相等。 */
  {
    /* 带分号的才是真声明（注释里那句没有分号，别被它蒙了） */
    /* 滚动条相关的断言原本读「content.js 内联那份」，CSS 合并后没有了 ——
       改成读唯一真相源 PANEL_CSS。断言意图不变：钉住三个可滚动区都留了槽、
       右内边距扣掉 8px、滚动条宽度仍是 8px。 */
    /* PANEL_CSS 是 panel-core.js 里的一个变量，测试里没有（原来是悬空的引用，
       一跑就 ReferenceError）。直接从文件里抽出来。 */
    const coreSrc = read('../lib/panel-core.js');
    const m = coreSrc.match(/const PANEL_CSS = `([\s\S]*?)`;/);
    const cssInline = m ? m[1] : '';
    const gutters = (cssInline.match(/scrollbar-gutter: stable;/g) || []).length;
    check("三个可滚动区都留了滚动条槽（.rt-out / .rt-src / .rt-diag）",
      gutters === 3, gutters + " 处");
    /* 判据改成「右侧确实用了 calc(... - 8px) 这个补偿」—— 上下留白是会调的
       （kniph 反复调过），但「右边扣掉滚动条宽度」这条规则不能变。 */
    check("右内边距扣掉了滚动条那 8px（左右才对称）",
      /\.rt-out \{[^}]*padding:[^;]*calc\(\.7em - 8px\)/s.test(cssInline) &&
        /\.rt-src \{[^}]*padding:[^;]*calc\(\.7em - 8px\)/s.test(cssInline) &&
        (/\.rt-diag \{[^}]*padding:[^;]*calc\(\.7em - 8px\)/s.test(cssInline) ||
          /\.rt-diag \{[^}]*padding: 10px 7px 10px 15px;/s.test(cssInline)));   // 15 - 8 = 7
    /* 滚动条宽度是这件事的前提：改宽了补偿值就得跟着改 */
    check("自绘滚动条仍是 8px（补偿值按它算的）",
      cssInline.includes("::-webkit-scrollbar { width: 8px; }"));
  }
  const bridge = read('../frame-bridge.js');
  check('桥在非顶层才干活（window.top 自检在最先）',
    /window\.top === window\) return/.test(bridge.slice(0, 1500)));
  check('协议两端对得上（rt-frame-sel）',
    'rt-frame-sel'.length > 0 && bridge.includes('rt-frame-sel') && content.includes('rt-frame-sel'));
  check('顶层收消息有开关（prefs.frameBridge 关了就忽略）',
    /prefs\.frameBridge\) return/.test(content));
  check('manifest 声明三条快捷键：翻译选区默认 Alt+T，两条截图默认不设键',
    manifest.commands && manifest.commands['translate-selection'] &&
      manifest.commands['translate-selection'].suggested_key.default === 'Alt+T' &&
      manifest.commands['shot-translate'] && !manifest.commands['shot-translate'].suggested_key &&
      manifest.commands['ocr-clipboard'] && !manifest.commands['ocr-clipboard'].suggested_key,
    JSON.stringify(manifest.commands));
  check('后台把指令转发给活动页签（选区在页面那边）',
    /chrome\.commands\.onCommand\.addListener/.test(background) &&
      /hotkey-translate/.test(background));
  check('content 接住快捷键并走现有选区翻译入口',
    /msg\.type === 'hotkey-translate'/.test(content) &&
      /readSelection\(\)/.test(content.slice(
        Math.max(0, content.indexOf('hotkey-translate') - 200),
        content.indexOf('hotkey-translate') + 300
      )));

  check('导入导出挪进设置页签（顶部那排不再占配置区空间）',
    !html.includes('head-actions') &&
      html.indexOf('id="btn-export"') > html.indexOf('data-panel="settings"') &&
      html.indexOf('id="btn-import"') > html.indexOf('data-panel="settings"') &&
      html.indexOf('id="chk-encrypt"') > html.indexOf('data-panel="settings"'));
  check('有「去 Key 的分享导出」入口（判据仍是 isSecretVar，不抄第二份）',
    html.includes('btn-export-share') &&
      /btn-export-share/.test(options) &&
      /structuredClone\(state\)/.test(options) &&
      /isSecretVar\(v\.name\) && v\.value/.test(options));
}

section('21. 结果区最大高度：默认值 = 原来写死的那个数，而且真的走变量');
{
  /* 这条设置的默认值**必须**是 46 —— 那是改动前 `.rt-out` 里写死的 `46vh`。
     换成别的数，老用户升级后会发现面板高度变样了（等于偷偷改了行为）。 */
  eq('默认值就是原来写死的 46（升级看不出变化）', DEFAULT_SETTINGS.panelMaxHeight, 46);

  // content.js 手抄了一份 prefs 初值（content script 不能 import），两边都得有
  const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  check('content.js 那份 prefs 初值里也有它（且同是 46）', /\bpanelMaxHeight:\s*46\b/.test(src));
  /* CSS 部分改读唯一真相源 PANEL_CSS（2026-11-09 合并后 content.js 里没有样式表了）；
     行为部分（classList.toggle）仍在 content.js。 */
  check('上限读的是变量，没写死回去', PANEL_CSS.includes('var(--rt-max-h, 46vh)'));
  check('填 0（不限）靠一个类显式关掉，而不是把变量设成 none',
    PANEL_CSS.includes('.rt-panel.no-max-h .rt-out { max-height: none; }') &&
    src.includes("classList.toggle('no-max-h'"));
}

section('22. 按钮：贴鼠标 + 自动消失');
{
  /* 鼠标划词时按钮改成**无条件贴鼠标**，不再从选区里挑「离鼠标近的那一头」。
     老逻辑在「拖一大段 / 那一行特别长 / 双击选段」时挑出来的角离鼠标很远。 */
  const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

  check('挑「离鼠标近的那一头」那段老逻辑已经删掉', !src.includes('dist2(head.left'));
  check('鼠标这一路走 atMouse', /atMouse:\s*true/.test(src) && src.includes('found.atMouse'));
  check('按钮离指针留了偏移（压在指针下会立刻 hover，就永远不消失了）',
    /const MOUSE_GAP = \d+/.test(src));
  check('翻边也留同样的偏移', src.includes('x = seg.left - size - off'));

  /* 键盘扩展选区：浏览器不给全局鼠标坐标，坐标只能从事件里自己记 —— 键盘改完选区后
     手里那个 lastMouse 是旧的，得清掉，改用光标那一端定位。 */
  check('有 mousemove 监听（鼠标位置只能自己记）',
    /addEventListener\('mousemove'/.test(src));
  check('键盘改选区时把旧鼠标坐标清掉', src.includes('if (e.key !== \'Escape\') lastMouse = null;'));
  check('键盘这一路用光标那一端（focusNode / focusOffset）', src.includes('sel.focusNode'));
  check('Shadow DOM 里连光标都量不到时不硬贴左上角',
    /if \(!b \|\| \(b\.width === 0 && b\.height === 0\)\) return null;/.test(src));

  /* 两个设置项：默认值 + content.js 那份同形 + 设置页真的接上了 */
  eq('默认 2 秒鼠标不动就消失', DEFAULT_SETTINGS.triggerIdleSec, 2);
  eq('默认鼠标移开 0.4 秒就消失', DEFAULT_SETTINGS.triggerLeaveSec, 0.4);
  check('content.js 那份 prefs 初值里也有它俩（且同值）',
    /\btriggerIdleSec:\s*5\b/.test(src) && /\btriggerLeaveSec:\s*0\.5\b/.test(src));
  check('两个时间都真的读的是设置', src.includes('prefs.triggerIdleSec') && src.includes('prefs.triggerLeaveSec'));
  check('鼠标停在按钮上会停掉计时', src.includes('if (Date.now() - trigShownAt < 250) return;') &&
    src.includes('trigHovered = true;'));
  check('移开按钮走那个「很短的时间」（且没用 mouseleave —— 它后面紧跟的 mousemove 会把计时清掉）',
    src.includes('if (trigHovered) { trigHovered = false; armTriggerLeave(); return; }') &&
    !src.includes("addEventListener('mouseleave'"));
  /* 指针离开按钮是一串 mousemove：第二个不能再走主计时，否则「移开就消失」会被换成主计时 */
  check('已经在移开倒计时里时，后面的 mousemove 不许把主计时盖上去',
    src.includes('if (trigLeaveTimer) return;'));

  const html = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  check('设置页有这两个输入框', html.includes('id="s-trigidle"') && html.includes('id="s-trigleave"'));
  const optSrc = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  // SETTING_MAP 是唯一真相源（数组，一行一条），绑定与回填都从它跑 —— 这两个输入框
  // 必须在表里各占一行，且 key 对得上 settings 字段
  check('设置页把这两个输入框接到了 settings（在 SETTING_MAP 表里）',
    optSrc.includes("sel: '#s-trigidle', key: 'triggerIdleSec'") &&
    optSrc.includes("sel: '#s-trigleave', key: 'triggerLeaveSec'"));

  /* ---- SETTING_MAP 是「唯一真相源」，别再退回三处手抄 ----
     绑定（bindSettings）和回填（renderSettings）都从这张表跑。把两条不变量钉住：
       ① 表里每个 sel 指向的控件，options.html 里必须真的存在（不然绑定会静默失效）；
       ② 每个 sel 在 options.js 里只出现一次（防止又抄出第二份「id → 字段」映射）。 */
  const mapSels = [...optSrc.matchAll(/sel:\s*'(#[^']+)'/g)].map((m) => m[1]);
  check('SETTING_MAP 至少覆盖了主要设置项（表没被删空）', mapSels.length >= 14,
    `${mapSels.length} 行`);
  const missingInHtml = mapSels.filter((s) => {
    // sel 是 '#s-xxx' 形式，对应 HTML 里的 id="s-xxx"
    const id = s.slice(1);
    return !html.includes(`id="${id}"`);
  });
  check('SETTING_MAP 里每个 sel 都在 options.html 里有对应控件', missingInHtml.length === 0,
    missingInHtml.join(','));
  const dupSel = mapSels.filter((s, i) => mapSels.indexOf(s) !== i);
  check('SETTING_MAP 里没有重复的 sel（一个控件一行）', dupSel.length === 0, dupSel.join(','));
  // 绑定与回填都得真的从这个表跑，而不是各自手写一遍 id 清单
  check('renderSettings / bindSettings 都遍历 SETTING_MAP',
    /function renderSettings\(\)[\s\S]{0,200}for \(const row of SETTING_MAP\)/.test(optSrc) &&
    /* 2000 → 4500：bindSettings 开头现在还有快捷键那一段（NAMES + render），
       把循环挤远了。判据是「它在 bindSettings 里」而不是「离函数头多近」。 */
    /function bindSettings\(\)[\s\S]{0,4500}for \(const row of SETTING_MAP\)/.test(optSrc));
}

section('23. 框选截图：覆盖层不铺位图，滚动条只在裁的那一刻切掉');
{
  /* A 方案（kniph 2026-10-11 定）：覆盖层**不铺底图**，只铺一层压暗的挖洞，页面原样可见
     —— 用户看到的是「直接对着页面框」。位图只在**松手那一刻**用来裁框里那块，
     所以「那台机器有没有滚动条」这件事只在 cropShot 里处理一次，预览那头根本不存在。 */
  const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

  check('老那套「覆盖层先铺一张底图再裁」已经删掉',
    !src.includes('paintShot') && !src.includes('shotSrcW') && !src.includes('painted') &&
    !src.includes('hostEl.classList.add(\'loading\')'));
  check('覆盖层只剩挖洞那层 .sel（+ 提示条），没有 .img',
    src.includes('const SHOT_TIP =') && src.includes('<div class="sel"></div>') &&
    !src.includes('class="img"'));
  check('挖洞 = 超大 box-shadow（这是「页面压暗、框里透亮」的唯一手法）',
    src.includes('box-shadow: 0 0 0 100000px rgba(0, 0, 0, .45)'));
  /* 「压暗」和「接指针」必须是两层：box-shadow 不参与命中测试，且挖洞那层为了不挡
     页面写的 pointer-events:none —— 只有它的话，真人按住鼠标框选不了
     （kniph 报过；脚本直接派发事件能过）。 */
  check('有独立一层 .veil 铺满整屏接指针（不能只靠 box-shadow 那层）',
    src.includes('<div class="veil"></div>') && src.includes('.veil {') &&
    src.includes('position: fixed; inset: 0;') && src.includes('cursor: crosshair;'));
  check('事件挂在 hostEl 上，不挂 shadow root（root 不是事件目标）',
    src.includes("hostEl.addEventListener('pointerdown'") &&
    !src.includes("root.addEventListener('pointerdown'"));
  check('按下时 setPointerCapture（拖到遮罩外也能收到 up）',
    src.includes('hostEl.setPointerCapture(e.pointerId)'));
  check('拖框期间还能滚页面：提示语里写了，且覆盖层不吃 wheel',
    src.includes('可滚动页面') && !src.includes("addEventListener('wheel'"));
  check('松手后先拆覆盖层，再去裁图（裁图期间用户能继续翻页）',
    /finish\(\);\s*\n\s*cropShot\(dataUrl, rect\)\.then/.test(src));

  // 裁剪那头的两个不变量
  check('切掉的判据 = 视口宽/高 − 内容宽/高（乘 dpr）',
    src.includes('window.innerWidth - document.documentElement.clientWidth') &&
    src.includes('window.innerHeight - document.documentElement.clientHeight'));
  check('比例按「位图 − 那一条」算，再映射屏幕坐标',
    src.includes('const kx = srcW / viewW') && src.includes('const ky = srcH / viewH'));
  check('cropShot 是异步的（返回 Promise，不阻塞覆盖层拆除）',
    src.includes('function cropShot(dataUrl, rect)') && src.includes('return new Promise((resolve) =>'));
  check('裁不出来时返回 null（上层转成 ocr-error，不炸）',
    src.includes('img.onerror = () => resolve(null);'));

  /* 照抄一遍算式，把「没有滚动条时切 0」这条不变量钉死。
     数字来自实机探针（Win11 + Edge + 真 captureVisibleTab）：
     innerW 1178 / clientW 1163 / dpr 1.5 → 位图 1767×1214。 */
  const cutOf = (inner, client, dpr) => Math.max(0, Math.round((inner - client) * dpr));
  eq('没有滚动条：切掉 0（等于没动）', cutOf(1170, 1170, 1), 0);
  eq('有 15px 滚动条、dpr 1：切掉 15', cutOf(1185, 1170, 1), 15);
  eq('实机那台：1178 视口 / 1163 内容 / dpr 1.5 → 切掉 23', cutOf(1178, 1163, 1.5), 23);
}

section('24. content.js 的两种「铺界面」骨架收口（别再散回各处）');
{
  /* 「进忙碌态」和「报失败」原先在 5 处各写一套（翻译开场 / OCR 开场 / 截图开场失败 /
     结果失败 / OCR 失败）。收成 enterBusy / showFailure 两个函数后，把性质钉住：
       —— 两个函数必须存在；
       —— 那 5 个位置不许再手写那串样板（busy= / retryBtn.disabled / dataset.placeholder…）；
       —— 入口函数必须真的调它们。 */
  const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');

  check('有 enterBusy 与 showFailure 两个公共骨架',
    src.includes('function enterBusy(placeholder, statusText, opts = {})') &&
    src.includes('function showFailure(why, opts = {})'));

  /* 数一数「清空结果区」那三连在全文出现几次 —— enterBusy / showFailure 各一处，
     再就是 showNoCachedResult 那一处（它语义不同，故意留着手写）。超过就说明又抄出去了。 */
  const clearBoxCount = (src.match(/outBox\.textContent = '';/g) || []).length;
  check('清空结果区那段不再是五处手抄（≤ 4 处）', clearBoxCount <= 4, `${clearBoxCount} 处`);

  check('进忙碌态都走 enterBusy（翻译开场 / OCR 开场各一处调用）',
    (src.match(/enterBusy\(/g) || []).length >= 2);

  check('报失败都走 showFailure（结果失败 / OCR 失败 / 截图开场失败）',
    (src.match(/showFailure\(/g) || []).length >= 3);

  /* saveSetting / saveImageConfigId 共用同一条「读-改-写」链 */
  check('有一处 mutateState 统一「读 state → 改 → 写回」',
    src.includes('function mutateState(mutate)'));
  check('saveSetting / saveImageConfigId 都改走 mutateState',
    src.includes('return mutateState((st) => {') &&
    !/function saveSetting\(key, value\) \{\s*saveChain = saveChain\.then/.test(src) &&
    !/function saveImageConfigId\(id\) \{\s*saveChain = saveChain\.then/.test(src));
}

section('25. 管模型的变量填多行 = 换 model 重试（每个一行）');
{
  /* 值按**行**拆成候选：一行一个。只有一行 = 普通单值，**没有任何新行为**
     （老存档的值都是单行，进来等于没开这个功能）。 */
  eq('一行就是一个候选', JSON.stringify(splitVarValues('a')), JSON.stringify(['a']));
  eq('多行拆成多个候选', JSON.stringify(splitVarValues('a\nb\nc')), JSON.stringify(['a', 'b', 'c']));
  eq('空行丢掉（末尾多敲回车不该多试一次）',
    JSON.stringify(splitVarValues('a\n\nb\n')), JSON.stringify(['a', 'b']));
  eq('首尾空白 trim，中间空格保留（model id 里可能有 / 和空格）',
    JSON.stringify(splitVarValues('  deepseek-ai/DeepSeek-V3  ')),
    JSON.stringify(['deepseek-ai/DeepSeek-V3']));
  eq('CRLF 也认（Windows 下手打换行）',
    JSON.stringify(splitVarValues('a\r\nb')), JSON.stringify(['a', 'b']));
  eq('全空 → 没有候选', JSON.stringify(splitVarValues('  \n  \n')), JSON.stringify([]));
  eq('空值 → 没有候选', JSON.stringify(splitVarValues('')), JSON.stringify([]));

  /* 「哪个变量管模型」= **模板里用到的占位符**里名字含 model 的那个（不看大小写）。
     判据跟 KEY 那条同一个路子（名字含 key = 密钥），只是多加一层「在哪找」：
     变量表是全局的，同时存着 GEMINI_MODEL 和 DEEPSEEK_MODEL 时扫表挑不出该轮换哪个。 */
  const T = (ph) => `curl https://x/y -d '{"model":"{{${ph}}}","text":"{{text}}"}'`;

  eq('模板里 {{model}} → 认它', modelVarFor(T('model'), { model: 'a\nb' }), 'model');
  eq('{{GEMINI_MODEL}} → 认它（kniph 报的就是这个：只认死名字等于功能对他不存在）',
    modelVarFor(T('GEMINI_MODEL'), { GEMINI_MODEL: 'a\nb' }), 'GEMINI_MODEL');
  eq('{{MODEL}} / {{Model}} 也认（不看大小写）',
    modelVarFor(T('MODEL'), { MODEL: 'a' }) + '/' + modelVarFor(T('Model'), { Model: 'a' }),
    'MODEL/Model');
  eq('{{model_name}} 这种含 model 的也认', modelVarFor(T('model_name'), { model_name: 'a' }), 'model_name');
  eq('模板里没用到它就不算（写了别的占位符就别乱轮换）',
    modelVarFor(T('M'), { GEMINI_MODEL: 'a\nb' }), '');
  eq('模板里引用了、但变量表里没有 → 不算（占位符写错了，不该凭空开一轮重试）',
    modelVarFor(T('GEMINI_MODEL'), { text: 'hi' }), '');
  eq('两个 MODEL 变量都在时，认**模板里那个**（不是变量表里排前面的那个）',
    modelVarFor(T('DEEPSEEK_MODEL'), { GEMINI_MODEL: 'a\nb', DEEPSEEK_MODEL: 'c\nd' }), 'DEEPSEEK_MODEL');
  eq('模板里两个都用到时取第一个',
    modelVarFor(
      `curl https://x/y -d '{"a":"{{GEMINI_MODEL}}","b":"{{OTHER_MODEL}}"}'`,
      { GEMINI_MODEL: 'a', OTHER_MODEL: 'b' }
    ), 'GEMINI_MODEL');

  /* modelCandidates：找不到那个变量 / 值是空的都返回 []，调用方据此完全不启用回退 */
  eq('没有那个变量 → 没有候选', JSON.stringify(modelCandidates(T('model'), { text: 'hi' })), JSON.stringify([]));
  eq('值是空串 → 没有候选', JSON.stringify(modelCandidates(T('model'), { model: '' })), JSON.stringify([]));
  eq('单值 → 一个候选（退化成普通请求）',
    JSON.stringify(modelCandidates(T('model'), { model: 'Gemma-4-31B-IT' })),
    JSON.stringify(['Gemma-4-31B-IT']));
  eq('多值 → 多个候选',
    JSON.stringify(modelCandidates(T('model'), { model: 'Gemma-4-31B-IT\nQwen3-32B' })),
    JSON.stringify(['Gemma-4-31B-IT', 'Qwen3-32B']));
  eq('GEMINI_MODEL 多值 → 一样给出多个候选',
    JSON.stringify(modelCandidates(T('GEMINI_MODEL'), { GEMINI_MODEL: 'a\nb' })),
    JSON.stringify(['a', 'b']));

  /* firstModelVars：渲染边界上的收敛 —— 一次请求只用一个 model */
  eq('单值：原样（老行为一个字节没变）',
    JSON.stringify(firstModelVars(T('model'), { model: 'gpt-4o', text: 'hi' })),
    JSON.stringify({ model: 'gpt-4o', text: 'hi' }));
  eq('多值：收敛成第一个候选', firstModelVars(T('model'), { model: 'a\nb\nc' }).model, 'a');
  eq('GEMINI_MODEL 多值：也是收敛，并且**键名保持用户原来那个**',
    JSON.stringify(firstModelVars(T('GEMINI_MODEL'), { GEMINI_MODEL: 'a\nb' })),
    JSON.stringify({ GEMINI_MODEL: 'a' }));
  check('模板里没有 model 占位符时返回原对象（不复制、不新增字段）',
    (() => { const v = { text: 'hi' }; return firstModelVars(T('M'), v) === v; })());
  check('值是空行也不动',
    (() => { const v = { model: '  \n ' }; return firstModelVars(T('model'), v) === v; })());

  /* ---- 渲染边界真的挂了这一步（不是只在设置页做） ---- */
  /* kniph 的真实形态：curl 模板 + 多行 GEMINI_MODEL 写在**地址路径**里 */
  const multiTpl =
    "curl 'https://x/v1beta/models/{{GEMINI_MODEL}}:streamGenerateContent?alt=sse&key={{GEMINI_API_KEY}}' " +
    "-H 'Content-Type: application/json' -d '{\"text\":\"{{text}}\"}'";
  const multiVars = {
    GEMINI_MODEL: 'gemini-3.8-flash\ngemini-3.7-flash\ngemini-3.6-flash',
    GEMINI_API_KEY: 'AQ.Ab8RN6abcdefghijklmnop',
    text: 'hi'
  };
  const multiReq = previewRequest(multiTpl, multiVars, '').request;
  check('多行 model 不会串进地址（渲染边界就收敛了）',
    !multiReq.url.includes('\n') && multiReq.url.includes('/models/gemini-3.8-flash:'),
    JSON.stringify(multiReq.url));
  check('多行 model 的值只用了第一个（地址里没有 3.7 / 3.6）',
    !multiReq.url.includes('gemini-3.7-flash') && !multiReq.url.includes('gemini-3.6-flash'),
    JSON.stringify(multiReq.url));
  check('同一次还顺手把 GEMINI_API_KEY 打码了（key 走变量跟随）',
    multiReq.url.includes('key=AQ.Ab8…（已隐藏）'), JSON.stringify(multiReq.url));

  /* engine 自己也得挂这一步：OCR 那条路（buildOcrRequest）走的是另一处组装 */
  check('OCR 的组装也过 firstModelVars（否则 OCR 预览里一样会串四个 model）',
    readFileSync(new URL('../lib/ocr.js', import.meta.url), 'utf8')
      .includes('firstModelVars(template, vars)'));

  /* 约定名和内置变量不冲突：buildVars 现在不产 model，用户变量可以自由用这个名字 */
  const builtins = buildVars(
    { vars: [], settings: { targetLang: '简体中文' } },
    '你好', {}
  );
  check('buildVars 不带 model（留给用户自定义变量，别撞名）', !('model' in builtins));

  /* ---- 后台那个回退循环，把性质钉住（背景层循环，绝不进 runRequest） ---- */
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const engine = readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8');

  check('回退循环在 background.js 里（不在 engine.runRequest）',
    bg.includes('modelVarFor(requestText, vars)') && bg.includes('for (let i = 0; i < attempts.length'));
  check('候选在链循环里算（每条后备的模板可能不一样，管模型的变量可能不是同一个）',
    /for \(let r = 0; r < runnable\.length[\s\S]{0,700}modelCandidates\(requestText, vars\)/.test(bg));
  check('runRequest 保持「一次调用 = 一次请求」，没被改成内部循环',
    /export async function runRequest/.test(engine) &&
    !/for \(let i = 0; i < attempts\.length/.test(engine));
  check('成功判据只有「拿到译文」一处',
    bg.includes('if (result && result.text) break;'));
  check('本次请求已作废（abort）时立刻退出循环，不继续试（否则白费请求）',
    bg.includes("if (result && result.error === '已取消') return;"));
  check('覆盖的是**命中的那个键名**，不是写死的 model',
    bg.includes('{ ...vars, [mkey]: model }') && !bg.includes('{ ...vars, model }'));
  check('每次开始试一个都把 model 名带给面板（statusText）',
    bg.includes('statusText') && bg.includes('type: \'start\''));
  check('面板接住 statusText 并拼进状态行',
    readFileSync(new URL('../content.js', import.meta.url), 'utf8')
      .includes('请求中…${msg.statusText}'));

  /* ---- 设置页那个「测试」也得逐个试 model（kniph 2026-10-14 报的）----
     原来只发第一个：第一个恰好挂了就报一片红，用户得出「这条配置坏了」——
     而面板上（会轮换）明明是好的。 */
  const optSrc = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  check('设置页「测试」先排好整条链的计划，每条请求自己算「谁管模型」',
    /const plan = chain\.map\(\(item\) => \{[\s\S]{0,300}modelVarFor\(requestText, vars\)/.test(optSrc));
  check('测试里覆盖的也是**命中的键名**（和后台同一处规矩）',
    optSrc.includes('{ ...vars, [mkey]: model }'));
  check('不轮换时徽章文案一字没改（「第 i 条拿到译文，后面 N 条没跑」）',
    optSrc.includes('`，后面 ${left} 条没跑`') && optSrc.includes('第 ${i + 1} 条拿到译文'));
  check('轮换时明说「最多发几次」+「第几个 model 成的」',
    /T\('opt_tryall'/.test(optSrc) && /String\(total\)/.test(optSrc) &&
      optSrc.includes('第 ${j + 1} 个 model 拿到译文'));
  check('轮换时每块自带 model 徽章（好几块长得一样，得分得清哪块是哪个）',
    optSrc.includes('function testItemHtml(item, r, opts = {})') &&
      optSrc.includes('if (opts.model) badges.unshift'));
  check('配置预览的备注交代「只摊第一个、真跑会逐个试」',
    /T\('opt_model_rotate_a'/.test(optSrc) && /T\('opt_model_rotate2'/.test(optSrc) && +
      optSrc.includes('+ models.length +') && optSrc.includes('+ models[0] +'));

  /* ---- 图片直传只试填了图片模板的条目（kniph 2026-10-14 提出）----
     `requestTemplateFor` 对没填图片模板的条目会**回退到普通那段**（老配置靠这个保行为）。
     截图这条路回退出来的模板里根本没有 {{image}} —— 发出去必然失败，白跑一次还报错。
     运行时（background）和设置页的「测试」按钮（imageItem）必须同一个口径。 */
  check('图片直传时只试填了「图片请求模板」的条目（不拿普通模板凑数）',
    /const runnable = hasImage[\s\S]{0,140}requestChain\(config\)\.filter\(\(it\) => String\(it\.imageRequest \|\| ''\)\.trim\(\)\)/.test(bg) &&
      /没填「图片请求模板」，没法带图翻译/.test(bg) &&
      /for \(let r = 0; r < runnable\.length; r \+= 1\)/.test(bg));
  check('设置页「测试」按钮和运行时同一个口径（imageItem 也只看 imageRequest 非空）',
    /function imageItem\(c\) \{[\s\S]{0,140}requestChain\(c\)\.find\(\(r\) => String\(r\.imageRequest \|\| ''\)\.trim\(\)\)/.test(optSrc));

  /* ---- 报错的块默认折起来（kniph 2026-10-14：测试完直接冒出来好几屏）----
     一次测试可能挂好几个 model，每个都是「错误 + 完整请求体 + 原始响应」。
     **外壳只有一处**：`resultBlockHtml`，配置栏和 OCR 栏共用（kniph 后来要求「覆盖到 OCR 栏」）。 */
  check('测试结果的外壳只有一处（resultBlockHtml：定义 1 处 + 配置栏 / OCR 栏各一个调用点）',
    /function resultBlockHtml\(\{ head = ''[\s\S]{0,60}fold, why = '' \}\)/.test(optSrc) &&
      (optSrc.match(/resultBlockHtml\(\{/g) || []).length === 3);
  check('没拿到结果的那块包成 <details>（默认收起），拿到的不加',
    optSrc.includes('<details class="test-fold">') &&
      /<\/summary>` \+/.test(optSrc) &&
      /fold: !r\.text/.test(optSrc) &&           // 配置栏：这条请求没译文
      /fold: !\(r && r\.text\)/.test(optSrc));   // OCR 栏：没认出文字
  check('折起来的块头挂一行「为什么挂」：从错误正文里捞 message（整体 parse 会挂 —— 后面还跟着我们自己加的提示）',
    optSrc.includes('function shortError(err)') &&
      optSrc.includes('const m = /"message"') &&
      optSrc.includes('String(JSON.parse(') &&
      /fold && why \? `<span class="why">/.test(optSrc));
  const optCss = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  check('折块的样式在（▸ 标记 + 打开时转 90°，别拿 CSS 把标记清了）',
    /\.test-fold > summary::-webkit-details-marker \{ display: none; \}/.test(optCss) &&
      /\.test-fold\[open\] > summary::before \{ transform: rotate\(90deg\); \}/.test(optCss));
}

section('26. 打码跟着变量走：名字里含 key 的才是密钥');
{
  /* kniph 报的：地址里的 key（`?key=AQ.Ab8RN6…`）明晃晃摆着没藏 —— 老实现只认
     `Authorization` 头，URL 和 body 里的同一把 key 从来没打过码。
     新规矩：**打码跟着变量走**（名字里含 key 不区分大小写），url / headers / body 一次全覆盖。 */

  /* 变量名判定 */
  check('名字含 key（不区分大小写）才算密钥',
    isSecretVar('apiKey') && isSecretVar('API_KEY') && isSecretVar('myKey2') && isSecretVar('Key'));
  check('不含 key 的不算（model / token / 语言这类）',
    !isSecretVar('model') && !isSecretVar('PROMPT') && !isSecretVar(''));
  check('名字里有个 key 片段也算（保守：宁可多藏）', isSecretVar('keyboard'));

  const KEY = 'AQ.Ab8RN6abcdefghijklmnop';
  const tpl =
    "curl 'https://x/v1/models/m:generateContent?alt=sse&key={{apiKey}}' " +
    "-H 'Authorization: Bearer {{apiKey}}' -H 'X-Trace: 1' " +
    "-d '{\"text\":\"{{text}}\",\"auth\":\"{{apiKey}}\"}'";
  const V = { apiKey: KEY, model: 'm', text: 'hi' };
  const req = previewRequest(tpl, V, '').request;

  check('地址里的 key 打码了（kniph 报的那处）',
    req.url.includes('key=AQ.Ab8…（已隐藏）') && !req.url.includes(KEY),
    req.url);
  check('Authorization 头打码了（老行为保留）',
    req.headers.Authorization === 'Bearer AQ.Ab8…（已隐藏）',
    req.headers.Authorization);
  check('不是 Authorization 的头里出现同一把 key 也打码',
    previewRequest("curl https://x/y -H 'X-Auth: {{apiKey}}'", V, '').request.headers['X-Auth']
      === 'AQ.Ab8…（已隐藏）');
  check('请求体里的 key 也打码',
    !req.body.includes(KEY) && req.body.includes('AQ.Ab8…（已隐藏）'),
    req.body);
  check('打码只影响展示：渲染出来的正文里还是真的（发出去的那份没被动）',
    previewRequest(tpl, V, '').rendered.includes(KEY));

  /* 幂等：变量那一步打过的，Authorization 那一步不许再打一遍（会叠成两层后缀） */
  check('不会叠成两层「…（已隐藏）」',
    (req.headers.Authorization.match(/（已隐藏）/g) || []).length === 1,
    req.headers.Authorization);

  /* 不越界打码 */
  const other = previewRequest("curl https://x/y -H 'K: {{model}}' -d '{\"t\":\"{{text}}\"}'",
    { model: 'gpt-4o-mini', text: 'hi' }, '').request;
  check('不含 key 的变量（model）不打码', other.headers.K === 'gpt-4o-mini' && other.body.includes('hi'));

  /* 没走变量、写死在 Authorization 头里的 key 仍然要兜住 */
  check('写死的 Authorization 也打码（兜底那条还在）',
    previewRequest("curl https://x/y -H 'Authorization: Bearer sk-hardcoded-key'", {}, '').request
      .headers.Authorization === 'Bearer sk-har…（已隐藏）');
  check('空 key 时打的是「Bearer （还没填）」—— 中间那个空格别丢',
    previewRequest("curl https://x/y -H 'Authorization: Bearer {{apiKey}}'", {}, '').request
      .headers.Authorization === 'Bearer （还没填）');

  /* 太短的「密钥」不做值替换：否则预览里所有同名片段都被涂掉 */
  const tiny = previewRequest("curl https://x/y?k={{apiKey}}&v=1", { apiKey: 'ab' }, '').request;
  check('四字符以下的值不替换（免得把预览涂花）', tiny.url.includes('k=ab&v=1'), tiny.url);

  /* 没填的 key 不该把地址改花：值是空的就什么都不换 */
  check('key 变量为空时地址原样', previewRequest("curl https://x/y?k={{apiKey}}", {}, '').request.url === 'https://x/y?k=');

  /* maskRequest 是给展示用的那一层：进来的对象不被改（别把真请求对象改掉） */
  const src = { url: 'https://x/y?key=' + KEY, headers: { A: KEY }, body: 'x' };
  const masked = maskRequest(src, V);
  check('maskRequest 不改原对象（真发出去的那份必须是原样）',
    src.url.includes(KEY) && masked.url !== src.url);
  check('maskRequest 返回的是新对象', masked !== src && masked.headers !== src.headers);
}

section('27. 值输入框按内容撑高：藏着的标签量不到高度，别硬写');
{
  /* 变量栏的值是 textarea、按 scrollHeight 撑高。踩过的坑：初始化时「变量」标签
     还是 display:none，scrollHeight 是 0，把它写进 style.height 就把框压成 0px 一条缝；
     切过来之后一直缩着，得手点一下才恢复（kniph 报的「不动这个框就扁成一条缝」）。
     这里把三条防回归的点钉住（真机几何由 e2e 第 3 节那段量）。 */
  const opt = readFileSync(new URL('../options.js', import.meta.url), 'utf8');

  check('有一个按内容撑高的公共函数 growTextarea',
    opt.includes('function growTextarea(el)'));
  check('量之前先判可见（offsetParent 为空就跳过，不写高度）',
    /function growTextarea[\s\S]{0,220}if \(!el\.offsetParent\) return;/.test(opt));
  check('切到「变量」标签会补量一次（存档里的多行值要撑开）',
    opt.includes("btn.dataset.tab === 'vars'") && opt.includes('growVarValues()'));

  const css = readFileSync(new URL('../options.css', import.meta.url), 'utf8');
  check('值输入框有 min-height 兜底（任何时候都不该扁成缝）',
    /\.var-edit-val textarea\[data-kind='value'\] \{[\s\S]{0,400}min-height:\s*30px/.test(css));

  /* 一条变量 = 紧凑一行 + 点击编辑（kniph 2026-10-14：「不显示所有的内容，而是你点击
     的时候再让你修改，这样查找起来方便的多」—— 学华词翻译的设置列表）。
     两轮教训：一张表（名字列被压瘦）→ 上下两行（13 条摊 26 行，找一条滚很久）。 */
  check('变量是紧凑行 + 点击编辑（.var-row 摘要态 / .editing 编辑态，不摊全文）',
    /function renderVars[\s\S]{0,4000}idx !== editingVarIdx/.test(opt) &&
      /editingVarIdx = idx;[\s\S]{0,60}renderVars\(\);/.test(opt) &&
      opt.includes('function varValueSummary') &&
      !/<tbody id="vars-body">/.test(readFileSync(new URL('../options.html', import.meta.url), 'utf8')));
  check('摘要不泄密：含 key 的名字只显示圆点，不显示长度',
    /isSecretVar\(v\.name\)\) return '••••••';/.test(opt));
  check('摘要支持多行值：首行 + 「 +N」标记（model 列表一眼认出有几行）',
    /`\$\{first\} \+\$\{lines\.length - 1\}`/.test(opt));
  check('编辑态值框独占一行（flex:1），名字框跟着卡片宽度走但不放更宽',
    /\.var-edit-val textarea\[data-kind='value'\] \{[\s\S]{0,120}flex: 1; min-width: 0;/.test(css) &&
      // 编辑态的卡片横跨整行（grid-column: 1 / -1），名字框 260px 那个死宽白留着不合适了：
      // 改成 flex: 1 + max-width，太长的名字最多占 420px，剩下留给值那一栏
      /\.var-edit-name input \{[\s\S]{0,160}flex: 1; max-width: 420px/.test(css) &&
      /\.var-row\.editing \{[\s\S]{0,60}grid-column: 1 \/ -1/.test(css));
  check('变量栏是网格不是列表（一行一条的话查找全靠滚动，kniph 要的「一目了然」）',
    /\.vars-list \{[\s\S]{0,220}display: grid[\s\S]{0,120}repeat\(auto-fill, minmax\(230px, 1fr\)\)/.test(css) &&
      // grid 子项默认 min-width:auto，值里的长 token 会把列撑得比卡片还宽 —— 必须显式 0
      /\.var-main \{[\s\S]{0,120}min-width: 0/.test(css) &&
      /\.var-sub \{[\s\S]{0,200}-webkit-line-clamp: 2/.test(css) &&
      // -webkit-box 的高度由内容行数决定，值只有一行时会缩一行、网格把它拉起来底部空一块
      /\.var-sub \{[\s\S]{0,240}min-height: 31px/.test(css));
  check('变量卡片也能拖动排序（复用同一个 bindSortDrag，不是另写一套）',
    // 四处左栏/卡片共用一个函数，`grid: true` 是「落点按最近的卡 + 左半还是右半算」
    /function bindSortDrag\(listEl, applyMove, opts = \{\}\)/.test(opt) &&
      /const gridSpot = \(x, y\) =>/.test(opt) &&
      /const spotAt = \(x, y\) => \(isGrid \? gridSpot\(x, y\) : dropSpot\(listEl, y, ITEM\)\)/.test(opt) &&
      /bindSortDrag\(\s*els\.varsBody,[\s\S]{0,900}\{ itemSel: '\.var-row', gripSel: '\.var-grip', grid: true \}/.test(opt) &&
      // 手柄两条硬约束抄自 .cfg-grip：漏了 touch-action 触屏就拖不动
      /\.var-grip \{[\s\S]{0,400}touch-action: none/.test(css) &&
      /\.var-grip svg \{[\s\S]{0,80}pointer-events: none/.test(css) &&
      // 网格里的指示线是竖的：横线在一行好几张的网格里分不清落在哪一列
      /\.var-row\.drop-before::before \{ left: -3px; \}/.test(css) &&
      /\.var-row\.drop-after::after \{ right: -3px; \}/.test(css));
  check('growVarValues 只撑编辑态那块（摘要行里没有 textarea）',
    /closest\('\.var-row\.editing'\)/.test(opt));
  check('删除时编辑态下标跟着修（删了上一条，正在编辑的那条不该错位）',
    /if \(editingVarIdx === idx\) editingVarIdx = -1;[\s\S]{0,80}else if \(editingVarIdx > idx\) editingVarIdx -= 1;/.test(opt));
}

section('28. 截图那一步失败点 ↻：重发**刚才那张图**，两条路都不许再去翻剪切板');
{
  /* 用户的心智：↻ = 拿刚才那张再发一次。旧实现是 `startOcr()` → 发一条不带图的
     `{type:'ocr'}`，后台只能去读剪切板 —— 用户在那之后复制了别的东西，重试就发了
     一张完全不相关的图（kniph 报的 bug）。
     图在哪儿：直传那张 content 自己存着（lastOcr.image）；OCR 那两条路（剪切板 /
     框选）图在后台手里，发 reuse 让它接着用上一次那张。 */
  const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  const bg = readFileSync(new URL('../background.js', import.meta.url), 'utf8');

  /* formatBytes 有**两份**（设置页 options.js + 面板 content.js，后者不能 import）。
     它们显示的是同一个量（截图 / 响应的大小），必须逐字一致 —— 原来小数位规则不同，
     同一张图会出现「设置页 49 KB / 面板 48.8 KB」（kniph 2026-10-18 通读发现）。
     这里把两边函数体抽出来逐值比对，不是只看「有没有这个函数」。 */
  /* 按**花括号配对**取函数体（不能直接找 '\n}' —— content.js 那份是缩进过的，
     结尾是 '\n  }'，朴素查找会切错）。 */
  const grabFn = (src, name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    let depth = 0;
    for (let k = src.indexOf('{', i); k < src.length; k += 1) {
      if (src[k] === '{') depth += 1;
      else if (src[k] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(i, k + 1);
      }
    }
    return '';
  };
  const fbOpt = grabFn(readFileSync(new URL('../options.js', import.meta.url), 'utf8'), 'formatBytes');
  const fbCon = grabFn(readFileSync(new URL('../content.js', import.meta.url), 'utf8'), 'formatBytes');
  const norm = (t) => t.split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  check('两份 formatBytes 逐字一致（设置页 vs 面板）',
    !!fbOpt && !!fbCon && norm(fbOpt) === norm(fbCon));
  // 真的跑一遍：两份对同一批字节数必须给同一个字符串
  const mk = (body) => new Function('n', body.replace(/^function formatBytes\(n\)\s*\{/, '').replace(/\}\s*$/, ''));
  const f1 = mk(fbOpt);
  const f2 = mk(fbCon);
  const samples = [0, 1, 512, 1023, 1024, 2048, 9999, 10240, 27700, 50000, 1048575, 1048576, 2097152];
  const diff = samples.filter((n) => f1(n) !== f2(n));
  check('两份 formatBytes 对同一批值输出相同（0 到 2MB）', diff.length === 0,
    diff.length ? diff.map((n) => n + ':' + f1(n) + '≠' + f2(n)).join(' ') : f1(50000));
  check('formatBytes 边界：<1KB 是整数 B、1MB 起走 MB',
    f1(512) === '512 B' && f1(1024) === '1.0 KB' && f1(1048576) === '1.0 MB',
    [f1(512), f1(1024), f1(1048576)].join(' | '));
  check('formatBytes 不给负数 / 非数字出怪值', f1(-5) === '0 B' && f1('abc') === '0 B', f1(-5) + ' | ' + f1('abc'));
  /* postOrFail 必须接住 postMessage 抛出的异常（kniph 2026-10-18 第 8 轮通读）。
     端口「存在但已断开」时 Chrome 会抛 "Attempting to use a disconnected port object"。
     **抠 content.js 的真代码跑**（不比对源码字面量）—— 造一个会抛的假端口。 */
  const csrcForPof = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  const pofSrc = (() => {
    const i = csrcForPof.indexOf('function postOrFail(');
    if (i < 0) return '';
    let depth = 0;
    for (let k = csrcForPof.indexOf('{', i); k < csrcForPof.length; k += 1) {
      if (csrcForPof[k] === '{') depth += 1;
      else if (csrcForPof[k] === '}') { depth -= 1; if (!depth) return csrcForPof.slice(i, k + 1); }
    }
    return '';
  })();
  check('能从 content.js 里抠出 postOrFail()', !!pofSrc);
  let goneHits = 0;
  const postOrFail = new Function('portGone', 'return (' + pofSrc + ')')(() => { goneHits += 1; });
  const sent = [];
  const okPort = { postMessage: (m) => sent.push(m) };
  check('postOrFail：端口正常时发出消息并返回 true',
    postOrFail(okPort, { type: 'x' }) === true && sent.length === 1 && goneHits === 0);

  const deadPort = { postMessage() { throw new Error('Attempting to use a disconnected port object'); } };
  let threw = false;
  let ret = null;
  try { ret = postOrFail(deadPort, { type: 'y' }); } catch { threw = true; }
  check('postOrFail：端口已断开时不把异常抛给调用方', threw === false);
  check('postOrFail：端口已断开时返回 false 并走 portGone 收场', ret === false && goneHits === 1,
    'ret=' + ret + ' gone=' + goneHits);
  check('postOrFail：完全没有端口时同样走 portGone',
    postOrFail(null, { type: 'z' }) === false && goneHits === 2, 'gone=' + goneHits);
  /* 同一个文件里另外两处裸 postMessage 也必须是包住的（作者原来就包了，别改回去） */
  const bareSends = [...csrcForPof.matchAll(/port\.postMessage\(\{ type: 'abort' \}\)/g)].length;
  const guardedSends = [...csrcForPof.matchAll(/try \{\s*\n\s*port\.postMessage\(\{ type: 'abort' \}\)/g)].length;
  check('两处 abort 的 postMessage 都还在 try/catch 里', bareSends === 2 && guardedSends === 2,
    'abort 发送点 ' + bareSends + ' 处，包住的 ' + guardedSends + ' 处');
  /* ---- background 的并发/生命周期（kniph 2026-10-18 第 3 轮通读）---- */
  const bgSrc = bg; // 上面已经读过
  /* abort 必须**同时**让批次号过期 —— abort() 只是让请求早点停，它有个窄窗口：
     请求刚好在 abort 之前收完，runRequest / runOcr 会正常返回成功，光靠 signal
     拦不住那一帧，回包会打到一个用户已经关掉的面板上。 */
  /* 老形状（没有 request 字段）的 OCR 存档迁移：**字段优先、内置补缺**。
     早先这里是 `normalizeOcrProvider(old)` —— 只吃存档不看内置，于是老用户升级后
     内置那条的 note（「个人认证每月 1000 次免费…」）被丢成空串（kniph 2026-10-18 通读）。 */
  const oldShape = normalizeOcrState({
    providers: [{ id: 'builtin-siliconflow', name: '我的硅基', endpoint: 'https://x/y', model: 'm', apiKey: 'sk-real', prompt: 'p' }]
  }).providers.find((x) => x.id === 'builtin-siliconflow');
  check('老形状迁移：内置 note 不再被丢掉', !!oldShape.note, JSON.stringify(oldShape.note).slice(0, 30));
  check('老形状迁移：Key 仍然内联进模板（内置 {{apiKey}} 不许漏进来）',
    oldShape.request.includes('sk-real') && !oldShape.request.includes('{{apiKey}}'));
  check('老形状迁移：用户自己的名字优先于内置名', oldShape.name === '我的硅基', oldShape.name);
  /* 新形状必须仍然逐字段覆盖 —— 别为了补内置把用户改过的模板顶掉 */
  const newShape = normalizeOcrState({
    providers: [{ id: 'builtin-siliconflow', name: '改过的', request: 'curl https://mine' }]
  }).providers.find((x) => x.id === 'builtin-siliconflow');
  check('新形状存档仍然逐字段覆盖内置',
    newShape.request === 'curl https://mine' && newShape.name === '改过的');
  check('abort 时 runBatch 递增（不只是 abort controller）',
    /if \(msg\.type === 'abort'\)[\s\S]{0,400}runBatch \+= 1/.test(bgSrc));
  check('abort 时 ocrSeq 递增（OCR 那条同样要判废）',
    /if \(msg\.type === 'abort'\)[\s\S]{0,400}ocrSeq \+= 1/.test(bgSrc));
  /* runCtrls 是「每条配置一个 controller」的 Map：早退（没模板 / 抛错）和正常结束
     都要把自己摘掉，否则一轮轮翻译下来这个 Map 只增不减。 */
  check('runCtrls 在每个出口都会 delete（早退 + 正常结束）',
    (bgSrc.match(/runCtrls\.delete\(cid\)/g) || []).length >= 3,
    '实际 ' + (bgSrc.match(/runCtrls\.delete\(cid\)/g) || []).length + ' 处');
  check('有一个专门的重试入口 retryShot', src.includes('function retryShot()'));
  /* 重试入口 2026-10-17 从顶栏搬到了译文尾部（retryOne）；
     这条断言盯的是「没有原文时走 retryShot、而不是重新去读剪切板」这个不变量。 */
  check('重试入口改走 retryShot，不再自己去 startOcr（那条会读剪切板）',
    /if \(!currentText && !\(lastOcr && lastOcr\.image\)\) \{\s*retryShot\(\);\s*return;\s*\}/.test(src) &&
    !/if \(!currentText\) \{[\s\S]{0,200}startOcr\(lastOcrAnchor\)/.test(src));
  check('直传那条路本地重发（图 content 自己就有，不用惊动后台）',
    src.includes('lastOcr.direct && lastOcr.image') &&
    src.includes("translate('', '', { direct: true, image: lastOcr.image, bytes: lastOcr.bytes })"));
  check('OCR 那两条路发 reuse，让后台接着用上一次那张',
    src.includes("{ type: 'ocr', reuse: true }"));

  check('后台记着上一次真正用过的截图', /let lastShot = null;/.test(bg));
  check('后台认 reuse（优先用记着的那张，其次才去读剪切板）',
    bg.includes('msg.reuse && lastShot'));
  const reuseIdx = bg.indexOf('msg.reuse && lastShot');
  check('reuse 命中时不去读剪切板（读剪切板那一步排在它后面）',
    reuseIdx > 0 && bg.indexOf('await readClipboardImage()', reuseIdx) > reuseIdx);
  check('只有真拿到图才记下来（失败那几次不算）',
    /if \(!shot \|\| !shot\.ok\) \{[\s\S]{0,500}?lastShot = shot;/.test(bg));
  check('端口协议那行注释写了 reuse（这机制光看代码看不出来）',
    /type:'ocr', dataUrl\?, reuse\?/.test(bg));

  /* ---- 直传那一屏：原文区贴的就是那张图 ---- */
  check('直传时把截图贴进原文区（OCR 中转不贴 —— 那边原文是认出来的文字）',
    src.includes('if (hasImage) renderSrcImage(ocr.image);'));
  check('renderSrcImage 只有这一个调用点', (src.match(/renderSrcImage\(/g) || []).length === 2,
    String((src.match(/renderSrcImage\(/g) || []).length));
  check('页面 CSP 挡掉 data: 图时有兜底（挂 img 的 error）',
    /function renderSrcImage[\s\S]{0,600}addEventListener\('error'/.test(src));
  check('兜底之后那句「没有先做外置 OCR」还在（不然用户不知道发生了什么）',
    src.includes("const DIRECT_SRC_NOTE = '（这张截图直接发给了模型，没有先做外置 OCR）'") &&
    /addEventListener\('error'[\s\S]{0,300}DIRECT_SRC_NOTE/.test(src));
  check('换回文字原文时会摘掉 has-img（不然那块高度上限一直撑着）',
    /classList\.remove\('has-img'\)/.test(src));

  const css = PANEL_CSS;   // 唯一真相源在 lib/panel-core.js（2026-11-09 合并）
  check('贴出来的图有尺寸上限（长截图不该把面板撑破）',
    /\.rt-src \.rt-srcimg \{[\s\S]{0,400}max-height:\s*11em/.test(css));
  check('原文区有图时高度上限抬高（不然 6em 里塞不下图 + 那句话）',
    css.includes('.rt-src.has-img { max-height: 14em; }'));
}


/* ------------------------------------------------------------------ */

/* ---- 导出文件口令加密（lib/crypto.js）----
   全异步，放在最后统一 await。测试点：往返、错口令必炸、篡改必炸、
   sniff 不认明文、明文导出不受影响（老用户路径一根汗毛都不能动）。 */
{
  const plain = exportState({
    configs: DEFAULT_CONFIGS, vars: [], settings: DEFAULT_SETTINGS,
    activeConfigId: DEFAULT_CONFIGS[0].id, ocr: { disabled: false }
  });

  // 明文导出没有任何加密痕迹 —— 老用户升级后导出的文件应该和以前一模一样地被认
  check('明文导出不会被误认成加密文件', isEncryptedExport(plain) === false);

  const wrapped = await encryptExport(plain, '正确口令');
  check('加密外壳的 kind 与明文导出区分开', isEncryptedExport(wrapped) === true);
  check('外壳里找不到明文痕迹（key 一个字都不落）',
    !wrapped.includes('api') || !wrapped.toLowerCase().includes('sk-'));

  const roundtrip = await decryptExport(wrapped, '正确口令');
  check('往返后逐字节还原', roundtrip === plain,
    `差了 ${Math.abs(roundtrip.length - plain.length)} 字符`);

  let wrongPassErr = '';
  try { await decryptExport(wrapped, '错误口令'); } catch (err) { wrongPassErr = err.message; }
  check('错口令直接报「口令不对」（GCM 语义：不存在解出一堆乱码）',
    wrongPassErr.includes('口令不对'), wrongPassErr || '没抛错');

  // 篡改密文一个字节 —— 完整性校验必须抓住（这就是选 AES-GCM 而不是 CBC 的原因）
  // 定位串不能带空格：JSON.stringify 无缩进，外壳是 "data":"hex"（冒号后没有空格）
  const dataIdx = wrapped.indexOf('"data":"') + 8;
  const tampered = wrapped.slice(0, dataIdx) + (wrapped[dataIdx] === '0' ? '1' : '0') + wrapped.slice(dataIdx + 1);
  check('（脚手架）改的确实是密文本身', tampered !== wrapped && tampered.slice(0, 30) === wrapped.slice(0, 30));
  let tamperErr = '';
  try { await decryptExport(tampered, '正确口令'); } catch (err) { tamperErr = err.message; }
  check('密文被改一个字节也解不开（完整性）', tamperErr.includes('口令不对'), tamperErr || '没抛错');

  // 明文文件喂给解密函数 —— 应该报「不是加密文件」而不是试图解
  let notEncErr = '';
  try { await decryptExport(plain, 'x'); } catch (err) { notEncErr = err.message; }
  check('明文文件喂给解密会被明确拒绝', notEncErr.includes('不是加密导出'), notEncErr || '没抛错');

  // 空口令在加密入口就拦（别让「空口令加密」的文件存在）
  let emptyErr = '';
  try { await encryptExport(plain, ''); } catch (err) { emptyErr = err.message; }

  /* 外壳里的 `iterations` **必须真的被用上**（kniph 2026-10-18 第 9 轮通读发现）：
     它写进格式就是为了让「加密时的次数」跟着文件走。原来 decryptExport 用的是模块常量，
     于是只要将来把 ITERATIONS 调大，**所有老文件都解不开**，还报「口令不对」——
     用户会以为自己记错了口令。这里造一个「别的次数」的文件，证明它能开。 */
  const encU8 = new TextEncoder();
  const hexOf = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const craftWithIterations = async (pass, iterations) => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const km = await crypto.subtle.importKey('raw', encU8.encode(pass), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
      km, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encU8.encode('{"a":1}'));
    return JSON.stringify({
      kind: 'request-translate-encrypted',
      crypto: { scheme: 'pbkdf2-aesgcm-v1', salt: hexOf(salt), iv: hexOf(iv), iterations },
      data: hexOf(cipher)
    });
  };
  let otherIterOk = false;
  let otherIterErr = '';
  try {
    otherIterOk = (await decryptExport(await craftWithIterations('正确口令', 100000), '正确口令')).trim() === '{"a":1}';
  } catch (err) { otherIterErr = err.message; }
  check('外壳里 iterations 不同的文件也能解开（不是只认常量 60 万）',
    otherIterOk, otherIterErr || '');

  /* 值非法时要**明说是文件参数不对**，不能混进「口令不对」那句里 */
  /* 「单次最多发送字数」的执行点**只能有一处**：content.js 的 translate()。
     frame-bridge.js 原来写死 slice(0, 8000)，于是把上限调到 8000 以上的用户，
     普通页面能发 5 万字、iframe 里的选区却被静默砍到 8000（kniph 2026-10-18 通读）。 */
  const bridgeSrc = readFileSync(new URL('../frame-bridge.js', import.meta.url), 'utf8');
  const csrcForCap = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  const capInTranslate = /const limit = Math\.max\(1, Number\(prefs\.maxChars\) \|\| 8000\)/.test(csrcForCap);
  check('content.js 仍然按 maxChars 截（唯一执行点还在）', capInTranslate);
  /* 比对前先**剥掉注释** —— 上面那段说明文字里就写着 `slice(0, 8000)`，
     不剥的话断言会被自己的注释绊倒。 */
  const stripComments = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const bridgeCode = stripComments(bridgeSrc);
  check('frame-bridge 的**代码**里没有写死的字数上限',
    !/slice\(0, \d+\)/.test(bridgeCode),
    (bridgeCode.match(/slice\(0, \d+\)/) || ['(无)'])[0]);
  /* 两边口径要一致：设置项上限 200000，别哪天桥里又冒出一个小数字 */
  const maxInput = readFileSync(new URL('../options.html', import.meta.url), 'utf8')
    .match(/id="s-max"[^>]*max="(\d+)"/);
  check('设置项 #s-max 的上限仍是 200000（和桥的「不设限」口径一致）',
    !!maxInput && maxInput[1] === '200000', maxInput ? maxInput[1] : '(没找到)');

  /* 要读本地文件的 curl 参数（-d @file / -F / -T）**必须出声**（kniph 2026-10-18 通读）。
     README 把它们列成「限制」，可行為是：`-d @f` 把 @f 当请求体发出去、`-F` 直接丢掉 ——
     用户从 API 文档抄一段过来只会收到看不懂的服务端报错。
     另：parseCurl 的 warnings 字段原来**永远是空数组**，而且 engine/options 都没读它，
     这条断言同时钉住「真的会 push」和「真的被带出去」。 */
  const warnOf = (src) => parseRequest(src).warnings || [];
  check('curl 的 -d @file 会给出提示（不再静默发 @文件）',
    warnOf('curl https://x -d @body.json').some((w) => /@文件/.test(w)),
    JSON.stringify(warnOf('curl https://x -d @body.json')));
  check('curl 的 --data-binary @file 同样给提示',
    warnOf('curl https://x --data-binary @b.json').some((w) => /@文件/.test(w)));
  check('curl 的 -F / --form / -T 给「不支持上传文件」的提示',
    warnOf('curl https://x -F a=@b.png').some((w) => /不支持/.test(w)) &&
      warnOf('curl https://x -T ./a.json').some((w) => /不支持/.test(w)) &&
      warnOf('curl https://x --form k=v').some((w) => /不支持/.test(w)));
  check('同一条参数写多次只提示一次（不刷屏）',
    warnOf('curl https://x -F a=1 -F b=@c.png').filter((w) => /不支持/.test(w)).length === 1);
  check('正常 curl 不会平白多出提示', warnOf('curl https://x -d "a=1"').length === 0,
    JSON.stringify(warnOf('curl https://x -d "a=1"')));
  /* 带出去这一环：引擎的 runRequest 和 previewRequest 都要带上 */
  const engSrc = readFileSync(new URL('../lib/engine.js', import.meta.url), 'utf8');
  check('runRequest 把解析期提示并进 result.warnings',
    /result\.warnings\.push\(\.\.\.\(parsed\.warnings \|\| \[\]\)\)/.test(engSrc));
  check('previewRequest 也返回 warnings（设置页预览要看得见）',
    /warnings: parsed\.warnings \|\| \[\]/.test(engSrc));
  const pvWarn = previewRequest('curl https://x -d @body.json', {}, '');
  check('预览这条路真的带出了提示', (pvWarn.warnings || []).some((w) => /@文件/.test(w)),
    JSON.stringify(pvWarn.warnings));

  /* connectPort 里那句 postMessage(hello) 也必须是包住的（kniph 2026-10-18 复查）。
     onDisconnect 是异步的：端口刚建立就被对端丢掉时，这一句会当场抛
     "Attempting to use a disconnected port object"，而它在 try 外面 ——
     异常会炸给 ensurePort() 的每个调用点。抠真代码 + 假端口验一遍：
     connectPort 要么返回可用端口，要么返回 null，**绝不抛**。 */
  {
    const csrcHello = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
    const grabFn2 = (name) => {
      const i = csrcHello.indexOf('function ' + name + '(');
      if (i < 0) return '';
      let d = 0;
      for (let k = csrcHello.indexOf('{', i); k < csrcHello.length; k += 1) {
        if (csrcHello[k] === '{') d += 1;
        else if (csrcHello[k] === '}') { d -= 1; if (!d) return csrcHello.slice(i, k + 1); }
      }
      return '';
    };
    const cpSrc = grabFn2('connectPort');
    check('能从 content.js 里抠出 connectPort()', !!cpSrc);
    const mkConnect = (throwOnSend) => {
      const fakeChrome = {
        runtime: {
          connect: () => ({
            onMessage: { addListener() {} },
            onDisconnect: { addListener() {} },
            postMessage() {
              if (throwOnSend) throw new Error('Attempting to use a disconnected port object');
            }
          })
        }
      };
      // connectPort 依赖三个外部符号：onPortMessage / busy / portGone —— 都给桩
      const prelude =
        'let port = null; let busy = false;\n' +
        'const portGone = () => { busy = true; };\n' +
        'const onPortMessage = () => {};\n';
      return new Function('chrome', prelude + cpSrc + '\nreturn connectPort;')(fakeChrome);
    };
    const good = mkConnect(false);
    let okPort = null;
    let okThrew = false;
    try { okPort = good(); } catch { okThrew = true; }
    check('connectPort：端口正常时返回端口、不抛', okThrew === false && !!okPort);
    const bad = mkConnect(true);
    let badRet;
    let badThrew = false;
    try { badRet = bad(); } catch { badThrew = true; }
    check('connectPort：hello 发不出去时不抛给调用方', badThrew === false, badThrew ? '抛了' : '没抛');
    check('connectPort：hello 发不出去时返回 null（退化成「端口拿不到」）', badRet === null, String(badRet));
  }

  /* 面板也会写几个设置键（showOriginal / targetLang / ocr.imageConfigId），
     而设置页是「整份 state 覆盖写」—— 不做合并的话，「面板里关了原文 → 回设置页随手
     打个字」会把面板的改动静默顶回去（kniph 2026-10-18 通读发现）。
     合并逻辑抽在 store 的 adoptPanelOwned（纯函数），这里钉住它的契约。 */
  {
    const mkP = () => ({ settings: { showOriginal: true, targetLang: '简体中文', fontSize: 20 }, ocr: { imageConfigId: '' } });
    const savedP = () => ({ settings: { showOriginal: false, targetLang: '日语', fontSize: 99 }, ocr: { imageConfigId: 'cfg-x' } });

    const a = mkP();
    adoptPanelOwned(a, savedP(), new Set());
    eq('面板改过的 showOriginal 不会被设置页顶回去', a.settings.showOriginal, false);
    eq('面板改过的 targetLang 不会被顶回去', a.settings.targetLang, '日语');
    eq('面板改过的 imageConfigId 不会被顶回去', a.ocr.imageConfigId, 'cfg-x');
    eq('存档里与面板无关的键不该被搬过来（fontSize 保持页面值）', a.settings.fontSize, 20);

    const b = mkP();
    adoptPanelOwned(b, savedP(), new Set(['showOriginal']));
    eq('用户在设置页动过的键以页面为准', b.settings.showOriginal, true);
    eq('没动过的键仍然跟存档', b.settings.targetLang, '日语');

    const c = mkP();
    adoptPanelOwned(c, null, new Set());
    adoptPanelOwned(c, {}, new Set());
    eq('存档读不到 / 缺字段时不炸、保持原值', c.settings.showOriginal, true);

    const d = mkP();
    adoptPanelOwned(d, savedP(), ['targetLang']);
    eq('touched 传数组也认', d.settings.targetLang, '简体中文');
  }

  /* 流式分片的「该重画了」那条路上，**定位槽位的地方只能有一处**：
     onPortMessage 用 slotForMsg(msg) 把文本写进对应槽，queueDelta 只管节流重画。
     原来 queueDelta 还带个 text 参数、收下就往 slots[0] 里写 —— 实际没人传过（死代码），
     但签名像「支持传文本」，真传了多配置时就会写进第一条（错的块）（kniph 2026-10-18 通读）。 */
  {
    const csrcQ = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
    const qFn = (() => {
      const i = csrcQ.indexOf('function queueDelta(');
      if (i < 0) return '';
      let d = 0;
      for (let k = csrcQ.indexOf('{', i); k < csrcQ.length; k += 1) {
        if (csrcQ[k] === '{') d += 1;
        else if (csrcQ[k] === '}') { d -= 1; if (!d) return csrcQ.slice(i, k + 1); }
      }
      return '';
    })();
    check('queueDelta 不再收 text 参数', /function queueDelta\(\s*\)/.test(qFn), qFn.split('\n')[0]);
    check('queueDelta 不碰任何槽位的文本（只负责排重画）',
      !/slots\[0\]/.test(qFn) && !/\.text\s*=/.test(qFn));
    check('delta 消息仍然用 slotForMsg 定位槽位（别改成写死 slots[0]）',
      /msg\.type === 'delta'[\s\S]{0,220}slotForMsg\(msg\)/.test(csrcQ));
    check('queueDelta 全文件只有一个调用点、且不传参',
      (csrcQ.match(/queueDelta\(/g) || []).length === 2 &&
        !/queueDelta\([^)]/.test(csrcQ.replace('function queueDelta(', '')),
      String((csrcQ.match(/queueDelta\([^)]*/g) || []).join(' | ')));
  }

  /* 翻译记录写入必须**串行**（kniph 2026-10-18 通读发现）。
     一次对比会并发跑 2~4 条配置（Promise.all），每条跑完都往 history 里插一条，
     而写入是「读 → 改 → 写」的读改写、中间隔着 await —— 不排队就会互相覆盖。
     实测（修复前，用同一份模拟）：并发 2 条只剩 1 条、并发 4 条也只剩 1 条。
     这里**抠 background.js 的真代码**跑，不比对源码字面量。 */
  const bgSrcForHist = readFileSync(new URL('../background.js', import.meta.url), 'utf8');
  const histFnSrc = (() => {
    const i = bgSrcForHist.indexOf('function appendHistory(');
    if (i < 0) return '';
    let d = 0;
    for (let k = bgSrcForHist.indexOf('{', i); k < bgSrcForHist.length; k += 1) {
      if (bgSrcForHist[k] === '{') d += 1;
      else if (bgSrcForHist[k] === '}') { d -= 1; if (!d) return bgSrcForHist.slice(i, k + 1); }
    }
    return '';
  })();
  check('能从 background.js 里抠出 appendHistory()', !!histFnSrc);
  const mkAppend = () => {
    const st = { state: { version: 9, history: [] } };
    const fakeChrome = { storage: { local: {
      get: async () => { await null; await null; return { state: JSON.parse(JSON.stringify(st.state)) }; },
      set: async (o) => { await null; st.state = JSON.parse(JSON.stringify(o.state)); }
    } } };
    const fn = new Function('chrome', 'let historyQueue = Promise.resolve();\n' + histFnSrc + '\nreturn appendHistory;')(fakeChrome);
    return { fn, names: () => st.state.history.map((h) => h.configName), reset: () => { st.state.history = []; } };
  };
  const rec = (fn, n, max = 10) => fn({ configName: n, src: n, dst: n, lang: '', ts: Date.now() }, max);

  {
    const h = mkAppend();
    await rec(h.fn, '甲');
    await rec(h.fn, '乙');
    eq('翻译记录：顺序写两次 → 两条都在', h.names().length, 2);
  }
  {
    const h = mkAppend();
    await Promise.all([rec(h.fn, '甲'), rec(h.fn, '乙')]);
    eq('翻译记录：并发 2 条（对比模式）→ **一条都不丢**', h.names().length, 2);
  }
  {
    const h = mkAppend();
    await Promise.all(['甲', '乙', '丙', '丁'].map((n) => rec(h.fn, n)));
    eq('翻译记录：并发 4 条 → 四条都在', h.names().length, 4);
  }
  {
    const h = mkAppend();
    await Promise.all(['甲', '乙', '丙', '丁'].map((n) => rec(h.fn, n, 2)));
    eq('翻译记录：并发 4 条 + 上限 2 → 只留最新的两条（且顺序是新的在前）',
      h.names().join(','), '丁,丙');
  }
  {
    /* 有一次写失败不能把队列卡死（.then(run, run) 的意义） */
    const st = { state: { version: 9, history: [] } };
    let calls = 0;
    const flakyChrome = { storage: { local: {
      get: async () => { calls += 1; if (calls === 1) throw new Error('storage 抽风'); return { state: JSON.parse(JSON.stringify(st.state)) }; },
      set: async (o) => { st.state = JSON.parse(JSON.stringify(o.state)); }
    } } };
    const fn = new Function('chrome', 'let historyQueue = Promise.resolve();\n' + histFnSrc + '\nreturn appendHistory;')(flakyChrome);
    await rec(fn, '坏的');
    await rec(fn, '好的');
    eq('翻译记录：一次写失败不影响后续排队（队列不卡死）', st.state.history.map((x) => x.configName).join(','), '好的');
  }

  /* ocrErrorHint 的两条提示原来**对真实报错从来不触发**（kniph 2026-10-18 覆盖率扫出来的
     未执行分支，排查后发现不是「测试没写」而是「写错了」）：
       · 模型名：原来用 model.{0,24}(…) —— 真机里「model」和「does not exist」之间夹着模型全名
         （Con 反引号、带斜杠），实测间隔 32 字符，窗口够不着
       · 百度：原来只认 access_token（下划线），而百度文案是「Access token invalid」（空格）
     放宽后还要防误报：正文里「回显 model + 无关的 invalid/unknown」不能算模型名错。 */
  const hitsModelHint = (b) => /模型名/.test(ocrErrorHint(b));
  const hitsBaiduHint = (b) => /access_token/.test(ocrErrorHint(b));

  check('模型名提示：带反引号的 The model ... does not exist 能命中',
    hitsModelHint('{"error":{"message":"The model \u0060deepseek-ai/DeepSeek-OCRR\u0060 does not exist"}}'));
  check('模型名提示：模型名很长时也能命中（不靠距离判定）',
    hitsModelHint('{"error":{"message":"The model \u0060vendor/some-really-long-model-name-v2-preview-0731\u0060 does not exist"}}'));
  check('模型名提示：OpenAI 那种「does not exist or you do not have access」也能命中',
    hitsModelHint('{"error":{"message":"The model gpt-5-vision does not exist or you do not have access to it."}}'));
  check('百度提示：Access token（空格）这种真实文案能命中',
    hitsBaiduHint('{"error_code":110,"error_msg":"Access token invalid or no longer valid"}'));
  check('百度提示：error_code 111 也能命中', hitsBaiduHint('{"error_code":111,"error_msg":"Access token invalid"}'));
  check('不误报：正文回显了 model、后面跟着无关的 invalid',
    !hitsModelHint('{"model":"gpt-4","error":{"message":"invalid request format"}}'));
  check('不误报：正文回显了 model、后面跟着无关的 unknown',
    !hitsModelHint('{"model":"gpt-4","note":"unknown field is ignored"}'));
  check('不误报：限流 / 配额 / 余额不足都别扯到模型名',
    !hitsModelHint('{"error":{"message":"Rate limit reached"}}') &&
      !hitsModelHint('{"error":{"message":"insufficient_quota"}}') &&
      !hitsModelHint('{"error":{"message":"Insufficient balance"}}'));

  /* SSE 的 CRLF 跨块处理（kniph 2026-10-18 用假 Response 精确控制块边界发现）。
     同一串流，块边界不同结果必须一样 —— 尤其「\r 在块尾、\n 在块头」这种 TCP 切法。
     早先那版把 \r 先塞回 buffer 再处理本块，塞回去的 \r 不在本块的 replace 范围里，
     于是 buffer 里留下 \n\r\n（该是 \n\n），事件切不开、整条流被末尾兜底拼成一个
     payload，JSON 解不开就当纯文本吐出去 —— 实测会得到一坨原始 JSON。 */
  const mkRes = (chunks, ctype) => {
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: (k) => (k.toLowerCase() === 'content-type' ? ctype : null) },
      body: {
        getReader: () => ({
          read: async () => (i < chunks.length ? { done: false, value: enc.encode(chunks[i++]) } : { done: true })
        })
      },
      text: async () => chunks.join('')
    };
  };
  const sseEv = (t) => 'data: {"choices":[{"delta":{"content":"' + t + '"}}]}';
  const sseStream = sseEv('甲') + '\r\n\r\n' + sseEv('乙') + '\r\n\r\n';
  const sseRead = async (chunks) =>
    (await readResponseBody(mkRes(chunks, 'text/event-stream'), { joiner: '', responseMode: 'auto' })).text;

  eq('SSE 一整块：两个事件都拿到', await sseRead([sseStream]), '甲乙');
  eq('SSE 按空行切开：不受影响', await sseRead([sseEv('甲') + '\n\n', sseEv('乙') + '\n\n']), '甲乙');
  eq('SSE 块尾 \\r / 块头 \\n（TCP 切开 CRLF）：不丢事件',
    await sseRead([sseEv('甲') + '\r\n\r', '\n' + sseEv('乙') + '\r\n\r\n']), '甲乙');
  eq('SSE 每个字节一块（极端切法）：仍然是甲乙', await sseRead(sseStream.split('')), '甲乙');
  eq('SSE 单事件、结尾没有空行：照样拿到', await sseRead([sseEv('甲')]), '甲');

  /* Bing 重试的提示语必须只在**重试真的成了**时才出现 ——
     否则「token 过期已重试」会和一条 HTTP 500 同时显示（kniph 2026-10-18 通读）。 */
  const adapterSrc = readFileSync(new URL('../lib/adapters.js', import.meta.url), 'utf8');
  check('Bing 重试提示只在重试成功时才加（不靠「有没有 body」判断）',
    /if \(res\.ok && raw\.trim\(\)\) \{\s*\n\s*result\.warnings\.push\('Bing 的 token 过期了/.test(adapterSrc),
    /if \(raw\.trim\(\)\) result\.warnings\.push/.test(adapterSrc) ? '旧写法还在' : 'ok');

  const badIterMsg = async (v) => {
    const f = JSON.stringify({ kind: 'request-translate-encrypted',
      crypto: { scheme: 'pbkdf2-aesgcm-v1', salt: '00', iv: '00', iterations: v }, data: '00' });
    try { await decryptExport(f, 'x'); return '(没抛错)'; } catch (err) { return err.message; }
  };
  check('iterations 是非法值时报「文件参数不对」，不赖口令',
    /参数不对/.test(await badIterMsg('abc')) && !/口令/.test(await badIterMsg('abc')),
    await badIterMsg('abc'));
  check('iterations 大到离谱时拒绝解密（防被塞个 1e12 卡死浏览器）',
    /异常大/.test(await badIterMsg(999999999999)), await badIterMsg(999999999999));
  check('空口令不让导出', emptyErr.includes('没有口令'), emptyErr || '没抛错');
}

/* ------------------------------------------------------------------ */

/* ---- 对比槽位（settings.panelSlots / slotConfigs 归一化）---- */
{
  const mkState = (settings) => ({
    version: 9,
    configs: [
      { id: 'a', name: 'A', request: 'r' },
      { id: 'b', name: 'B', request: 'r' },
      { id: 'c', name: 'C', request: 'r' }
    ],
    activeConfigId: 'a',
    vars: [],
    ocr: { disabled: false, providers: [], activeId: '' },
    settings
  });
  const loadWith = (state) => {
    const origGet = globalThis.chrome.storage.local.get;
    globalThis.chrome.storage.local.get = async () => ({ state });
    return loadState().finally(() => {
      globalThis.chrome.storage.local.get = origGet;
    });
  };

  // 默认：1 条、空槽位（面板端用 activeConfigId 兜底成一条）
  const d = await loadWith(mkState({}));
  check('默认显示 1 条、槽位空表', d.settings.panelSlots === 1 && d.settings.slotConfigs.length === 0);
  check('默认「新选的配置放最下面」（slotInsert=tail）', d.settings.slotInsert === 'tail', d.settings.slotInsert);

  /* 「新选的往哪边放」由用户自己定（kniph 2026-10-17：「出顶部顶掉尾部，出尾部顶掉顶部」）。
     只认 head / tail 两个值，别的一律回到 tail —— 老存档没这个键也走默认。 */
  const headSet = await loadWith(mkState({ slotInsert: 'head' }));
  check('slotInsert=head 会被保留', headSet.settings.slotInsert === 'head', headSet.settings.slotInsert);
  const junkSet = await loadWith(mkState({ slotInsert: '乱写' }));
  check('slotInsert 是垃圾值 → 回到 tail', junkSet.settings.slotInsert === 'tail', junkSet.settings.slotInsert);
  const oldSave = await loadWith(mkState({ panelSlots: 2 }));
  check('老存档没有 slotInsert 这个键 → tail（不用写迁移）', oldSave.settings.slotInsert === 'tail');

  // 上限夹取 + 去重 + 滤不存在的 + 按条数截断
  const n = await loadWith(mkState({ panelSlots: 99, slotConfigs: ['b', 'b', 'nope', 'c', 'a'] }));
  check('条数上限夹到 4', n.settings.panelSlots === 4, String(n.settings.panelSlots));
  check('槽位去重、滤掉不存在的配置、按条数截断',
    JSON.stringify(n.settings.slotConfigs) === JSON.stringify(['b', 'c', 'a']),
    JSON.stringify(n.settings.slotConfigs));

  const m = await loadWith(mkState({ panelSlots: 2, slotConfigs: ['b', 'c', 'a'] }));
  check('条数 2 时槽位只留前两条', JSON.stringify(m.settings.slotConfigs) === JSON.stringify(['b', 'c']));

  const bad = await loadWith(mkState({ panelSlots: 0, slotConfigs: 'x' }));
  check('条数 0 / 垃圾值 → 回到 1；槽位不是数组 → 空表',
    bad.settings.panelSlots === 1 && Array.isArray(bad.settings.slotConfigs) && bad.settings.slotConfigs.length === 0);

  // 导入也要走同一套归一化（备份文件里带槽位配置）
  const exported = exportState(mkState({ panelSlots: 2, slotConfigs: ['b', 'c'] }));
  const re = importState(exported);
  /* 导入时 historyMax 必须归一化 —— loadState 那边靠 `{...DEFAULT_SETTINGS}` 合并兜住了，
     但 importState 是**直接吃外部文件**的，`-5` / `"abc"` 会原样进来：
     负数让 background 的 `.slice(0, -5)` 从尾部倒砍，字符串静默变成 0（= 不记录）。 */
  const importHm = (v) => {
    const data = { kind: 'request-translate', configs: [{ id: 'a', name: 'A', request: 'r' }], settings: { historyMax: v } };
    return importState(JSON.stringify(data)).settings.historyMax;
  };
  check('导入时 historyMax 归一化：负数 → 0', importHm(-5) === 0, String(importHm(-5)));
  check('导入时 historyMax 归一化：非数字 → 0', importHm('abc') === 0, String(importHm('abc')));
  check('导入时 historyMax 归一化：null → 0', importHm(null) === 0, String(importHm(null)));
  check('导入时 historyMax 归一化：超上限 999 → 200', importHm(999) === 200, String(importHm(999)));
  check('导入时 historyMax 归一化：小数取整 3.7 → 4', importHm(3.7) === 4, String(importHm(3.7)));

  /* maxChars 也必须归一化（2026-10-18 复查）—— 和第 1 轮修的 historyMax 是同一类漏洞：
     importState 只做 { ...DEFAULT_SETTINGS, ...data.settings }，导入文件里的坏值原样进 state。
     而三个消费方表现不一致：content.js / background.js 有 Math.max(1, ...) 兜底，
     popup.js 直接 slice(0, x) —— slice(0, 'abc') 和 slice(0, 0) 都得到空串，
     弹窗里选中的文字整个消失；slice(0, -5) 还会从尾部倒砍。 */
  const importMc = (v) => {
    const data = { kind: 'request-translate', configs: [{ id: 'a', name: 'A', request: 'r' }], settings: { maxChars: v } };
    return importState(JSON.stringify(data)).settings.maxChars;
  };
  eq('导入时 maxChars 归一化：非数字 → 默认 8000', importMc('abc'), 8000);
  eq('导入时 maxChars 归一化：负数 → 默认 8000（不是 1、也不倒砍）', importMc(-5), 8000);
  eq('导入时 maxChars 归一化：0 → 默认 8000', importMc(0), 8000);
  eq('导入时 maxChars 归一化：null → 默认 8000', importMc(null), 8000);
  eq('导入时 maxChars 归一化：超上限 999999 → 200000', importMc(999999), 200000);
  eq('导入时 maxChars 归一化：小数取整 3.7 → 4', importMc(3.7), 4);
  eq('导入时 maxChars 归一化：正常值不动', importMc(5000), 5000);
  {
    const optSrcMax = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
    check('设置页 #s-max 清空时退回 8000，不写 0',
      /key: 'maxChars'[\s\S]{0,200}save: \(el\) => Number\(el\.value\) \|\| 8000/.test(optSrcMax));
    const popupSrcMax = readFileSync(new URL('../popup.js', import.meta.url), 'utf8');
    check('popup.js 用 maxChars 时有和另外两处一样的守卫',
      /Math\.max\(1, Number\(state\.settings\.maxChars\) \|\| 8000\)/.test(popupSrcMax));
  }
  check('导入时 historyMax 缺省 → 默认 10', importHm(undefined) === 10, String(importHm(undefined)));
  check('导入回来的槽位设置也归一化过', re.settings.panelSlots === 2 &&
    JSON.stringify(re.settings.slotConfigs) === JSON.stringify(['b', 'c']),
    JSON.stringify(re.settings.slotConfigs));
}

/* ---- 语音映射必须覆盖 TARGET_LANG_CODES 的每一种语言 --------------------------
   权威表在 lib/template.js（27 种）。content.js 不能 import，只能自己维护一份 ——
   这里用**真代码**（抠出 speechTagsFor 跑）比对：加语言时漏改会当场红。 */
/* ---- 朗读的语音挑选（2026-10-17 kniph 报「第二次朗读变粤语」）----
   这两个函数在 content.js 的 IIFE 里，测不到实例；但它们**纯逻辑**，
   这里按同样的算法复刻一份跑断言 —— 钉住两条不变量：
     ① 普通话绝不落到 zh-HK / zh-TW / yue；
     ② 「第一次列表为空、第二次才有」这个时序不能改变结果。
   改动那两个函数时，这里要一起改（否则断言会失去意义，注释里写清楚）。 */
{
  // —— 复刻：与 content.js 的 speechTagsFor / pickVoice 逐字一致 ——
  const SPEECH_DIALECT_TAGS = ['zh-hk', 'zh-tw', 'zh-hant', 'yue', 'hk', 'tw'];
  function speechTagsFor(lang) {
    const s = String(lang || '').toLowerCase();
    if (s.includes('繁体') || s.includes('繁體') || s.includes('zh-tw') || s.includes('zh-hant')) {
      return ['zh-TW', 'zh-HK'];
    }
    if (s.includes('英')) return ['en-US', 'en-GB', 'en'];
    if (s.includes('日')) return ['ja-JP', 'ja'];
    if (s.includes('韩') || s.includes('朝鲜')) return ['ko-KR', 'ko'];
    if (s.includes('法')) return ['fr-FR', 'fr'];
    if (s.includes('德')) return ['de-DE', 'de'];
    if (s.includes('俄')) return ['ru-RU', 'ru'];
    if (s.includes('西班牙')) return ['es-ES', 'es'];
    if (s.includes('葡萄牙')) return ['pt-BR', 'pt'];
    if (s.includes('意大利')) return ['it-IT', 'it'];
    if (s.includes('中文') || s.includes('简体') || s.includes('zh') || !s) {
      return ['zh-CN', 'zh-Hans', 'zh'];
    }
    if (s.startsWith('en')) return ['en-US', 'en-GB', 'en'];
    if (s.startsWith('ja')) return ['ja-JP', 'ja'];
    if (s.startsWith('ko')) return ['ko-KR', 'ko'];
    return ['zh-CN', 'zh-Hans', 'zh'];
  }
  function pickVoice(voices, tags) {
    if (!voices || !voices.length) return null;
    const norm = (v) => String(v.lang || '').toLowerCase().replace(/_/g, '-');
    for (const tag of tags) {
      const t = tag.toLowerCase();
      const exact = voices.filter((v) => norm(v) === t);
      if (exact.length) return exact.find((v) => v.localService) || exact[0];
    }
    for (const tag of tags) {
      const t = tag.toLowerCase();
      const prefix = voices.filter((v) => {
        const L = norm(v);
        if (!L.startsWith(t.split('-')[0])) return false;
        if (SPEECH_DIALECT_TAGS.some((d) => L.includes(d))) return false;
        return true;
      });
      if (prefix.length) return prefix.find((v) => v.localService) || prefix[0];
    }
    return null;
  }
  const V = (lang, name, local) => ({ lang, name: name || lang, localService: !!local });

  check('简体中文 → 候选标签是普通话（没有笼统的 zh）',
    JSON.stringify(speechTagsFor('简体中文')) === JSON.stringify(['zh-CN', 'zh-Hans', 'zh']),
    JSON.stringify(speechTagsFor('简体中文')));

  /* 粤语语音排在列表**最前面**（Windows 上常见）—— 普通话目标也必须跳过它 */
  const cantoneseFirst = [V('zh-HK', '粤语'), V('zh-CN', '普通话', true), V('en-US', 'English')];
  const picked1 = pickVoice(cantoneseFirst, speechTagsFor('简体中文'));
  check('粤语排第一时，普通话仍挑到 zh-CN（不会读成粤语）',
    picked1 && picked1.lang === 'zh-CN', picked1 ? picked1.lang : 'null');

  /* 只有粤语可用时：宁可不挑（交给 u.lang = zh-CN，浏览器自己兜） */
  const onlyCantonese = [V('zh-HK', '粤语'), V('zh-TW', '台灣'), V('yue-HK', 'Cantonese')];
  check('列表里只有粤语/台湾时，不挑它们（返回 null）',
    pickVoice(onlyCantonese, speechTagsFor('简体中文')) === null);

  /* 「第一次空、第二次才有」的时序：两次调用结果必须一致 */
  check('首次 getVoices() 返回空 → null（与第二次的结论不冲突）',
    pickVoice([], speechTagsFor('简体中文')) === null);
  // 第二次拿到完整列表 → 仍然挑普通话，不该因为「这次有得挑」就挑到粤语
  const cantoneseFirstFull = [V('zh-HK'), V('zh-CN', '普通话', true)];
  const secondPick = pickVoice(cantoneseFirstFull, speechTagsFor('简体中文'));
  check('第二次有列表了，挑的还是普通话（这才是「第二次变粤语」的病根）',
    secondPick && secondPick.lang === 'zh-CN', secondPick ? secondPick.lang : 'null');

  /* 繁体目标：允许 zh-TW */
  const tw = pickVoice([V('zh-CN'), V('zh-TW', '台灣', true)], speechTagsFor('繁體中文'));
  check('繁體中文目标 → 挑 zh-TW', tw && tw.lang === 'zh-TW', tw ? tw.lang : 'null');

  /* 同标签优先本地语音（在线语音容易等半天/静默失败） */
  const localFirst = pickVoice([V('zh-CN', '在线', false), V('zh-CN', '本地', true)], speechTagsFor('简体中文'));
  check('同一标签下优先本地语音', localFirst && localFirst.localService === true);

  check('英文目标 → en-US 优先', JSON.stringify(speechTagsFor('英文')).startsWith('["en-US"'));

  /* 覆盖率：把 content.js 里那个 speechTagsFor **真跑一遍**，对 TARGET_LANG_CODES
     的每个语言名都要挑得出标签 —— 加语言时漏改会当场红。 */
  const { TARGET_LANG_CODES } = await import('../lib/template.js');
  const speechFnSrc = (() => {
    const src = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
    const start = src.indexOf('function speechTagsFor(lang) {');
    if (start < 0) return '';
    // 大括号配平找函数体结束（比正则稳：函数体里有 / 和引号，正则容易踩坑）
    let i = src.indexOf('{', start);
    let depth = 0;
    for (; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return '';
  })();
  check('能从 content.js 里抠出 speechTagsFor（改名/重构时这条会先红）', !!speechFnSrc);
  if (speechFnSrc) {
    const realFn = new Function('lang', speechFnSrc + '; return speechTagsFor(lang);');
    const names = [...new Set(Object.keys(TARGET_LANG_CODES))];
    const missing = names.filter((n) => {
      const t = realFn(n);
      return !t || !t.length || !t[0];
    });
    check(`语音映射覆盖全部 ${names.length} 个语言名（一个都不能漏）`,
      missing.length === 0, missing.join(', '));

    /* 「繁體中文」曾被简体的正则吃掉（两条规则都命中、繁体排在后面）——
       这条钉住顺序：繁体必须排在简体前面判。 */
    check('繁體中文 → zh-TW（繁体规则必须先于简体判定）',
      JSON.stringify(realFn('繁體中文')) === JSON.stringify(['zh-TW', 'zh-HK']),
      JSON.stringify(realFn('繁體中文')));
    check('简体中文 → 只给 zh-CN / zh-Hans（不含笼统的 zh / 粤语）',
      JSON.stringify(realFn('简体中文')) === JSON.stringify(['zh-CN', 'zh-Hans']),
      JSON.stringify(realFn('简体中文')));
  }

  /* 源码侧：确认 content.js 里确实用了「排除方言」这套，别被改回去 */
  const speechSrc = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  check('content.js 里保留了方言排除表（防改回 startsWith 的老写法）',
    /SPEECH_DIALECT_TAGS/.test(speechSrc) && /zh-hk/.test(speechSrc) &&
      !/startsWith\(want\)/.test(speechSrc));
}

/* ---- 翻译记录（v9：state.history + settings.historyMax）----
   loadState 无参、从 mock 读 —— 和迁移测试同一种喂数方式（替换 get 再还原）。 */
{
  const mk = (settings, history) => ({
    version: 9,
    configs: [{ id: 'a', name: 'A', request: 'r' }],
    activeConfigId: 'a',
    vars: [],
    ocr: { disabled: false, providers: [], activeId: '' },
    settings,
    history
  });
  const loadWith = (state) => {
    const origGet = globalThis.chrome.storage.local.get;
    globalThis.chrome.storage.local.get = async () => ({ state });
    return loadState().finally(() => {
      globalThis.chrome.storage.local.get = origGet;
    });
  };

  // 老存档（没有 history 字段）：load 后是空表，不出错
  const old = await loadWith(mk(DEFAULT_SETTINGS, undefined));
  check('老存档没有 history → 空表', Array.isArray(old.history) && old.history.length === 0);

  // 白名单构造：垃圾元素滤掉、字段截断、超出条数切掉
  const junk = mk({ ...DEFAULT_SETTINGS, historyMax: 2 }, [
    { src: 'a'.repeat(3000), dst: 'b'.repeat(9000), configName: 'C', lang: 'EN', ts: 111 },
    null,
    '垃圾',
    { src: 'c', dst: 'd', ts: 222 }
  ]);
  const loaded = await loadWith(junk);
  check('垃圾元素被滤掉、条数按上限截断', loaded.history.length === 2, String(loaded.history.length));
  check('字段白名单 + 截断（src 2000 / dst 5000）',
    loaded.history[0].src.length === 2000 && loaded.history[0].dst.length === 5000 &&
      loaded.history[0].configName === 'C');

  // historyMax = 0：一条都不留
  const none = await loadWith(mk({ ...DEFAULT_SETTINGS, historyMax: 0 }, [{ src: 'x', dst: 'y', ts: 1 }]));
  check('条数设成 0 → 一条不留', none.history.length === 0);

  // 导出（备份口径）里不含 history —— 那是个人对话，不是配置
  const withHist = mk(DEFAULT_SETTINGS, [{ src: '私人原文', dst: '私人译文', ts: 1 }]);
  const exported = exportState(withHist);
  check('导出文件里没有 history 字段', !exported.includes('私人原文') && !JSON.parse(exported).history);

  // 导入时 history 不进 state（importState 的白名单本来就没有它）
  const re = importState(exportState(withHist));
  check('导入回来的 state 里也没有 history', !('history' in re));
}

/* ------------------------------------------------------------------ */

/* ---- 面板不能被网页的 text-align 带跑 ----
   页面把 text-align 写在 html/body 上时，它会**穿过 shadow DOM** 继承进来
   （和 scrollbar-color 那个坑同源）：宿主页是居中排版（nhentai 之类），
   面板里的原文区 / 译文 / 底栏就全被居中，看着像我们排版坏了。
   修法是 .rt-panel 里显式写回 text-align: start。下面两条钉住它。
   kniph 2026-11-08 报的。 */
/* 样式表合并后只有一份，所以只查 PANEL_CSS 一处。 */
check('面板显式声明了 text-align（挡住网页继承进来的居中）',
  /text-align:\s*start/.test(PANEL_CSS), 'PANEL_CSS 里缺了就是漏网');
check('那条 text-align 写在 .rt-panel 里（不是写在别处白写）',
  (() => {
    for (const src of [PANEL_CSS]) {
      const i = src.indexOf('.rt-panel {');
      if (i < 0) return false;
      const j = src.indexOf('}', i);
      const block = src.slice(i, j + 1);
      if (!/text-align:\s*start/.test(block)) return false;
    }
    return true;
  })(),
  '必须写在 .rt-panel 的规则块里');

/* ---- DNR 规则：隐私承诺的守门人（2026-11-09 补，此前断言数为 0）----
   这条规则决定「扩展会替用户改哪些请求头」。它的边界必须被钉住：
   一旦有人手滑把 requestDomains 加宽、或多加一个 header，就等于扩大了扩展的
   能力范围，而 PRIVACY.md 里对用户的承诺会立刻变成假话。 */
{
  const rules = JSON.parse(readFileSync(new URL('../lib/ua-rules.json', import.meta.url), 'utf8'));
  eq('规则只有一条（多一条就要重新审视隐私描述）', rules.length, 1);
  const r0 = rules[0];
  eq('只对 bilibili 的 index-translate 那一个域名生效',
    JSON.stringify(r0.condition.requestDomains), JSON.stringify(['index-translate.bilibili.com']));
  eq('只改 request 头，不动 response 头', r0.action.type, 'modifyHeaders');
  const hdrs = r0.action.requestHeaders.map((h) => h.header).sort();
  eq('只改 user-agent 和 origin 两个头（多一个都算扩权）',
    JSON.stringify(hdrs), JSON.stringify(['origin', 'user-agent']));
  check('两个头都是 set（不是 append/remove —— 那会和浏览器默认值打架）',
    r0.action.requestHeaders.every((h) => h.operation === 'set'));
  check('资源类型只含 xmlhttprequest / other（不碰主文档导航）',
    r0.condition.resourceTypes.every((t) => t === 'xmlhttprequest' || t === 'other') &&
      r0.condition.resourceTypes.length <= 2);
  check('没有 excludeHeaders / tabIds 之类的额外条件（条件越少越好审）',
    !('tabIds' in r0.condition) && !('excludedRequestDomains' in r0.condition));
}

/* ---- clipboard-read：读图的几条分支（此前断言数为 0）----
   它同时被 offscreen.js（Chromium）和 background.js（Firefox 兜底）用，
   走错一条分支的后果是「截图翻译静默不工作」，所以关键判断要钉住。 */
{
  const { errText } = await import('../lib/clipboard-read.js');
  eq('errText 取 message', errText(new Error('boom')), 'boom');
  eq('errText 取字符串', errText('plain'), 'plain');
  eq('errText 兜底（空值不返回空串）', errText(null).length > 0, true);
  const src = readFileSync(new URL('../lib/clipboard-read.js', import.meta.url), 'utf8');
  check('没有 clipboard API 时返回 undefined（让调用方走别的路，不是报错）',
    /if \(!navigator\.clipboard[\s\S]{0,80}return undefined/.test(src));
  check('剪贴板里没有图片时返回 no-image（不是抛异常）', src.includes("reason: 'no-image'"));
  check('读失败时返回 unavailable 并带上 errText', /reason: 'unavailable'/.test(src));
  /* MIME 判断在 lib/clipboard.js（clipboard-read 只是 import 它），所以查那个文件。
     用 startsWith 而不是 /^image\//i 是为了躲 addons-linter 的假报警（见那边的注释）。 */
  const cbSrc = readFileSync(new URL('../lib/clipboard.js', import.meta.url), 'utf8');
  check('MIME 判断只认 image/ 开头（不把文字剪贴板当图）',
    /startsWith\('image\/'\)/.test(cbSrc));
  check('判断前先 toLowerCase（Image/PNG 也要认）', /toLowerCase\(\).*startsWith\('image\/'/.test(cbSrc));
}
/* ---- F1 翻译记录增强 / F2 导入勾选 ----
   这两条断言钉的是「功能还在」，不是逐字文案。原来的 confirm 式整体替换是**明确的坏体验**
   （收到别人的 8 条配置只能全要），所以这里禁止它回退。 */
{
  const optSrc = readFileSync(new URL('../options.js', import.meta.url), 'utf8');
  const optHtml = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const optCss = readFileSync(new URL('../options.css', import.meta.url), 'utf8');

  check('翻译记录：搜索框 + 每条两个动作都在 HTML 里',
    /id="history-search"/.test(optHtml) && /data-act="copy"/.test(optSrc) && /data-act="redo"/.test(optSrc));
  check('翻译记录：过滤按原文/译文/配置名/语言四处匹配',
    /\[h\.src, h\.dst, h\.configName, h\.lang\]/.test(optSrc));
  check('翻译记录：重翻走 runRequest 并写回这条记录',
    /await runRequest\(/.test(optSrc) && /h\.dst = String\(r\.text\)/.test(optSrc));

  check('导入：不再用 confirm 做整体替换',
    !/confirm\(\s*$/.test(optSrc) && !/会被替换掉/.test(optSrc));
  check('导入：有勾选弹层（列表 + 全选 + 合并开关）',
    /id="import-list"/.test(optHtml) && /id="import-all"/.test(optHtml) && /id="import-merge"/.test(optHtml));
  check('导入：合并按 name 判重（分享版的 id 两边都不同，用 id 合不上）',
    /byName = new Map\(state\.configs\.map\(\(c\) => \[c\.name/.test(optSrc));
  /* 弹层布局：.imp-box 是 .pass-box 的 grid 子项，用 flex 会把说明文字挤出容器（实测过）。
     这条钉住它保持 grid 两列。 */
  check('导入弹层的勾选行用 grid 两列（flex 会把文字挤出弹层）',
    /\.imp-all,\s*\n\.imp-mode \{[\s\S]{0,200}display: grid/.test(optCss));
}
/* ---- v9 → v10：外观默认值从大改小（2026-11-10）----
   这条钉的是「迁移不许冲掉用户自己调过的值」。做法是真的跑一遍 loadState：
   塞一个 v9 存档进去，一个全老默认、一个改过两项，看结果。
   为什么值得单独测：迁移写错是**静默**的 —— 用户不会报「我的字号被改了」，
   他只会觉得「怎么突然变小了」。 */
await (async () => {
  const { loadState, STORAGE_VERSION } = await import('../lib/store.js');
  const original = globalThis.chrome.storage.local.get;
  const originalSet = globalThis.chrome.storage.local.set;
  let box = {};
  globalThis.chrome.storage.local.get = async () => ({ state: box });
  globalThis.chrome.storage.local.set = async (o) => { box = o.state || box; };

  const OLD = { triggerSize: 45, triggerIdleSec: 5, triggerLeaveSec: 0.5, panelWidth: 460, fontSize: 20 };
  const NEW = { triggerSize: 28, triggerIdleSec: 2, triggerLeaveSec: 0.4, panelWidth: 280, fontSize: 16 };

  box = { version: 9, configs: [], vars: [], settings: { ...OLD }, ocr: {} };
  const a = await loadState();
  eq('v9 存档里全是老默认值 → 五项一起换成新值',
    JSON.stringify({ triggerSize: a.settings.triggerSize, triggerIdleSec: a.settings.triggerIdleSec,
      triggerLeaveSec: a.settings.triggerLeaveSec, panelWidth: a.settings.panelWidth, fontSize: a.settings.fontSize }),
    JSON.stringify(NEW));
  eq('迁完版本号是最新的', a.version, STORAGE_VERSION);

  /* 用户调过的必须留着 —— 这是这条迁移唯一真正危险的地方 */
  box = { version: 9, configs: [], vars: [], settings: { ...OLD, triggerSize: 60, fontSize: 24 }, ocr: {} };
  const b = await loadState();
  eq('用户调过的按钮大小(60)不会被冲掉', b.settings.triggerSize, 60);
  eq('用户调过的字号(24)不会被冲掉', b.settings.fontSize, 24);
  eq('没调过的那三项照样跟着换',
    JSON.stringify([b.settings.triggerIdleSec, b.settings.triggerLeaveSec, b.settings.panelWidth]),
    JSON.stringify([2, 0.4, 280]));

  globalThis.chrome.storage.local.get = original;
  globalThis.chrome.storage.local.set = originalSet;
})();
/* ---- i18n 第一阶段（面板 + 触发按钮那一族文案）----
   这几条钉的是「抽 key 之后不许悄悄退回硬编码」：代码里每一处 T() 的 key
   必须在 zh_CN/messages.json 里真有这一条，否则界面会显示成 key 本身。 */
{
  const i18nSrc = readFileSync(new URL('../lib/i18n.js', import.meta.url), 'utf8');
  const zh = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
  const panelSrc = readFileSync(new URL('../lib/panel-core.js', import.meta.url), 'utf8');
  const contentSrc = readFileSync(new URL('../content.js', import.meta.url), 'utf8');
  const man = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

  check('i18n.js 是普通脚本（挂 window.RTI18n），不是 ES module',
    !/^export /m.test(i18nSrc) && /window\.RTI18n\s*=/.test(i18nSrc));

  /* 两个 content script 都排在 i18n.js 后面 —— 顺序反了 panel-core 拿不到 T() */
  check('manifest 里 i18n.js 排在 panel-core 和 content.js 之前',
    (() => {
      const js = man.content_scripts[0].js;
      return js.indexOf('lib/i18n.js') === 0 && js.indexOf('lib/panel-core.js') > 0;
    })());

  /* 代码里出现的每个 panel_* / trigger_* key，messages.json 里都得有。
     漏一条的后果不是报错，是那处界面直接显示成 'panel_xxx' 这几个字。 */
  check('代码里用到的 panel_/trigger_ key 在 messages.json 里全都有',
    (() => {
      const used = new Set();
      for (const src of [panelSrc, contentSrc]) {
        for (const m of src.matchAll(/T\(\s*'((?:panel|trigger)_[a-z_]+)'/g)) used.add(m[1]);
      }
      const missing = [...used].filter((k) => !zh[k]);
      return used.size > 0 && missing.length === 0;
    })(),
    '缺的 key 会原样显示在界面上');

  /* 反过来也要查：messages.json 里每条 message 必须是字符串（手改 JSON 会写成对象） */
  check('messages.json 每条都有非空 message 字符串',
    Object.values(zh).every((v) => v && typeof v.message === 'string' && v.message.length > 0));

  /* 生成语言包时**绝不能**把含 ${} 的模板丢给机翻 —— 会变成 $ {mkey} 把功能搞坏。
     zh_CN 是 base 语言，它的 value 里不许出现 ${。 */
  /* Chrome 的硬规矩：message 里出现的 $X$ 必须配 placeholders 声明，否则**整个**
     messages.json 加载失败 → 扩展加载失败（不是「那一条显示不出来」，是整个扩展装不上）。
     2026-11-10 栽过：opt_ui_lang_listed 写了 $N$（N 不是数字），扩展直接起不来，
     e2e 报「service worker 没起来」，查了半小时才发现是 locale 文件。 */
  check('messages.json 里没有非数字的 $X$ 占位符（Chrome 会拒绝整个文件）',
    (() => {
      const bad = [];
      for (const [k, v] of Object.entries(zh)) {
        for (const m of String(v.message || '').matchAll(/\$([^$]+)\$/g)) {
          if (!/^\d+$/.test(m[1])) bad.push(k + ':' + m[1]);
        }
      }
      return bad.length === 0;
    })(),
    '占位符必须是 $1$ $2$ 这种数字形式');

  /* 数字占位符也必须配 placeholders —— 声明数少于用到的是同一个坑 */
  check('每个用到 $N$ 的 message 都声明了等量 placeholders',
    (() => {
      for (const [k, v] of Object.entries(zh)) {
        const used = new Set([...String(v.message || '').matchAll(/\$(\d+)\$/g)].map((m) => m[1]));
        const declared = v.placeholders ? Object.keys(v.placeholders).length : 0;
        if (used.size !== declared) return false;
      }
      return true;
    })());
  check('messages.json 的 value 里没有 ${ 模板语法（机翻会把它拆坏）',
    Object.values(zh).every((v) => !String(v.message).includes('${')));

  /* 占位符 key 和 $1$ 必须对得上：声明了 placeholders 就必须在 message 里用到 $N$，反之亦然 */
  check('声明的 placeholders 和 message 里的 $N$ 一一对应',
    Object.values(zh).every((v) => {
      const declared = v.placeholders ? Object.keys(v.placeholders).length : 0;
      const usedNums = new Set([...String(v.message).matchAll(/\$(\d+)\$/g)].map((m) => Number(m[1])));
      return declared === usedNums.size;
    }));
}
/* ---- i18n 第二阶段（设置页）----
   HTML 用 data-i18n 标记、JS 用 T() 查表。这两条钉住「以后新写界面别忘了标记」：
   漏标记的后果不是报错，是那一处永远停在中文，而且很难发现（只有切了语言才看得见）。 */
{
  const optHtml2 = readFileSync(new URL('../options.html', import.meta.url), 'utf8');
  const optJs2 = readFileSync(new URL('../options.js', import.meta.url), 'utf8');

  const nAttr = (optHtml2.match(/data-i18n="/g) || []).length;
  const nTitle = (optHtml2.match(/data-i18n-title="/g) || []).length;
  const nPh = (optHtml2.match(/data-i18n-ph="/g) || []).length;
  check('设置页 HTML 有大量 data-i18n 标记（文案不是硬编码）',
    nAttr > 100,
    `data-i18n=${nAttr} title=${nTitle} ph=${nPh}`);

  /* 每个 data-i18n 的 key 都得在 messages.json 里 —— 漏了那一处会显示成 key 本身 */
  check('设置页 HTML 里每个 data-i18n key 都在 messages.json 里有值',
    (() => {
      const keys = new Set();
      for (const m of optHtml2.matchAll(/data-i18n(?:-title|-ph)?="([a-z0-9_]+)"/g)) keys.add(m[1]);
      const zh2 = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
      const missing = [...keys].filter((k) => !zh2[k]);
      return keys.size > 0 && missing.length === 0;
    })(),
    '缺的 key 会原样显示在界面上');

  /* options.js 里的 T() 也必须都有定义 */
  check('options.js 里每个 T(key) 在 messages.json 里都有值',
    (() => {
      const zh3 = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
      const keys = new Set([...optJs2.matchAll(/\bT\(\s*'([a-z0-9_]+)'/g)].map((m) => m[1]));
      const missing = [...keys].filter((k) => !zh3[k]);
      return keys.size > 0 && missing.length === 0;
    })(),
    '漏一条那一处就永远是中文');

  /* 右键菜单 / 快捷键那几条也在 messages.json 里 —— 它们在 Chrome 界面显示，
     漏一条就是两种语言混在同一个右键菜单里。 */
  check('右键菜单和快捷键的文案都在 messages.json 里',
    (() => {
      const zhM = JSON.parse(readFileSync(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8'));
      const need = ['menuTranslate', 'menuOcrClipboard', 'menuShotTranslate',
        'cmdTranslateSelection', 'cmdShotTranslate', 'cmdOcrClipboard'];
      return need.every((k) => zhM[k] && zhM[k].message);
    })());

  /* manifest 的命令描述必须走 __MSG_，否则 Chrome 界面里永远是中文 */
  check('manifest 的 commands 描述走 __MSG_',
    (() => {
      const man = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
      return Object.values(man.commands || {}).every((c) => !c.description || /^__MSG_\w+__$/.test(c.description));
    })());

  /* 背景那边用 lib/i18n-msg.js（ESM），网页这边用 lib/i18n.js（普通脚本）。
     两份必须都存在且不互相 import —— 混了会在 service worker 里炸。 */
  check('lib/i18n-msg.js 是 ESM，lib/i18n.js 是普通脚本（两者不能互相 import）',
    (() => {
      const esm = readFileSync(new URL('../lib/i18n-msg.js', import.meta.url), 'utf8');
      const plain = readFileSync(new URL('../lib/i18n.js', import.meta.url), 'utf8');
      return /^export /m.test(esm) && !/^export /m.test(plain) &&
        !/from ['"]\.\/i18n\.js['"]/.test(esm) && !/from ['"]\.\/i18n-msg\.js['"]/.test(plain);
    })());
  /* 语言包走 GitHub 现取（kniph 2026-11-12：翻译由我做，但包不打包），
     所以启动时必须先 loadPack 再 applyI18n —— 顺序反了用户会看见文字闪。 */
  check('设置页启动时载入语言包并调用 applyI18n',
    /loadPack/.test(optJs2) && /applyI18n\(document\)/.test(optJs2));

  /* ---- v11 → v12：内置配置 / OCR 供应商改名成简短英文 ----
     kniph 2026-11-12：「默认的配置尽量不要用中文，用英文即可，简单易懂的英文，比如 bing (free)」。
     判据是「逐字还等于老默认值」，用户自己改过的名字不能被冲掉。 */
  check('v12：八条内置配置的默认名都是简短英文',
    (() => {
      const src = readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8');
      const want = ['Bing (free)', 'bilibili (free)', 'OpenAI-compatible', 'DeepSeek', 'DeepL', 'Ling', 'Ollama (local)', 'Anthropic (raw)'];
      return want.every((n) => src.includes("name: '" + n + "'"));
    })());
  check('v12：三条 OCR 供应商的默认名也是英文',
    (() => {
      const src = readFileSync(new URL('../lib/ocr.js', import.meta.url), 'utf8');
      const want = ['SiliconFlow', 'Baidu OCR (accurate)', 'OpenAI-compatible (vision)'];
      return want.every((n) => src.includes("name: '" + n + "'"));
    })());
  check('v12：迁移用冻死旧名做判据，且 OCR id 是真实的那些',
    (() => {
      const src = readFileSync(new URL('../lib/store.js', import.meta.url), 'utf8');
      return /OLD_CONFIG_NAMES/.test(src) && /OLD_OCR_NAMES/.test(src) &&
        src.includes("'builtin-baidu-ocr': '百度 OCR（高精度版）'") &&
        src.includes("'builtin-openai-vl': 'OpenAI 兼容（任意视觉模型）'") &&
        /STORAGE_VERSION = 12/.test(src);
    })());
}
console.log('\n' + '='.repeat(46));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(46));

process.exit(failed === 0 ? 0 : 1);
