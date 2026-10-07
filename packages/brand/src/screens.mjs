/* Solana dApp Store screenshots: the app, captured at the phone's screen shape
   (scripts/capture-screens.mjs), inside the Generic Phone from "Device Mockups
   With Long Shadows" on Figma Community, on the Teal ground with a caption and
   the sea at the foot. The phone is the file's iPhone 14 Pro Max (owner,
   2026-10-07; it was the Generic Phone until then), drawn as vector from
   the component's own geometry and styles (devices/<DEVICE_NAME>/device.json):
   frame and its rim, screen, screen shine, buttons, frame splits, speaker,
   Dynamic Island, its two drop shadows and its long-shadow corners
   (shadows.svg, exported from the file). 1080 x 1920: the store wants every
   image at least 1080 px on both sides, one orientation, one aspect ratio. */

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { C } from './palette.mjs';
import { FONTS, textPath } from './type.mjs';
import { f, nid } from './draw.mjs';
import { svgDoc, tag, sparks, foot } from './compose.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

/** Which device from devices/ frames the screenshots. capture-screens.mjs reads the same name. */
export const DEVICE_NAME = 'iphone-14-pro-max';
const DEVICE_DIR = fileURLToPath(new URL(`../devices/${DEVICE_NAME}/`, import.meta.url));
export const DEVICE = JSON.parse(readFileSync(`${DEVICE_DIR}device.json`, 'utf8'));
export const CAPTURES = fileURLToPath(new URL('../screens/captures/', import.meta.url));

/** In store order. `bar` is the status bar's ink: dark icons over a light screen top. */
export const SCREENS = [
  { file: '01-splash', tag: 'Free to play', lines: ['Bingo on', 'the beach.'], bar: 'dark' },
  { file: '02-map', tag: 'Adventure', lines: ['40 levels.', '4 islands.'], bar: 'light' },
  { file: '03-game', tag: 'Boosters', lines: ['Daub fast.', 'Call bingo.'], bar: 'light' },
  { file: '04-room', tag: '75-ball rooms', lines: ['Up to 4 cards', 'a game.'], bar: 'light' },
  { file: '05-pier', tag: '90-ball rooms', lines: ['Line, two lines,', 'full house.'], bar: 'light' },
  { file: '06-fair', tag: 'Provably fair', lines: ['Check every', 'round yourself.'], bar: 'light' },
];

export const capturesReady = () => SCREENS.every((s) => existsSync(`${CAPTURES}${s.file}.jpg`));

/** The iPhone's status bar (9:41 beside the Dynamic Island, the file's own
    signal, Wi-Fi and battery) and home indicator, over a capture W x H px. */
function iosBars(W, H, bar) {
  const { cssWidth } = DEVICE.capture;
  const k = W / cssWidth;
  const ink = bar === 'dark' ? C.ink : '#ffffff';
  const S = DEVICE.screen;
  const I = DEVICE.statusIcons;
  const time = textPath('9:41', { font: FONTS.bodyBold, size: 18 * k, x: 73 * k, y: 42 * k, anchor: 'middle' }).d;
  const icons = readFileSync(`${DEVICE_DIR}${I.file}`, 'utf8').replace(/white/g, ink)
    .replace(/<svg[^>]*>/, `<svg x="${f((I.x - S.x) * k)}" y="${f((I.y - S.y) * k)}" width="${f(I.width * k)}" height="${f(I.height * k)}" viewBox="0 0 ${I.width} ${I.height}" xmlns="http://www.w3.org/2000/svg">`);
  const cssH = H / k;
  const home = `<rect x="${f((cssWidth / 2 - 67 + 0.5) * k)}" y="${f((cssH - 14) * k)}" width="${f(134 * k)}" height="${f(5 * k)}" rx="${f(2.5 * k)}" fill="${ink}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="${time}" fill="${ink}"/>${icons}${home}</svg>`;
}

/** Android's status bar and gesture handle, drawn over a capture W x H px. */
function androidBars(W, H, bar) {
  const { cssWidth, statusBar } = DEVICE.capture;
  const k = W / cssWidth;
  const ink = bar === 'dark' ? C.ink : '#ffffff';
  const s = (v) => f(v * k);
  const mid = statusBar / 2 + 1; // icons centre on the bar
  const time = textPath('9:30', { font: FONTS.bodyBold, size: 16 * k, x: 22 * k, y: (mid + 5.5) * k }).d;
  const right = cssWidth - 22;
  // Wi-Fi: a fan from its point at the bottom; signal: a right triangle; battery: an upright pill.
  const wx = right - 50;
  const wy = mid + 6.5;
  const wr = 13;
  const a0 = (-135 * Math.PI) / 180;
  const a1 = (-45 * Math.PI) / 180;
  const wifi = `M${s(wx)} ${s(wy)}L${s(wx + wr * Math.cos(a0))} ${s(wy + wr * Math.sin(a0))}A${s(wr)} ${s(wr)} 0 0 1 ${s(wx + wr * Math.cos(a1))} ${s(wy + wr * Math.sin(a1))}Z`;
  const signal = `M${s(right - 31)} ${s(mid + 6.5)}H${s(right - 17)}V${s(mid - 7.5)}Z`;
  const battery = `<rect x="${s(right - 9)}" y="${s(mid - 7.5)}" width="${s(9)}" height="${s(15)}" rx="${s(2)}" fill="${ink}"/><rect x="${s(right - 6.5)}" y="${s(mid - 9.5)}" width="${s(4)}" height="${s(2.5)}" rx="${s(1)}" fill="${ink}"/>`;
  const cssH = H / k;
  const handle = `<rect x="${s((cssWidth - 108) / 2)}" y="${s(cssH - 9)}" width="${s(108)}" height="${s(4)}" rx="${s(2)}" fill="${ink}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="${time}" fill="${ink}"/><path d="${wifi}" fill="${ink}"/><path d="${signal}" fill="${ink}"/>${battery}${handle}</svg>`;
}

const png64 = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
const SHADOWS = `data:image/svg+xml;base64,${readFileSync(`${DEVICE_DIR}${DEVICE.cornerShadows.file}`).toString('base64')}`;

/** The capture with its system bars, sized to the phone's screen at `px` pixels per device unit. */
async function screenImage(file, bar, px) {
  const meta = await sharp(file).metadata();
  const { width, height } = DEVICE.screen;
  // sharp resizes before it composites, so draw the bars first, then resize.
  const bars = DEVICE.os === 'ios' ? iosBars : androidBars;
  const barred = await sharp(file).composite([{ input: Buffer.from(bars(meta.width, meta.height, bar)) }]).png().toBuffer();
  return sharp(barred)
    .resize(Math.round(width * px), Math.round(height * px), { fit: 'cover', position: 'top', kernel: 'lanczos3' })
    .png()
    .toBuffer();
}

/** The device in its own units, the screen showing `screen` (a PNG). */
function phone(screen) {
  const { frame: F, screen: S, dropShadows, cornerShadows: CS, shine, buttons, speaker: SP, splits = [], island: IS } = DEVICE;
  const id = nid('p');
  // CSS box-shadow blur B is a Gaussian of deviation B / 2.
  const drops = dropShadows.map((d, i) => `<filter id="${id}d${i}" filterUnits="userSpaceOnUse" x="-400" y="-400" width="1600" height="2000" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="${d.blur / 2}"/><feOffset dx="${d.dx}" dy="${d.dy}"/><feComponentTransfer><feFuncA type="linear" slope="${d.opacity}"/></feComponentTransfer></filter>`).join('');
  // The CSS gradient line for the shine's angle, across the screen box.
  const a = (shine.angle * Math.PI) / 180;
  const dir = [Math.sin(a), -Math.cos(a)];
  const len = Math.abs(S.width * Math.sin(a)) + Math.abs(S.height * Math.cos(a));
  const cx = S.x + S.width / 2;
  const cy = S.y + S.height / 2;
  const g = { x1: cx - (dir[0] * len) / 2, y1: cy - (dir[1] * len) / 2, x2: cx + (dir[0] * len) / 2, y2: cy + (dir[1] * len) / 2 };
  const stops = shine.stops.map(([o, op]) => `<stop offset="${o}" stop-color="#fff" stop-opacity="${op}"/>`).join('');
  const frameRect = `x="${F.x}" y="${F.y}" width="${F.width}" height="${F.height}" rx="${F.radius}"`;
  const btn = buttons.map((b) => {
    const r = 1.5;
    const d = b.side === 'right'
      ? `M${b.x} ${b.y}H${b.x + b.width - r}Q${b.x + b.width} ${b.y} ${b.x + b.width} ${b.y + r}V${b.y + b.height - r}Q${b.x + b.width} ${b.y + b.height} ${b.x + b.width - r} ${b.y + b.height}H${b.x}Z`
      : `M${b.x + b.width} ${b.y}H${b.x + r}Q${b.x} ${b.y} ${b.x} ${b.y + r}V${b.y + b.height - r}Q${b.x} ${b.y + b.height} ${b.x + r} ${b.y + b.height}H${b.x + b.width}Z`;
    return `<path d="${d}" fill="#000" fill-opacity="0.5"/>`;
  }).join('');
  return `<defs>${drops}<clipPath id="${id}s"><rect x="${S.x}" y="${S.y}" width="${S.width}" height="${S.height}" rx="${S.radius}"/></clipPath><linearGradient id="${id}g" gradientUnits="userSpaceOnUse" x1="${f(g.x1)}" y1="${f(g.y1)}" x2="${f(g.x2)}" y2="${f(g.y2)}">${stops}</linearGradient></defs>`
    + `<image href="${SHADOWS}" x="${CS.x}" y="${CS.y}" width="${CS.width}" height="${CS.height}"/>`
    + dropShadows.map((_, i) => `<rect ${frameRect} fill="#000" filter="url(#${id}d${i})"/>`).join('')
    + `<rect ${frameRect} fill="${F.fill}"/>`
    + `<g clip-path="url(#${id}s)"><image href="${png64(screen)}" x="${S.x}" y="${S.y}" width="${S.width}" height="${S.height}" preserveAspectRatio="none"/>`
    + `<rect x="${S.x}" y="${S.y}" width="${S.width}" height="${S.height}" fill="url(#${id}g)"${shine.opacity != null ? ` opacity="${shine.opacity}"` : ''} style="mix-blend-mode:screen"/></g>`
    // CSS draws the rim inside the frame's box, so the stroke sits half its width in.
    + (F.rim ? `<rect x="${F.x + F.rim.width / 2}" y="${F.y + F.rim.width / 2}" width="${F.width - F.rim.width}" height="${F.height - F.rim.width}" rx="${F.radius - F.rim.width / 2}" fill="none" stroke="${F.rim.color}" stroke-opacity="${F.rim.opacity}" stroke-width="${F.rim.width}"/>` : '')
    + (IS ? `<rect x="${IS.x}" y="${IS.y}" width="${IS.width}" height="${IS.height}" rx="${IS.height / 2}" fill="#000"/>` : '')
    + btn
    + (SP ? `<rect x="${SP.x}" y="${SP.y}" width="${SP.width}" height="${SP.height}" rx="${SP.height / 2}" fill="${SP.fill}" fill-opacity="${SP.opacity}"/>` : '')
    + splits.map((p) => {
      const across = p.width > p.height;
      const a = across ? `x="${p.x}" y="${p.y}" width="${p.width / 4}" height="${p.height}"` : `x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height / 4}"`;
      const b = across ? `x="${p.x + (p.width * 3) / 4}" y="${p.y}" width="${p.width / 4}" height="${p.height}"` : `x="${p.x}" y="${p.y + (p.height * 3) / 4}" width="${p.width}" height="${p.height / 4}"`;
      return `<rect x="${p.x}" y="${p.y}" width="${p.width}" height="${p.height}" fill="${p.fill}"/><rect ${a} fill="#fff" fill-opacity="${p.edge}"/><rect ${b} fill="#fff" fill-opacity="${p.edge}"/>`;
    }).join('');
}

/** One store screenshot as an SVG with the screen embedded (rasterise it; don't ship the SVG). */
export async function storeScreenshot(s, { W = 1080, H = 1920 } = {}) {
  const { frame: F } = DEVICE;
  const frameH = 1400;
  const k = frameH / F.height; // px per device unit
  const fx = Math.round((W - F.width * k) / 2);
  const fy = H - frameH - 64;
  const screen = await screenImage(`${CAPTURES}${s.file}.jpg`, s.bar, k);

  // Caption: the tag bar, then two lines of Bungee caps in Ink (7.7:1 on Teal), sized to fit.
  const margin = 72;
  const widest = Math.max(...s.lines.map((l) => textPath(l.toUpperCase(), { font: FONTS.sign, size: 100 }).width));
  const size = Math.min(92, ((W - 2 * margin) * 100) / widest);
  const top = 92;
  const t = tag(s.tag, { x: W / 2, y: top, size: 30 });
  const first = top + t.h + 30 + size * 0.72;
  const caption = s.lines.map((l, i) => `<path d="${textPath(l.toUpperCase(), { font: FONTS.sign, size, x: W / 2, y: first + i * size * 1.04, anchor: 'middle' }).d}" fill="${C.ink}"/>`).join('');
  const captionBottom = first + (s.lines.length - 1) * size * 1.04 + 20;

  const seaTop = H * 0.8;
  const keep = [[0, 0, W, captionBottom + 30], [fx - 40, fy - 40, F.width * k + 80, frameH + 80], [fx + F.width * k, fy, 520, frameH + 520]];
  const body = `<rect width="${W}" height="${H}" fill="${C.teal}"/>`
    + sparks(W, H, 7, 101 + s.file.charCodeAt(1), { y0: captionBottom, y1: seaTop - 20, r0: 9, r1: 20, avoid: keep })
    + foot(W, H, seaTop, { u: Math.round(W / 3.4), line: 9 })
    + `<g transform="translate(${f(fx - F.x * k)} ${f(fy - F.y * k)}) scale(${f(k)})">${phone(screen)}</g>`
    + t.svg + caption;
  return svgDoc(W, H, body, { title: `Beach Bingo: ${s.lines.join(' ')}` });
}
