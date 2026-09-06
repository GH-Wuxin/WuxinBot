import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {chromium,type Browser} from 'playwright-core';
import {getDataDir} from '../../store.js';

let browserPromise: Promise<Browser> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: NodeJS.Timeout | undefined;
const IDLE_MS=30_000;

export function skillCardFontFace(): string {
  const candidates=[process.env.SKILL_CARD_FONT_FILE,
    'C:/Windows/Fonts/NotoSansSC-VF.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc'];
  const font=candidates.find(file=>file&&fs.existsSync(file));
  const src=font?`url("${pathToFileURL(path.resolve(font)).href}")`:'local("Noto Sans SC"),local("Noto Sans CJK SC")';
  return `@font-face{font-family:'Skill Sans';src:${src};font-weight:100 900;font-style:normal;font-display:block}`;
}

async function getBrowser():Promise<Browser>{
  if(!browserPromise){
    const executable=process.env.SKILL_CARD_BROWSER_PATH;
    const launching=chromium.launch({headless:true,timeout:20_000,
      ...(executable?{executablePath:executable}:{channel:'msedge'})});
    browserPromise=launching;
    launching.then(browser=>browser.on('disconnected',()=>{
      if(browserPromise===launching)browserPromise=null;
    }),()=>{if(browserPromise===launching)browserPromise=null;});
  }
  return browserPromise;
}

export async function closeSkillCardBrowser():Promise<void>{
  if(idleTimer)clearTimeout(idleTimer);
  idleTimer=undefined;
  const current=browserPromise;
  browserPromise=null;
  if(current)await current.then(browser=>browser.close(),()=>{});
}

async function render(html:string):Promise<Buffer>{
  if(idleTimer)clearTimeout(idleTimer);
  const root=path.join(getDataDir(),'skill-card-tmp');
  fs.mkdirSync(root,{recursive:true});
  const folder=fs.mkdtempSync(path.join(root,'render-'));
  const file=path.join(folder,'card.html');
  let context:Awaited<ReturnType<Browser['newContext']>>|undefined;
  try{
    fs.writeFileSync(file,html,'utf8');
    const browser=await getBrowser();
    context=await browser.newContext({viewport:{width:1200,height:2400},deviceScaleFactor:1,javaScriptEnabled:false,serviceWorkers:'block'});
    // All remote media is fetched and validated by the shared image cache.
    await context.route(/^https?:/,route=>route.abort());
    const page=await context.newPage();
    page.setDefaultTimeout(20_000);
    await page.goto(pathToFileURL(file).href,{waitUntil:'load'});
    await page.evaluate(async()=>{
      await document.fonts.ready;
      await Promise.all([...document.images].map(img=>img.decode()));
      const name=document.querySelector<HTMLElement>('.identity h1');
      if(name){
        let size=parseFloat(getComputedStyle(name).fontSize);
        while(name.scrollWidth>name.clientWidth+1&&size>24){size-=1;name.style.fontSize=size+'px';}
      }
    });
    const box=await page.locator('.sheet').boundingBox();
    if(!box||box.width!==1200||box.height>5000)throw Error('SKILL_CARD_LAYOUT_INVALID');
    return await page.locator('.sheet').screenshot({type:'png',animations:'disabled'});
  }finally{
    await context?.close();
    // This directory is created by mkdtemp directly under the render root.
    if(path.dirname(path.resolve(folder))===path.resolve(root))fs.rmSync(folder,{recursive:true,force:true});
    idleTimer=setTimeout(()=>void closeSkillCardBrowser(),IDLE_MS);
    idleTimer.unref?.();
  }
}

export function renderSkillCardHtml(html:string):Promise<Buffer>{
  const pending=queue.then(()=>render(html),()=>render(html));
  queue=pending.then(()=>undefined,()=>undefined);
  return pending;
}
