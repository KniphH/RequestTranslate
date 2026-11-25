import {chromium} from 'playwright-core';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const extension=resolve(process.argv[2] || '.');
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end('<p>Sample text to translate</p>')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const ctx=await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(),'rt-m3-')),{executablePath:edge,headless:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension],viewport:{width:1440,height:900}});
const errors=[];
try {
 const worker=ctx.serviceWorkers()[0]||await ctx.waitForEvent('serviceworker'); const origin=worker.url().replace(/\/[^/]+$/,'');
 const page=await ctx.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin+'/options.html'); await page.locator('#palette-toggle').waitFor(); await page.locator('#palette-menu button').first().waitFor({state:'attached'});
 const popup=await ctx.newPage();popup.on('pageerror',e=>errors.push(e.message));await popup.goto(origin+'/popup.html');
 const web=await ctx.newPage();web.on('pageerror',e=>errors.push(e.message));await web.goto('http://127.0.0.1:'+server.address().port);await web.locator('#request-translate-host').waitFor({state:'attached',timeout:10000});
 mkdirSync('test-results/m3',{recursive:true});
 const colors=['purple','blue','green','warm','rose','gray'];
 for (const mode of ['dark','light']) {
   if(await page.locator('html').getAttribute('data-theme')!==mode) await page.locator('#theme-toggle').click();
   for(const color of colors){
     await page.locator('#palette-toggle').click(); await page.locator('#palette-menu button[data-color="'+color+'"]').click();
     await page.waitForFunction(c=>document.documentElement.style.getPropertyValue('--m3-primary')===window.RTM3Palettes[c][document.documentElement.dataset.theme].primary,color);
     await popup.waitForFunction(c=>document.documentElement.style.getPropertyValue('--m3-primary')===window.RTM3Palettes[c][document.documentElement.dataset.theme].primary,color);
     const primary = await page.evaluate(() => document.documentElement.style.getPropertyValue('--m3-primary'));
     assert.equal(await page.locator('.brand .mark').evaluate(el=>getComputedStyle(el).backgroundColor), await page.evaluate(() => {const e=document.createElement('i'); e.style.color=getComputedStyle(document.documentElement).getPropertyValue('--m3-primary'); document.body.append(e); const value=getComputedStyle(e).color; e.remove(); return value;}));
     await web.waitForFunction(expected => document.querySelector('#request-translate-host').style.getPropertyValue('--m3-primary') === expected, primary);
     await page.waitForFunction(c=>chrome.storage.local.get('state').then(x=>x.state.settings.themeColor===c),color);
     await page.screenshot({path:`test-results/m3/options-${color}-${mode}.png`});
     await popup.screenshot({path:`test-results/m3/popup-${color}-${mode}.png`});
   }
 }
 await page.reload();await page.waitForFunction(()=>document.documentElement.style.getPropertyValue('--m3-primary')===window.RTM3Palettes.gray.light.primary);
 await page.evaluate(async () => { const {state} = await chrome.storage.local.get('state'); state.settings.panelCss = '.rt-panel { --rt-bg: rgb(1, 2, 3); }'; await chrome.storage.local.set({state}); });
 await web.waitForFunction(() => getComputedStyle(document.querySelector('#request-translate-host').shadowRoot.querySelector('.rt-panel')).getPropertyValue('--rt-bg').trim() === 'rgb(1, 2, 3)');
 for (const width of [1440,390]) {
   await page.setViewportSize({width,height:900});
   for (const mode of ['light','dark']) {
     if (width === 390) await page.locator('[data-tab=settings]').click();
     if (await page.locator('html').getAttribute('data-theme') !== mode) await page.locator('#theme-toggle').click();
     for (const tab of ['configs','ocr','vars','settings']) {
       await page.locator(`[data-tab=${tab}]`).click();
       await page.screenshot({path:`test-results/m3/${tab}-${width}-${mode}.png`});
     }
   }
 }
 await page.setViewportSize({width:390,height:844}); await page.locator('[data-tab=settings]').click(); await page.locator('#palette-toggle').click();assert.equal(await page.locator('#palette-menu button').count(),6);await page.keyboard.press('Escape');assert.equal(await page.locator('#palette-menu').isHidden(),true);
 for (const width of [768,1024,1440]) { await page.setViewportSize({width,height:900}); await page.screenshot({path:`test-results/m3/options-${width}.png`}); }
 await page.setViewportSize({width:390,height:844}); await page.screenshot({path:'test-results/m3/options-mobile.png'});await popup.screenshot({path:'test-results/m3/popup.png'});
 console.log(JSON.stringify({passed:'12 palette/mode combinations, popup and content sync, custom CSS priority, persistence, mobile menu and Escape',errors,contentHosts:await web.evaluate(()=>Array.from(document.querySelectorAll('*')).filter(e=>e.shadowRoot).map(e=>e.id))}));
 if(errors.length)process.exitCode=1;
} finally {await ctx.close();server.close();}
