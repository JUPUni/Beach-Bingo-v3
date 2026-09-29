#!/usr/bin/env node
// Builds the Beach Bingo brand kit, the web app's icons, the Android launcher
// icons and the dApp Store art from ONE drawing of the logo (src/draw.mjs).
//
//   pnpm --filter @beach-bingo/brand brand
//
// The output is committed: packages/brand/kit/, the zip, the brand page
// (packages/brand/index.html), apps/web/public/ icons and og.png,
// apps/web/src/assets/brand/, and android/app/src/main/res/.
// Every word in every file is outlined from the TTFs in fonts/, so no file
// needs a font installed. Re-running with nothing changed rewrites the same bytes.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { C, PALETTE, slug } from '../src/palette.mjs';
import { FONTS, textPath } from '../src/type.mjs';
import { COLOR, MASK, halo, logo, stack, wordLine, symbol, appIcon, sea, TILE, CORNER, f, nid } from '../src/draw.mjs';
import { BOX, svgDoc, place, heightAt, card, poster, banner, storeBanner, storeFeature, pfp, highlight, sticker, og, foot } from '../src/compose.mjs';
import { brandPage } from '../src/page.mjs';
import { SCREENS, storeScreenshot, capturesReady } from '../src/screens.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const PKG = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(PKG, '../..');
const KIT = join(PKG, 'kit');
const WEB = join(ROOT, 'apps/web/public');
const APP_ASSETS = join(ROOT, 'apps/web/src/assets/brand');
const RES = join(ROOT, 'android/app/src/main/res');

/* ── output helpers ───────────────────────────────────────────────────── */

const written = [];
function put(abs, data) {
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, data);
  written.push(relative(ROOT, abs));
}

function sizeOf(svg) {
  const m = /<svg[^>]*\swidth="([\d.]+)"[^>]*\sheight="([\d.]+)"/.exec(svg);
  return { w: +m[1], h: +m[2] };
}

/** Rasterise an SVG string at w x h. `bg` flattens alpha (JPEG has none). */
async function raster(svg, w, h, fmt, { bg, photo = false } = {}) {
  const { w: sw } = sizeOf(svg);
  let img = sharp(Buffer.from(svg), { density: Math.min(2400, 72 * Math.max(1, w / sw)) }).resize(w, h, { fit: 'fill' });
  if (bg || fmt === 'jpg') img = img.flatten({ background: bg || '#ffffff' });
  // Flat colour art: a 256-colour palette is indistinguishable at 1:1 and a third of the size.
  // Pictures with photographs or app screens in them keep every colour.
  if (fmt === 'png') return img.png(photo ? { compressionLevel: 9 } : { palette: true, quality: 100, effort: 10, compressionLevel: 9 }).toBuffer();
  if (fmt === 'jpg') return img.jpeg({ quality: 88, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
  if (fmt === 'webp') return img.webp({ quality: 90, alphaQuality: 100, effort: 6 }).toBuffer();
  throw new Error(fmt);
}

/** Every kit file goes through here, so the brand page can list exactly what was written. */
export const REG = [];
async function asset(dir, name, svg, { px, formats = ['svg', 'png', 'webp', 'jpg'], jpgBg, ground, photo = false } = {}) {
  const { w, h } = sizeOf(svg);
  const W = Math.round(px || w);
  const H = Math.round(px ? (px * h) / w : h);
  REG.push({ dir, name, w: W, h: H, formats, ground: ground || jpgBg || null });
  for (const fmt of formats) {
    const file = join(KIT, dir, `${name}.${fmt}`);
    if (fmt === 'svg') put(file, svg);
    else put(file, await raster(svg, W, H, fmt, { bg: fmt === 'jpg' ? jpgBg : undefined, photo }));
  }
}

/** Same drawing, re-declared at another pixel size. */
const sized = (svg, W, H) => svg.replace(/(<svg[^>]*?)\swidth="[\d.]+"\sheight="[\d.]+"/, `$1 width="${W}" height="${H}"`);

/** A PNG-in-ICO file (every current browser and Windows reads these). */
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach(({ size, buf }, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, o);
    head.writeUInt8(size >= 256 ? 0 : size, o + 1);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(buf.length, o + 8);
    head.writeUInt32LE(off, o + 12);
    off += buf.length;
  });
  return Buffer.concat([head, ...pngs.map((p) => p.buf)]);
}

/** The ink bounds of a drawing, found by rasterising it at `scale` px per unit
 *  over [-span, span]. Half a pixel per unit is plenty for laying things out. */
async function measure(body, { span = 2400, scale = 0.5 } = {}) {
  const W = Math.round(span * 2 * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-span} ${-span} ${span * 2} ${span * 2}" width="${W}" height="${W}">${body}</svg>`;
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = W;
  let y0 = W;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < W; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (data[(y * W + x) * 4 + 3] > 4) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || x0 === 0 || y0 === 0 || x1 === W - 1 || y1 === W - 1) throw new Error('measure: drawing empty or larger than the canvas');
  return { x: x0 / scale - span, y: y0 / scale - span, w: (x1 - x0 + 1) / scale, h: (y1 - y0 + 1) / scale };
}

/* ── the drawings as standalone files ─────────────────────────────────── */

/** A drawing cropped to its ink plus `pad` (a fraction of its height), `px` wide. */
function cropped(body, box, { pad = 0.08, px = 2000, bg = null } = {}) {
  const p = box.h * pad;
  const vb = { x: box.x - p, y: box.y - p, w: box.w + 2 * p, h: box.h + 2 * p };
  const H = Math.round((px * vb.h) / vb.w);
  const ground = bg ? `<rect x="${f(vb.x)}" y="${f(vb.y)}" width="${f(vb.w)}" height="${f(vb.h)}" fill="${bg}"/>` : '';
  return svgDoc(px, H, ground + body, { viewBox: `${f(vb.x)} ${f(vb.y)} ${f(vb.w)} ${f(vb.h)}` });
}

/** One-colour version of a drawing: its Ink line work, in `colour`. */
function mono(drawMask, box, colour) {
  const id = nid('m');
  const m = 60;
  return `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="${f(box.x - m)}" y="${f(box.y - m)}" width="${f(box.w + 2 * m)}" height="${f(box.h + 2 * m)}">${drawMask}</mask></defs><rect x="${f(box.x - m)}" y="${f(box.y - m)}" width="${f(box.w + 2 * m)}" height="${f(box.h + 2 * m)}" fill="${colour}" mask="url(#${id})"/>`;
}

/** The horizontal lockup: the symbol tile, then the one-line wordmark. */
function lockupH(ground = 'light') {
  const ink = ground === 'ink';
  const wb = ink ? BOX.wordHalo : BOX.word;
  const body = ink ? wordLine(halo(18)).svg + wordLine(COLOR).svg : wordLine(COLOR).svg;
  const t = BOX.word.h * 1.18;
  const gap = BOX.word.h * 0.3;
  const x0 = -(t + gap + wb.w) / 2;
  const tile = `<g transform="translate(${f(x0)} ${f(-t / 2)}) scale(${f(t / TILE)})">${symbol(COLOR)}</g>`;
  return tile + place(body, wb, x0 + t + gap + wb.w / 2, 0, wb.w);
}

async function main() {
  for (const d of ['logo', 'pfp', 'social', 'store', 'web', 'colour', 'fonts', 'android']) rmSync(join(KIT, d), { recursive: true, force: true });

  /* 0 · measure ---------------------------------------------------------- */
  Object.assign(BOX, {
    stack: await measure(stack(COLOR)),
    stackHalo: await measure(stack(halo(20))),
    logo: await measure(logo(COLOR)),
    logoHalo: await measure(logo(halo(20))),
    logoHalo22: await measure(logo(halo(22))),
    word: await measure(wordLine(COLOR).svg),
    wordHalo: await measure(wordLine(halo(18)).svg),
  });
  BOX.lockup = await measure(lockupH());
  BOX.lockupInk = await measure(lockupH('ink'));

  /* 1 · logo ------------------------------------------------------------- */
  const L = 'logo';
  await asset(L, 'beachbingo-logo', cropped(logo(COLOR), BOX.logo), { jpgBg: C.teal });
  await asset(L, 'beachbingo-logo-sticker', cropped(logo(halo(20)) + logo(COLOR), BOX.logoHalo), { jpgBg: C.ink });
  await asset(L, 'beachbingo-logo-mono-ink', cropped(mono(logo(MASK), BOX.logo, C.ink), BOX.logo), { jpgBg: C.cream });
  await asset(L, 'beachbingo-logo-mono-cream', cropped(mono(logo(MASK), BOX.logo, C.cream), BOX.logo), { jpgBg: C.ink });
  await asset(L, 'beachbingo-wordmark', cropped(wordLine(COLOR).svg, BOX.word, { pad: 0.2, px: 2400 }), { jpgBg: C.teal });
  await asset(L, 'beachbingo-wordmark-sticker', cropped(wordLine(halo(18)).svg + wordLine(COLOR).svg, BOX.wordHalo, { pad: 0.2, px: 2400 }), { jpgBg: C.ink });
  await asset(L, 'beachbingo-lockup-horizontal', cropped(lockupH(), BOX.lockup, { pad: 0.2, px: 2400 }), { jpgBg: C.cream });
  await asset(L, 'beachbingo-lockup-horizontal-ink', cropped(lockupH('ink'), BOX.lockupInk, { pad: 0.2, px: 2400 }), { jpgBg: C.ink });
  await asset(L, 'beachbingo-symbol', svgDoc(1024, 1024, symbol(COLOR)), { jpgBg: C.cream });
  await asset(L, 'beachbingo-symbol-mono-ink', svgDoc(1024, 1024, mono(symbol(MASK, { square: true, palmOn: false }), { x: 0, y: 0, w: 1024, h: 1024 }, C.ink)), { jpgBg: C.cream });
  await asset(L, 'beachbingo-app-icon', svgDoc(1024, 1024, appIcon(COLOR)), { jpgBg: C.cream });
  await asset(L, 'beachbingo-app-icon-square', svgDoc(1024, 1024, appIcon(COLOR, { square: true })), { formats: ['svg', 'png', 'jpg'], jpgBg: C.teal });

  /* 2 · dApp Store (publish.solanamobile.com) ----------------------------- */
  const ST = 'store';
  await asset(ST, 'dapp-store-icon-512', svgDoc(1024, 1024, appIcon(COLOR, { square: true })), { px: 512, formats: ['png'], ground: C.teal });
  await asset(ST, 'dapp-store-banner-1200x600', storeBanner(), { formats: ['png', 'jpg'], jpgBg: C.teal });
  await asset(ST, 'dapp-store-feature-1200x1200', storeFeature(), { formats: ['png', 'jpg'], jpgBg: C.teal });
  // Screenshots: the app in a Pixel 10 Pro frame. The captures come from
  // scripts/capture-screens.mjs; without them this step is skipped.
  if (capturesReady()) {
    for (const [i, s] of SCREENS.entries()) {
      await asset(`${ST}/screenshots`, `dapp-store-screenshot-${String(i + 1).padStart(2, '0')}-1080x1920`, await storeScreenshot(s), { formats: ['png'], photo: true, ground: C.teal });
    }
  } else {
    console.warn('brand: no captures in screens/captures, store screenshots skipped (run scripts/capture-screens.mjs)');
  }

  /* 3 · profile pictures -------------------------------------------------- */
  const PF = 'pfp';
  await asset(PF, 'beachbingo-pfp-teal', pfp('symbol'), { formats: ['svg', 'png', 'jpg'], jpgBg: C.teal });
  await asset(PF, 'beachbingo-pfp-ink', pfp('symbol', { ground: 'ink' }), { formats: ['svg', 'png', 'jpg'], jpgBg: C.ink });
  await asset(PF, 'beachbingo-pfp-cream', pfp('symbol', { ground: 'cream' }), { formats: ['svg', 'png', 'jpg'], jpgBg: C.cream });
  await asset(PF, 'beachbingo-pfp-logo', pfp('logo'), { formats: ['svg', 'png', 'jpg'], jpgBg: C.teal });

  /* 4 · social ------------------------------------------------------------ */
  const S = 'social';
  await asset(`${S}/x`, 'x-profile-400', sized(pfp('symbol'), 400, 400), { formats: ['png', 'jpg'], jpgBg: C.teal });
  await asset(`${S}/x`, 'x-header-1500x500', banner(1500, 500), { formats: ['svg', 'png', 'jpg'], jpgBg: C.teal });
  await asset(`${S}/x`, 'x-post-1600x900', card(1600, 900), { formats: ['svg', 'png', 'jpg'], jpgBg: C.teal });
  await asset(`${S}/x`, 'x-post-ink-1600x900', card(1600, 900, { ground: 'ink', seed: 3 }), { formats: ['svg', 'png', 'jpg'], jpgBg: C.ink });
  await asset(`${S}/instagram`, 'instagram-profile-1080', pfp('symbol'), { formats: ['png', 'jpg'], jpgBg: C.teal });
  await asset(`${S}/instagram`, 'instagram-post-1080', poster(1080, 1080, { lockW: 0.66, band: 0.15, head: false, seed: 2 }), { formats: ['svg', 'png', 'jpg'], jpgBg: C.teal });
  await asset(`${S}/instagram`, 'instagram-post-ink-1080', poster(1080, 1080, { ground: 'ink', lockW: 0.66, band: 0.15, head: false, seed: 4 }), { formats: ['svg', 'png', 'jpg'], jpgBg: C.ink });
  await asset(`${S}/instagram`, 'instagram-portrait-1080x1350', poster(1080, 1350, { lockW: 0.7, seed: 8 }), { formats: ['svg', 'png', 'jpg'], jpgBg: C.teal });
  await asset(`${S}/instagram`, 'instagram-story-1080x1920', poster(1080, 1920, { lockW: 0.8, band: 0.17, seed: 9 }), { formats: ['svg', 'png', 'jpg'], jpgBg: C.teal });
  for (const [n, bg, ink] of [['teal', C.teal, C.ink], ['pink', C.pink, C.ink], ['gold', C.gold, C.ink], ['lime', C.lime, C.ink], ['ink', C.ink, C.cream]]) {
    await asset(`${S}/instagram/highlights`, `highlight-${n}`, highlight(bg, ink), { formats: ['svg', 'png'], ground: bg });
  }
  await asset(`${S}/whatsapp`, 'whatsapp-profile-640', sized(pfp('symbol'), 640, 640), { formats: ['png', 'jpg'], jpgBg: C.teal });
  await asset(`${S}/whatsapp`, 'whatsapp-status-1080x1920', poster(1080, 1920, { lockW: 0.8, band: 0.17, seed: 12 }), { formats: ['svg', 'png', 'jpg'], jpgBg: C.teal });
  await asset(`${S}/whatsapp`, 'whatsapp-status-ink-1080x1920', poster(1080, 1920, { ground: 'ink', lockW: 0.8, band: 0.17, seed: 13 }), { formats: ['svg', 'png', 'jpg'], jpgBg: C.ink });
  // WhatsApp stickers: 512 x 512 WebP under 100 KB, plus a 96 px tray icon.
  for (const k of ['logo', 'ball', 'symbol', 'app-icon']) await asset(`${S}/whatsapp/stickers`, `sticker-${k}`, sticker(k), { formats: ['svg', 'webp', 'png'], ground: C.sand });
  put(join(KIT, S, 'whatsapp/stickers/tray-96.png'), await raster(sized(sticker('symbol'), 96, 96), 96, 96, 'png'));

  /* 5 · web: every icon a browser or phone asks for ---------------------- */
  const tiny = (px) => svgDoc(px, px, symbol(COLOR, { palmOn: false, num: '' }), { viewBox: '0 0 1024 1024' });
  const tile = (px, opts = {}) => svgDoc(px, px, appIcon(COLOR, opts), { viewBox: '0 0 1024 1024' });
  const webFiles = {};
  webFiles['favicon.svg'] = svgDoc(64, 64, symbol(COLOR, { palmOn: false }), { viewBox: '0 0 1024 1024' });
  const icoParts = [];
  for (const s of [16, 32, 48]) icoParts.push({ size: s, buf: await raster(s < 32 ? tiny(s) : svgDoc(s, s, symbol(COLOR, { palmOn: false }), { viewBox: '0 0 1024 1024' }), s, s, 'png') });
  webFiles['favicon.ico'] = ico(icoParts);
  webFiles['favicon-16x16.png'] = icoParts[0].buf;
  webFiles['favicon-32x32.png'] = icoParts[1].buf;
  webFiles['favicon-48x48.png'] = icoParts[2].buf;
  // iOS rounds the corners itself and shows black through transparency: full bleed.
  webFiles['apple-touch-icon.png'] = await raster(tile(180, { square: true }), 180, 180, 'png');
  webFiles['icon-192.png'] = await raster(tile(192), 192, 192, 'png');
  webFiles['icon-512.png'] = await raster(tile(512), 512, 512, 'png');
  // Maskable: full bleed, the logo inside the 80% safe circle.
  const mk = svgDoc(1024, 1024, `<rect width="1024" height="1024" fill="${C.teal}"/>${foot(1024, 1024, 780, { u: 256, line: 22 })}${place(stack(COLOR), BOX.stack, 512, 470, 640)}`);
  webFiles['icon-maskable-512.png'] = await raster(mk, 512, 512, 'png');
  webFiles['og.png'] = await raster(og(), 1200, 630, 'png');
  webFiles['og.svg'] = og();
  webFiles['safari-pinned-tab.svg'] = svgDoc(16, 16, mono(symbol(MASK, { square: true, palmOn: false }), { x: 0, y: 0, w: 1024, h: 1024 }, '#000'), { viewBox: '0 0 1024 1024' });
  for (const [n, data] of Object.entries(webFiles)) put(join(KIT, 'web', n), data);

  // Into the web app. The manifest in vite.config.ts points at icons/.
  put(join(WEB, 'favicon.svg'), webFiles['favicon.svg']);
  put(join(WEB, 'favicon.ico'), webFiles['favicon.ico']);
  put(join(WEB, 'apple-touch-icon.png'), webFiles['apple-touch-icon.png']);
  put(join(WEB, 'icons/icon-192.png'), webFiles['icon-192.png']);
  put(join(WEB, 'icons/icon-512.png'), webFiles['icon-512.png']);
  put(join(WEB, 'icons/icon-maskable-512.png'), webFiles['icon-maskable-512.png']);
  put(join(WEB, 'og.png'), webFiles['og.png']);
  // The logo the app draws on its splash screen (imported as a URL by Vite).
  put(join(APP_ASSETS, 'beachbingo-logo-sticker.svg'), cropped(logo(halo(20)) + logo(COLOR), BOX.logoHalo, { pad: 0.02, px: 600 }));
  put(join(APP_ASSETS, 'beachbingo-wordmark.svg'), cropped(wordLine(COLOR).svg, BOX.word, { pad: 0.04, px: 600 }));

  /* 6 · Android launcher (the dApp Store WebView shell) ------------------- */
  // Adaptive icon, 108 dp layers. The background carries the teal and the sea;
  // the foreground carries the logo, kept inside the 66 dp safe circle so a
  // round mask never clips it. The monochrome layer is the logo's line work,
  // for Android 13+ themed icons. minSdk is 28, so these always win; the
  // legacy mipmaps are for tools that read the APK's icon directly.
  const A = 432; // 108 dp at xxxhdpi
  const vis = A * (72 / 108);
  const off = (A - vis) / 2;
  const bgArt = svgDoc(A, A, `<rect width="${A}" height="${A}" fill="${C.teal}"/>${sea(COLOR, { x1: A, y: off + vis * 0.78, u: vis / 4, line: vis / 46, bottom: A + 2, phase: vis * 0.04 })}`);
  put(join(RES, 'drawable-nodpi/ic_launcher_background_sea.png'), await raster(bgArt, A, A, 'png'));
  // Foreground and monochrome are 512 px images inset 18 dp, so 512 px = 72 dp.
  const fgW = 512 * 0.74;
  const fg = svgDoc(512, 512, place(stack(COLOR), BOX.stack, 256, 244, fgW));
  put(join(RES, 'drawable-nodpi/ic_launcher_foreground_inner.png'), await raster(fg, 512, 512, 'png'));
  const mono512 = svgDoc(512, 512, place(mono(stack(MASK, { palmOn: false }), BOX.stack, '#fff'), BOX.stack, 256, 256, fgW));
  put(join(RES, 'drawable-nodpi/ic_launcher_monochrome_inner.png'), await raster(mono512, 512, 512, 'png'));
  const dens = [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]];
  const roundIcon = svgDoc(1024, 1024, `<defs><clipPath id="rc"><circle cx="512" cy="512" r="512"/></clipPath></defs><g clip-path="url(#rc)"><rect width="1024" height="1024" fill="${C.teal}"/>${foot(1024, 1024, 760, { u: 256, line: 22 })}${place(stack(COLOR), BOX.stack, 512, 452, 700)}</g>`);
  for (const [d, px] of dens) {
    put(join(RES, `mipmap-${d}/ic_launcher.webp`), await raster(tile(px), px, px, 'webp'));
    put(join(RES, `mipmap-${d}/ic_launcher_round.webp`), await raster(roundIcon, px, px, 'webp'));
  }
  put(join(RES, 'drawable/ic_launcher_monochrome.xml'), `<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android"
    android:drawable="@drawable/ic_launcher_monochrome_inner"
    android:insetBottom="18dp"
    android:insetLeft="18dp"
    android:insetRight="18dp"
    android:insetTop="18dp" />
`);
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background_sea" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>
`;
  put(join(RES, 'mipmap-anydpi/ic_launcher.xml'), adaptive);
  put(join(RES, 'mipmap-anydpi/ic_launcher_round.xml'), adaptive);
  const colours = join(RES, 'values/colors.xml');
  if (existsSync(colours)) {
    put(colours, readFileSync(colours, 'utf8')
      .replace(/(<color name="launcher_icon_background">)#[0-9A-Fa-f]{6}(<\/color>)/, `$1${C.teal.toUpperCase()}$2`)
      .replace(/(<color name="splash_background">)#[0-9A-Fa-f]{6}(<\/color>)/, `$1${C.teal.toUpperCase()}$2`));
  }
  // The same layers in the kit, for Google Play or anyone rebuilding the shell.
  put(join(KIT, 'android/ic_launcher-playstore-512.png'), await raster(tile(512, { square: true }), 512, 512, 'png'));
  put(join(KIT, 'android/adaptive-background-432.png'), await raster(bgArt, A, A, 'png'));
  put(join(KIT, 'android/adaptive-foreground-432.png'), await raster(svgDoc(A, A, place(stack(COLOR), BOX.stack, A / 2, off + (vis * 244) / 512, (vis * fgW) / 512)), A, A, 'png'));
  put(join(KIT, 'android/adaptive-monochrome-432.png'), await raster(svgDoc(A, A, place(mono(stack(MASK, { palmOn: false }), BOX.stack, '#fff'), BOX.stack, A / 2, A / 2, (vis * fgW) / 512)), A, A, 'png'));

  /* 7 · colour ------------------------------------------------------------ */
  const T = 'colour';
  put(join(KIT, T, 'beachbingo-colours.css'), `/* Beach Bingo colours. Six are Fete Labs' own; Surf, Deep, Coconut and Sand come from the Fete Labs site palette and kit. */\n:root{\n${PALETTE.map(([n, h]) => `  --bb-${slug(n)}:${h};`).join('\n')}\n}\n`);
  put(join(KIT, T, 'beachbingo-colours.json'), `${JSON.stringify(Object.fromEntries(PALETTE.map(([n, h]) => [slug(n), h])), null, 2)}\n`);
  const sw = PALETTE.map(([n, h], i) => {
    const x = 40 + (i % 5) * 300;
    const y = 40 + Math.floor(i / 5) * 320;
    const dark = h === C.ink;
    const fg = dark ? C.cream : C.ink;
    return `<rect x="${x + 10}" y="${y + 10}" width="260" height="280" fill="${C.ink}"/><rect x="${x}" y="${y}" width="260" height="280" fill="${h}" stroke="${C.ink}" stroke-width="4"/>`
      + `<path d="${textPath(n.toUpperCase(), { font: FONTS.sign, size: 30, x: x + 20, y: y + 210 }).d}" fill="${fg}"/>`
      + `<path d="${textPath(h, { font: FONTS.bodyBold, size: 28, x: x + 20, y: y + 252, tracking: 0.08 }).d}" fill="${fg}"/>`;
  }).join('');
  await asset(T, 'beachbingo-palette', svgDoc(1540, 700, `<rect width="1540" height="700" fill="${C.sand}"/>${sw}`), { formats: ['svg', 'png'], ground: C.sand });

  /* 8 · fonts ------------------------------------------------------------- */
  for (const file of readdirSync(join(PKG, 'fonts'))) {
    mkdirSync(join(KIT, 'fonts'), { recursive: true });
    copyFileSync(join(PKG, 'fonts', file), join(KIT, 'fonts', file));
    written.push(relative(ROOT, join(KIT, 'fonts', file)));
  }

  /* 9 · readme, zip, the brand page -------------------------------------- */
  put(join(KIT, 'README.txt'), README);
  const zip = join(PKG, 'beach-bingo-brand-kit.zip');
  rmSync(zip, { force: true });
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? walk(join(d, x.name)) : [join(d, x.name)]));
  const kitFiles = walk(KIT).filter((p) => !p.endsWith('.DS_Store')).sort();
  // Byte-for-byte reproducible: fixed entry times, sorted names, no directory entries, UTC.
  const STAMP = new Date('2026-09-29T00:00:00Z');
  for (const p of kitFiles) utimesSync(p, STAMP, STAMP);
  execFileSync('zip', ['-qX9D', zip, '-@'], {
    cwd: PKG,
    input: `${kitFiles.map((p) => relative(PKG, p)).join('\n')}\n`,
    env: { ...process.env, TZ: 'UTC' },
  });
  // Give the files their real mtime back. With the fixed stamp, git's stat cache
  // misses an edit that keeps a file's size (a colour swap in an SVG, say).
  const now = new Date();
  for (const p of kitFiles) utimesSync(p, now, now);
  written.push(relative(ROOT, zip));
  put(join(PKG, 'index.html'), brandPage({ REG, zipBytes: readFileSync(zip).length, kitBytes: (rel) => readFileSync(join(KIT, rel)).length }));

  console.log(`brand: wrote ${written.length} files`);
}

const README = `BEACH BINGO BRAND KIT  ·  v1  ·  beachbingo.xyz
===============================================

The logo is the original Beach Bingo icon, redrawn in the Fete Labs language:
a palm, BEACH stacked on BiNGO, a bingo ball dotting the i, and the sea
underneath with a shell on it. Flat Fete Labs colours, Bungee lettering, one
Ink outline round everything and a hard Ink block shadow. It leans 4 degrees.

FORMATS
  .svg   vector. Use it wherever it is accepted: web, print, signage.
  .png   transparent where the design is (logos, stickers).
  .webp  transparent, smallest for the web and WhatsApp stickers.
  .jpg   flattened onto the ground it was made for. Smallest for email.

FOLDERS
  logo/       the logo (primary), the sticker logo (Cream halo, for Ink and
              photos), one-colour logos in Ink and Cream, the one-line
              wordmark, the horizontal lockup, the symbol (the ball coming up
              out of the sea), the app icon rounded and full-bleed.
  store/      Solana dApp Store listing art: icon 512, banner 1200x600,
              feature graphic 1200x1200, and screenshots/ (six 1080x1920
              screens of the app in a Pixel 10 Pro frame).
  android/    launcher layers (adaptive background, foreground, monochrome)
              and the 512 store icon, for the WebView shell.
  pfp/        square profile pictures: the symbol on Teal (default), Ink and
              Cream, and the logo on Teal. A round crop never clips them.
  social/x          profile 400, header 1500x500, posts 1600x900 (Teal, Ink).
  social/instagram  profile 1080, posts 1080 (Teal, Ink), portrait
                    1080x1350, story 1080x1920, highlights/ (five colours).
  social/whatsapp   profile 640, status 1080x1920 (Teal, Ink),
                    stickers/ (512 WebP + 96 px tray icon).
  web/        favicon.svg, favicon.ico (16/32/48), apple-touch-icon,
              PWA icons (192, 512, maskable 512), Safari pinned tab,
              og.png (1200x630 link card).
  colour/     the palette as CSS variables, JSON and a swatch sheet.
  fonts/      Bungee, Rubik Wet Paint and Barlow Condensed (SIL OFL 1.1).

COLOUR
${PALETTE.map(([n, h, role]) => `  ${n.padEnd(10)} ${h}   ${role}`).join('\n')}

  Ink, Cream, Teal, Soca Pink, Gold and Lime are Fete Labs' own. Surf, Deep,
  Coconut and Sand come from the Fete Labs site palette and kit.

TYPE
  Bungee: the wordmark, display lines, buttons. Caps.
  Rubik Wet Paint: one loud headline per layout, caps, line height 0.92,
    lines alternating Cream and a colour. Never the logo.
  Barlow Condensed: body at 15 px or larger; labels in caps, tracked 0.3em.

RULES
  Keep clear space equal to the height of the ball on every side.
  Below 64 px use the symbol, not the logo. Below 32 px the symbol drops
    the palm and the number (favicon.svg and the 16 px favicon already do).
  On Ink or a photograph, use the sticker logo.
  Don't straighten the lean, recolour the words, swap BEACH and BiNGO,
    or dot the i with anything but the ball.
  Beach Bingo is free to play. Never write "win money", "cash" or "jackpot
    payout" next to the logo. Coins are play money.

CREDITS
  Fonts: Bungee (The Bungee Project Authors), Rubik Wet Paint (The Rubik
    Filtered Project Authors), Barlow Condensed (The Barlow Project
    Authors), all SIL Open Font License 1.1.
  Phone frame in the store screenshots: "Google Pixel 10 Pro Free Mockups"
    by BRIX Templates, Figma Community.
`;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
