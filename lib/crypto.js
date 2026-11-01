/**
 * 导出文件的口令加密（Web Crypto，零依赖）。
 *
 * 为什么是「用户口令」而不是内置密钥：内置密钥只能存在扩展源码里，而咱们的 zip
 * 就挂在公开 Release 上——解包即明文，「只有作者知道」不成立。口令派生密钥、
 * 口令不落盘，丢了口令文件就解不开：这是特性（口令等于 key 本身），导出 UI 要讲清。
 *
 * 形态（外壳 kind 与明文导出的 `request-translate` 区分开，导入先认它）：
 *   { kind: 'request-translate-encrypted',
 *     crypto: { scheme, salt, iv, iterations },   // 都是 hex —— 公开参数，不是秘密
 *     data: '<hex 密文>' }
 *
 * 方案：PBKDF2-HMAC-SHA256（60 万次迭代，OWASP 2023 建议值）→ AES-256-GCM。
 * GCM 自带完整性：口令错或密文被篡改，解密直接抛错，不存在「解出一堆乱码」。
 */

const SCHEME = 'pbkdf2-aesgcm-v1';
const ITERATIONS = 600000;
const enc = new TextEncoder();

/** bytes → hex（不用 btoa：导出 JSON 几十 KB，String.fromCharCode 展开会爆栈） */
function toHex(buf) {
  const v = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < v.length; i += 1) s += v[i].toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error('bad hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 随机字节（测试里注入替换点，避免真实随机数让单测无法对答案） */
function randomBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deriveKey(passphrase, saltBytes, iterations = ITERATIONS) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/* 迭代次数的合理上限：文件里的这个值是**公开参数**，解密时按它算 PBKDF2。
   给一个上限是防「被塞了 1e12 次的原文件」把浏览器卡死 —— 那不是我们的文件。 */
const MAX_ITERATIONS = 10000000;

/**
 * 从外壳里读迭代次数。
 *
 * **必须读它，不能用模块里的常量**（kniph 2026-10-18 通读发现）：这个字段写进格式里
 * 就是为了让「加密时的次数」跟着文件走。原来 decryptExport 拿的是常量 ITERATIONS，
 * 于是——只要将来把 ITERATIONS 调大（OWASP 建议值本来就会涨），**所有老文件都解不开**，
 * 而且报的是「口令不对，或者文件已经损坏」，用户会以为是自己记错了口令，
 * 完全无从下手。
 *
 * 缺字段 / 类型不对 → 退回当前默认值（兼容手写的文件）；
 * 值非法 → **明说是文件参数不对**，别混进「口令不对」那句话里。
 */
function readIterations(field) {
  const raw = field && field.iterations;
  if (raw === undefined || raw === null || raw === '') return ITERATIONS;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1) {
    throw new Error('这个加密文件的参数不对（iterations = ' + String(raw) + '）');
  }
  if (n > MAX_ITERATIONS) {
    throw new Error('这个加密文件的迭代次数异常大（' + n + '），已拒绝解密 —— 文件可能被改过');
  }
  return n;
}

/** 这段文本是不是咱们加密导出的外壳（导入 sniff 用 —— 只认 scheme 对得上的） */
export function isEncryptedExport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return false;
  }
  return !!data
    && data.kind === 'request-translate-encrypted'
    && data.crypto
    && data.crypto.scheme === SCHEME
    && typeof data.data === 'string';
}

/** 明文导出字符串 → 加密外壳 JSON 字符串 */
export async function encryptExport(plainJsonText, passphrase) {
  if (!passphrase) throw new Error('没有口令就没法加密导出');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(plainJsonText)
  );
  return JSON.stringify({
    kind: 'request-translate-encrypted',
    crypto: { scheme: SCHEME, salt: toHex(salt), iv: toHex(iv), iterations: ITERATIONS },
    data: toHex(cipher)
  });
}

/**
 * 加密外壳 → 明文导出字符串（原样交给 importState，不做别的）。
 * 口令错 / 密文被改过：GCM 校验失败抛 OperationError —— 上层统一说「口令不对」，
 * 不区分是哪种（也区分不了，这就是 GCM 的语义）。
 */
export async function decryptExport(wrappedText, passphrase) {
  let data;
  try {
    data = JSON.parse(wrappedText);
  } catch {
    throw new Error('不是合法的 JSON —— 文件可能坏了，或者选错了文件');
  }
  if (!data || data.kind !== 'request-translate-encrypted' || !data.crypto || typeof data.data !== 'string') {
    throw new Error('这不是加密导出的配置文件');
  }
  if (data.crypto.scheme !== SCHEME) {
    throw new Error('这个加密文件的格式（' + data.crypto.scheme + '）不认识 —— 可能来自更新后的版本');
  }
  const salt = fromHex(data.crypto.salt);
  const iv = fromHex(data.crypto.iv);
  const key = await deriveKey(passphrase, salt, readIterations(data.crypto));
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, fromHex(data.data));
  } catch {
    // 口令错和密文损坏在 GCM 里是同一个错 —— 分不开，也不必分
    throw new Error('口令不对，或者文件已经损坏');
  }
  return new TextDecoder().decode(plain);
}