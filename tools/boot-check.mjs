/** 设置页白屏 / 初始化失败检测。
 *  e2e 与 test-lib 共用同一份：e2e 拿真实页面文本，test-lib 拿反例文本真跑。
 *  以前只认「短文本 + 错误词」，纯空白页面会假阴；现在短文本本身就是异常信号。
 */
export function detectBootFailure(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return '空白页面（没有渲染出设置页）';
  if (t.length < 200) {
    return /失败|failed|error/i.test(t) ? t.slice(0, 200) : '页面内容异常短：' + t.slice(0, 200);
  }
  return '';
}
