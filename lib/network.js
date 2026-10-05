/**
 * 临时直连（让某一次请求绕过系统代理）
 * ------------------------------------------------------------------
 * 扩展里的 fetch 走的是浏览器的网络栈，只要系统开着代理（Clash / FlClash /
 * SwitchyOmega …），请求就一律走代理，Chromium 没有「这一次别走代理」的开关。
 *
 * 实测的麻烦：开着代理时 Bing 的翻译接口会回一个 HTTP 200 + 空 body，
 * 换个节点也一样 —— 节点那边把它掐了。
 *
 * 能用的手段只有一个：把浏览器的代理设置临时切成直连，发完再切回来。
 *
 *   const release = await acquireDirect(['bing.com']);
 *   try { ...发请求... } finally { await release(); }
 *
 * 几个刻意的设计：
 *
 * · 窗口能多短就多短。只包住 fetch 本身，不包住后面的解析 ——
 *   这期间浏览器里其他新连接也会受影响，虽然通常只是几百毫秒。
 * · 收尾用 clear()，不是 set(旧值)。set 回去会让本扩展一直「压着」代理设置
 *   （levelOfControl 变成 controlled_by_this_extension），之后用户在代理软件里
 *   改端口就不生效了。clear() 是交还控制权，会自然回落到系统设置 / 别的扩展 / 策略。
 * · 能拿到原代理地址时用 PAC，只让目标域名直连、其余照旧走代理；
 *   拿不到地址时（系统代理 / 自动检测 / 别的扩展塞的 PAC）只能整机切直连。
 * · 用引用计数兜住并发：同时来两个翻译请求，只切一次、只切回来一次。
 *
 * 边界：
 * · 需要 manifest 里的 "proxy" 权限，且只有扩展自己的页面能用（content 脚本不行）。
 * · 代理若是 TUN / 虚拟网卡模式，流量在网卡层就被抓走了，这一招没用 ——
 *   只能在代理软件里加 DOMAIN-SUFFIX,bing.com,DIRECT。这是物理限制，绕不过去。
 * · service worker 被意外中断时可能留下「直连」状态，initDirectGuard() 负责清理。
 */

const SCOPE = 'regular';

/* 一次直连窗口的记账 -------------------------------------------------- */

let using = 0;     // 窗口里还有几个请求在用直连
let setup = null;  // 设置代理的 Promise（一个窗口只设一次）
let owned = false; // 当前的代理设置是不是我们改的，是的话得负责改回去
let method = '';   // 'pac' | 'direct' | ''，给诊断面板看

/** 扩展页面里才有 chrome.proxy；Node 里跑测试时没有 */
export function canControlProxy() {
  return typeof chrome !== 'undefined' && !!chrome.proxy && !!chrome.proxy.settings;
}

/** 这次直连是怎么实现的：'pac' 只放行目标域名，'direct' 整机切直连 */
export function directMethod() {
  return method;
}

/** 现在浏览器是不是正被我们按在直连上 */
export function isDirectActive() {
  return owned;
}

/**
 * 把「当前生效的代理配置」翻译成 PAC 里能写的回退项。
 * 翻不出来返回 null —— 那这次就只能整机切直连了。
 *
 * @param {object} cfg chrome.proxy.settings.get() 里的 value
 */
export function pacFallback(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  if (cfg.mode === 'direct') return 'DIRECT';
  // system / auto_detect / pac_script 都拿不到具体地址
  if (cfg.mode !== 'fixed_servers') return null;

  const rules = cfg.rules || {};
  const server =
    rules.singleProxy || rules.proxyForHttps || rules.proxyForHttp || rules.fallbackProxy;
  if (!server || !server.host) return null;

  const scheme = String(server.scheme || 'http').toLowerCase();
  const keyword =
    scheme === 'socks5' ? 'SOCKS5' :
    scheme === 'socks4' ? 'SOCKS4' :
    scheme === 'https' ? 'HTTPS' : 'PROXY';

  return `${keyword} ${server.host}:${server.port || 80}`;
}

/**
 * 生成 PAC：hosts 里的域名（含子域）走直连，其余交给 fallback。
 *
 * @param {string[]} hosts   域名后缀，例如 ['bing.com']
 * @param {string} fallback  例如 'PROXY 127.0.0.1:7890'
 */
export function buildPac(hosts, fallback) {
  const list = JSON.stringify((hosts || []).map((h) => String(h).toLowerCase()));
  return [
    `var rtDirect = ${list};`,
    'function FindProxyForURL(url, host) {',
    '  host = String(host).toLowerCase();',
    '  for (var i = 0; i < rtDirect.length; i++) {',
    '    var d = rtDirect[i];',
    '    if (host === d || host.slice(-(d.length + 1)) === "." + d) return "DIRECT";',
    '  }',
    `  return ${JSON.stringify(fallback)};`,
    '}'
  ].join('\n');
}

/** 真正去改代理设置。失败（没权限 / 被策略锁死）就当没这回事 */
async function applyDirect(hosts) {
  try {
    const cur = await chrome.proxy.settings.get({ incognito: false });
    const cfg = cur && cur.value;

    // 本来就是直连，什么都不用做
    if (cfg && cfg.mode === 'direct') return;

    const fallback = pacFallback(cfg);
    let value;
    if (Array.isArray(hosts) && hosts.length && fallback) {
      value = { mode: 'pac_script', pacScript: { data: buildPac(hosts, fallback) } };
      method = 'pac';
    } else {
      value = { mode: 'direct' };
      method = 'direct';
    }

    await chrome.proxy.settings.set({ value, scope: SCOPE });
    owned = true;
  } catch {
    owned = false;
    method = '';
  }
}

/**
 * 进入一个直连窗口。返回 release()，务必在 finally 里调。
 *
 * @param {string[]|null} hosts 需要直连的域名后缀；给 null 表示整机直连
 * @returns {Promise<() => Promise<void>>}
 */
export async function acquireDirect(hosts = null) {
  const list = Array.isArray(hosts) ? hosts.filter(Boolean) : null;
  const noop = async () => {};

  if (!canControlProxy()) return noop;

  using += 1;
  if (using === 1) setup = applyDirect(list);
  await setup;

  let done = false;
  return async () => {
    if (done) return;
    done = true;

    using = Math.max(0, using - 1);
    if (using !== 0) return; // 还有别的请求在用这个窗口

    const pending = setup;
    setup = null;
    try {
      await pending;
    } catch {
      /* applyDirect 自己吞了异常 */
    }
    if (using !== 0 || !owned) return; // 等待期间又来了新请求

    owned = false;
    method = '';
    try {
      await chrome.proxy.settings.clear({ scope: SCOPE });
    } catch {
      /* 没权限就随它去 */
    }
  };
}

/**
 * service worker 启动时跑一次：上次要是在「直连」状态下被打断了，
 * 这里把代理设置交还回去，免得浏览器一直裸奔。
 *
 * 判据很干净 —— 本扩展除了这个功能之外从不碰代理设置，
 * 所以「当前是 controlled_by_this_extension」就等于「上次没收尾」。
 */
export async function initDirectGuard() {
  if (!canControlProxy() || using > 0) return;
  try {
    const cur = await chrome.proxy.settings.get({ incognito: false });
    if (cur && cur.levelOfControl === 'controlled_by_this_extension' && using === 0) {
      await chrome.proxy.settings.clear({ scope: SCOPE });
      owned = false;
      method = '';
    }
  } catch {
    /* 没权限就算了 */
  }
}
