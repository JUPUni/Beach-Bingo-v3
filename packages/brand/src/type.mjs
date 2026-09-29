/* Type, outlined. Every word in a kit file is a path cut from the committed
   TTFs, so nothing depends on a font being installed.

   Bungee            the wordmark, display and buttons (Fete Labs' sign face)
   Rubik Wet Paint   loud headlines only, never the logo (Fete Labs' paint face)
   Barlow Condensed  body, labels and captions (Fete Labs' body face) */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');
const load = (file) => opentype.parse(readFileSync(new URL(`../fonts/${file}`, import.meta.url)).buffer);

export const FONTS = {
  sign: load('Bungee-Regular.ttf'),
  paint: load('RubikWetPaint-Regular.ttf'),
  body: load('BarlowCondensed-Medium.ttf'),
  bodySemi: load('BarlowCondensed-SemiBold.ttf'),
  bodyBold: load('BarlowCondensed-Bold.ttf'),
  bodyX: load('BarlowCondensed-ExtraBold.ttf'),
};

/** Bungee's stylistic-alternate I: a plain stem, no slabs. The logo's i is cut from it. */
export const STEM = (() => {
  for (let i = 0; i < FONTS.sign.glyphs.length; i += 1) {
    const g = FONTS.sign.glyphs.get(i);
    if (g.name === 'I.salt') return g;
  }
  throw new Error('Bungee I.salt not found');
})();

const n = (v) => String(Math.round(v * 100) / 100);

/** One glyph as path data. Serialised by hand: opentype.js 2.0's toPathData can
 *  print NaN, and librsvg stops drawing a path at the first NaN. */
export function glyphD(g, x, y, size) {
  return g.getPath(x, y, size).commands.map((c) => (c.type === 'Z' ? 'Z'
    : c.type === 'Q' ? `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`
      : c.type === 'C' ? `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`
        : `${c.type}${n(c.x)} ${n(c.y)}`)).join('');
}

/** Advance positions for a run of glyphs, kerning included. `tracking` is in em. */
export function layout(glyphs, font, size, tracking = 0) {
  const s = size / font.unitsPerEm;
  let adv = 0;
  const pos = [];
  glyphs.forEach((g, i) => {
    pos.push(adv);
    adv += g.advanceWidth * s;
    if (i < glyphs.length - 1) adv += tracking * size + (Number(font.getKerningValue(g, glyphs[i + 1])) || 0) * s;
  });
  return { pos, width: adv };
}

/** A string as one path. Glyphs by charToGlyph: stringToGlyphs throws on some GSUB tables. */
export function textPath(str, { font = FONTS.body, size, x = 0, y = 0, tracking = 0, anchor = 'start' }) {
  const glyphs = [...str].map((ch) => font.charToGlyph(ch));
  const { pos, width } = layout(glyphs, font, size, tracking);
  const x0 = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  return { d: glyphs.map((g, i) => glyphD(g, x0 + pos[i], y, size)).join(''), width, x0 };
}

/** Where CSS line-height:1 puts the baseline inside a box `size` tall. */
export function baselineInBox(size, font) {
  const asc = font.tables.hhea.ascender;
  const desc = -font.tables.hhea.descender;
  const s = size / font.unitsPerEm;
  return (size - (asc + desc) * s) / 2 + asc * s;
}
