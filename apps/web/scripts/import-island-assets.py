#!/usr/bin/env python3
"""Convert Figma PNG exports (3x) of the Island UI kit into WebP assets for the web app.

Usage: python3 scripts/import-island-assets.py <export-dir>
Art source: "Island | mobile game" Figma Community file (CC BY 4.0) — see apps/web/CREDITS.md.
"""
import os
import sys

from PIL import Image

SRC = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('ISLAND_ASSETS_DIR', '')
DST = os.path.join(os.path.dirname(__file__), '..', 'src', 'assets', 'island')

if not SRC or not os.path.isdir(SRC):
    sys.exit('pass the directory holding the PNG exports')

os.makedirs(DST, exist_ok=True)
total_in = total_out = 0
for name in sorted(os.listdir(SRC)):
    if not name.endswith('.png') or name.startswith('ref-') or 'reference' in name:
        continue
    src = os.path.join(SRC, name)
    img = Image.open(src).convert('RGBA')
    is_scene = name.startswith('bg-')
    out = os.path.join(DST, name[:-4] + '.webp')
    if is_scene:
        img.convert('RGB').save(out, 'WEBP', quality=80, method=6)
    else:
        img.save(out, 'WEBP', quality=90, method=6)
    total_in += os.path.getsize(src)
    total_out += os.path.getsize(out)
    print(f'{name:32s} {img.size[0]}x{img.size[1]:<5d} {os.path.getsize(src)//1024:5d}KB -> {os.path.getsize(out)//1024:4d}KB')
print(f'total {total_in//1024}KB -> {total_out//1024}KB')
