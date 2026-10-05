/**
 * 内置适配器
 * ------------------------------------------------------------------
 * 大部分翻译服务都能用「一整段请求文本」表达，所以直接走请求模板。
 *
 * 但有些免费服务没法这样表达，最典型的是 Bing：
 *   1. GET https://cn.bing.com/translator，从 630KB 的 HTML 里正则抠出
 *      IG / IID / key / token（token 有效期 1 小时）
 *   2. 拿这些参数 POST https://cn.bing.com/ttranslatev3
 * 两步，而且第二步的入参是第一步动态拿到的，模板写不出来。
 *
 * 这类走适配器。适配器返回的结构和 engine.runRequest 完全一致，
 * 所以面板、诊断、「…」详情、错误处理都能原样复用。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0';

const BING_HOST = 'cn.bing.com';

/** 可被测试替换的基址（默认就是 cn.bing.com） */
let bingBase = `https://${BING_HOST}`;

/** 给测试用：把请求指到本地假服务器上 */
export function setBingBase(base) {
  bingBase = String(base || `https://${BING_HOST}`).replace(/\/+$/, '');
  session = null;
}

const websiteUrl = () => `${bingBase}/translator`;
const apiUrl = (sess) =>
  `${bingBase}/ttranslatev3?isVertical=1&IG=${encodeURIComponent(sess.ig)}&IID=${encodeURIComponent(sess.iid)}`;

/**
 * 语言名 → Bing 语言代码。
 * 设置里填的是「简体中文」这种中文名，Bing 要 zh-Hans 这种代码。
 */
const LANG_MAP = {
  '简体中文': 'zh-Hans', '简体': 'zh-Hans', '中文': 'zh-Hans', '汉语': 'zh-Hans',
  '繁體中文': 'zh-Hant', '繁体中文': 'zh-Hant', '繁体': 'zh-Hant', '繁體': 'zh-Hant',
  '英语': 'en', '英文': 'en', 'english': 'en',
  '日语': 'ja', '日文': 'ja', 'japanese': 'ja',
  '韩语': 'ko', '韩文': 'ko', 'korean': 'ko',
  '法语': 'fr', '法文': 'fr', 'french': 'fr',
  '德语': 'de', '德文': 'de', 'german': 'de',
  '西班牙语': 'es', '西班牙文': 'es', 'spanish': 'es',
  '俄语': 'ru', '俄文': 'ru', 'russian': 'ru',
  '葡萄牙语': 'pt', 'portuguese': 'pt',
  '意大利语': 'it', 'italian': 'it',
  '阿拉伯语': 'ar', 'arabic': 'ar',
  '泰语': 'th', 'thai': 'th',
  '越南语': 'vi', 'vietnamese': 'vi',
  '印尼语': 'id', 'indonesian': 'id',
  '土耳其语': 'tr', 'turkish': 'tr'
};

/** 认语言名，也认语言代码本身 */
export function toBingLang(input, fallback = 'zh-Hans') {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return fallback;
  if (/^[a-z]{2}(-[a-z0-9]+)?$/i.test(raw)) return raw;
  return LANG_MAP[raw] || LANG_MAP[raw.toLowerCase()] || fallback;
}

/* ------------------------------------------------------------------ */
/* Bing 会话（token）缓存                                              */
/* ------------------------------------------------------------------ */

let session = null;

async function fetchSession(signal) {
  const res = await fetch(websiteUrl(), {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    signal
  });
  if (!res.ok) throw new Error(`抓 Bing 翻译页失败：HTTP ${res.status}`);

  const html = await res.text();
  const ig = html.match(/IG\s*:\s*"([A-Fa-f0-9]+)"/);
  const iid = html.match(/data-iid\s*=\s*"([^"]+)"/);
  const abuse = html.match(
    /params_AbusePreventionHelper\s*=\s*\[\s*(\d+)\s*,\s*"([^"]+)"\s*,\s*(\d+)\s*\]/
  );

  if (!ig || !iid || !abuse) {
    throw new Error('没能从 bing.com/translator 页面里解析出鉴权参数（Bing 可能改版了）');
  }

  const ttl = Number(abuse[3]) || 3600000;
  return {
    ig: ig[1],
    iid: iid[1],
    key: abuse[1],
    token: abuse[2],
    expires: Date.now() + Math.max(60000, ttl - 120000) // 留 2 分钟余量
  };
}

async function getSession(signal) {
  if (session && Date.now() < session.expires) return session;
  session = await fetchSession(signal);
  return session;
}

/** 丢掉缓存的 token，下次重新抓（调用失败时用） */
export function resetBingSession() {
  session = null;
}

/** Bing 的 token 抓一次能用一小时，这里顺手报给 UI 看 */
export function bingSessionInfo() {
  if (!session) return null;
  return { ig: session.ig, iid: session.iid, leftMs: Math.max(0, session.expires - Date.now()) };
}

/* ------------------------------------------------------------------ */
/* 适配器实现                                                          */
/* ------------------------------------------------------------------ */

function emptyResult() {
  return {
    ok: false,
    status: 0,
    statusText: '',
    ms: 0,
    text: '',
    error: null,
    warnings: [],
    missingVars: [],
    usedPath: null,
    request: null,
    raw: '',
    ttfbMs: null,
    firstDeltaMs: null,
    reasoningChars: 0,
    mode: null,
    chunks: 0,
    bytes: 0,
    direct: false
  };
}

function finish(result, started) {
  result.ms = Date.now() - started;
  if (result.ttfbMs === null) result.ttfbMs = result.ms;
  return result;
}

async function runBing(options) {
  const { text, vars = {}, signal = null, onDelta = null } = options;
  const started = Date.now();
  const result = emptyResult();
  result.mode = 'adapter';
  result.usedPath = 'Bing ttranslatev3';

  const to = toBingLang(vars.targetLang || vars.target);

  const call = async (sess) => {
    const res = await fetch(apiUrl(sess), {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: websiteUrl(),
        Origin: bingBase
      },
      body: new URLSearchParams({
        fromLang: 'auto-detect',
        text,
        to,
        token: sess.token,
        key: sess.key,
        tryFetchingGenderDebiasedTranslations: 'true'
      }),
      signal
    });
    return { res, raw: await res.text() };
  };

  try {
    let { res, raw } = await call(await getSession(signal));

    // token 过期或被拒：重抓一次再试。Bing 这时常常回 200 + 空 body，光看状态码判断不出来
    if (!res.ok || !raw.trim()) {
      resetBingSession();
      const retry = await call(await getSession(signal));
      res = retry.res;
      raw = retry.raw;
      if (raw.trim()) result.warnings.push('Bing 的 token 过期了，已自动重新获取并重试');
    }

    result.status = res.status;
    result.statusText = res.statusText;
    result.ok = res.ok;
    result.raw = raw;
    result.bytes = raw.length;
    result.chunks = 1;
    result.ttfbMs = Date.now() - started;

    if (!res.ok) {
      result.error = `HTTP ${res.status} ${res.statusText} —— ${raw.slice(0, 200)}`;
      return finish(result, started);
    }
    if (!raw.trim()) {
      result.error =
        'Bing 返回了空响应。通常是 token 失效或被限流，重试一次一般就好；' +
        '如果每次都空，八成是请求走了代理（节点把它掐了）——' +
        '先在代理客户端里给 bing.com 加一条直连规则（DOMAIN-SUFFIX,bing.com,DIRECT）；' +
        '加不了的话，到设置页的「网络」里把「用内置适配器时临时直连」打开也能绕过去。';
      return finish(result, started);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      result.error = 'Bing 返回的不是 JSON：' + raw.slice(0, 200);
      return finish(result, started);
    }

    const first = Array.isArray(data) ? data[0] : data;
    const translated =
      first && first.translations && first.translations[0] && first.translations[0].text;

    if (!translated) {
      result.error = 'Bing 没返回译文，响应结构：' + JSON.stringify(data).slice(0, 200);
      return finish(result, started);
    }

    result.text = translated;
    result.chunks = 1;
    result.firstDeltaMs = Date.now() - started;
    if (onDelta) onDelta(translated, translated);
    return finish(result, started);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      result.error = '已取消';
    } else {
      result.error = 'Bing 翻译失败：' + (err && err.message ? err.message : String(err));
    }
    return finish(result, started);
  }
}

/** 适配器注册表：id → { label, hint, run } */
export const ADAPTERS = {
  bing: {
    id: 'bing',
    label: 'Bing 翻译 · 免费，不需要 API Key',
    hint: '走 bing.com 网页版接口。第一次翻译会先抓一次鉴权参数（多花约 0.5 秒），之后一小时内的请求都很快。',
    run: runBing
  }
};

export function hasAdapter(id) {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, id);
}

/**
 * 每个适配器建议走直连的域名。
 * 代理节点普遍把 Bing 的翻译接口掐了 —— 走代理时稳稳回一个空 body，
 * 所以这些域名在请求期间会被放进 PAC 的直连名单。
 */
const DIRECT_HOSTS = {
  bing: ['bing.com', 'bing.net', 'bingapis.com', 'microsofttranslator.com']
};

export function adapterDirectHosts(id) {
  return DIRECT_HOSTS[id] || null;
}

export function runAdapter(id, options) {
  const a = ADAPTERS[id];
  if (!a) {
    const r = emptyResult();
    r.error = `没有名为 ${id} 的内置适配器`;
    return Promise.resolve(r);
  }
  return a.run(options);
}
