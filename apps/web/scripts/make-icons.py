#!/usr/bin/env python3
"""Render PWA / dApp Store icons (192, 512, maskable 512, store 512) from the Island art.

Needs Pillow + fonttools[woff2] (pip install pillow fonttools brotli).
"""
import io
import os

from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..')
ART = os.path.join(ROOT, 'src', 'assets', 'island')
OUT = os.path.join(ROOT, 'public', 'icons')
WOFF2 = os.path.join(ROOT, 'node_modules', '@fontsource', 'luckiest-guy', 'files', 'luckiest-guy-latin-400-normal.woff2')

os.makedirs(OUT, exist_ok=True)
font = TTFont(WOFF2)
font.flavor = None
buf = io.BytesIO()
font.save(buf)


def lucky(size):
    buf.seek(0)
    return ImageFont.truetype(io.BytesIO(buf.getvalue()), size)


def render(size, safe):
    """`safe` = fraction of the canvas the artwork may use (maskable icons need ~0.8)."""
    s = 1024
    img = Image.new('RGBA', (s, s))
    # Sky → sea gradient.
    top, bottom = (84, 208, 255), (0, 150, 214)
    d = ImageDraw.Draw(img)
    for y in range(s):
        t = y / s
        d.line([(0, y), (s, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)) + (255,))
    # Sand dune.
    d.ellipse([-s * 0.4, s * 0.72, s * 1.4, s * 1.5], fill=(246, 212, 139, 255))
    inner = int(s * safe)
    off = (s - inner) // 2
    # Gold bingo ball.
    ball = Image.new('RGBA', (inner, inner))
    bd = ImageDraw.Draw(ball)
    r = inner * 0.36
    cx, cy = inner / 2, inner * 0.42
    shadow = Image.new('RGBA', (inner, inner))
    ImageDraw.Draw(shadow).ellipse([cx - r, cy - r + inner * 0.03, cx + r, cy + r + inner * 0.03], fill=(0, 0, 0, 110))
    ball.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(inner * 0.02)))
    for i in range(60, 0, -1):
        k = i / 60
        col = (int(215 + 40 * (1 - k)), int(119 + 110 * (1 - k)), int(1 + 120 * (1 - k) ** 2), 255)
        rr = r * k
        bd.ellipse([cx - rr - (1 - k) * r * 0.25, cy - rr - (1 - k) * r * 0.3, cx + rr - (1 - k) * r * 0.25, cy + rr - (1 - k) * r * 0.3], fill=col)
    bd.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(122, 59, 12, 255), width=int(inner * 0.018))
    wr = r * 0.58
    bd.ellipse([cx - wr, cy - wr, cx + wr, cy + wr], fill=(255, 255, 255, 255), outline=(122, 59, 12, 255), width=int(inner * 0.012))
    f = lucky(int(wr * 1.25))
    bd.text((cx, cy + wr * 0.08), 'B', font=f, fill=(29, 42, 92, 255), anchor='mm')
    # "BINGO" banner text.
    f2 = lucky(int(inner * 0.2))
    tx, ty = inner / 2, inner * 0.86
    for dx in range(-9, 10, 3):
        for dy in range(-9, 13, 3):
            bd.text((tx + dx, ty + dy), 'BINGO', font=f2, fill=(110, 22, 120, 255), anchor='mm')
    bd.text((tx, ty), 'BINGO', font=f2, fill=(255, 214, 40, 255), anchor='mm')
    img.alpha_composite(ball, (off, off))
    return img.resize((size, size), Image.LANCZOS)


render(192, 0.92).save(os.path.join(OUT, 'icon-192.png'))
render(512, 0.92).save(os.path.join(OUT, 'icon-512.png'))
render(512, 0.72).save(os.path.join(OUT, 'icon-maskable-512.png'))
print('icons written to', OUT)
