/**
 * 已废弃（2026-11-09）。
 *
 * 这里原来 export 一份 PANEL_CSS，content.js 里再手抄一份，靠 test-lib 的逐字比对
 * 断言防漂移 —— 改一个样式要同步两处，已经漏过一次（text-align 继承穿透 shadow DOM）。
 *
 * 现在样式表只有一份，在 lib/panel-core.js（挂 window.RTPanelCore）：
 *   - content script   —— manifest 的 content_scripts.js 里 panel-core 排在前面
 *   - 设置页           —— options.html 用 <script src> 先加载它
 * 两边都不能 import，所以必须走全局对象；这也是这个文件退役的原因。
 *
 * 保留这个空文件不删，是为了让老链接 / 老记忆指过来时不至于 404，也留一条迁移线索。
 */
export {};
