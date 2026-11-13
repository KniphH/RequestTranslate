/**
 * 请求模板的占位符渲染
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

  const raw = String(template ?? '');
  const lang = extractLangMap(raw);
  if (lang && Object.keys(lang.map).length) {
    // 这条配置自己声明了语言代码表 —— 命中就覆盖掉 builtin 那份
    const hit = pickLangCode(lang.map, table.target, table.targetCode);
    if (hit) table.targetCode = hit;
  }
  // 声明块在这里就**整块吃掉**，不让它进到渲染结果里 —— 这样它写在哪儿都行
  // （原始 HTTP 报文风格会把「空行之后的所有东西」当 body，留个尾巴会被吞进去）
  const body = lang ? stripLines(raw, lang.head, lang.end) : raw;

  const text = body.replace(PLACEHOLDER_RE, (match, name, offset, whole) => {
    if (!(name in table)) {
      missing.add(name);
      return ''; // 未定义变量替换为空，同时记录，UI 会提示
    }
    return escapeInContext(whole, offset, table[name]);
  });

  return { text, missing: [...missing] };
}

/** BUILTIN_VAR_HINTS 每条对应的文案 key（界面按当前语言查表，中文原文留作兜底） */
export const VAR_HINT_KEYS = {
  text: 'varhint_text',
  selection: 'varhint_selection',
  image: 'varhint_image',
  imageBase64: 'varhint_imageb64',
  imageUrlEncoded: 'varhint_imageurl',
  imagePart: 'varhint_imagepart',
  target: 'varhint_target',
  targetCode: 'varhint_targetcode',
  targetLang: 'varhint_targetlang',
  url: 'varhint_url',
  title: 'varhint_title',
  date: 'varhint_date'
};
export const BUILTIN_VAR_HINTS = {
  text: '选中 / 待翻译的文本',
  selection: '同 {{text}}',
  image: '截图翻译直传模式下的图片（data URL）；普通翻译时是空串',
  imageBase64: '裸 base64（去掉 data: 前缀），给要纯 base64 的接口',
  imageUrlEncoded: 'base64 再过一遍 URL 编码（百度 OCR 的 image 参数要这种）',
  imagePart: '图片那一段（含前导逗号），写在 content 数组最后；没图时是空串',
  target: '设置里的目标语言，原样搬过来（给聊天模型看）',
  targetCode: '映射成接口要的代码（ZH-HANS / JA），给 DeepL 这类只认代码的接口用。' +
    '换服务就改进配置末尾的 #@lang 表',
  targetLang: '同 {{target}}',
  url: '所在页面地址',
  title: '所在页面标题',
  date: '今天的日期 YYYY-MM-DD'
};

/**
 * 语言表：**以代码为主键**（kniph 2026-11-13 定的）。
 *
 *   code  —— 接口要的代码，也是存档里唯一认的值（DeepL 那套）
 *   zh    —— 中文名（内置显示名，也是用户第一次看到的那个）
 *   en    —— 英文名（界面切英文时的显示名）
 *   alias —— 别的写法（老存档里可能存的是「简体」/「english」，都得认）
 *
 * 这个结构解决的核心问题：**代码是身份，名字只是显示**。
 *   · 存档里存 code，不存名字 —— 用户改显示名不会让配置失效
 *   · {{target}} 取显示名（settings.targetNames[code]），可以先按界面语言自动填、之后用户随便改
 *   · {{targetCode}} 永远取 code
 *
 * 想加一门语言：这里加一行 + i18n 里加两条名字，别处不用动。
 */
/**
 * 支持的语言：**只有代码**。
 *
 * 名字不写在这里 —— 一个 code 永远只对应**一个**名字，那个名字是
 * 「当前界面语言下该叫什么」，存在 settings.targetNames[code] 里：
 *
 *   { code: "ZH-HANS" }  →  targetNames["ZH-HANS"] = "简体中文"（中文界面）
 *                                              = "Simplified Chinese"（英文界面）
 *                                              = 用户自己填的任何内容
 *
 * 换界面语言时批量重置一次，平时用户随便改。名字本身是**文案**，
 * 所以它们在 i18n 语言包里（键名 langname_ZH_HANS 这种），不在这份代码里。
 */
export const LANGS = [
  'ZH-HANS', 'ZH-HANT', 'EN', 'JA', 'KO', 'FR', 'DE', 'ES', 'RU', 'PT',
  'IT', 'AR', 'TH', 'VI', 'ID', 'TR', 'NL', 'PL', 'UK', 'CS', 'SV',
  'NB', 'DA', 'FI', 'EL', 'HU', 'RO'
];

/** 地区变体：语言名表达不了，只能直接填代码（DeepL 认这些） */
export const LANG_REGION_VARIANTS = ['EN-US', 'EN-GB', 'PT-BR', 'PT-PT'];

/** 代码 → i18n key（名字是文案，在语言包里） */
export function langNameKey(code) {
  return 'langname_' + String(code || '').replace(/-/g, '_');
}

/**
 * 历史别名：老存档 / 老配置里可能存的是「简体中文」「english」这种。
 * 只用于**识别输入**，不是显示名 —— 显示名永远只有 targetNames[code] 那一个。
 */
export const LANG_ALIASES = {
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
  '挪威语': 'NB', 'norwegian': 'NB',
  '丹麦语': 'DA', 'danish': 'DA',
  '芬兰语': 'FI', 'finnish': 'FI',
  '希腊语': 'EL', 'greek': 'EL',
  '匈牙利语': 'HU', 'hungarian': 'HU',
  '罗马尼亚语': 'RO', 'romanian': 'RO'
};

/** 代码 → 条目 */
/** 语言代码 → i18n key（显示名在语言包里，见 langNameKey） */
export const TARGET_PRESETS = LANGS;

/**
 * 各种写法 → 代码。**只用于识别输入**（老存档 / 老配置），不是显示名的来源。
 * 认：代码本身（不分大小写）+ 历史别名。
 */
export const TARGET_LANG_CODES = (() => {
  const table = {};
  for (const code of LANGS) table[code] = code;
  return Object.assign(table, LANG_ALIASES);
})();

/** 地区变体：语言名表达不了，只能直接填代码（DeepL 认这些） */


/* ---- 请求文本里自带的语言代码表：`#@lang` ----

   各家机器翻译服务对同一个语言的代码写法不一样（DeepL 要 ZH-HANS，Google 要 zh-CN，
   百度要 zh）。内置表只兜住 DeepL / Bing 那套，换服务就得自己声明一张：

     #@lang
     # 简体中文 = zh
     # 英语 = en
     # 日语 = jp

   规则（都刻意定得很死，免得跟请求文本打架）：
     - `#@lang` 必须单独占一行，后面紧跟若干行 `# 键 = 值`；**空行就结束**。
     - 键写语言名（简体中文）或代码（ZH-HANS）都认，匹配不分大小写。
     - 整块**在渲染时被吃掉、不进输出** —— 所以放在请求文本的哪儿都行；而且它带 `#`，
       就算用户把整段粘到终端里也是安全的。
     - 命中不了当前目标语言就用上面那张内置表兜底（所以不必把语言抄全）。
*/

const LANG_MAP_HEAD = /^[ \t]*#@lang[ \t]*$/;
const LANG_MAP_ROW = /^[ \t]*#[ \t]*([^=\r\n]+?)[ \t]*=[ \t]*([^\r\n]+?)[ \t]*$/;

/**
 * 从请求文本里揪出 `#@lang` 那张表。
 * @param {string} template
 * @returns {{map: Record<string,string>, head: number, end: number}|null} 行号用于把整块删掉
 */
export function extractLangMap(template) {
  const lines = String(template ?? '').split('\n');
  const head = lines.findIndex((l) => LANG_MAP_HEAD.test(l));
  if (head < 0) return null;

  const map = {};
  let end = head;
  for (let i = head + 1; i < lines.length; i += 1) {
    const m = LANG_MAP_ROW.exec(lines[i]);
    if (!m) break;
    const k = m[1].trim();
    const v = m[2].trim();
    if (k && v) map[k] = v;
    end = i;
  }
  return { map, head, end };
}

/** 查这张表：键写语言名 / 别名（英文、日文）/ 规范码都认，两边都不分大小写 */
/**
 * 查 #@lang 表。
 *
 * **键是语言代码，不是语言名**（kniph 2026-11-13 定的）：
 *
 *   #@lang
 *   # ZH-HANS = zh
 *   # EN = en
 *   # JA = ja
 *
 * 为什么用代码当键：语言名是**自然语言**，界面切成英文、日文之后就没法写了；
 * 而代码（ZH-HANS / EN / JA）是跨语言通用的，用户界面换成什么语言这张表都不用动。
 * 内置的那套就是 DeepL 的 language code（README 有官方文档链接）。
 *
 * 匹配时**两边都归一成代码再比**，所以下面这些写法都认：
 *   ZH-HANS = zh      EN = en        ja = ja      日语 = ja
 * 最后一个走的是 targetCodeOf 的别名表 —— 老配置里写语言名的那些不会失效。
 */
function pickLangCode(map, target, canonical) {
  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();
  /* 先把「我们要找的语言」归一成代码（存档里可能存的是「简体中文」） */
  const want = [targetCodeOf(target, ''), targetCodeOf(canonical, ''), target, canonical]
    .map(norm)
    .filter(Boolean);
  for (const [k, v] of Object.entries(map)) {
    /* 键也归一：写 ZH-HANS 和写「简体中文」拿到同一个代码 */
    const keyCode = norm(targetCodeOf(k, ''));
    if (want.includes(norm(k)) || (keyCode && want.includes(keyCode))) return v;
  }
  return '';
}

/** 删掉 [from, to] 这几行（含两端） */
function stripLines(text, from, to) {
  const lines = text.split('\n');
  lines.splice(from, to - from + 1);
  return lines.join('\n');
}



/** 拿一个语言名在当前语言下该显示成什么（查不到就原样返回） */
/** 某个语言代码在当前界面语言下该显示成什么（查不到就返回代码本身） */
export function langDisplayName(code, t) {
  if (!code) return '';
  const key = langNameKey(code);
  if (typeof t !== "function") return String(code);
  const got = t(key);
  return got && got !== key ? got : String(code);
}

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

/**
 * 按界面语言生成一套「代码 → 显示名」。
 *
 * 这就是 target 的来源：settings.targetNames[code]。
 *
 * @param {string} uiLang  "zh" 或 "en"
 * @returns {Record<string,string>}  如 { "ZH-HANS": "Simplified Chinese", ... }
 *
 * 用户之后在设置页改的是**同一个对象**的值 —— 改完不会被自动覆盖，
 * 只有「切换界面语言」这一个动作会重新生成（kniph 2026-11-13 定的）。
 */
export function defaultTargetNames(t) {
  const out = {};
  for (const code of LANGS) {
    const key = langNameKey(code);
    const got = typeof t === 'function' ? t(key) : '';
    out[code] = got && got !== key ? got : code;   // 查不到就用代码本身，别留空
  }
  return out;
}

/**
 * 内置显示名（不跟着界面语言变，兜底用）。
 * 老存档里没有 targetNames 时，用它把对象的键补齐。
 */
/**
 * 内置中文名（**不依赖 i18n**，给 background / store 这些拿不到语言包的地方用）。
 *
 * 为什么要有这么一份：buildVars 在后台跑，service worker 里没有 T()，
 * 而 targetNames 空着时又不能拿代码（ZH-HANS）当名字喂给模型。
 * 这份只做「最后兜底」，界面上一律走 i18n 的 langname_* 。
 */
export const BUILTIN_ZH_NAMES = {
  'ZH-HANS': '简体中文', 'ZH-HANT': '繁體中文', 'EN': '英语', 'JA': '日语',
  'KO': '韩语', 'FR': '法语', 'DE': '德语', 'ES': '西班牙语', 'RU': '俄语',
  'PT': '葡萄牙语', 'IT': '意大利语', 'AR': '阿拉伯语', 'TH': '泰语',
  'VI': '越南语', 'ID': '印尼语', 'TR': '土耳其语', 'NL': '荷兰语',
  'PL': '波兰语', 'UK': '乌克兰语', 'CS': '捷克语', 'SV': '瑞典语',
  'NB': '挪威语', 'DA': '丹麦语', 'FI': '芬兰语', 'EL': '希腊语',
  'HU': '匈牙利语', 'RO': '罗马尼亚语'
};

/** 内置显示名：优先查表，查不到才用代码 */
export function builtinTargetName(code) {
  return BUILTIN_ZH_NAMES[code] || String(code || '');
}

/* ---- 变量约定 ----
   两个约定都长在**变量名**上，所以和渲染放在一起；engine / ocr / 设置页都往这儿取，
   别在别处再写一遍：
     · 模板里名字含 model 的那个变量填多行 = 换 model 重试（一行一个候选）
     · 名字里含 key = 这是个密钥，展示时打码 */

/**
 * 一个变量的值拆成「候选列表」—— **每行一个**。
 *
 * 这是「同一条请求里换 model 重试」的全部开关：管模型的那个变量填了多行，
 * 后台就逐个试，第一个返回译文为止。只有一行 = 就是普通单值，**没有任何新行为**，
 * 老存档（值都是单行）进来等于没开这个功能。
 *
 * 为什么按行而不是按逗号：model id / 别的值里可能有逗号，按行不怕内容里有分隔符；
 * 也和请求文本里 `#@lang` 那块「一行一条」的惯例一致。
 *
 * 值里**允许有空格**（`deepseek-ai/DeepSeek-V3` 这种），所以只 trim 首尾、不删中间。
 * 空行直接丢掉（末尾多敲一个回车不该多试一次）。
 */
export function splitVarValues(value) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/** 哪个占位符算「管模型的」：名字里含 model 就行（`model` / `GEMINI_MODEL` / `MODEL` 都认） */
const MODEL_HINT = /model/i;

/**
 * 这条请求模板里「哪个变量管模型」——**轮换/收敛的唯一判据**。
 *
 * 看**模板里真正用到的占位符**，而不是去扫变量表：变量是**全局的**（所有配置共用一张表），
 * 一个人完全可以同时存着 `GEMINI_MODEL` 和 `DEEPSEEK_MODEL`，光看变量名挑不出该轮换哪一个；
 * 看模板就永远挑得准 —— 这条配置引用的是哪个占位符，就轮换哪个。
 *
 * 原来只认死名字 `model`（2026-10-13 之前），于是 `{{GEMINI_MODEL}}` 这种写法的用户
 * 整段多行值被原样塞进地址、还很纳闷「模型轮换怎么没用」（kniph 报的）。
 *
 * @param {string} template 渲染前的请求文本
 * @param {object} vars 已组装好的变量
 * @returns {string} 命中的**键名原样**（保大小写）；没有则空串
 */
export function modelVarFor(template, vars) {
  if (!vars) return '';
  const seen = new Set();
  for (const m of String(template || '').matchAll(PLACEHOLDER_RE)) {
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    // 变量表里没有的不算：占位符写错了就该渲染成空串，不该凭空开一轮重试
    if (MODEL_HINT.test(name) && name in vars) return name;
  }
  return '';
}

/**
 * 从模板 + vars 里取 model 候选列表。
 * 找不到那个变量、或它只有空值 → 返回 []（调用方据此完全不启用回退）。
 */
export function modelCandidates(template, vars) {
  const key = modelVarFor(template, vars);
  return key ? splitVarValues(vars[key]) : [];
}

/**
 * 「一次调用 = 一次请求 = 一个 model」：多行的 model 值收敛成第一个候选。
 *
 * **每个渲染边界都要过这一下**（engine 的 runRequest / previewRequest、ocr 的 buildOcrRequest）：
 * 不过的话整段多行值会被原样塞进模板，地址里就出现四行 model 串在一起的怪东西
 * （kniph 报过：`.../models/gemini-3.8-flash\ngemini-3.7-flash\n…:streamGenerateContent`
 * 且那个地址根本发不出去）。后台真跑时每个候选各调一次 runRequest、传进来的本来就是单值，
 * 过这一下等于没变。
 */
export function firstModelVars(template, vars) {
  const key = modelVarFor(template, vars);
  if (!key) return vars;
  const list = splitVarValues(vars[key]);
  return list.length ? { ...vars, [key]: list[0] } : vars;
}

/**
 * 名字里含 key（不区分大小写）= 这是密钥。
 * 设置页拿它决定值要不要默认藏起来，engine 拿它决定「实际请求」里哪段值要打码。
 */
export function isSecretVar(name) {
  return /key/i.test(String(name || ''));
}
