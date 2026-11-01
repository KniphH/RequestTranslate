/**
 * 面板的 DOM 骨架 + 槽位 HTML + 增量更新 —— **网页和设置页预览共用的唯一一份**。
 *
 * 为什么要有这个文件：设置页的「效果预览」以前是在 options.js 里**手抄**了一份
 * 面板 DOM，于是每加一个部件（眼睛图标、诊断按钮、rt-actions 容器）预览就落后一步，
 * 表现为「和网页上不一样」。这份文件用普通脚本写成（挂 window.RTPanelCore），
 * 让 content script（manifest 的 js 数组）和设置页（script 标签）都能加载同一份，
 * 从结构上消灭第二份。
 *
 * content script 不能 import，所以这里**不能是 ES module**；样式表那份同理见
 * lib/panel-styles.js（那个仍是 module，第二步再合并）。
 */
(function () {
  'use strict';

  /* ---- 图标：和原来 content.js 里那几份逐字一致 ---- */
  var EYE_SVG =
    "<svg viewBox='0 0 20 20' width='19' height='19' fill='none' stroke='currentColor' stroke-width='1.6' " +
    "stroke-linecap='round' stroke-linejoin='round'><path d='M1.6 10S4.9 4.6 10 4.6 18.4 10 18.4 10 15.1 15.4 10 15.4 1.6 10 1.6 10Z'/>" +
    "<circle cx='10' cy='10' r='2.3'/></svg>";
  var ACT_COPY_SVG =
    "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' " +
    "stroke-linecap='round' stroke-linejoin='round'><rect x='7' y='7' width='9' height='9' rx='1.6'/>" +
    "<path d='M13 4.5H5.6A1.6 1.6 0 0 0 4 6.1V13'/></svg>";
  var ACT_RETRY_SVG =
    "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' " +
    "stroke-linecap='round' stroke-linejoin='round'><path d='M16.5 10a6.5 6.5 0 1 1-1.9-4.6'/>" +
    "<path d='M16.5 3.5V7H13'/></svg>";
  var ACT_SPEAK_SVG =
    "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' " +
    "stroke-linecap='round' stroke-linejoin='round'><path d='M3.5 7.5h2.8L10 4.2v11.6l-3.7-3.3H3.5z'/>" +
    "<path d='M13 7.6a3.4 3.4 0 0 1 0 4.8'/><path d='M15.2 5.4a6.6 6.6 0 0 1 0 9.2'/></svg>";
  var ACT_STOP_SVG =
    "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' " +
    "stroke-linecap='round' stroke-linejoin='round'><path d='M3.5 7.5h2.8L10 4.2v11.6l-3.7-3.3H3.5z'/>" +
    "<path d='M13 8l4 4M17 8l-4 4'/></svg>";

  /** HTML 转义：只包三个字符，和原来 content.js 里那份一致。 */
  function esc(t) {
    return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /**
   * 面板的**静态骨架**（顶栏 / 正文 / 底栏 / 诊断区）。
   * 和 content.js 原来那段 panel.innerHTML 逐字对应 —— 眼睛的 SVG、
   * rt-actions 容器、data-placeholder、底栏那个「⋯」、诊断区一个都不少。
   */
  function shellHtml() {
    return (
      "<div class='rt-head' data-drag>" +
      "<span class='rt-dot'></span>" +
      "<select class='rt-cfg' title='翻译接口'></select>" +
      "<select class='rt-lang' title='目标语言'></select>" +
      "<div class='rt-actions'>" +
      "<button class='rt-btn' data-act='src' title='显示 / 隐藏原文'>" + EYE_SVG + "</button>" +
      "<button class='rt-btn' data-act='close' title='关闭 (Esc)'>&#10005;</button>" +
      "</div></div>" +
      "<div class='rt-body'><div class='rt-src'></div>" +
      "<div class='rt-out empty' data-placeholder='等待结果…'></div></div>" +
      "<div class='rt-foot'><span class='rt-msg'></span>" +
      "<button class='rt-more' data-act='more' title='查看详细信息' hidden>&#8943;</button></div>" +
      "<div class='rt-diag' hidden></div>"
    );
  }

  /**
   * 一条译文尾巴上那排「复制 / 朗读 / 重试」。
   *
   * `speaking` 由调用方传进来（原来是读闭包里的 speakingKey）—— 这是把它抽成
   * 公共函数的唯一代价，换来的是两边共用同一份 HTML。
   */
  function actsHtml(cid, text, speaking) {
    var hasText = !!(text && String(text).trim());
    var stop = !!speaking;
    return (
      "<div class='rt-acts'>" +
      "<button class='rt-act' data-act='copy' data-cid='" + cid + "'" + (hasText ? '' : ' disabled') + " title='复制这条译文'>" +
      ACT_COPY_SVG + "<span>复制</span></button>" +
      "<button class='rt-act' data-act='speak' data-cid='" + cid + "'" + (hasText ? '' : ' disabled') + " " +
      "data-icon='" + (stop ? 'rt-act-stop' : 'rt-act-speak') + "' " +
      "title='" + (stop ? '停止朗读' : '朗读这条译文') + "'>" +
      (stop ? ACT_STOP_SVG : ACT_SPEAK_SVG) +
      "<span>" + (stop ? '停止' : '朗读') + "</span></button>" +
      "<button class='rt-act' data-act='retry-one' data-cid='" + cid + "' title='只重试这一条'>" +
      ACT_RETRY_SVG + "<span>重试</span></button>" +
      "</div>"
    );
  }

  /**
   * 一个槽位块。
   *
   * `s` = { configId, name, state, text, error, statusText }，和 content.js 的槽位对象同形。
   * `opts.allowDel` 决定要不要那个 ×（原逻辑：只有一个槽位时不显示）。
   * `opts.speaking` 同 actsHtml。
   */
  function slotHtml(s, opts) {
    opts = opts || {};
    var st = '';
    var body = '';
    var cls = '';
    if (s.state === 'busy') {
      st = '翻译中…' + (s.statusText || '');
      body = s.text || '';
    } else if (s.state === 'done') {
      st = '完成';
      body = s.text || '';
    } else if (s.state === 'fail') {
      st = '失败';
      cls = ' err';
      body = s.error || '出错了';
    } else {
      st = '等待…';
    }
    var del = opts.allowDel
      ? "<button class='rt-slot-x' data-del='" + esc(s.configId) + "' title='不再显示这一条（只影响这次，不改设置里的默认组合）'>×</button>"
      : '';
    return (
      "<div class='rt-slot' data-cid='" + esc(s.configId) + "'>" +
      "<div class='rt-slot-h'><span class='rt-slot-name' data-p='name'>" + esc(s.name) + "</span>" +
      del +
      "<span class='rt-slot-st" + cls + "' data-p='st'>" + esc(st) + "</span></div>" +
      "<div class='rt-slot-b" + cls + "' data-p='body'>" + esc(body) + "</div>" +
      actsHtml(esc(s.configId), body, opts.speaking) +
      "</div>"
    );
  }

  /**
   * 把一个槽位的新状态**就地**写进已经存在的那份 DOM（增量渲染）。
   *
   * 只碰值不碰结构：文本、状态字、err 类、按钮的 disabled 与朗读图标。
   * 子元素用 data-p 定位而不是类名 —— 那几个类名是拼在模板里的，
   * tools/check-dom.mjs 的正则识别不到，会误报「类没有定义」。
   */
  function patchSlot(el, s, speaking) {
    var st = '';
    var body = '';
    var err = false;
    if (s.state === 'busy') {
      st = '翻译中…' + (s.statusText || '');
      body = s.text || '';
    } else if (s.state === 'done') {
      st = '完成';
      body = s.text || '';
    } else if (s.state === 'fail') {
      st = '失败';
      err = true;
      body = s.error || '出错了';
    } else {
      st = '等待…';
    }

    var nameEl = el.querySelector('[data-p=\"name\"]');
    if (nameEl && nameEl.textContent !== s.name) nameEl.textContent = s.name;

    var stEl = el.querySelector('[data-p=\"st\"]');
    if (stEl) {
      if (stEl.textContent !== st) stEl.textContent = st;
      stEl.classList.toggle('err', err);
    }

    var bodyEl = el.querySelector('[data-p=\"body\"]');
    if (bodyEl) {
      if (bodyEl.textContent !== body) bodyEl.textContent = body;
      bodyEl.classList.toggle('err', err);
    }

    var acts = el.querySelector('.rt-acts');
    if (!acts) return;
    var hasText = !!(body && String(body).trim());
    var stop = !!speaking;
    var copyBtn = acts.querySelector('[data-act=\"copy\"]');
    var speakBtn = acts.querySelector('[data-act=\"speak\"]');
    var retryBtn = acts.querySelector('[data-act=\"retry-one\"]');
    if (copyBtn) copyBtn.disabled = !hasText;
    if (retryBtn) retryBtn.disabled = !hasText;
    if (speakBtn) {
      speakBtn.disabled = !hasText;
      speakBtn.title = stop ? '停止朗读' : '朗读这条译文';
      var label = speakBtn.querySelector('span');
      var want = stop ? '停止' : '朗读';
      if (label && label.textContent !== want) label.textContent = want;
      var wantSvg = stop ? 'rt-act-stop' : 'rt-act-speak';
      if (speakBtn.getAttribute('data-icon') !== wantSvg) {
        var old = speakBtn.querySelector('svg');
        if (old) old.remove();
        speakBtn.insertAdjacentHTML('afterbegin', stop ? ACT_STOP_SVG : ACT_SPEAK_SVG);
        speakBtn.setAttribute('data-icon', wantSvg);
      }
    }
  }

  /** 结果区的一整批槽位（整块重建时用）。 */
  function slotsHtml(slots, opts) {
    opts = opts || {};
    return slots.map(function (s) {
      return slotHtml(s, { allowDel: slots.length > 1, speaking: opts.speaking === s.configId });
    }).join('');
  }

  /**
   * 把诊断行填进容器 —— 真面板的「⋯」展开区与设置页预览**共用这一份**。
   *
   * `rows` = [{ k, v, err?, warn?, hint? }]，和 content.js 组装出来的那份同形。
   * 只负责画行；moreBtn 的显隐、容器 hidden 那些状态属于各自的逻辑。
   */
  function renderDiag(el, rows) {
    if (!el) return;
    el.textContent = "";
    for (var i = 0; i < rows.length; i += 1) {
      var r = rows[i];
      var line = document.createElement("div");
      line.className = "d-row";
      var k = document.createElement("span");
      k.className = "d-k";
      k.textContent = r.k;
      var v = document.createElement("span");
      v.className = "d-v" + (r.err ? " err" : r.warn ? " warn" : "");
      v.textContent = r.v;
      line.appendChild(k);
      line.appendChild(v);
      if (r.hint) line.title = r.hint;
      el.appendChild(line);
    }
  }
  window.RTPanelCore = {
    EYE_SVG: EYE_SVG,
    ACT_COPY_SVG: ACT_COPY_SVG,
    ACT_RETRY_SVG: ACT_RETRY_SVG,
    ACT_SPEAK_SVG: ACT_SPEAK_SVG,
    ACT_STOP_SVG: ACT_STOP_SVG,
    esc: esc,
    shellHtml: shellHtml,
    actsHtml: actsHtml,
    slotHtml: slotHtml,
    slotsHtml: slotsHtml,
    patchSlot: patchSlot,
    renderDiag: renderDiag
  };
})();
