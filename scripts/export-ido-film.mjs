import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=path.join(root,'examples/ido-film');
const output=path.resolve(process.argv[2]||'.ido-build/film');
await fs.mkdir(output,{recursive:true});
let css=await fs.readFile(path.join(source,'film.css'),'utf8');
let fontCSS=await fs.readFile(path.join(source,'fonts.css'),'utf8');
for(const match of [...fontCSS.matchAll(/url\((\.\/fonts\/[^)]+)\)/g)]){
  const bytes=await fs.readFile(path.join(source,match[1]));
  fontCSS=fontCSS.replace(match[0],`url(data:font/woff2;base64,${bytes.toString('base64')})`);
}
css=css.replace('@import url("fonts.css");',fontCSS);
const code=await fs.readFile(path.join(source,'film.mjs'),'utf8');
const prototype=await fs.readFile(path.join(root,'examples/meeting-locomotion/index.html'),'utf8');
let html=await fs.readFile(path.join(source,'index.html'),'utf8');
html=html.replace('<link rel="stylesheet" href="film.css">',`<style>${css}</style>`)
 .replace('<script type="module" src="film.mjs"></script>',`<script>window.__FILM_BUNDLED_PROTOTYPE=${JSON.stringify(prototype).replaceAll('<','\\u003c')};</script><script type="module">${code.replaceAll('</script','<\\/script')}</script>`);
await fs.writeFile(path.join(output,'ido-shooting-screen.html'),html);
await fs.copyFile(path.join(source,'fonts/OFL.txt'),path.join(output,'FONT-LICENSE.txt'));
for(const file of ['STORY.md','content-t118.json'])await fs.copyFile(path.join(source,file),path.join(output,file));
console.log(JSON.stringify({standalone:path.join(output,'ido-shooting-screen.html'),bytes:Buffer.byteLength(html)}));
