/**
 * 请求条目与「链」—— 主请求 + 若干后备。
 *
 * **配置和 OCR 供应商共用这一套**：一条配置里可以挂几条请求（主请求先发，挂了按顺序试勾上的
 * 后备），一个 OCR 供应商也一样。两边曾经各写一份，于是「OCR 供应商只能填一条请求」
 * （kniph 2026-10-14 报的：「中转OCR还是只能填一个请求啊」）。
 *
 * 形状：**条目** = `{ id, name?, main?, enabled, request, path, … }`，链 = 主 + 勾上的后备。
 * 顶层对象（配置 / 供应商）把主请求的字段直接放在自己身上（`request` / `path`），
 * 后备放在 `fallbacks[]`，`mainEnabled` 管主请求勾没勾 —— 所以下面这些函数
 * **对配置和供应商是同一套代码**，传进去就行。
 *
 * 这个文件不碰 chrome、不 import 别的 lib（除了自己），能在 Node 里单测；
 * 也正因为它没有依赖，`store.js` 和 `ocr.js` 才能同时 import 它而不会成环。
 */

/** 新 id。配置 / 后备 / 供应商都用它。 */
export function uid() {
  return 'cfg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/** 一条后备请求的归一化。缺字段补默认，类型不对按没有算。 */
export function normalizeRequestItem(f) {
  return {
    id: f && f.id ? String(f.id) : uid(),
    enabled: !(f && f.enabled === false),
    adapter: f && f.adapter ? String(f.adapter) : '',
    request: f && typeof f.request === 'string' ? f.request : '',
    imageRequest: f && typeof f.imageRequest === 'string' ? f.imageRequest : '',
    path: f && typeof f.path === 'string' ? f.path : '',
    responseMode: ['auto', 'sse', 'json', 'text'].includes(f && f.responseMode) ? f.responseMode : 'auto'
  };
}

/** 顶层那条主请求 → 和后备**同形**的条目（`main: true`）。 */
export function mainRequest(config) {
  if (!config) return null;
  return {
    id: config.id,
    name: config.name || '',
    main: true,
    enabled: config.mainEnabled !== false,
    adapter: config.adapter || '',
    request: config.request || '',
    imageRequest: config.imageRequest || '',
    path: config.path || '',
    responseMode: config.responseMode || 'auto'
  };
}

/** 主请求 + 后备，都在（不管勾没勾）—— 编辑器要按这个顺序画块 */
export function allRequests(config) {
  const main = mainRequest(config);
  if (!main) return [];
  /* `enabled !== false` 而不是 `!!enabled`：**缺字段 = 勾上**（老存档 / 手写的后备都没这个字段）。
     和 content.js 那份镜像、normalizeRequestItem 三处必须同一个口径。

     名字在这儿现算（`后备 1` / `后备 2`…，按在链里的位置）—— 存档里不存这个字段，
     所以**改序之后名字自动跟着走**，不会出现「叫后备 2 的那条排在第一个」。 */
  const rest = (Array.isArray(config.fallbacks) ? config.fallbacks : []).map((f, i) => ({
    ...f,
    name: `后备 ${i + 1}`,
    main: false,
    enabled: f.enabled !== false
  }));
  return [main, ...rest];
}

/**
 * 这次要**按顺序试**哪些请求：主请求 + 勾上的后备。
 *
 * 「启用勾」是唯一的开关。**一条都没勾时退回主请求** —— 一条配置存在却什么都不发
 * 是个没人看得懂的死状态，宁可照老样子跑主请求（也等于「全都不勾 = 只跑主请求」）。
 */
export function requestChain(config) {
  const all = allRequests(config);
  if (!all.length) return [];
  const on = all.filter((r) => r.enabled);
  return on.length ? on : [all[0]];
}

/**
 * 这次请求该用哪一段模板。
 *
 * 一个**请求条目**（主请求或后备，形状见 `mainRequest`）带两段模板：普通那段翻文字，
 * `imageRequest` 那段翻图（右键「翻译剪切板中的截图」+ 勾了「禁用外置 OCR」时走它）。
 * 图片模板**留空就回退到普通那段** —— 老配置（没这个字段）行为完全不变，
 * 想一段模板两用的也照样能用 {{image}} / {{imagePart}} 自己拼。
 */
export function requestTemplateFor(item, context = {}) {
  if (!item) return '';
  const hasImage = !!(context && context.image);
  const img = typeof item.imageRequest === 'string' ? item.imageRequest : '';
  if (hasImage && img.trim()) return img;
  return item.request || '';
}
