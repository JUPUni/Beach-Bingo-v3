#!/usr/bin/env node
// Refreshes everything in public/ that is made from the brand kit, then stamps
// both pages with the result. Run it after `pnpm brand`:
//
//   pnpm --filter @beach-bingo/site build
//
// It writes, and all of it is committed:
//   public/favicon.ico, favicon.svg, apple-touch-icon.png   the names browsers ask for blindly
//   public/apple-touch-icon-precomposed.png                 the same, for clients that ask for it
//   public/site.webmanifest, browserconfig.xml              home screens and Windows tiles
//   public/assets/icons/*                                   16/32/48 favicons, 192/512/maskable,
//                                                           the Safari pinned tab, the Windows tile
//   public/assets/icon-512.png                              the old site's icon address, now the new icon
//   public/assets/og.png                                    the kit's link card
//   public/assets/brand/beachbingo-stack.svg                the hero logo (stacked, no sea band)
//   public/assets/brand/sea.svg, shell.svg                  one wavelength of the sea, the shell
//   public/assets/screens/screen-0N-{480,720}.webp          the dApp Store screenshots
//   public/assets/fonts/*.woff2                             Latin subsets (only if pyftsubset is installed)
// and rewrites, in public/index.html, public/play/index.html, public/privacy/index.html,
// public/terms/index.html and public/assets/legal.css:
//   the icon tags between <!-- BUILD:icons --> and <!-- /BUILD:icons --> (one list, every page)
//   the screenshot strip between <!-- BUILD:screens --> and <!-- /BUILD:screens --> (index.html)
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

// 1. Straight copies from the kit. The root four are the names a browser or a
//    crawler asks for blindly; everything else lives under assets/icons/.
//    assets/icon-512.png is the address the old site used for its tab icon and
//    link card, so it carries the new icon too: an old preview, re-read, shows it.
for (const [from, to] of [
  ['web/favicon.ico', 'favicon.ico'],
  ['web/favicon.svg', 'favicon.svg'],
  ['web/apple-touch-icon.png', 'apple-touch-icon.png'],
  ['web/apple-touch-icon.png', 'apple-touch-icon-precomposed.png'],
  ['web/favicon-16x16.png', 'assets/icons/favicon-16x16.png'],
  ['web/favicon-32x32.png', 'assets/icons/favicon-32x32.png'],
  ['web/favicon-48x48.png', 'assets/icons/favicon-48x48.png'],
  ['web/icon-192.png', 'assets/icons/icon-192.png'],
  ['web/icon-512.png', 'assets/icons/icon-512.png'],
  ['web/icon-maskable-512.png', 'assets/icons/icon-maskable-512.png'],
  ['web/safari-pinned-tab.svg', 'assets/icons/safari-pinned-tab.svg'],
  ['web/icon-512.png', 'assets/icon-512.png'],
  ['web/og.png', 'assets/og.png'],
]) {
  mkdirSync(dirname(`${PUB}${to}`), { recursive: true });
  copyFileSync(`${KIT}${from}`, `${PUB}${to}`);
}
// The Windows tile: the full-bleed icon, so the tile's own colour never shows a corner.
put('assets/icons/mstile-150x150.png', await sharp(`${KIT}web/icon-maskable-512.png`).resize(150, 150, { kernel: 'lanczos3' }).png({ palette: true, compressionLevel: 9 }).toBuffer());

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

// 5. Every icon a browser, a home screen, a crawler or a link preview reads,
//    written once and stamped into both pages. The manifest and the Windows
//    tile file name the icons with the same content hashes as the pages.
const hashes = new Map();
const hashOf = (path) => {
  if (!hashes.has(path)) {
    if (!existsSync(`${PUB}${path}`)) throw new Error(`a page links /${path}, which is not in public/`);
    hashes.set(path, createHash('sha256').update(readFileSync(`${PUB}${path}`)).digest('hex').slice(0, 10));
  }
  return hashes.get(path);
};
const v = (path) => `/${path}?v=${hashOf(path)}`;
put('site.webmanifest', `${JSON.stringify({
  id: '/',
  name: 'Beach Bingo',
  short_name: 'Beach Bingo',
  description: 'Free-to-play island bingo from Fete Labs.',
  start_url: '/',
  scope: '/',
  display: 'browser',
  background_color: C.teal,
  theme_color: C.teal,
  icons: [
    { src: v('assets/icons/icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: v('assets/icons/icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: v('assets/icons/icon-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2)}\n`);
put('browserconfig.xml', `<?xml version="1.0" encoding="utf-8"?>\n<browserconfig><msapplication><tile><square150x150logo src="${v('assets/icons/mstile-150x150.png')}"/><TileColor>${C.teal}</TileColor></tile></msapplication></browserconfig>\n`);
const ICONS = [
  '<link rel="icon" href="/favicon.ico?v=" sizes="32x32">',
  '<link rel="icon" href="/favicon.svg?v=" type="image/svg+xml">',
  '<link rel="icon" href="/assets/icons/favicon-16x16.png?v=" type="image/png" sizes="16x16">',
  '<link rel="icon" href="/assets/icons/favicon-32x32.png?v=" type="image/png" sizes="32x32">',
  '<link rel="icon" href="/assets/icons/favicon-48x48.png?v=" type="image/png" sizes="48x48">',
  '<link rel="icon" href="/assets/icons/icon-192.png?v=" type="image/png" sizes="192x192">',
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=" sizes="180x180">',
  `<link rel="mask-icon" href="/assets/icons/safari-pinned-tab.svg?v=" color="${C.teal}">`,
  '<link rel="manifest" href="/site.webmanifest?v=">',
  '<meta name="apple-mobile-web-app-title" content="Beach Bingo">',
  '<meta name="application-name" content="Beach Bingo">',
  `<meta name="msapplication-TileColor" content="${C.teal}">`,
  '<meta name="msapplication-config" content="/browserconfig.xml?v=">',
];
const block = (html, name, lines, indent) => {
  const a = `<!-- BUILD:${name} -->`;
  const b = `<!-- /BUILD:${name} -->`;
  if (!html.includes(a) || !html.includes(b)) throw new Error(`a page has lost its BUILD:${name} markers`);
  return html.replace(new RegExp(`${a}[\\s\\S]*?${b}`), `${a}\n${lines.map((l) => indent + l).join('\n')}\n${indent}${b}`);
};
const STAMP = /(https:\/\/beachbingo\.xyz)?\/((?:assets\/|favicon|apple-touch-icon|site\.webmanifest|browserconfig\.xml)[^"'?\s)]*)\?v=[0-9a-f]*/g;
const sizes = [];
// The notices' stylesheet first: the pages link it by its hash, so it must be final before they are.
for (const [page, kind] of [
  ['assets/legal.css', 'css'],
  ['index.html', 'landing'],
  ['play/index.html', 'page'],
  ['privacy/index.html', 'page'],
  ['terms/index.html', 'page'],
]) {
  let html = readFileSync(`${PUB}${page}`, 'utf8');
  if (kind !== 'css') html = block(html, 'icons', ICONS, '');
  if (kind === 'landing') html = block(html, 'screens', figures, '      ');
  html = html.replace(STAMP, (_, abs = '', path) => `${abs}/${path}?v=${hashOf(path)}`);
  writeFileSync(`${PUB}${page}`, html);
  sizes.push(`${page} ${kb(html.length)}`);
}

const total = [...hashes.keys()].reduce((a, p) => a + readFileSync(`${PUB}${p}`).length, 0);
console.log(`site: stamped ${hashes.size} asset URLs (${kb(total)} of assets; ${sizes.join(', ')})`);
