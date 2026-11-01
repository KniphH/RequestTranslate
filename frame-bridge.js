/**
 * iframe 薄桥接（2026-10-16）—— 让划词在 iframe 里也能用。
 *
 * 为什么是「桥」而不是把整个 content.js 注进每个 frame：一份 content.js 剥注释后
 * 还有几十 KB，一个大页面几十个 iframe 全注一遍内存和按钮重复都吃不消。
 * 桥只做一件事：盯着自己 frame 里的选区，用 postMessage 把「文本 + frame 内坐标」
 * 报给顶层；按钮、面板、翻译全在顶层（永远只有一份 UI）。
 *
 * 注入：all_frames: true 会连顶层一起注 —— 顶层自己就是「父 frame」的终点，
 * 用 window.top === window 自检跳过下面的全部逻辑（UI 由 content.js 负责）。
 *
 * 坐标换算（为什么要 trail）：frame 内的 getBoundingClientRect 是**相对该 frame
 * 视口**的。叶子把自己 frame 内的坐标放进 rect、trail 留空往上发；中间层收到
 * 子 frame 的消息时，把「来源 iframe 元素在自己文档里的 rect」追加进 trail 再往
 * parent 发。顶层把 trail 逐层累加 + rect，就是顶层视口里的真实位置。
 *
 * postMessage 用 '*'：选区文本是用户在父页面看得见的内容（它就渲染在页面上），
 * 经此转发不构成额外泄露；跨域父页的 origin 无法查询，没有更窄的写法。
 *
 * 已知限制：iframe 内部滚动不会通知顶层 —— 按钮可能停在旧位置几秒，
 * 下一次 selectionchange 会修正（划词按钮本来几秒就自动消失，可接受）。
 */
(() => {
  if (window.top === window) return; // 顶层：UI 由 content.js 负责，桥不干活

  let lastText = '';
  let debounce = 0;

  const send = (msg) => {
    try {
      window.parent.postMessage(msg, '*');
    } catch {
      /* 父页拒绝（极罕见的 sandbox）—— 这个 frame 就没有划词，不致命 */
    }
  };

  const rectOf = (sel) => {
    try {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      if (r && (r.width || r.height)) {
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      }
    } catch {
      /* 选区已失效 */
    }
    return null;
  };

  document.addEventListener('selectionchange', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const sel = window.getSelection();
      const text = (sel && sel.toString()) || '';
      if (text.trim() && text !== lastText) {
        lastText = text;
        /* **不在这里截字数**（kniph 2026-10-18 通读）。「单次最多发送字数」是个
           用户设置（100~200000，默认 8000），执行点只有一处：顶层 content.js 的
           translate() —— 它按 prefs.maxChars 截，还带「负数会倒砍」的防护。
           这里原本写死 slice(0, 8000)，于是把上限调到 8000 以上的用户，
           普通页面能发 5 万字、iframe 里的选区却被**静默砍到 8000**，毫无提示。
           桥只负责报「选了哪段」，长度该由配置说了算。 */
        send({ type: 'rt-frame-sel', text, rect: rectOf(sel), trail: [] });
      } else if (!text.trim() && lastText) {
        // 选区没了（点击别处 / Esc）—— 告诉顶层把按钮收掉
        lastText = '';
        send({ type: 'rt-frame-sel', text: '', rect: null, trail: [] });
      }
    }, 120);
  });

  // 中转：更深一层的 iframe 的消息经我往上送（每层把自己的 offset 记进 trail）
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'rt-frame-sel') return;
    let fr = null;
    for (const f of document.querySelectorAll('iframe, frame')) {
      if (f.contentWindow === e.source) {
        fr = f.getBoundingClientRect();
        break;
      }
    }
    if (!fr) return; // 不是我直接子 frame 的消息，与我无关
    const trail = [...(m.trail || []), { left: fr.left, top: fr.top, right: fr.right, bottom: fr.bottom }];
    send({ ...m, trail });
  });
})();
