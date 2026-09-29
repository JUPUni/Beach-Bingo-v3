/* Solana dApp Store screenshots: the app, captured at the Pixel 10 Pro's own
   resolution (scripts/capture-screens.mjs), inside the Pixel 10 Pro frame
   (Obsidian) from BRIX Templates' free Pixel mockups on Figma Community, on
   the Teal ground with a caption, the sea at the foot and the phone's hard
   Ink block shadow. 1080 x 1920: the store wants every image at least 1080 px
   on both sides, one orientation, one aspect ratio. */

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { C } from './palette.mjs';
import { FONTS, textPath } from './type.mjs';
import { f } from './draw.mjs';
import { svgDoc, tag, sparks, foot } from './compose.mjs';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const DEVICE_DIR = fileURLToPath(new URL('../devices/pixel-10-pro/', import.meta.url));
export const DEVICE = JSON.parse(readFileSync(`${DEVICE_DIR}device.json`, 'utf8'));
export const CAPTURES = fileURLToPath(new URL('../screens/captures/', import.meta.url));

/** In store order. `bar` is the status bar's ink: dark icons over a light screen top. */
export const SCREENS = [
  { file: '01-splash', tag: 'Free to play', lines: ['Bingo on', 'the beach.'], bar: 'dark' },
  { file: '02-map', tag: 'Adventure', lines: ['40 levels.', '4 islands.'], bar: 'light' },
  { file: '03-game', tag: 'Boosters', lines: ['Daub fast.', 'Call bingo.'], bar: 'light' },
  { file: '04-room', tag: '75-ball rooms', lines: ['Up to 6 cards', 'a game.'], bar: 'light' },
  { file: '05-pier', tag: '90-ball rooms', lines: ['Line, two lines,', 'full house.'], bar: 'light' },
  { file: '06-fair', tag: 'Provably fair', lines: ['Check every', 'round yourself.'], bar: 'light' },
];

export const capturesReady = () => SCREENS.every((s) => existsSync(`${CAPTURES}${s.file}.jpg`));

/** Android's status bar and gesture handle, drawn over a capture W x H px (412 CSS px wide). */
function systemBars(W, H, bar) {
  const k = W / 412;
  const ink = bar === 'dark' ? C.ink : '#ffffff';
  const s = (v) => f(v * k);
  const time = textPath('9:30', { font: FONTS.bodyBold, size: 17 * k, x: 24 * k, y: 33 * k }).d;
  // Wi-Fi: a fan from its point at the bottom; signal: a right triangle; battery: an upright pill.
  const wx = 336;
  const wy = 33;
  const wr = 14;
  const a0 = (-135 * Math.PI) / 180;
  const a1 = (-45 * Math.PI) / 180;
  const wifi = `M${s(wx)} ${s(wy)}L${s(wx + wr * Math.cos(a0))} ${s(wy + wr * Math.sin(a0))}A${s(wr)} ${s(wr)} 0 0 1 ${s(wx + wr * Math.cos(a1))} ${s(wy + wr * Math.sin(a1))}Z`;
  const signal = `M${s(350)} ${s(33)}H${s(365)}V${s(18)}Z`;
  const battery = `<rect x="${s(375)}" y="${s(17)}" width="${s(10)}" height="${s(17)}" rx="${s(2)}" fill="${ink}"/><rect x="${s(378)}" y="${s(15)}" width="${s(4)}" height="${s(2.5)}" rx="${s(1)}" fill="${ink}"/>`;
  const cssH = H / k;
  const handle = `<rect x="${s(152)}" y="${s(cssH - 9)}" width="${s(108)}" height="${s(4)}" rx="${s(2)}" fill="${ink}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><path d="${time}" fill="${ink}"/><path d="${wifi}" fill="${ink}"/><path d="${signal}" fill="${ink}"/>${battery}${handle}</svg>`;
}

/** The phone at the frame's own size (971 x 2048): capture, system bars, frame, camera. */
async function phone(file, bar) {
  const { width: DW, height: DH, display: D, cameraAt: CAM } = DEVICE;
  const meta = await sharp(file).metadata();
  const screen = await sharp(file)
    .composite([{ input: Buffer.from(systemBars(meta.width, meta.height, bar)) }])
    .png()
    .toBuffer();
  // The frame hides the capture's square corners, so the capture can stay a rectangle.
  const fitted = await sharp(screen).resize(D.width, D.height, { fit: 'cover', position: 'top', kernel: 'lanczos3' }).png().toBuffer();
  return sharp({ create: { width: DW, height: DH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([
      { input: fitted, left: D.x, top: D.y },
      { input: `${DEVICE_DIR}${DEVICE.frame}` },
      { input: `${DEVICE_DIR}${DEVICE.camera}`, left: Math.round(CAM.x), top: Math.round(CAM.y) },
    ])
    .png()
    .toBuffer();
}

const dataUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

/** One store screenshot as an SVG with the phone embedded (rasterise it; don't ship the SVG). */
export async function storeScreenshot(s, { W = 1080, H = 1920 } = {}) {
  const phoneH = 1400;
  const phoneW = Math.round((phoneH * DEVICE.width) / DEVICE.height);
  const px = Math.round((W - phoneW) / 2);
  const py = H - phoneH - 64;
  const ph = await sharp(await phone(`${CAPTURES}${s.file}.jpg`, s.bar)).resize(phoneW, phoneH, { kernel: 'lanczos3' }).png().toBuffer();
  const alpha = await sharp(ph).extractChannel(3).toBuffer();
  const silhouette = await sharp({ create: { width: phoneW, height: phoneH, channels: 3, background: C.ink } }).joinChannel(alpha).png().toBuffer();

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
  const keep = [[0, 0, W, captionBottom + 30], [px - 40, py - 40, phoneW + 110, phoneH + 110]];
  const body = `<rect width="${W}" height="${H}" fill="${C.teal}"/>`
    + sparks(W, H, 7, 101 + s.file.charCodeAt(1), { y0: captionBottom, y1: seaTop - 20, r0: 9, r1: 20, avoid: keep })
    + foot(W, H, seaTop, { u: Math.round(W / 3.4), line: 9 })
    + `<image href="${dataUri(silhouette)}" x="${px + 20}" y="${py + 20}" width="${phoneW}" height="${phoneH}"/>`
    + `<image href="${dataUri(ph)}" x="${px}" y="${py}" width="${phoneW}" height="${phoneH}"/>`
    + t.svg + caption;
  return svgDoc(W, H, body, { title: `Beach Bingo: ${s.lines.join(' ')}` });
}
