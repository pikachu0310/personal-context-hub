"""Supply a real video poster to Google's static exports.

The native Google deck embeds a Drive video. Its PPTX export replaces that video
with a linked image, but currently returns an unavailable thumbnail. Replace only
that exported poster; keep the native text, geometry, and video hyperlink.
"""
from pathlib import Path
from PIL import Image, ImageDraw
import io, zipfile, xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parent.parent
out=ROOT/'output'
poster=Image.open(out/'ido-demo-poster.jpg').convert('RGB')
d=ImageDraw.Draw(poster)
d.ellipse((588,308,692,412),fill='#2368D2')
d.polygon([(627,330),(627,390),(673,360)],fill='white')
buf=io.BytesIO();poster.save(buf,format='PNG');poster_bytes=buf.getvalue()
deck=out/'ido-submission-template.pptx'
with zipfile.ZipFile(deck) as z:
    entries={n:z.read(n) for n in z.namelist()}
assert 'ppt/media/image1.png' in entries
entries['ppt/media/image1.png']=poster_bytes
rel='ppt/slides/_rels/slide1.xml.rels'
entries[rel]=entries[rel].replace(b'http://drive.google.com/',b'https://drive.google.com/')
entries[rel]=entries[rel].replace(b'https://drive.google.com/file/d/1UUzFCY4FjKIbEqmHwEpFiF7oqt9ZbjKL/view',b'https://ido-engine-demo.pikachu0310.chatgpt.site/ido-demo.mp4')
ns={'p':'http://schemas.openxmlformats.org/presentationml/2006/main'}
slide=ET.fromstring(entries['ppt/slides/slide1.xml'])
timing=slide.find('p:timing',ns)
if timing is not None:slide.remove(timing)
entries['ppt/slides/slide1.xml']=ET.tostring(slide,encoding='utf-8',xml_declaration=True)
temp=deck.with_suffix('.tmp.pptx')
with zipfile.ZipFile(temp,'w',zipfile.ZIP_DEFLATED) as z:
    for n,data in entries.items():z.writestr(n,data)
temp.replace(deck)
im=Image.open(out/'ido-submission-template.png').convert('RGB')
# These coordinates come from the native template's 720 by 405 point canvas.
x=round(355/720*im.width);y=round(139/405*im.height)
w=round(329/720*im.width);h=round(185.0625/405*im.height)
im.paste(poster.resize((w,h),Image.Resampling.LANCZOS),(x,y))
im.save(out/'ido-submission-template.png')
im.save(out/'ido-submission-template.pdf',resolution=160)
print('Static export poster supplied; Google Slides retains the embedded video.')
