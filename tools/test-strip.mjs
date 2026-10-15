// 剥注释器的自测。**这是最该有单测的一个工具** —— 剥错了不会当场报错，
// 装上去才发现面板打不开，或者更糟：某个字符串被吃掉、翻译静默失败。
// 判据不能只看「注释没了」，还要看「该留的全留住了」。

import { stripJsComments, stripCssComments, stripHtmlComments, tidyBlankLines } from './strip-comments.mjs';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass += 1;
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
}

console.log('— URL 里的 // 不能被当成注释 —');
ok('字符串里的 https:// 留着',
  stripJsComments('const u = "https://a.com/b"; // 真注释') === 'const u = "https://a.com/b"; ',
  JSON.stringify(stripJsComments('const u = "https://a.com/b"; // 真注释')));

console.log('— 正则字面量 —');
{
  // 反斜杠转义的斜杠：正则字面量是 /ab\/\/c/ —— 里面有两个 \/ ，正则的结束 / 是第三个
  const src = 'const r = /ab\\/\\/c/g; const d = 1/2;';
  const out = stripJsComments(src);
  // 关键不是「输出长什么样」，而是「它没把后面的代码当注释吃掉、也没截断正则」
  ok('正则里的斜杠不结束正则（后半段代码完整）',
    out === src && out.includes('const d = 1/2;'), JSON.stringify(out));
}
ok('除号还是除号',
  stripJsComments('const q = (a+b)/(c+d); //x') === 'const q = (a+b)/(c+d); ',
  JSON.stringify(stripJsComments('const q = (a+b)/(c+d); //x')));
{
  const src = 'function f(){ return /x\\/y/.test(s); } //k';
  const out = stripJsComments(src);
  ok('return 后面的 /x\\/y/ 是正则不是除法（.test 那截没被吃掉）',
    out === 'function f(){ return /x\\/y/.test(s); } ', JSON.stringify(out));
}

console.log('— 模板串里的 // 是字面文本 —');
ok('模板串内的 // 不删',
  stripJsComments('const s = `前 // 中 ${x} 后`; // 真注释') === 'const s = `前 // 中 ${x} 后`; ',
  JSON.stringify(stripJsComments('const s = `前 // 中 ${x} 后`; // 真注释')));
ok('模板串插值内部的注释要删',
  !stripJsComments('const s = `${ a /* 内部 */ }`;').includes('内部'),
  JSON.stringify(stripJsComments('const s = `${ a /* 内部 */ }`;')));

console.log('— 字符串里的注释样文本 —');
ok('"/* 不是注释 */" 原样留着',
  stripJsComments('const t = "/* 不是注释 */";') === 'const t = "/* 不是注释 */";');
ok('"// 也不是" 原样留着',
  stripJsComments('const t = "// 也不是";') === 'const t = "// 也不是";');

console.log('— 转义引号不结束字符串 —');
{
  // 单引号字符串里有一个转义的 \' —— 紧跟其后的 // 仍是字符串内容
  const src = "const s = 'it\\'s // not comment'; // yes";
  const out = stripJsComments(src);
  ok('转义引号后面的 // 不删', out.includes('not comment'), JSON.stringify(out));
  ok('真的注释删掉了', !out.includes('yes'), JSON.stringify(out));
}

console.log('— 行号不变（报错栈要对得上源码）—');
{
  const src = ['const a = 1;', '/* 第一行', '   第二行 */', 'const b = 2;'].join('\n');
  const out = stripJsComments(src);
  ok('删掉的块注释留下等量的换行', out.split('\n').length === 4, JSON.stringify(out));
  ok('后一行的行号没变（还在第 4 行）', out.split('\n')[3].includes('const b = 2;'));
}

console.log('— JSDoc 整块删掉（对查 stack trace 没用）—');
{
  const src = '/**\n * 报失败。\n * @param {string} why\n */\nfunction showFailure(why) {}';
  const out = stripJsComments(src);
  ok('JSDoc 里的 @param 不留在包里', !out.includes('@param'), JSON.stringify(out));
  ok('函数本体留着', out.includes('function showFailure(why) {}'));
}

console.log('— CSS —');
ok('CSS 块注释删掉', stripCssComments('a{}/*x*/b{}').trim() === 'a{}b{}');
ok('CSS 里的字符串不动', stripCssComments('a{content:"/*"}') === 'a{content:"/*"}');

console.log('— HTML —');
ok('HTML 注释删掉但换行留着',
  stripHtmlComments('a\n<!-- 说明 -->\nb').trim() === 'a\n\nb',
  JSON.stringify(stripHtmlComments('a\n<!-- 说明 -->\nb')));

console.log('— 空行与行号（kniph 2026-10-14 定的：留着，让报错栈对得上源码）—');
ok('tidyBlankLines 现在是原样返回（空行留着 = 行号不变）',
  tidyBlankLines('a\n\n\nb') === 'a\n\n\nb', JSON.stringify(tidyBlankLines('a\n\n\nb')));
{
  // 删掉一段注释之后，后面的行号必须仍然等于它在源码里的行号
  const src = ['const a = 1;', '/* 20 行注释', ' * 第 2 行', ' * 第 3 行 */', 'const b = 2;'].join('\n');
  const out = stripJsComments(src);
  ok('剥完之后行号完全对得上（b 还在第 5 行）',
    out.split('\n').length === 5 && out.split('\n')[4].includes('const b = 2;'),
    `剥后 ${out.split('\n').length} 行：${JSON.stringify(out)}`);
}

console.log(failed(fail) ? '' : `\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
function failed(n) {
  return n > 0;
}