/**
 * 请求模板的占位符渲染
 * ------------------------------------------------------------------
 * 模板里所有 `{{name}}` 都会被替换。内置变量：
 *
 *   {{text}}        选中 / 待翻译的文本
 *   {{selection}}   {{text}} 的别名
 *   {{image}}       截图翻译「直传」模式下的图片（data URL）；普通翻译时是空串
 *   {{imagePart}}   同上，但给的是**一整段 content 元素**（含前导逗号）；没有图时是空串
 *   {{target}}      设置里的目标语言（例：简体中文）
 *   {{targetLang}}  {{target}} 的别名
 *   {{url}}         所在页面的地址
 *   {{title}}       所在页面的标题
 *   {{date}}        当前日期（YYYY-MM-DD）
 *
 * 除此之外的 {{xxx}} 从「变量」里取（比如 {{apiKey}}）。
 *
 * 关键点：会看占位符**落在哪几层引号里**，从内到外逐层转义。
 *   "{{text}}"               → 按 JSON 字符串内容转义（" 变 \"，换行变 \n）
 *   '{{text}}'               → 按 shell 单引号规则转义（' 变 '\''）
 *   {{text}}                 → 原样插入，不动
 *   -d '{"content":"{{text}}"}'  → **两层**：先 JSON 转义，再 shell 转义
 *
 * 最后那一条是 curl 模板的常态，也是最容易踩的：外层是 shell 单引号、
 * 里面才是 JSON 字符串。这时占位符两侧既不是 " 也不是 '（前后多半是 \n 之类），
 * 光看两侧就会当「裸插」—— 于是文本里一个撇号（英文里几乎必然有）就把 shell
 * 那层提前闭合，请求体从那儿被截断（服务端会报 JSON parse 的 end-of-input）。
 * 所以判断依据是「此刻还开着哪几层引号」，不是「紧挨着的是什么字符」。
 *
 * （{{imagePart}} 必须裸着写，它要插的就是一段 JSON，套上引号反而会坏。）
 */

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_$][\w.$-]*)\s*\}\}/g;

export function escapeJsonString(value) {
  let out = '';
  for (const ch of String(value)) {
    switch (ch) {
      case '"': out += '\\"'; break;
      case '\\': out += '\\\\'; break;
      case '\n': out += '\\n'; break;
      case '\r': out += '\\r'; break;
      case '\t': out += '\\t'; break;
      case '\b': out += '\\b'; break;
      case '\f': out += '\\f'; break;
      default: {
        const code = ch.codePointAt(0);
        if (code < 0x20) out += '\\u' + code.toString(16).padStart(4, '0');
        else out += ch;
      }
    }
  }
  return out;
}

export function escapeShellSingle(value) {
  return String(value).split("'").join("'\\''");
}

/**
 * `{{imagePart}}` 的值：content 数组里「图片那一段」的完整 JSON 片段。
 *
 *   有图 → ,{"type":"image_url","image_url":{"url":"data:image/png;base64,…"}}
 *   没图 → 空串
 *
 * 前面那个逗号是刻意留的：这样模板里把它写在 content 数组的**最后一项**，
 * 文本翻译时数组里就只有一个 text 段（不剩空元素），截图直传时自动多出图片段。
 * 这就是「一段模板同时能翻文字和翻图」的全部秘密 —— 没有条件语法，
 * 靠「空串 = 什么都不加」来实现可选。
 *
 * 位置是固定的（只能放最后）：JSON 数组里第一项前面不能有逗号，
 * 而占位符没法知道自己是第几个。真要把图片放最前，就用两条配置。
 */
export function imageContentPart(dataUrl) {
  const url = String(dataUrl || '');
  if (!url) return '';
  return ',{"type":"image_url","image_url":{"url":"' + escapeJsonString(url) + '"}}';
}

/**
 * data URL → 裸 base64（去掉 "data:image/png;base64," 前缀）。
 * 给 OCR 模板的 {{imageBase64}} 用；不是 data URL 就原样返回。
 */
export function stripDataUrl(dataUrl) {
  const s = String(dataUrl || '');
  const i = s.indexOf(',');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * 模板里第 pos 个字符处「此刻还开着的引号」，从外到内。
 *
 * 只做词法扫描，不解析语法 —— 够用来判断占位符被哪几层字符串包着。
 * 两条刻意的规则：
 *   - `\x` 一律跳过：`\"` 是 JSON 的转义引号，不是字符串边界；
 *   - 已经在双引号里时，撇号当普通字符（`don't` 里的那个），不当 shell 引号。
 */
function quoteStackAt(template, pos) {
  const stack = [];
  for (let i = 0; i < pos; i += 1) {
    const ch = template[i];
    if (ch === '\\') { i += 1; continue; }
    if (ch !== '"' && ch !== "'") continue;

    const top = stack[stack.length - 1];
    if (top === ch) { stack.pop(); continue; }
    if (ch === "'" && top === '"') continue;
    stack.push(ch);
  }
  return stack;
}

/** 按「占位符所在的那几层引号」从内到外逐层转义 */
function escapeInContext(template, offset, value) {
  const stack = quoteStackAt(template, offset);
  let out = value;
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    out = stack[i] === '"' ? escapeJsonString(out) : escapeShellSingle(out);
  }
  return out;
}

/**
 * @param {string} template
 * @param {Record<string,string>} vars
 * @returns {{text:string, missing:string[]}}
 */
export function renderTemplate(template, vars) {
  const missing = new Set();
  const table = {};
  for (const [k, v] of Object.entries(vars || {})) table[k] = v == null ? '' : String(v);

  const text = String(template ?? '').replace(PLACEHOLDER_RE, (match, name, offset, whole) => {
    if (!(name in table)) {
      missing.add(name);
      return ''; // 未定义变量替换为空，同时记录，UI 会提示
    }
    return escapeInContext(whole, offset, table[name]);
  });

  return { text, missing: [...missing] };
}

/** 模板里出现过的所有占位符名 */
export function listPlaceholders(template) {
  const names = new Set();
  for (const m of String(template ?? '').matchAll(PLACEHOLDER_RE)) names.add(m[1]);
  return [...names];
}

export const BUILTIN_VARS = ['text', 'selection', 'image', 'imageBase64', 'imageUrlEncoded', 'imagePart', 'target', 'targetCode', 'targetLang', 'url', 'title', 'date'];

export const BUILTIN_VAR_HINTS = {
  text: '选中 / 待翻译的文本',
  selection: '同 {{text}}',
  image: '截图翻译直传模式下的图片（data URL）；普通翻译时是空串',
  imageBase64: '裸 base64（去掉 data: 前缀），给要纯 base64 的接口',
  imageUrlEncoded: 'base64 再过一遍 URL 编码（百度 OCR 的 image 参数要这种）',
  imagePart: '图片那一段（含前导逗号），写在 content 数组最后；没图时是空串',
  target: '设置里的目标语言，原样搬过来（给聊天模型看）',
  targetCode: '同一件事，但映射成接口要的大写代码（ZH-HANS / JA），给 DeepL 这类接口用',
  targetLang: '同 {{target}}',
  url: '所在页面地址',
  title: '所在页面标题',
  date: '今天的日期 YYYY-MM-DD'
};

/**
 * 目标语言 → 接口用的大写代码。
 * ------------------------------------------------------------------
 * 同一个意思有两种写法，各家接口要的不一样：
 *   聊天模型读得懂「简体中文」，而 DeepL 只认 ZH-HANS。
 * 所以这里放一张「名字 / 各种写法 → 大写规范代码」的表，两边共用：
 *   - {{target}}      原样（给聊天模型）
 *   - {{targetCode}}  映射后的代码（给只认代码的接口）
 *   - Bing 适配器也吃这张表，再转成它自己的写法（zh-Hans）
 *
 * 表里的值统一按「大写 + 连字符」写，转别的写法由调用方自己变形。
 */
export const TARGET_LANG_CODES = {
  '简体中文': 'ZH-HANS', '简体': 'ZH-HANS', '中文': 'ZH-HANS', '汉语': 'ZH-HANS', 'chinese': 'ZH-HANS',
  '繁體中文': 'ZH-HANT', '繁体中文': 'ZH-HANT', '繁体': 'ZH-HANT', '繁體': 'ZH-HANT',
  '英语': 'EN', '英文': 'EN', 'english': 'EN',
  '日语': 'JA', '日文': 'JA', 'japanese': 'JA',
  '韩语': 'KO', '韩文': 'KO', 'korean': 'KO',
  '法语': 'FR', '法文': 'FR', 'french': 'FR',
  '德语': 'DE', '德文': 'DE', 'german': 'DE',
  '西班牙语': 'ES', '西班牙文': 'ES', 'spanish': 'ES',
  '俄语': 'RU', '俄文': 'RU', 'russian': 'RU',
  '葡萄牙语': 'PT', 'portuguese': 'PT',
  '意大利语': 'IT', 'italian': 'IT',
  '阿拉伯语': 'AR', 'arabic': 'AR',
  '泰语': 'TH', 'thai': 'TH',
  '越南语': 'VI', 'vietnamese': 'VI',
  '印尼语': 'ID', 'indonesian': 'ID',
  '土耳其语': 'TR', 'turkish': 'TR',
  '荷兰语': 'NL', 'dutch': 'NL',
  '波兰语': 'PL', 'polish': 'PL',
  '乌克兰语': 'UK', 'ukrainian': 'UK',
  '捷克语': 'CS', 'czech': 'CS',
  '瑞典语': 'SV', 'swedish': 'SV',
  // DeepL 只认 NB（书面挪威语），用 NO 会被它拒
  '挪威语': 'NB', 'norwegian': 'NB',
  '丹麦语': 'DA', 'danish': 'DA',
  '芬兰语': 'FI', 'finnish': 'FI',
  '希腊语': 'EL', 'greek': 'EL',
  '匈牙利语': 'HU', 'hungarian': 'HU',
  '罗马尼亚语': 'RO', 'romanian': 'RO'
};

/**
 * 设置页「目标语言」下拉里的候选。
 * 以**语言名**为主 —— 选中后由 targetCodeOf 自动映射成接口要的代码（英语 → EN），
 * 用户不需要知道 EN 这回事；末尾几个是语言名表达不了的地区变体，只能填代码。
 * ===== 加语言只改这里和上面那张表 =====
 * （options.html 里那个 datalist 是空容器，列表由 options.js 从这儿填，
 *  别再往 HTML 里手抄一份；test-lib 第 22 节会盯着两者是否同步。）
 */
export const TARGET_PRESETS = [
  '简体中文', '繁體中文',
  '英语', '日语', '韩语', '法语', '德语', '西班牙语', '俄语', '葡萄牙语',
  '意大利语', '阿拉伯语', '泰语', '越南语', '印尼语', '土耳其语',
  '荷兰语', '波兰语', '乌克兰语', '捷克语', '瑞典语', '挪威语', '丹麦语',
  '芬兰语', '希腊语', '匈牙利语', '罗马尼亚语',
  /* 地区变体：语言名没法区分，只能直接填代码 */
  'EN-US', 'EN-GB', 'PT-BR', 'PT-PT'
];

/** 看着像语言代码吗（EN / ZH-HANS / PT-BR / YUE） */
const LOOKS_LIKE_CODE = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * 认语言：代码就大写化，名字就查表。
 * 都不认时返回 fallback —— 传 '' 进来就表示「我不想要兜底，你自己判断」。
 * @param {string} input
 * @param {string} [fallback]
 */
export function targetCodeOf(input, fallback = 'ZH-HANS') {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return fallback;
  if (LOOKS_LIKE_CODE.test(raw)) return raw.toUpperCase();
  return TARGET_LANG_CODES[raw] || TARGET_LANG_CODES[raw.toLowerCase()] || fallback;
}
