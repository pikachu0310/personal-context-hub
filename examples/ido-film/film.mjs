const $ = selector => document.querySelector(selector);
const screen = $('.screen');
const durations = [8, 8, 12, 12, 10, 6];
const starts = durations.map((_, i) => durations.slice(0, i).reduce((a, b) => a + b, 0));
const total = durations.reduce((a, b) => a + b, 0);
const scenes = [
  {eyebrow:'会議の中で、触って決める', headline:'「どっちがいい？」を、<br>その場で試す。', subhead:'ワープか、連続移動か。話している間に、比べられるものへ。', messages:[], context:'同じコースで、移動の違いを比べたい。', step:2},
  {eyebrow:'話した背景を、作業につなぐ', headline:'この二つ、<br>触って比べたい。', subhead:'会議の文脈を受け取って、Codexが試作を進める。', messages:[['企画担当','ワープと連続移動、どちらがいいだろう。'],['体験担当','同じコースで、両方を試したい。']], context:'VRゲームの移動方式。迷っている二案を、動く形で比較する。', step:0},
  {eyebrow:'会議をしながら、実装が進む', headline:'議論していた案が、<br>触れるものになる。', subhead:'会話を受けたCodexが生成した、ブラウザ上の比較試作。', messages:[['企画担当','今話した二つを、触って比べたい。'],['IDO','二つの方式を、同じコースで比較する試作へ。']], context:'目的・迷った案・比較したい点を、作業するCodexへ。', step:1},
  {eyebrow:'触った感想を、そのまま続きを作る材料に', headline:'「速すぎる。<br>半分にしてみよう。」', subhead:'同じタスクに感想を返し、次の版で確かめる。', messages:[['体験担当','連続移動が速すぎる。初期速度を半分に。'],['IDO','同じCodexタスクで、続きを修正。']], context:'移動速度を1.0から0.5へ。同じタスク・同じ会話で修正した記録。', step:3},
  {eyebrow:'画面の説明から、手触りの比較へ', headline:'変わったところを、<br>もう一度、触って決める。', subhead:'同じ移動入力で、速度1.0と0.5の違いを比較。', messages:[['体験担当','速さを変えると、動きはどう変わる？'],['IDO','次の判断に使える、動く比較対象。']], context:'ここでは生成済み試作の速度パラメータを切り替えて比較。', step:2},
  {step:3},
];
let current = -1, playing = false, time = 0, previous = 0, moveBucket = -1;
const frames = [$('#left'), $('#right')];
const readyFrames = new Set();
function send(frame, action, extra = {}) { frame.contentWindow?.postMessage({source:'ido-film-director', action, ...extra}, '*'); }
function move() { frames.forEach(f => send(f, 'move')); }
function reset() { frames.forEach(f => send(f, 'reset')); }
function fit() {
  const wrap = $('.screen-wrap');
  const factor = Math.min(wrap.clientWidth / 1600, wrap.clientHeight / 900);
  screen.style.transform = document.fullscreenElement ? `translate(-50%, -50%) scale(${factor})` : `scale(${factor})`;
}
function setScene(index, resetTime = true) {
  index = Math.max(0, Math.min(scenes.length - 1, index));
  current = index;
  if (resetTime) time = starts[index];
  const s = scenes[index]; screen.classList.remove('playing'); screen.dataset.scene = index; $('#scene').value = index;
  if (playing) requestAnimationFrame(() => screen.classList.add('playing'));
  if (s.headline) {
    $('#eyebrow').textContent=s.eyebrow; $('#headline').innerHTML=s.headline; $('#subhead').textContent=s.subhead;
    $('#context').textContent=s.context;
    $('#messages').replaceChildren(...s.messages.map(([name, text]) => {
      const item=document.createElement('div');item.className='message'+(name==='IDO'?' agent':'');
      const avatar=document.createElement('div');avatar.className='avatar';avatar.textContent=name==='IDO'?'IDO':name.slice(0,1);
      const content=document.createElement('div');const label=document.createElement('p');label.className='speaker';label.textContent=name;
      const body=document.createElement('p');body.textContent=text;content.append(label,body);item.append(avatar,content);return item;
    }));
  }
  $('.loop').querySelectorAll('li').forEach((li, i) => li.classList.toggle('active', i===s.step));
  const compare=index===4;
  $('#left-title').textContent=compare?'速度 1.0':'ワープ移動';
  $('#right-title').textContent=compare?'速度 0.5':'連続移動';
  $('#left-detail').textContent=compare?'同じ移動入力':'瞬間的に移動';
  $('#right-detail').textContent=compare?'同じ移動入力':'滑らかに移動';
  $('#artifact-tag').textContent=compare?'PLAYABLE COMPARISON':'GENERATED PROTOTYPE';
  $('#artifact-title').textContent=compare?'連続移動の速度を比較':'二つの移動方式を、同じコースで。';
  $('#artifact-state').textContent=index===1?'次に試すもの':compare?'実物を操作して比較':'操作できる試作';
  $('#artifact-footnote').textContent=compare?'同一試作の速度パラメータ比較':'生成済みのブラウザ試作を再生';
  $('#artifact-hint').textContent=index===3?'修正記録：同一タスクで 1.0 → 0.5':'前へボタンで、違いを試せます';
  $('#disclosure').textContent=index===4?'生成済みの試作を操作 / 同一試作の速度パラメータ比較 / ブラウザ上の体験':'会話・制作条件を設定した実動作をもとに再構成。VR機器での検証は含みません。';
  frames.forEach((f,i)=>send(f,'configure',{mode:compare?'smooth':i===0?'teleport':'smooth',speed:compare&&i===0?1:.5}));
  reset(); moveBucket=-1; updateTime();
}
function updateTime(){const f=n=>`00:${String(Math.floor(n)).padStart(2,'0')}`;$('#time').textContent=`${f(time)} / ${f(total)}`;}
function play(){if(time>=total)time=0;playing=!playing;screen.classList.toggle('playing',playing);$('#play').textContent=playing?'一時停止':'56秒を再生';previous=performance.now();}
function tick(now){
  if(playing){time=Math.min(total,time+(now-previous)/1000);const next=Math.max(0,starts.findLastIndex(t=>time>=t));if(next!==current)setScene(next,false);
    if([0,2,3,4].includes(current)){const elapsed=time-starts[current];const bucket=Math.floor(elapsed/2.7);if(bucket!==moveBucket){if(bucket%3===0)reset();move();moveBucket=bucket;}}
    updateTime();if(time>=total){playing=false;$('#play').textContent='56秒を再生';}
  }previous=now;requestAnimationFrame(tick);
}
const embedStyle=`html,body{margin:0!important;min-width:0!important;width:100%!important;height:100%!important;overflow:hidden!important;background:#91abba!important}.shell{padding:0!important;width:100%!important;height:100%!important;max-width:none!important}header,.footnote,.scene-head,.readout,.speed-control,.view-label,.reset-button{display:none!important}.compare{display:block!important;height:100%!important}.scene-card{display:none!important;height:100%!important;border:0!important;border-radius:0!important;box-shadow:none!important}.scene-card.selected-film{display:flex!important;flex-direction:column!important}.viewport{margin:0!important;border:0!important;border-radius:0!important;flex:1!important;min-height:0!important;overflow:hidden!important}canvas{display:block!important;width:100%!important;height:100%!important}.controls{padding:6px 12px!important;background:#f5f9fb!important}.pad-row{display:flex!important;margin:0!important;gap:7px!important}.move-button{font-size:12px!important;min-height:28px!important;padding:4px!important;flex:1!important}.move-button.forward{grid-area:auto!important}`;
const bridge=`<script>(()=>{let selected='teleport';function configure(mode,speed){selected=mode;document.querySelectorAll('[data-scene]').forEach(e=>e.classList.toggle('selected-film',e.dataset.scene===mode));const range=document.querySelector('#speed');range.value=speed;range.dispatchEvent(new Event('input',{bubbles:true}));window.dispatchEvent(new Event('resize'));}window.addEventListener('message',e=>{if(e.source!==parent||e.data?.source!=='ido-film-director')return;const d=e.data;if(d.action==='configure')configure(d.mode,d.speed);if(d.action==='move')document.querySelector('[data-scene='+selected+'] [data-move=forward]').click();if(d.action==='reset')document.querySelectorAll('[data-reset]').forEach(b=>b.click());});configure('teleport',.5);parent.postMessage({source:'ido-film-prototype',ready:true},'*');})()<\/script>`;
window.addEventListener('message',e=>{if(!frames.some(f=>f.contentWindow===e.source)||e.data?.source!=='ido-film-prototype')return;readyFrames.add(e.source);if(readyFrames.size===2){setScene(current);window.film.ready=true;}});
$('#play').addEventListener('click',play);$('#restart').addEventListener('click',()=>{playing=false;$('#play').textContent='56秒を再生';setScene(0);});$('#scene').addEventListener('change',e=>setScene(Number(e.target.value)));$('#move').addEventListener('click',move);$('#reset').addEventListener('click',reset);$('#fullscreen').addEventListener('click',()=>document.fullscreenElement?document.exitFullscreen():$('.screen-wrap').requestFullscreen());
document.addEventListener('keydown',e=>{if(['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement?.tagName))return;if(e.code==='Space'){e.preventDefault();play();}if(e.code==='ArrowRight'){e.preventDefault();setScene(current+1);}if(e.code==='ArrowLeft'){e.preventDefault();setScene(current-1);}});
window.addEventListener('resize',fit);document.addEventListener('fullscreenchange',fit);
window.film={ready:false,setScene,move,reset,play,getState:()=>({scene:current,time,playing}),seek(seconds){time=Math.max(0,Math.min(total,seconds));setScene(Math.max(0,starts.findLastIndex(t=>time>=t)),false);updateTime();}};
if(new URLSearchParams(location.search).has('capture'))document.body.classList.add('capture');
setScene(0);fit();
try { const html=window.__FILM_BUNDLED_PROTOTYPE ?? await fetch('../meeting-locomotion/index.html').then(r=>{if(!r.ok)throw new Error('試作の読み込みに失敗しました');return r.text();});frames.forEach(f=>f.srcdoc=html.replace('</head>',`<style>${embedStyle}.canvas-message{display:none!important}</style></head>`).replace('</body>',`${bridge}</body>`)); }
catch(error){$('#artifact-title').textContent=error.message;$('#artifact-state').textContent='ローカルサーバーから開いてください';}
requestAnimationFrame(tick);
