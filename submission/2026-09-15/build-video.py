"""Compose the pitch from real CUA captures and authored narration.

No synthetic application UI is generated. Source timestamps are retained for
screen actions. Editing crops source images and condenses generation waits.
"""
from pathlib import Path
import bisect, json, re, subprocess, sys, wave
from functools import lru_cache
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent.parent
BUILD=ROOT/'build'; ASSETS=ROOT/'assets'; OUT=ROOT/'output'
sys.path.insert(0,str(BUILD/'video-deps'))
import imageio_ffmpeg
FFMPEG=imageio_ffmpeg.get_ffmpeg_exe()
FONT='C:/Windows/Fonts/NotoSansJP-VF.ttf'
BG='#10282C'; WHITE='#F6F4EC'; MUTED='#BFD5D1'; ACCENT='#78D7C7'
W,H,FPS=1280,720,24
CONTENT=json.loads((BUILD/'content.json').read_text(encoding='utf-8'))
DUR=[12,16,25,29,20,15]
START=[sum(DUR[:i]) for i in range(len(DUR))]
TIMINGS=json.loads((ASSETS/'narration'/'timings.json').read_text())
@lru_cache(maxsize=32)
def font(size,bold=False):
    f=ImageFont.truetype(FONT,size)
    try:f.set_variation_by_name('Bold' if bold else 'Regular')
    except ValueError:pass
    return f
def tx(im,txt,x,y,size=30,color=WHITE,bold=False,spacing=12):
    ImageDraw.Draw(im).multiline_text((x,y),txt,font=font(size,bold),fill=color,spacing=spacing,stroke_width=0)
def wrap(txt,limit=38):
    lines=[]
    while len(txt)>limit:
        split=max(txt.rfind('、',0,limit+1),txt.rfind('。',0,limit+1))
        if split<limit//3:split=limit-1
        lines.append(txt[:split+1]);txt=txt[split+1:]
    return '\n'.join(lines+[txt])
@lru_cache(maxsize=250)
def load(path):return Image.open(path).convert('RGB')
@lru_cache(maxsize=220)
def fit_photo(p,w,h,crop):
    src=load(p)
    if crop:src=src.crop(crop)
    ratio=min(w/src.width,h/src.height)
    sz=(round(src.width*ratio),round(src.height*ratio))
    return src.resize(sz,Image.Resampling.LANCZOS)
def photo(im,p,box,crop=None):
    x,y,w,h=box
    src=fit_photo(str(p),w,h,crop)
    im.paste(src,(x+(w-src.width)//2,y+(h-src.height)//2))
class Clip:
    def __init__(self,name):
        self.root=ASSETS/name
        data=json.loads((self.root/'capture.json').read_text())
        self.frames=data['frames'];self.times=[f['ms']/1000 for f in self.frames]
        self.duration=data.get('seconds',self.times[-1]+0.125)
    def frame(self,t):
        i=max(0,min(len(self.frames)-1,bisect.bisect_right(self.times,t)-1))
        return self.root/self.frames[i]['file']
hero=Clip('06_hero_play');context=Clip('04_context_trace');revision=Clip('01_revision_arrives')

# Decode the supplied filming reel once at the output frame rate. Only selected
# ranges are used, with their reconstructed nature labeled in the picture.
film_dir=BUILD/'film-frames'
film_dir.mkdir(exist_ok=True)
if not (film_dir/'01343.jpg').exists():
    subprocess.run([FFMPEG,'-y','-loglevel','error','-i',str(ASSETS/'ido-film-reel.mp4'),'-vf',f'fps={FPS}','-q:v','2',str(film_dir/'%05d.jpg')],check=True)
film_files=sorted(film_dir.glob('*.jpg'))
def film_frame(t):return film_files[min(len(film_files)-1,max(0,int(t*FPS)))]
vrc_dir=BUILD/'vrc-frames'
vrc_dir.mkdir(exist_ok=True)
if not (vrc_dir/'00096.jpg').exists():
    subprocess.run([FFMPEG,'-y','-loglevel','error','-ss','5','-i',str(ASSETS/'ido-localhost-demo.mp4'),'-t','4','-vf',f'fps={FPS}','-q:v','2',str(vrc_dir/'%05d.jpg')],check=True)
vrc_files=sorted(vrc_dir.glob('*.jpg'))
def vrc_frame(t):return vrc_files[min(len(vrc_files)-1,max(0,int(t*FPS)))]

# Phrase-level captions follow each synthesized narration track. The MP4 also
# contains selectable subtitles; the same captions are burned into the picture.
cues=[]
for i,s in enumerate(CONTENT['segments']):
    phrases=[p+'。' for p in s['voice'].split('。') if p]
    total=sum(len(p) for p in phrases);cursor=START[i]+0.5
    for phrase in phrases:
        duration=TIMINGS[i]['seconds']*len(phrase)/total
        cues.append((cursor,cursor+duration,wrap(phrase)))
        cursor+=duration
def stamp(t,sep=','):
    ms=round(t*1000);h,ms=divmod(ms,3600000);m,ms=divmod(ms,60000);s,ms=divmod(ms,1000)
    return f'{h:02}:{m:02}:{s:02}{sep}{ms:03}'
(OUT/'ido-demo.srt').write_text('\n\n'.join(f'{i+1}\n{stamp(a)} --> {stamp(b)}\n{t}' for i,(a,b,t) in enumerate(cues))+'\n',encoding='utf-8')
(OUT/'ido-demo.vtt').write_text('WEBVTT\n\n'+'\n\n'.join(f'{stamp(a,".")} --> {stamp(b,".")}\n{t}' for a,b,t in cues)+'\n',encoding='utf-8')

with wave.open(str(ASSETS/'narration'/TIMINGS[0]['file'])) as first:
    params=first.getparams();sr=params.framerate;stride=params.nchannels*params.sampwidth
with wave.open(str(BUILD/'narration-mix.wav'),'wb') as dest:
    dest.setparams(params)
    for i,item in enumerate(TIMINGS):
        with wave.open(str(ASSETS/'narration'/item['file'])) as src:audio=src.readframes(src.getnframes())
        silence=b'\0'*(round(0.5*sr)*stride)
        padded=silence+audio
        padded+=b'\0'*max(0,round(DUR[i]*sr)*stride-len(padded))
        dest.writeframes(padded)

def base(i):
    im=Image.new('RGB',(W,H),BG);d=ImageDraw.Draw(im)
    tx(im,'IDOエンジン',36,18,24,bold=True);tx(im,f'{i+1:02} / 06',1140,23,17,MUTED)
    return im
def frame(t):
    i=max(j for j,s in enumerate(START) if t>=s);u=t-START[i];im=base(i);d=ImageDraw.Draw(im)
    if i==0:
        tx(im,'この二つ、どちらがいい？',36,65,38,bold=True)
        if u<8:
            photo(im,film_frame(u),(40,152,1200,424),crop=(64,390,1855,950))
            tx(im,'撮影用に再構成・生成済み試作を操作',864,117,17,ACCENT)
        else:
            photo(im,hero.frame(u-8),(40,143,1200,446),crop=(38,60,1215,681))
            tx(im,'実システム上の試作を操作',969,112,17,ACCENT)
    elif i==1:
        tx(im,'会話の文脈を、作業につなぐ。',36,65,38,bold=True)
        photo(im,context.frame(min(u,context.duration)),(40,133,1200,464),crop=(310,153,1272,705))
        tx(im,'元の発言まで辿れる会議記録',857,110,20,ACCENT)
    elif i==2:
        tx(im,'「今話した案」が、実装につながる。',36,70,38,bold=True)
        if u<8:
            photo(im,context.frame(min(max(u-1,0),7)),(40,139,1200,458),crop=(310,153,1272,705))
            tx(im,'議題から元の発言へ',898,111,20,ACCENT)
        elif u<13:
            photo(im,ASSETS/'transcript.png',(54,154,1172,421),crop=(907,366,1260,685))
            tx(im,'参加者の依頼からタスクを作成',54,574,21,ACCENT)
        else:
            photo(im,film_frame(16+u-13),(40,151,1200,432),crop=(63,438,1856,955))
            tx(im,'初回試作：4分44秒（今回の収録）',820,114,21,ACCENT)
            tx(im,'生成済み試作・会話表示は撮影用に再構成',43,585,17,ACCENT)
    elif i==3:
        tx(im,'触った感想で、同じタスクを直す。',36,68,38,bold=True)
        if u<4:
            photo(im,film_frame(28+u),(40,149,1200,432),crop=(63,438,1856,955))
            tx(im,'撮影用の会話表示・生成済み試作',889,113,18,ACCENT)
        elif u<10:
            photo(im,ASSETS/'feedback.png',(43,163,820,394),crop=(355,289,870,514))
            tx(im,'初期速度',907,235,28,MUTED)
            tx(im,'1.00',924,294,46,WHITE,True);tx(im,'0.50',924,377,58,ACCENT,True)
            tx(im,'今回の修正：1分32秒 → 待ち時間を短縮して収録',75,568,21,ACCENT)
        elif u<20:
            photo(im,revision.frame(u-10),(40,138,1200,454),crop=(18,120,1260,701))
            tx(im,'新しい版を開く',991,108,21,ACCENT)
        elif u<25:
            photo(im,ASSETS/'comparison.png',(40,139,1200,450),crop=(76,98,1186,538))
            tx(im,'修正前',134,134,21,WHITE,True);tx(im,'光る目標を追加',682,134,21,WHITE,True)
        else:
            photo(im,film_frame(40+u-25),(40,143,1200,444),crop=(499,438,1857,959))
            tx(im,'動きの違い：同じ試作の速度パラメータを切り替えて比較',43,586,17,ACCENT)
    elif i==4:
        tx(im,'人が評価し、Codexが続きを作る。',36,65,38,bold=True)
        if u<8:
            photo(im,revision.frame(min(u+2,revision.duration)),(40,145,1200,441),crop=(18,120,1260,701))
            tx(im,'プレビューから修正依頼',937,114,21,ACCENT)
        else:
            photo(im,ASSETS/'comparison.png',(40,145,1200,441),crop=(76,98,1186,538))
            tx(im,'修正前後を並べて比較',946,114,21,ACCENT)
        tx(im,'IDOエンジン自体もCodexで開発。当日に追加した2つの機能。',44,577,19,ACCENT)
    else:
        tx(im,'会議の出口に、触って判断できるものを。',36,76,39,bold=True)
        if u<5:
            photo(im,film_frame(min(u,7.9)),(40,143,1200,398),crop=(64,390,1855,950))
            tx(im,'まず、Discordで共同制作する小さなチームへ。',43,562,26,ACCENT,True)
        elif u<9:
            photo(im,vrc_frame(u-5),(40,143,1200,412))
            tx(im,'VRChat連携の試作：Unity ClientSim・localhost接続・固定返答',43,569,22,ACCENT,True)
        else:
            tx(im,'IDOエンジン',44,192,68,WHITE,True)
            tx(im,'会議で決める前に、触って試せる。',48,305,38,ACCENT,True)
            tx(im,'動画の続きは、デモへ。',49,424,29,WHITE,True)
            tx(im,'ido-engine-demo.pikachu0310.chatgpt.site',49,481,27,ACCENT)
            tx(im,'結論、めっちゃ開発　H156',49,554,20,MUTED)
    # Reserved caption band is visually separate from the real app recording.
    d.rectangle((0,610,W,H),fill='#081A1E')
    caption=next((v for a,b,v in cues if a<=t<b),CONTENT['segments'][i]['caption'])
    lines=caption.split('\n');size=27 if max(map(len,lines))<=39 else 25
    f=font(size);bbox=d.multiline_textbbox((0,0),caption,font=f,spacing=6)
    x=(W-(bbox[2]-bbox[0]))/2
    tx(im,caption,x,620,size,WHITE,False,spacing=6)
    tx(im,'準備済み会話・制作条件での実動作　/　待ち時間を短縮　/　AI音声',34,691,12,MUTED)
    d.rectangle((0,H-3,round(W*t/sum(DUR)),H),fill=ACCENT)
    return im

if '--stills' in sys.argv:
    for t in [3,18,34,44,58,68,74,80,91,106,114]:
        frame(t).save(BUILD/f'video-final-review-{t:03}.png')
    print('Final review frames written.')
    raise SystemExit(0)

silent=BUILD/'video-picture.mp4'
cmd=[FFMPEG,'-y','-loglevel','error','-f','rawvideo','-vcodec','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p',str(silent)]
proc=subprocess.Popen(cmd,stdin=subprocess.PIPE)
try:
    for n in range(sum(DUR)*FPS):
        t=n/FPS;im=frame(t)
        if n% (FPS*10)==0:print(json.dumps({'renderSeconds':round(t),'totalSeconds':sum(DUR)}),flush=True)
        if n in [3*FPS,23*FPS,36*FPS,53*FPS,65*FPS,82*FPS,102*FPS]:im.save(BUILD/f'video-review-{int(t):03}.png')
        proc.stdin.write(im.tobytes())
finally:proc.stdin.close()
if proc.wait():raise SystemExit('Picture encode failed')
subprocess.run([FFMPEG,'-y','-loglevel','error','-i',str(silent),'-i',str(BUILD/'narration-mix.wav'),'-i',str(OUT/'ido-demo.srt'),'-map','0:v','-map','1:a','-map','2:0','-c:v','copy','-c:a','aac','-b:a','160k','-af','loudnorm=I=-16:TP=-1.5:LRA=11','-c:s','mov_text','-metadata:s:s:0','language=jpn','-movflags','+faststart','-t',str(sum(DUR)),str(OUT/'ido-demo.mp4')],check=True)
frame(3).save(OUT/'ido-demo-poster.jpg',quality=93)
# Image-based PDFs preserve the rendered layout; the PPTX remains editable.
for name in ['ido-overview','ido-pitch']:
    pages=[Image.open(p).convert('RGB') for p in sorted(OUT.glob(name+'-*.png'))]
    pages[0].save(OUT/(name+'.pdf'),save_all=True,append_images=pages[1:],resolution=144)
(BUILD/'video-manifest.json').write_text(json.dumps({'durationSeconds':sum(DUR),'fps':FPS,'resolution':[W,H],'audio':'AI narration, gpt-4o-mini-tts / coral','source':'real browser screen captures using demo conversation','speechSeconds':sum(x['seconds'] for x in TIMINGS),'segments':[{'id':s['id'],'startSeconds':START[i],'durationSeconds':DUR[i]} for i,s in enumerate(CONTENT['segments'])]},ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'video':str(OUT/'ido-demo.mp4'),'durationSeconds':sum(DUR)}),flush=True)
