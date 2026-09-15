"""Crop captured evidence to the relevant UI; export layout-preserving PDFs."""
from pathlib import Path
import sys
from PIL import Image
ROOT=Path(__file__).resolve().parent.parent
if '--pdf' in sys.argv:
    for name in ['ido-overview','ido-pitch']:
        pages=[Image.open(p).convert('RGB') for p in sorted((ROOT/'output').glob(name+'-*.png'))]
        pages[0].save(ROOT/'output'/(name+'.pdf'),save_all=True,append_images=pages[1:],resolution=144)
else:
    for source,target,crop in [
        ('feedback.png','feedback-detail.png',(361,294,831,489)),
        ('comparison.png','comparison-detail.png',(80,110,1180,537)),
        ('transcript.png','transcript-detail.png',(315,158,1262,704)),
    ]:
        Image.open(ROOT/'assets'/source).crop(crop).save(ROOT/'assets'/target)
