"""Copy only authored source and final deliverables into the owning repository."""
from pathlib import Path
import shutil, sys
studio=Path(sys.argv[1]).resolve()
repo=Path(sys.argv[2]).resolve()
if not (repo/'.git').exists():raise SystemExit('Expected a Git worktree.')
source=repo/'submission'/'2026-09-15'
ignored=repo/'.ido-build'/'hackathon'
source.mkdir(parents=True,exist_ok=True)
ignored.mkdir(parents=True,exist_ok=True)
for name in ['build-video.py','content.json','narration.py','prepare-assets.py','integrate-film.py','template-plan.json','prepare-export.py','serve-preview.py','deliver-sources.py']:
    (source/name).write_bytes((studio/'build'/name).read_bytes().replace(b'\r\n',b'\n'))
(source/'submission-notes.md').write_bytes((studio/'output'/'submission-notes.md').read_bytes().replace(b'\r\n',b'\n'))
for name in ['ido-demo.mp4','ido-demo-poster.jpg','ido-demo.srt','ido-demo.vtt','ido-submission-template.png','ido-submission-template.pptx','ido-submission-template.pdf','index.html','submission-notes.md']:
    path=studio/'output'/name
    if path.exists():shutil.copy2(path,ignored/name)
print(f'Authored sources: {source}\nMedia: {ignored}')
