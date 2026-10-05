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
const { renderTemplate, escapeJsonString, imageContentPart, targetCodeOf, TARGET_PRESETS } = await import('../lib/template.js');
const { parsePath, getByPath, extractContent, describeShape } = await import('../lib/extract.js');
const {
  DEFAULT_CONFIGS, DEFAULT_SETTINGS, moveItem, dropIndex, buildVars,
  requestTemplateFor, freshConfigs, loadState, exportState, importState
} = await import('../lib/store.js');
const { previewRequest } = await import('../lib/engine.js');
const { toBingLang, hasAdapter } = await import('../lib/adapters.js');
const {
  OCR_MENU_ID, OCR_MENU_TITLE, OCR_PROVIDERS, BUILTIN_OCR_IDS,
  DEFAULT_OCR_PROMPT,
  normalizeOcrProvider, normalizeOcrState, defaultOcrState, activeOcrProvider,
  buildOcrBody, pickOcrText, describeOcrError, ocrErrorHint,
  normalizeMaxTokens, previewOcrRequest, runOcr
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

  const r4 = parseRequest('curl -sSL -H "A: 1" https://x.com -o /dev/null');
  eq('组合短选项不吞错参数', r4.url, 'https://x.com');
  eq('组合短选项里的 -H 生效', r4.headers['A'], '1');

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
  eq('老存档那条硅基流动换成了 DeepSeek-OCR', v4sf.model, 'deepseek-ai/DeepSeek-OCR');
  eq('提示词跟着换成 DeepSeek-OCR 的预设', v4sf.prompt, 'Free OCR.');
  eq('名称也归位成新的', v4sf.name, '硅基流动');
  eq('说明也换成新内置的那份', v4sf.note, OCR_PROVIDERS[0].note);
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
  eq('模型和提示词归位了', v4namedP.prompt, 'Free OCR.');
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

  globalThis.chrome.storage.local = original;
}

const {
  TRIGGER_STYLES,
  TRIGGER_CSS,
  TRIGGER_SVG_SAMPLE,
  SVG_GUARDS,
  getTriggerStyle,
  clampTriggerSize,
  parseTriggerSvg,
  sanitizeTriggerSvg,
  DEFAULT_TRIGGER_STYLE
} = await import('../lib/trigger-styles.js');

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
  check('自定义 = 无底座 + SVG', custom.round === false && custom.bare === true && /^<svg /.test(custom.svg || ''));
  check('自定义的占位图标就是示例图标（没填图标时按钮不会空着）',
    custom.svg === TRIGGER_SVG_SAMPLE);
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
  eq('默认设置里的大小', DEFAULT_SETTINGS.triggerSize, 45);
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

  check('按钮样式表逐字一致（忽略空白）', squash(src).includes(squash(TRIGGER_CSS)));

  for (const s of TRIGGER_STYLES) {
    if (!s.svg) continue;
    check(`预设「${s.name}」的 SVG 逐字一致`, squash(src).includes(squash(s.svg)));
  }

  check('预设名都对得上（badge/globe/custom）',
    ['badge', 'globe', 'custom'].every((id) => squash(src).includes(id + ':{')));
  // 「自定义」的占位图标也得抄过去，否则页面上选到自定义而没填图标时按钮是空的
  check('自定义的占位图标也在 content.js 里',
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
}

/* ------------------------------------------------------------------ */

section('15. 截图 OCR：供应商状态 / 请求体 / 取文字');
{
  const d = defaultOcrState();
  check('全新状态下内置供应商都在', d.providers.length === OCR_PROVIDERS.length,
    d.providers.map((p) => p.id));
  eq('默认选中硅基流动那条', d.activeId, 'builtin-siliconflow');
  eq('全新的供应商没有 key', d.providers[0].apiKey, '');
  check('内置条目都带接口地址和模型名',
    d.providers.every((p) => p.endpoint && p.model));

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
  eq('改过的内置条目：没动的字段还是默认', sf.model, 'deepseek-ai/DeepSeek-OCR');
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
  eq('没填提示词就用默认的那句', body.messages[0].content[1].text, 'Free OCR.');
  eq('提示词留空时退回默认',
    buildOcrBody({ model: 'm', prompt: '   ' }, 'data:x').messages[0].content[1].text, 'Free OCR.');

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
  check('max_seq_len 那种 400 会提示去清空最大输出长度',
    eMax.includes('最大输出长度'), eMax);
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

  /* ---- 右键菜单那一条 ---- */
  eq('菜单 id', OCR_MENU_ID, 'rt-ocr-clipboard');
  eq('菜单文案', OCR_MENU_TITLE, '翻译剪切板中的截图');
  check('右键菜单开关默认开', DEFAULT_SETTINGS.ocrMenu === true);
  check('内置那条默认是硅基流动的 DeepSeek-OCR',
    OCR_PROVIDERS[0].model === 'deepseek-ai/DeepSeek-OCR', OCR_PROVIDERS[0].model);
  check('默认提示词是 DeepSeek-OCR 认的那句（不是 PaddleOCR-VL 的 OCR:）',
    DEFAULT_OCR_PROMPT === 'Free OCR.', DEFAULT_OCR_PROMPT);
  /* 提示词**不内置成预设**：各家格式互不相通（DeepSeek-OCR 认 `Free OCR.`、
     PaddleOCR-VL 认 `OCR:`），设置页摆一排只对某一家有效的按钮就是误导。
     内置那条供应商只兜一个默认值，换模型时用户自己去文档里抄。
     设置页里那句说明由 e2e 第 10 节盯着（它得写清「不同模型不一样 + 举个例子」）。 */
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
  check('全新的内置配置都带 imageRequest',
    freshConfigs().every((c) => c.imageRequest === ''), freshConfigs().map((c) => c.name));
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
  check('后台把语言候选随 ready 一起发给页面',
    /import\s*\{[^}]*\bTARGET_PRESETS\b[^}]*\}\s*from\s*'\.\/lib\/template\.js'/.test(bgJs) &&
      /targetLangs:\s*TARGET_PRESETS/.test(bgJs));
  check('面板顶栏有一个目标语言下拉',
    /class="rt-lang"/.test(panelJs) && panelJs.includes("querySelector('.rt-lang')"));
  check('面板的候选来自后台，没在 content.js 里手抄一份',
    !panelJs.includes('TARGET_PRESETS'));
  check('面板换语言后会把各配置的旧译文作废（那是上一门语言的）',
    /langSelect\.addEventListener\('change'/.test(panelJs) &&
      /resultCache\.clear\(\)/.test(panelJs));
  /* 流式输出不自动跟随滚动：有些模型吐字快，视口被一路拉着往下跑就没法读了。
     文本是往后接的，视口原地不动就能从头读（要跟尾巴自己拖滚动条）。 */
  check('流式输出不把滚动条带着跑（没有对 scrollTop 的赋值）',
    !/outBox\.scrollTop\s*=\s*[^=]/.test(panelJs));

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

/* ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(46));
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
console.log('='.repeat(46));
process.exit(failed === 0 ? 0 : 1);
