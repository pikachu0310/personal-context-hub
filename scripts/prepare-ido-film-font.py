"""Reuse licensed font subsets already installed by the product workspace."""
from pathlib import Path
import re
import shutil

root = Path(__file__).resolve().parents[1]
film = root / 'examples/ido-film'
package = root / 'node_modules/@fontsource-variable/noto-sans-jp'
copy = ''.join(p.read_text() for p in film.iterdir() if p.suffix in ('.html', '.mjs', '.css'))
points = set(map(ord, copy)) | set(range(32, 127))
blocks = re.findall(r'@font-face\s*\{[^}]+\}', (package / 'wght.css').read_text())
selected=[]
(film / 'fonts').mkdir(exist_ok=True)
for block in blocks:
    ranges = re.search(r'unicode-range:\s*([^;]+)', block)
    include = not ranges
    for item in ranges.group(1).split(',') if ranges else []:
        parts = item.strip().removeprefix('U+').split('-')
        lower, upper = int(parts[0], 16), int(parts[-1], 16)
        include |= any(lower <= n <= upper for n in points)
    if not include:
        continue
    filename = re.search(r'url\(\./files/([^\)]+)\)', block).group(1)
    shutil.copyfile(package / 'files' / filename, film / 'fonts' / filename)
    selected.append(block.replace('Noto Sans JP Variable', 'FilmJP').replace('./files/', './fonts/'))
(film / 'fonts.css').write_text('\n'.join(selected))
shutil.copyfile(package / 'LICENSE', film / 'fonts' / 'OFL.txt')
print(f'Prepared {len(selected)} Noto Sans JP font subsets with OFL license')
