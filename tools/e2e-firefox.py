#!/usr/bin/env python3
"""火狐端到端冒烟测试。

为什么不用 Playwright：它的 firefox 要 Mozilla 之外的定制二进制（Juggler 协议），
**装不了我们的扩展**。火狐的正路是 WebDriver —— selenium + geckodriver，
它有 install_web_extension(..., temporary=True)，正对应火狐的「临时载入」。

和 Edge 那套（tools/e2e-ui.mjs，554 项）的关系：那套覆盖全，这套是**火狐专有风险**的
最小集合 —— 凡是在 Chromium 上也能验的，不在这里重复。

前提：
  - 火狐在 C:\\rtff\\app\\firefox.exe（**必须短路径**，长路径沙箱起不来，见 firefox/README.md）
  - 扩展源码在 C:\\rtsrc（短路径，从 .xpi 解出来）
  - pip install selenium（geckodriver 由 Selenium Manager 自动获取）

用法：  python tools/e2e-firefox.py
"""

import json
import os
import sys
import threading
import time
import http.server
import socketserver

FF = os.environ.get("RT_FF", r"C:\rtff\app\firefox.exe")
SRC = os.environ.get("RT_SRC", r"C:\rtsrc")
PROF = os.environ.get("RT_PROF", r"C:\rtgd\prof-e2e")
SHOT = r"C:\rt-ff-e2e.png"

PREFS = [
    "xpinstall.signatures.required",
    "browser.shell.checkDefaultBrowser",
    "browser.aboutwelcome.enabled",
    "datareporting.policy.dataSubmissionEnabled",
    "toolkit.telemetry.enabled",
    "app.update.enabled",
]

PAGE = """<!doctype html><meta charset=utf-8><title>rt-e2e-ff</title>
<style>body{margin:0;padding:40px;font:16px/28px sans-serif}
#t{width:600px}</style>
<p id=t>第一行文字稍微长一点，长到能把整段选区的右边界推到很远的地方<br>第二行是中等长度的文字，用来撑出多行选区<br>短短一行</p>
"""


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def main():
    from selenium import webdriver
    from selenium.webdriver.firefox.options import Options

    results = []

    def check(name, ok, detail=""):
        results.append((name, bool(ok), detail))
        print(("  ok   " if ok else "  FAIL ") + name + (("  " + str(detail)) if detail else ""), flush=True)

    def check_skip(name, why):
        print("  SKIP " + name + "  " + str(why), flush=True)

    srv = socketserver.TCPServer(("127.0.0.1", 0), Handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    os.makedirs(PROF, exist_ok=True)
    with open(os.path.join(PROF, "user.js"), "w", encoding="utf-8") as f:
        for p in PREFS:
            f.write('user_pref("%s", false);\n' % p)
        f.write('user_pref("trailhead.firstrun.didSeeAboutWelcome", true);\n')
        f.write('user_pref("browser.startup.homepage_override.mstone", "ignore");\n')

    opts = Options()
    opts.binary_location = FF
    opts.add_argument("-profile")
    opts.add_argument(PROF)
    # 注意：指定了 -profile 就**不能**再 set_preference —— 两者一起用会
    # SessionNotCreatedException("Failed to set preferences")。prefs 全走 user.js。

    d = webdriver.Firefox(options=opts)
    try:
        print("火狐 " + str(d.capabilities.get("browserVersion")) +
              " / geckodriver " + str(d.capabilities.get("moz:geckodriverVersion")), flush=True)
        print("", flush=True)

        # ---- 装扩展 ----
        # install_addon(SRC, temporary=True) 是火狐专用的「临时载入」，正好对应
        # about:debugging 里那个功能，也是 Release 版唯一能装未签名扩展的路。
        # Selenium 标了 DeprecationWarning 建议换 install_web_extension，但那个方法
        # 的签名不接受 temporary 参数（4.52 实测 TypeError），所以继续用它。
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            rid = d.install_addon(SRC, temporary=True)
        check("扩展装得上（临时载入）", rid == "requesttranslate@kniph.github.io", str(rid))

        # ---- 页面注入 ----
        d.get("http://127.0.0.1:%d/" % port)
        time.sleep(3)
        check("content script 注入", d.execute_script(
            "return !!document.getElementById('request-translate-host')"))

        # ---- 划词 ----
        d.execute_script("""
          const p = document.getElementById("t");
          const [t0, , t2] = p.childNodes;
          const r = document.createRange();
          r.setStart(t0, 2); r.setEnd(t2, t2.textContent.length);
          const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
          const segs = Array.from(r.getClientRects()).filter(x => x.width > 0);
          const tail = segs[segs.length - 1];
          document.dispatchEvent(new MouseEvent("mouseup", {
            bubbles: true, composed: true,
            clientX: tail.right - 2, clientY: tail.top + tail.height / 2 }));
        """)
        time.sleep(1.5)
        trig = d.execute_script("""
          const sh = document.getElementById("request-translate-host").shadowRoot;
          const t = sh.querySelector(".rt-trigger");
          const r = t ? t.getBoundingClientRect() : null;
          return { show: !!(t && t.classList.contains("show")), w: r ? Math.round(r.width) : 0 };
        """)
        check("划词弹出小圆点", trig.get("show") and trig.get("w", 0) > 0, json.dumps(trig))

        # ---- 点开面板（不需要真接口：能开就说明 UI 链路通） ----
        d.execute_script("""
          const sh = document.getElementById("request-translate-host").shadowRoot;
          sh.querySelector(".rt-trigger").click();
        """)
        time.sleep(2)
        panel = d.execute_script("""
          const sh = document.getElementById("request-translate-host").shadowRoot;
          const p = sh.querySelector("#rt-panel");
          const r = p ? p.getBoundingClientRect() : null;
          return { show: !!(p && p.classList.contains("show")), h: r ? Math.round(r.height) : 0 };
        """)
        check("点小圆点能开面板", panel.get("show") and panel.get("h", 0) > 0, json.dumps(panel))

        d.save_screenshot(SHOT)

        # ---- 只有火狐能验的：chrome.* 到底返不返回 Promise（待验 #1 的硬证据） ----
        # 扩展的 UUID 不在 extensions.json 里（临时载入的扩展压根不写那个文件），
        # 而在 prefs.js 的 extensions.webextensions.uuids 这一条里，值是个 JSON 字符串、
        # 引号是转义过的。
        uuid = None
        import re
        prefs_path = os.path.join(PROF, "prefs.js")
        if os.path.exists(prefs_path):
            raw = open(prefs_path, encoding="utf-8", errors="ignore").read()
            m = re.search(r'user_pref\("extensions\.webextensions\.uuids",\s*"(.+?)"\);\n', raw)
            if m:
                try:
                    uuid = json.loads(m.group(1).replace(chr(92) + chr(34), chr(34))).get("requesttranslate@kniph.github.io")
                except Exception:
                    pass
        # WebDriver **不允许**导航到 moz-extension://（实测 "is not allowed in this
        # context"），所以这条路多半走不通。走不通就记 SKIP 并把 uuid 置空 —— 注意
        # 必须**再判一次** if uuid，不能指望在块里把 uuid 改成 None 就能跳过后面，
        # Python 不会因为变量变了就中断当前代码块（这里踩过一次，probe 跑到了测试页上，
        # 报 chrome is not defined）。
        nav_ok = False
        if uuid:
            try:
                d.get("moz-extension://%s/options.html" % uuid)
                nav_ok = True
            except Exception as e:
                check_skip("扩展页面里验 Promise", "WebDriver 不让进 moz-extension://（" + str(e)[:70] + "）")

        if nav_ok:
            time.sleep(2)
            probe = d.execute_script("""
              const out = {};
              out.chrome = typeof chrome;
              out.browser = typeof browser;
              try {
                const r = chrome.storage.local.get("__probe");
                out.storageIsPromise = !!(r && typeof r.then === "function");
              } catch (e) { out.storageErr = String(e); }
              try {
                const t = chrome.tabs.query({});
                out.tabsIsPromise = !!(t && typeof t.then === "function");
              } catch (e) { out.tabsErr = String(e); }
              out.offscreen = typeof (chrome.offscreen && chrome.offscreen.createDocument);
              return out;
            """)
            check("扩展页面里 chrome.* 返回 Promise（storage）", probe.get("storageIsPromise"), json.dumps(probe, ensure_ascii=False))
            check("扩展页面里 chrome.* 返回 Promise（tabs）", probe.get("tabsIsPromise"))
            check("火狐没有 offscreen（走的是后台直接读那条分支）", probe.get("offscreen") == "undefined", str(probe.get("offscreen")))


    finally:
        d.quit()
        srv.shutdown()

    passed = sum(1 for _, ok, _ in results if ok)
    failed = len(results) - passed
    print("", flush=True)
    print("火狐冒烟：%d 项通过，%d 项失败" % (passed, failed), flush=True)
    print("截图：%s" % SHOT, flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
