import { isSecretVar } from './template.js';

/* 展示用的打码：网络请求、预览、错误文案、诊断信息共用这一份。
   上游 e86f74e 把打码从 engine.js 提取到本模块；Stage 02 冻结版里增强的「诊断遮蔽」
   （URL 编码 / JSON 转义变体、显式凭据提取、结果字段兜底）合并到同一处，
   避免引擎、适配器、OCR、设置页各留一份实现。 */

/** 打码后统一留这个尾巴，顺带当成「这段已经打过了」的记号（见 maskAuthHeaders） */
const MASKED = '…（已隐藏）';

/** 比这更短的值不做替换：一个 2 字符的「密钥」会把预览里所有同名片段都涂掉，反而看不清 */
const MIN_SECRET_LEN = 4;

export function maskSecret(value) {
  const s = String(value ?? '').trim();
  if (!s) return '（还没填）';
  if (s.length <= 6) return '***';
  return s.slice(0, 6) + MASKED;
}

/**
 * 把 vars 里**名字含 key / token / secret / password** 的那些值，在文本里出现过的
 * 每一处都换成打码版。按值扫而不是按占位符位置打：渲染完占位符就没影了，而同一把
 * key 常常同时出现在 URL 查询串、Authorization 头和请求体里。
 * 值可能是 URL 编码或 JSON 转义后的形式，三种变体一起扫，避免回显时漏掉。
 */
export function maskSecretOccurrences(text, vars) {
  let out = String(text ?? '');
  if (!out) return out;
  for (const [name, value] of Object.entries(vars || {})) {
    if (!isSecretVar(name) && !/(?:token|secret|password)/i.test(name)) continue;
    const v = String(value ?? '').trim();
    if (v.length < MIN_SECRET_LEN) continue;
    let encoded = v;
    try { encoded = encodeURIComponent(v); } catch { /* Keep masking malformed Unicode verbatim. */ }
    const variants = [...new Set([v, encoded, JSON.stringify(v).slice(1, -1)])].sort((a, b) => b.length - a.length);
    for (const variant of variants) out = out.split(variant).join(maskSecret(v));
  }
  return out;
}

function maskAuthValue(value) {
  const s = String(value || '');
  /* 前缀统一重排成 `Bearer `：解析出来的头值已经被 trim 过。 */
  const m = /^\s*Bearer\s*(.*)$/i.exec(s);
  if (!m) return s.trim() ? maskSecret(s) : s;
  return 'Bearer ' + maskSecret(m[1]);
}

export function maskAuthHeaders(headers, vars = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    let val = maskSecretOccurrences(v, vars);
    // 变量那一步已经打过的别再打一遍 —— 会叠成两层「…（已隐藏）…（已隐藏）」
    if (/^authorization$/i.test(k) && !val.includes(MASKED)) val = maskAuthValue(val);
    out[k] = val;
  }
  return out;
}

/** 从请求头和 URL 查询串里补出「没走变量、直接写死」的凭据，一并参与打码。 */
export function diagnosticVarsForRequest(vars = {}, request = {}) {
  const out = { ...vars };
  let count = 0;
  const add = (value) => {
    const secret = String(value || '').replace(/^\s*(?:Bearer|Basic)(?:\s+|$)/i, '').trim();
    if (secret.length >= MIN_SECRET_LEN) out['diagnosticKey' + count++] = secret;
  };
  for (const [name, value] of Object.entries(request.headers || {})) {
    if (/authorization|api[-_]?key|auth[-_]?token/i.test(name)) add(value);
  }
  try {
    const url = new URL(request.url);
    for (const [name, value] of url.searchParams) if (/key|token|secret|password/i.test(name)) add(value);
  } catch { /* Invalid URLs are reported by request validation. */ }
  return out;
}

/** 展示用请求：永远返回新对象，不碰真正要发出去的那份。 */
export function maskRequest(req, vars = {}) {
  const out = { ...req };
  const secrets = diagnosticVarsForRequest(vars, req);
  if (typeof out.url === 'string') out.url = maskSecretOccurrences(out.url, secrets);
  out.headers = maskAuthHeaders(out.headers, secrets);
  if (typeof out.body === 'string') out.body = maskSecretOccurrences(out.body, secrets);
  return out;
}

/** 错误文案 / 提示里出现的密钥也要按同一规则隐藏。 */
export function redactErrorText(text, vars) {
  return maskSecretOccurrences(text, vars);
}

/** 诊断文本（原始响应、OCR 错误等）单独走这里，语义与错误文案一致。 */
export function maskDiagnosticText(value, vars = {}) {
  return maskSecretOccurrences(value, vars);
}

/** 结果出引擎前的最后一道兜底：所有展示字段都过遮蔽，成功的译文不动。 */
export function maskResultDiagnostics(result, vars = {}) {
  if (!result) return result;
  const mask = (value) => typeof value === 'string' ? maskDiagnosticText(value, vars) : value;
  const maskEntry = (entry) => {
    if (typeof entry === 'string') return mask(entry);
    if (!entry || typeof entry !== 'object') return entry;
    const copy = { ...entry };
    if ('text' in copy) copy.text = mask(copy.text);
    if ('shape' in copy) copy.shape = mask(copy.shape);
    if (Array.isArray(copy.params)) copy.params = copy.params.map(mask);
    return copy;
  };
  result.error = mask(result.error);
  result.raw = mask(result.raw);
  result.model = mask(result.model);
  if (!result.ok) result.text = mask(result.text);
  if (Array.isArray(result.errorParams)) result.errorParams = result.errorParams.map(mask);
  if (Array.isArray(result.problems)) result.problems = result.problems.map(maskEntry);
  if (Array.isArray(result.warnings)) result.warnings = result.warnings.map(maskEntry);
  return result;
}
