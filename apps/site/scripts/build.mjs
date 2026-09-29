#!/usr/bin/env node
// Refreshes everything in public/ that is made from the brand kit, then stamps
// public/index.html with the result. Run it after `pnpm brand`:
//
//   pnpm --filter @beach-bingo/site build
//
// It writes, and all of it is committed:
//   public/favicon.ico, favicon.svg, apple-touch-icon.png   the kit's web icons
//   public/assets/og.png                                    the kit's link card
//   public/assets/brand/beachbingo-stack.svg                the hero logo (stacked, no sea band)
//   public/assets/brand/sea.svg, shell.svg                  one wavelength of the sea, the shell
//   public/assets/screens/screen-0N-{480,720}.webp          the dApp Store screenshots
//   public/assets/fonts/*.woff2                             Latin subsets (only if pyftsubset is installed)
// and rewrites two things in public/index.html:
//   the screenshot strip between <!-- BUILD:screens --> and <!-- /BUILD:screens -->
//   every ?v= on a local asset URL: 10 hex of the file's SHA-256, so a changed
//   file gets a new URL and link-preview caches pick it up.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { C } from '../../../packages/brand/src/palette.mjs';
import { COLOR, f, sea, shell, stack } from '../../../packages/brand/src/draw.mjs';
import { SCREENS } from '../../../packages/brand/src/screens.mjs';

const PUB = fileURLToPath(new URL('../public/', import.meta.url));
const BRAND = fileURLToPath(new URL('../../../packages/brand/', import.meta.url));
// The brand package's sharp: this script is part of the brand build chain, not a second copy of it.
const sharp = createRequire(`${BRAND}package.json`)('sharp');
const KIT = `${BRAND}kit/`;
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const put = (path, data) => {
  mkdirSync(dirname(`${PUB}${path}`), { recursive: true });
  writeFileSync(`${PUB}${path}`, data);
};

// 1. Straight copies from the kit.
for (const [from, to] of [
  ['web/favicon.ico', 'favicon.ico'],
  ['web/favicon.svg', 'favicon.svg'],
  ['web/apple-touch-icon.png', 'apple-touch-icon.png'],
  ['web/og.png', 'assets/og.png'],
]) {
  mkdirSync(dirname(`${PUB}${to}`), { recursive: true });
  copyFileSync(`${KIT}${from}`, `${PUB}${to}`);
}

// 2. The hero's drawings, by the brand's own functions so they match the link
//    card and the store art: the stacked logo without its sea band (the hero has
//    the sea at its foot, as the link card does), cropped to its ink; one
//    wavelength of the sea, which tiles seamlessly; and the shell on it.
{
  const span = 700;
  const body = stack(COLOR);
  const probe = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-span} ${-span} ${span * 2} ${span * 2}" width="${span * 2}" height="${span * 2}">${body}</svg>`;
  const { info } = await sharp(Buffer.from(probe)).trim({ threshold: 0 }).toBuffer({ resolveWithObject: true });
  const pad = 4;
  const x = -info.trimOffsetLeft - span - pad;
  const y = -info.trimOffsetTop - span - pad;
  const w = info.width + 2 * pad;
  const h = info.height + 2 * pad;
  if (w >= span * 2 || h >= span * 2) throw new Error('the stacked logo is larger than its probe canvas');
  put('assets/brand/beachbingo-stack.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(x)} ${f(y)} ${f(w)} ${f(h)}" width="${f(w * 2)}" height="${f(h * 2)}"><title>Beach Bingo</title>${body}</svg>\n`);
}
const U = 240;
const SEA_H = 150;
const seaBody = sea(COLOR, { x0: 0, x1: U, y: 26, u: U, line: 6, bottom: SEA_H + 2, phase: U * 0.16 });
put('assets/brand/sea.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${U} ${SEA_H}" width="${U}" height="${SEA_H}" preserveAspectRatio="none">${seaBody}</svg>\n`);
const SR = 40;
put('assets/brand/shell.svg', `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-SR * 1.25} ${-SR * 1.2} ${SR * 2.5} ${SR * 2.05}" width="${SR * 2.5}" height="${SR * 2.05}">${shell(COLOR, 0, 0, SR, { line: 6.5 })}</svg>\n`);

// 3. Screenshots: 480 and 720 wide WebP (the strip shows them at up to 300 CSS px).
const SHOWS = {
  '01-splash': 'the Beach Bingo title screen',
  '02-map': 'the island level map',
  '03-game': 'an adventure level in play',
  '04-room': 'a game in Sunset Hall, the 75-ball room',
  '05-pier': 'a game in Pier Hall, the 90-ball room',
  '06-fair': 'the provably fair screen',
};
const SHADOWS = [C.surf, C.pink, C.gold, C.lime, C.coconut, C.deep];
const figures = [];
for (const [i, s] of SCREENS.entries()) {
  const n = s.file.slice(0, 2);
  const src = `${KIT}store/screenshots/dapp-store-screenshot-${n}-1080x1920.png`;
  for (const w of [480, 720]) {
    const out = await sharp(src).resize(w, Math.round((w * 1920) / 1080), { kernel: 'lanczos3' }).webp({ quality: 80, effort: 6 }).toBuffer();
    put(`assets/screens/screen-${n}-${w}.webp`, out);
  }
  if (!SHOWS[s.file]) throw new Error(`no description for screenshot ${s.file}`);
  const alt = `A phone showing ${SHOWS[s.file]}. ${s.tag}: ${s.lines.join(' ')}`;
  figures.push(`<figure class="shot" style="--c:${SHADOWS[i % SHADOWS.length]}"><img src="/assets/screens/screen-${n}-480.webp?v=" srcset="/assets/screens/screen-${n}-480.webp?v= 480w, /assets/screens/screen-${n}-720.webp?v= 720w" sizes="(min-width: 760px) 300px, 62vw" width="1080" height="1920" alt="${alt.replace(/"/g, '&quot;')}" loading="lazy" decoding="async"></figure>`);
}

// 4. Fonts: Latin subsets of the kit's TTFs. pyftsubset (fonttools + brotli) is
//    optional; without it the committed files stay as they are.
const FONTS = [
  ['Bungee-Regular', 'bungee'],
  ['RubikWetPaint-Regular', 'rubik-wet-paint'],
  ['BarlowCondensed-Medium', 'barlow-condensed-500'],
  ['BarlowCondensed-SemiBold', 'barlow-condensed-600'],
  ['BarlowCondensed-Bold', 'barlow-condensed-700'],
  ['BarlowCondensed-ExtraBold', 'barlow-condensed-800'],
];
const UNICODES = 'U+0020-007E,U+00A0,U+00A9,U+00B7,U+00D7,U+2013,U+2014,U+2018-201D,U+2026,U+2190,U+2192,U+2193,U+25BC,U+2605';
if (spawnSync('pyftsubset', ['--help'], { stdio: 'ignore' }).status === 0) {
  mkdirSync(`${PUB}assets/fonts`, { recursive: true });
  for (const [from, to] of FONTS) {
    const r = spawnSync('pyftsubset', [`${BRAND}fonts/${from}.ttf`, `--unicodes=${UNICODES}`, '--layout-features=kern,liga,calt,ccmp,locl,mark,mkmk', '--flavor=woff2', '--no-hinting', '--desubroutinize', `--output-file=${PUB}assets/fonts/${to}.woff2`], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`pyftsubset failed on ${from}: ${r.stderr}`);
  }
} else {
  console.log('site: pyftsubset not found; keeping the committed fonts');
}
for (const [, to] of FONTS) if (!existsSync(`${PUB}assets/fonts/${to}.woff2`)) throw new Error(`missing font assets/fonts/${to}.woff2`);

// 5. Stamp index.html: the strip, then a content hash on every local asset URL.
let html = readFileSync(`${PUB}index.html`, 'utf8');
const A = '<!-- BUILD:screens -->';
const B = '<!-- /BUILD:screens -->';
if (!html.includes(A) || !html.includes(B)) throw new Error('index.html has lost its BUILD:screens markers');
html = html.replace(new RegExp(`${A}[\\s\\S]*?${B}`), `${A}\n      ${figures.join('\n      ')}\n      ${B}`);
const hashes = new Map();
const hashOf = (path) => {
  if (!hashes.has(path)) {
    if (!existsSync(`${PUB}${path}`)) throw new Error(`index.html links /${path}, which is not in public/`);
    hashes.set(path, createHash('sha256').update(readFileSync(`${PUB}${path}`)).digest('hex').slice(0, 10));
  }
  return hashes.get(path);
};
html = html.replace(/(https:\/\/beachbingo\.xyz)?\/((?:assets\/|favicon|apple-touch-icon)[^"'?\s)]*)\?v=[0-9a-f]*/g, (_, abs = '', path) => `${abs}/${path}?v=${hashOf(path)}`);
writeFileSync(`${PUB}index.html`, html);

const total = [...hashes.keys()].reduce((a, p) => a + readFileSync(`${PUB}${p}`).length, 0);
console.log(`site: stamped ${hashes.size} asset URLs in index.html (${kb(total)} of assets, index.html ${kb(html.length)})`);
