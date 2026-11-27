import { DEFAULT_CONFIGS } from './store.js';
import { OCR_PROVIDERS } from './ocr.js';
import { escapeShellSingle } from './template.js';

export const NEW_TRANSLATION_REQUEST = [
  'curl https://example.com/v1/chat/completions \\',
  '  -H "Content-Type: application/json" \\',
  '  -H "Authorization: Bearer {{apiKey}}" \\',
  "  -d '{",
  '  "model": "your-model",',
  '  "messages": [{"role": "user", "content": "{{text}}"}],',
  '  "stream": true',
  "}'"
].join('\n');

const leadingNotes = /^(?:[ \t]*#[^\r\n]*(?:\r?\n|$)|[ \t]*\r?\n)*/;
const escaped = text => text.replace(/[.*+?^{}$()|[\]\\]/g, '\\$&').replace(/\r?\n/g, '\\r?\\n');
const quoted = /"(?:[^"\\\r\n]|\\.)*"/.source;
const shellQuote = escapeShellSingle("'");
const variable = /^\{\{[\w.-]+\}\}$/;
export const variableReference = value => variable.test(value) ? value : '';

function profile({id, request}) {
  const seed = request.replace(leadingNotes, '');
  if (id === 'builtin-bilibili') return { literal: seed, publicService: true, fields: [] };
  const curl = seed.startsWith('curl ');
  const baidu = id === 'builtin-baidu-ocr';
  const fields = [];
  function capture(key, expression, pattern, other = {}) {
    const match = expression.exec(seed);
    if (!match) return;
    const {value} = match.groups;
    fields.push({key, start: match.indices.groups.value[0], length: value.length, pattern, ...other});
  }

  capture('url', /^(?:curl|POST) (?<value>\S+?)(?=\?access_token=|\s)/d,
    baidu ? "[^\\s\"'?#]+" : "[^\\s\"']+");
  capture('key', /(?:Authorization:[ \t]*(?:Bearer|DeepL-Auth-Key)[ \t]+|x-api-key:[ \t]*)(?<value>\{\{apiKey\}\})/id,
    '[^\\r\\n"\\\\]*', {secret: true});
  if (baidu) {
    capture('token', /access_token=(?<value>[^&\s]+)/d, "[^\\s&#\"']*", {secret: true});
    capture('language', /language_type=(?<value>[A-Za-z_]+)/d, '[A-Za-z_]+');
  }
  const jsonString = curl ? '"(?:' + escaped(shellQuote) + '|[^"\\\\\'\\r\\n]|\\\\.)*"' : quoted;
  capture('model', /"model":\s*(?<value>"[^"]*")/d, jsonString, {json: true});
  if (id !== 'builtin-siliconflow') {
    const prompt = /"role": "user", "content": (?<value>"(?:[^"\\]|\\.)*")/d;
    capture('prompt', prompt.test(seed) ? prompt : /"type": "text", "text": (?<value>"(?:[^"\\]|\\.)*")/d,
      jsonString, {json: true});
  }
  fields.sort((a, b) => a.start - b.start);
  let offset = 0;
  const parts = fields.map(field => {
    const fixed = escaped(seed.slice(offset, field.start));
    offset = field.start + field.length;
    return fixed + '(' + field.pattern + ')';
  });
  const remainder = id === 'builtin-deepl'
    ? escaped(seed.slice(offset).split('\n\n#@lang')[0]) + '(?:[ \\t]*\\r?\\n(?:[ \\t]*#[^\\r\\n]*)?)*'
    : escaped(seed.slice(offset)) + '[ \\t\\r\\n]*';
  return { fields, curl, regexp: new RegExp('^' + parts.join('') + remainder + '$', 'd') };
}

const translators = [...DEFAULT_CONFIGS.filter(config => !config.adapter), {
  id: 'starter', request: NEW_TRANSLATION_REQUEST
}].map(profile);
const providers = OCR_PROVIDERS.map(profile);

// A match identifies the original spans. Text outside those spans stays byte-for-byte intact.
export function requestFields(source, ocr = false) {
  if (!source) return null;
  const lead = leadingNotes.exec(source)[0].length;
  const body = source.slice(lead);
  for (const candidate of ocr ? providers : translators) {
    if (candidate.publicService) {
      if (body.trimEnd().replace(/\r\n/g, '\n') === candidate.literal) return {publicService: true, fields: []};
      continue;
    }
    const match = candidate.regexp.exec(body);
    if (!match) continue;
    try {
      const fields = candidate.fields.map((field, index) => {
        const raw = match[index + 1];
        const [start, end] = match.indices[index + 1];
        return { ...field, start: start + lead, end: end + lead,
          value: field.json ? JSON.parse(candidate.curl ? raw.split(shellQuote).join("'") : raw) : raw };
      });
      return { fields, curl: candidate.curl };
    } catch {
      return null;
    }
  }
  return null;
}

export function updateRequestField(source, mapping, key, value) {
  const field = mapping?.fields.find(entry => entry.key === key);
  if (!field) return null;
  if (key === 'url' && !/^\{\{[\w.-]+\}\}(?:\/|$)/.test(value)) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!/^https?:$/.test(url.protocol) || !url.hostname) return null;
  }
  let inserted = field.json ? JSON.stringify(value) : value;
  if (field.json && mapping.curl) inserted = escapeShellSingle(inserted);
  if (!new RegExp('^(?:' + field.pattern + ')$').test(inserted)) return null;
  if (inserted === source.slice(field.start, field.end)) return source;
  return source.slice(0, field.start) + inserted + source.slice(field.end);
}
