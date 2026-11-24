import { isSecretVar } from './template.js';

/* 展示用的打码：网络请求、预览、错误文案共用这一份，避免三处各写一套。 */

/** 打码后统一留这个尾巴，顺带当成「这段已经打过了」的记号 */
const MASKED = '…（已隐藏）';

/** 比这更短的值不做替换：一个 2 字符的「密钥」会把预览里所有同名片段都涂掉 */
const MIN_SECRET_LEN = 4;

export function maskSecret(value) {
  const s = String(value ?? '').trim();
  if (!s) return '（还没填）';
  if (s.length <= 6) return '***';
  return s.slice(0, 6) + MASKED;
}

export function maskSecretOccurrences(text, vars) {
  let out = String(text ?? '');
  if (!out) return out;
  for (const [name, value] of Object.entries(vars || {})) {
    if (!isSecretVar(name)) continue;
    const v = String(value ?? '').trim();
    if (v.length < MIN_SECRET_LEN) continue;
    out = out.split(v).join(maskSecret(v));
  }
  return out;
}

function maskAuthValue(value) {
  const s = String(value || '');
  const m = /^\s*Bearer\s*(.*)$/i.exec(s);
  if (!m) return s.trim() ? maskSecret(s) : s;
  return 'Bearer ' + maskSecret(m[1]);
}

export function maskAuthHeaders(headers, vars = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    let val = maskSecretOccurrences(v, vars);
    if (/^authorization$/i.test(k) && !val.includes(MASKED)) val = maskAuthValue(val);
    out[k] = val;
  }
  return out;
}

/** 展示用请求：永远返回新对象，不碰真正要发出去的那份。 */
export function maskRequest(req, vars = {}) {
  const out = { ...req };
  if (typeof out.url === 'string') out.url = maskSecretOccurrences(out.url, vars);
  out.headers = maskAuthHeaders(out.headers, vars);
  if (typeof out.body === 'string') out.body = maskSecretOccurrences(out.body, vars);
  return out;
}

/** 错误文案 / 提示里出现的密钥也要按同一规则隐藏。 */
export function redactErrorText(text, vars) {
  return maskSecretOccurrences(text, vars);
}
