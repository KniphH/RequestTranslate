/**
 * 自定义面板样式的「能力上限演示」样张。
 *
 * 单独一个文件、不打进 options.js 的原因：它只被一个按钮用到，
 * 塞进 options.js 会让那个已经 3300 行的文件更难读；放这儿也方便
 * 和 docs/CUSTOM-PANEL-DEMO.md 对照着看（那份是带逐段讲解的完整版）。
 *
 * 这不是给人长期用的配色 —— 它是用来演示「自定义面板能做到什么程度」：
 * 渐变 / 毛玻璃 / 伪元素装饰 / CSS 动画 / 计数器编号 / 网格重排 /
 * 定制滚动条 / 按主题分支 / 容器查询 / 无障碍降级，每一样都真的跑过。
 */
export const PANEL_CSS_DEMO = `
/* 能力上限演示（样张）—— 想看逐段讲解见 docs/CUSTOM-PANEL-DEMO.md */

#rt-panel { width: 520px !important; border-radius: 20px !important; overflow: visible !important; }

#rt-panel {
  background-color: rgba(16, 12, 28, .72) !important;
  background-image:
    radial-gradient(1200px 300px at -10% -20%, rgba(168, 85, 247, .55), transparent 60%),
    radial-gradient(900px 260px at 110% 10%, rgba(34, 211, 238, .45), transparent 55%),
    linear-gradient(160deg, #1b1030 0%, #120e1f 45%, #0b0a14 100%) !important;
  backdrop-filter: blur(14px) saturate(1.5);
  -webkit-backdrop-filter: blur(14px) saturate(1.5);
  border: 0 !important;
  box-shadow:
    inset 0 0 0 1px rgba(255,255,255,.14),
    inset 0 1px 0 rgba(255,255,255,.22),
    0 0 0 1px rgba(168,85,247,.45),
    0 18px 60px -12px rgba(124,58,237,.55),
    0 0 90px -20px rgba(34,211,238,.35) !important;
}

#rt-panel::before {
  content: "";
  position: absolute; inset: 0 0 auto 0; height: 2px;
  border-radius: 20px 20px 0 0;
  background: linear-gradient(90deg, #a855f7, #22d3ee, #f472b6, #fbbf24, #a855f7);
  background-size: 300% 100%;
  animation: rt-demo-flow 6s linear infinite;
  pointer-events: none;
}
@keyframes rt-demo-flow { to { background-position: 300% 0; } }

#rt-panel .rt-head {
  background: linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.015)) !important;
  border-bottom: 1px solid rgba(255,255,255,.12) !important;
  padding: 6px 8px !important;
}
#rt-panel .rt-cfg, #rt-panel .rt-lang {
  background: rgba(255,255,255,.06) !important;
  border: 1px solid rgba(255,255,255,.16) !important;
  border-radius: 999px !important;
  color: #e9e5f5 !important;
  padding: 2px 12px !important;
}
#rt-panel .rt-cfg:hover, #rt-panel .rt-lang:hover {
  border-color: #22d3ee !important;
  box-shadow: 0 0 0 3px rgba(34,211,238,.22), 0 0 18px -4px rgba(34,211,238,.7);
}
#rt-panel .rt-btn {
  background: rgba(255,255,255,.07) !important;
  border-radius: 999px !important;
  color: #cfc8e6 !important;
  transition: transform .18s, color .18s, background .18s;
}
#rt-panel .rt-btn:hover {
  background: rgba(255,255,255,.18) !important; color: #fff !important;
  transform: translateY(-1px) scale(1.08);
}
#rt-panel .rt-dot { box-shadow: 0 0 10px 2px currentColor; animation: rt-demo-pulse 1.6s ease-in-out infinite; }
@keyframes rt-demo-pulse {
  0%, 100% { opacity: .65; transform: scale(.92); }
  50%      { opacity: 1;   transform: scale(1.12); }
}

#rt-panel .rt-src {
  background: repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 6px, transparent 6px 12px) !important;
  border-left: 3px solid #f472b6 !important;
  border-bottom: 0 !important;
  border-radius: 0 10px 10px 0;
  margin: 8px 10px; padding: 8px 12px !important;
  color: #b9b0d4 !important; font-style: italic;
}

#rt-panel .rt-out { padding: 10px 12px !important; counter-reset: rt-demo-slot; }
#rt-panel .rt-slot {
  counter-increment: rt-demo-slot;
  position: relative;
  padding: 10px 12px 12px !important;
  margin: 8px 0 !important;
  background: linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.012)) !important;
  border: 1px solid rgba(255,255,255,.1) !important;
  border-radius: 14px !important;
  transition: border-color .2s, box-shadow .2s;
}
#rt-panel .rt-slot:hover {
  border-color: rgba(168,85,247,.55) !important;
  box-shadow: 0 10px 30px -14px rgba(168,85,247,.75);
}
#rt-panel .rt-slot + .rt-slot { border-top: 0 !important; margin-top: 8px !important; padding-top: 10px !important; }
#rt-panel .rt-slot::before {
  content: counter(rt-demo-slot);
  position: absolute; top: -7px; left: 10px;
  min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 9px;
  background: linear-gradient(135deg, #a855f7, #22d3ee);
  color: #0b0a14; font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
  box-shadow: 0 2px 8px rgba(168,85,247,.6);
}
#rt-panel .rt-slot-name { color: #22d3ee !important; font-weight: 600; letter-spacing: .02em; }
#rt-panel .rt-slot-st {
  color: #8f86ad !important; font-size: .64em !important;
  letter-spacing: .12em; text-transform: uppercase;
}
#rt-panel .rt-slot-b {
  color: #f2eefc !important;
  border-right: 2px solid transparent; padding-right: 10px;
  border-image: linear-gradient(180deg, rgba(168,85,247,.7), rgba(34,211,238,0)) 1;
}
#rt-panel .rt-slot-b.err { color: #ffb4b4 !important; }

#rt-panel .rt-acts { gap: 6px !important; margin-top: 8px; }
#rt-panel .rt-act {
  background: rgba(255,255,255,.05) !important;
  border: 1px solid rgba(255,255,255,.12) !important;
  border-radius: 999px !important;
  padding: 2px 10px !important;
  color: #b9b0d4 !important;
  transition: all .18s;
}
#rt-panel .rt-act:hover {
  background: rgba(168,85,247,.28) !important;
  border-color: rgba(168,85,247,.8) !important;
  color: #fff !important; transform: translateY(-1px);
}

#rt-panel .rt-foot {
  background: rgba(255,255,255,.03) !important;
  border-top: 1px solid rgba(255,255,255,.1) !important;
}
#rt-panel .rt-msg {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace !important;
  color: #8f86ad !important; letter-spacing: .02em;
}
#rt-panel .rt-more {
  border-radius: 999px !important;
  background: rgba(255,255,255,.07) !important;
  min-width: 26px;
}
#rt-panel .rt-more:hover {
  background: rgba(34,211,238,.25) !important;
  border-color: rgba(34,211,238,.8) !important;
  color: #22d3ee !important;
}

#rt-panel .rt-diag {
  background: rgba(0,0,0,.45) !important;
  border-top: 1px solid rgba(255,255,255,.1) !important;
  padding: 10px 14px !important;
}
#rt-panel .rt-diag .d-row {
  display: grid !important;
  grid-template-columns: 6.5em 1fr;
  gap: 10px; padding: 1px 0;
}
#rt-panel .rt-diag .d-k {
  width: auto !important; text-align: right;
  color: #6f6790 !important; font-size: .72em; letter-spacing: .06em;
}
#rt-panel .rt-diag .d-v { color: #22d3ee !important; font-weight: 600; }
#rt-panel .rt-diag .d-v.warn { color: #fbbf24 !important; }
#rt-panel .rt-diag .d-v.err  { color: #ff8080 !important; }

#rt-panel .rt-out::-webkit-scrollbar { width: 8px; }
#rt-panel .rt-out::-webkit-scrollbar-track {
  background: rgba(255,255,255,.04); border-radius: 999px;
}
#rt-panel .rt-out::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, #a855f7, #22d3ee); border-radius: 999px;
}

[data-rt-theme="light"]#rt-panel {
  background-color: rgba(255,255,255,.78) !important;
  background-image:
    radial-gradient(1200px 300px at -10% -20%, rgba(168,85,247,.22), transparent 60%),
    linear-gradient(160deg, #ffffff 0%, #f6f2ff 100%) !important;
  box-shadow:
    inset 0 0 0 1px rgba(124,58,237,.2),
    0 18px 50px -16px rgba(124,58,237,.4) !important;
}
[data-rt-theme="light"]#rt-panel .rt-slot {
  background: rgba(255,255,255,.75) !important;
  border-color: rgba(124,58,237,.16) !important;
}
[data-rt-theme="light"]#rt-panel .rt-slot-b { color: #1e1633 !important; }
[data-rt-theme="light"]#rt-panel .rt-slot-name { color: #6d28d9 !important; }
[data-rt-theme="light"]#rt-panel .rt-src { color: #5b5378 !important; }
[data-rt-theme="light"]#rt-panel .rt-cfg,
[data-rt-theme="light"]#rt-panel .rt-lang {
  background: rgba(255,255,255,.8) !important;
  border-color: rgba(124,58,237,.25) !important;
  color: #2b2244 !important;
}

#rt-panel { container-type: inline-size; }
@container (max-width: 360px) {
  #rt-panel .rt-slot-st, #rt-panel .rt-slot::before { display: none !important; }
}

@media (prefers-reduced-motion: reduce) {
  #rt-panel *, #rt-panel::before { animation: none !important; transition: none !important; }
}
`;
