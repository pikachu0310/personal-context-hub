import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

// Own local shooting surface only. No authenticated browser or live meeting is read.
const output = path.resolve(process.argv[2] || '.ido-build/film');
const record = process.argv.includes('--record');
await fs.mkdir(output, {recursive:true});
const browser = await chromium.launch({headless:true,
  ...(process.env.IDO_FILM_CHROMIUM ? {executablePath:process.env.IDO_FILM_CHROMIUM} : {})});
const context = await browser.newContext({viewport:{width:1920,height:1080}, deviceScaleFactor:1,
  ...(record ? {recordVideo:{dir:path.join(output,'take'),size:{width:1920,height:1080}}}: {})});
const page = await context.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
await page.goto(process.env.IDO_FILM_URL || 'http://127.0.0.1:4348/ido-film/?capture=1');
await page.waitForFunction(()=>window.film?.ready);
await page.evaluate(()=>document.fonts.ready);
if(record){
  await page.evaluate(()=>window.film.seek(0));
  await page.waitForTimeout(500);
  const start=Date.now();
  await page.evaluate(()=>window.film.play());
  await page.waitForFunction(()=>window.film.getState().time>=56,{},{timeout:65000});
  await page.waitForTimeout(350);
  console.log(JSON.stringify({recordedSeconds:(Date.now()-start)/1000,video:await page.video().path()}));
}else{
  for(let i=0;i<6;i++){
    await page.evaluate(i=>window.film.setScene(i),i);
    await page.waitForTimeout(350);
    await page.screenshot({path:path.join(output,`scene-${i+1}.png`)});
  }
}
await context.close();await browser.close();
console.log(JSON.stringify({output,errors}));
