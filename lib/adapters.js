/**
 * 内置适配器
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
 *
 * 关于代理：这条通道的请求**全部建在 cn.bing.com 这一个基址上**（下面两个 URL 都是），
 * 所以用户在代理软件里放行 `bing.com` 这一族就够。开着代理时这里容易拿到 200 + 空 body
 * （token 跟会话绑，取 token 和用 token 的出口不一致就失效，半拉子分流没用）——
 * 修法一律在代理软件里按域名直连（README「代理与 Bing 免费通道」有完整清单）。
 * 早先版本往扩展里加过「临时改浏览器代理」的开关，已经整块删掉了，**别再捡回来**。
 */

import { targetCodeOf } from './template.js';

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
 * 映射表不在这儿 —— 它和 {{targetCode}} 共用 lib/template.js 里那一张
 * （TARGET_LANG_CODES，值统一写成 ZH-HANS 这种大写形式）。
 * 不用为大小写再做一层变形：真机实测 Bing 不挑大小写，
 * zh-Hans / ZH-HANS / ZH-hans / zh-hans 四种写法都是 HTTP 200、译文一模一样。
 */
export function toBingLang(input, fallback = 'zh-Hans') {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return fallback;
  return targetCodeOf(raw, '') || fallback;
}

/* ---- Bing 会话（token）缓存 ---- */

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

/* ---- 适配器实现 ---- */

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
    // 适配器没有可编辑的请求文本，也就没有模型名可读 —— 面板据此不显示「模型」那行
    model: '',
    raw: '',
    ttfbMs: null,
    firstDeltaMs: null,
    reasoningChars: 0,
    mode: null,
    chunks: 0,
    bytes: 0
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
        '如果每次都空，八成是请求走了代理 —— 节点把这个接口掐了，换节点也一样。' +
        '在代理客户端里给 bing.com 加一条直连规则（DOMAIN-SUFFIX,bing.com,DIRECT）即可。';
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

export function runAdapter(id, options) {
  const a = ADAPTERS[id];
  if (!a) {
    const r = emptyResult();
    r.error = `没有名为 ${id} 的内置适配器`;
    return Promise.resolve(r);
  }
  return a.run(options);
}
