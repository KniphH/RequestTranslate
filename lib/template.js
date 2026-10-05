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

export const BUILTIN_VARS = ['text', 'selection', 'image', 'imagePart', 'target', 'targetLang', 'url', 'title', 'date'];

export const BUILTIN_VAR_HINTS = {
  text: '选中 / 待翻译的文本',
  selection: '同 {{text}}',
  image: '截图翻译直传模式下的图片（data URL）；普通翻译时是空串',
  imagePart: '图片那一段（含前导逗号），写在 content 数组最后；没图时是空串',
  target: '设置里的目标语言',
  targetLang: '同 {{target}}',
  url: '所在页面地址',
  title: '所在页面标题',
  date: '今天的日期 YYYY-MM-DD'
};
