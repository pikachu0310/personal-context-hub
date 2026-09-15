from pathlib import Path
import json, shutil, subprocess, sys
ROOT=Path(__file__).resolve().parent.parent
source=Path(sys.argv[1])
content=json.loads((source/'content-t118.json').read_text(encoding='utf-8'))
content['title']='会議で決める前に、触って試せる。'
for s in content['segments']:
    s['id'] += '_engine'
(ROOT/'build'/'content.json').write_text(json.dumps(content,ensure_ascii=False,indent=2),encoding='utf-8')
shutil.copy2(source/'ido-film-reel.mp4',ROOT/'assets'/'ido-film-reel.mp4')
sys.path.insert(0,str(ROOT/'build'/'video-deps'))
import imageio_ffmpeg
exe=imageio_ffmpeg.get_ffmpeg_exe()
for t in [3,18,33,44,53]:
    subprocess.run([exe,'-y','-loglevel','error','-ss',str(t),'-i',str(ROOT/'assets'/'ido-film-reel.mp4'),'-frames:v','1',str(ROOT/'build'/f'film-source-{t}.png')],check=True)
print(json.dumps({'voiceCharacters':[len(s['voice']) for s in content['segments']],'sourceDuration':55.96}))
