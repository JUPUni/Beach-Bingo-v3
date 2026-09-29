/* Layouts: every picture in the kit that is more than the logo on its own.
   They follow the Fete Labs kit's rules: a flat ground, the logo centred, a
   tagline under it, and the brand's one pattern across the foot. For Fete
   Labs that pattern is the three waves out of the test tube; for Beach Bingo
   it is the sea out of the icon, Surf over Deep. No gradients, no glows. */

import { C } from './palette.mjs';
import { COLOR, MASK, halo, logo, stack, wordLine, symbol, appIcon, sea, shell, P, circleD, f, nid, TILE } from './draw.mjs';
import { FONTS, textPath } from './type.mjs';

export const TAGLINE = 'Provably fair island bingo';
export const URL_TXT = 'beachbingo.xyz';
export const ENDORSE = 'A Fete Labs game';
export const HEADLINE = ['Sun up.', 'Cards out.'];

/* Ink bounds of the drawings, measured once by rasterising (build.mjs fills
   these in before anything is laid out). */
export const BOX = {};

export const svgDoc = (w, h, body, { viewBox = `0 0 ${w} ${h}`, title = 'Beach Bingo' } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${f(w)}" height="${f(h)}"><title>${title}</title>${body}</svg>\n`;

/** Put a drawing whose ink box is `box` so that box is centred on (cx,cy) and `w` wide. */
export function place(body, box, cx, cy, w) {
  const s = w / box.w;
  return `<g transform="translate(${f(cx - (box.x + box.w / 2) * s)} ${f(cy - (box.y + box.h / 2) * s)}) scale(${f(s)})">${body}</g>`;
}
export const heightAt = (box, w) => (box.h * w) / box.w;

/* ── pieces of the language ───────────────────────────────────────────── */

/** A Fete Labs tag bar: a solid block, Ink caps in Barlow Condensed. */
export function tag(text, { x, y, size, fill = C.lime, ink = C.ink, anchor = 'middle', font = FONTS.bodyX, tracking = 0.14 }) {
  const t = textPath(text.toUpperCase(), { font, size, tracking, x: 0, y: 0 });
  const padX = size * 0.55;
  const h = size * 1.42;
  const w = t.width + 2 * padX;
  const x0 = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  const svg = `<rect x="${f(x0)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${fill}"/>`
    + `<path d="${textPath(text.toUpperCase(), { font, size, tracking, x: x0 + padX, y: y + h / 2 + size * 0.35 }).d}" fill="${ink}"/>`;
  return { svg, w, h, x0 };
}

/** Spaced caps label (the Fete Labs kicker: Barlow, 0.3em tracking). */
export function label(text, { x, y, size, fill = C.cream, anchor = 'middle', font = FONTS.bodyBold, tracking = 0.3 }) {
  return `<path d="${textPath(text.toUpperCase(), { font, size, tracking, x, y, anchor }).d}" fill="${fill}"/>`;
}

/** A loud two-line headline in Rubik Wet Paint, lines alternating Cream and a colour. */
export function headline(lines, { x, y, size, colours = [C.cream, C.pink], anchor = 'middle', lh = 0.92, outline = C.ink, ow = 0 }) {
  let out = '';
  lines.forEach((ln, i) => {
    const t = textPath(ln.toUpperCase(), { font: FONTS.paint, size, x, y: y + i * size * lh, anchor });
    if (ow) out += `<path d="${t.d}" fill="${outline}" stroke="${outline}" stroke-width="${f(ow)}" stroke-linejoin="round"/>`;
    out += `<path d="${t.d}" fill="${colours[i % colours.length]}"/>`;
  });
  return out;
}

/** Bingo-ball sparks, scattered with a fixed seed so every build is identical. */
export function sparks(W, H, n, seed, { y0 = 0, y1 = H, r0 = 6, r1 = 18, avoid = [] } = {}) {
  let a = seed >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cols = [C.gold, C.pink, C.gold, C.lime, C.cream, C.surf];
  const placed = [];
  let out = '';
  for (let tries = 0; placed.length < n && tries < n * 60; tries += 1) {
    const r = r0 + rnd() * (r1 - r0);
    const x = r + rnd() * (W - 2 * r);
    const y = y0 + r + rnd() * (y1 - y0 - 2 * r);
    const c = cols[Math.floor(rnd() * cols.length)];
    if (avoid.some(([ax, ay, aw, ah]) => x > ax - r && x < ax + aw + r && y > ay - r && y < ay + ah + r)) continue;
    if (placed.some(([px, py, pr]) => Math.hypot(px - x, py - y) < pr + r + r1)) continue;
    placed.push([x, y, r]);
    const line = Math.max(2, r * 0.3);
    out += `<circle cx="${f(x + line)}" cy="${f(y + line)}" r="${f(r + line / 2)}" fill="${C.ink}"/>`
      + `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" fill="${c}" stroke="${C.ink}" stroke-width="${f(line)}"/>`
      + `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r * 0.46)}" fill="${c === C.cream ? C.gold : C.cream}"/>`;
  }
  return out;
}

/** The foot of every layout: the sea from `top` to the bottom edge, full bleed. */
export function foot(W, H, top, { u, line, shellAt = null }) {
  let out = sea(COLOR, { x1: W, y: top, u, line, bottom: H + 2, phase: u * 0.16 });
  if (shellAt) out += shell(COLOR, shellAt * W, top - u * 0.12, Math.min(u * 0.15, H * 0.05), { line: line * 0.6 });
  return out;
}

const GROUND = { teal: C.teal, ink: C.ink, cream: C.cream };

/** The logo for a ground: on Ink it wears the Cream halo, elsewhere its own Ink outline. */
function stackFor(ground) {
  return ground === 'ink' ? { body: stack(halo(20)) + stack(COLOR), box: BOX.stackHalo } : { body: stack(COLOR), box: BOX.stack };
}
function logoFor(ground) {
  return ground === 'ink' ? { body: logo(halo(20)) + logo(COLOR), box: BOX.logoHalo } : { body: logo(COLOR), box: BOX.logo };
}
function lineFor(ground) {
  const wl = wordLine(COLOR);
  return ground === 'ink' ? { body: wordLine(halo(18)).svg + wl.svg, box: BOX.wordHalo } : { body: wl.svg, box: BOX.word };
}

/* ── compositions ─────────────────────────────────────────────────────── */

/** Stack blocks top to bottom, centred in [top, bottom], scaled down together
 *  if they do not fit. Each block: {h, gap (above it), draw(y, k)}; k is the scale. */
function column(blocks, top, bottom) {
  const total = (k) => blocks.reduce((a, b, i) => a + b.h * k + (i ? b.gap * k : 0), 0);
  const k = Math.min(1, (bottom - top) / total(1));
  let y = top + (bottom - top - total(k)) / 2;
  return blocks.map((b, i) => {
    if (i) y += b.gap * k;
    const out = b.draw(y, k);
    y += b.h * k;
    return out;
  }).join('');
}

// Rubik Wet Paint: caps are 0.7 em; the drips hang 0.24 em below the baseline.
const HEAD_CAP = 0.7;
const HEAD_DRIP = 0.24;
const HEAD_LH = 0.92;
const headH = (hs) => hs * (HEAD_CAP + HEAD_LH + HEAD_DRIP);

/** Landscape card: the stacked logo over the sea, the tagline as a tag bar,
 *  the address top right. */
export function card(W, H, { ground = 'teal', lockW = 0.44, band = 0.2, url = true, seed = 11, tagline = TAGLINE } = {}) {
  const bg = GROUND[ground];
  const L = stackFor(ground);
  const top = H * (1 - band);
  const m = H * 0.07;
  const lw = W * lockW;
  const lh = heightAt(L.box, lw);
  const size = Math.round(Math.min(W, H * 1.9) * 0.026);
  let keep = [];
  const body = column([
    { h: lh, gap: 0, draw: (y, k) => { keep.push([W / 2 - (lw * k) / 2 - 30, y - 30, lw * k + 60, lh * k + 60]); return place(L.body, L.box, W / 2, y + (lh * k) / 2, lw * k); } },
    { h: size * 1.42, gap: size * 1.1, draw: (y, k) => { const t = tag(tagline, { x: W / 2, y, size: size * k }); keep.push([t.x0 - 20, y - 20, t.w + 40, t.h + 40]); return t.svg; } },
  ], m, top - m * 0.9);
  const us = size * 0.9;
  const u2 = url ? label(URL_TXT, { x: W - m * 1.1, y: m + us * 0.7, size: us, anchor: 'end', fill: ground === 'cream' ? C.ink : C.cream }) : '';
  if (url) keep.push([W * 0.55, 0, W * 0.45, m + us * 1.4]);
  const spark = sparks(W, H, 9, seed, { y1: top - 30, r0: W / 170, r1: W / 70, avoid: keep });
  return svgDoc(W, H, `<rect width="${W}" height="${H}" fill="${bg}"/>${spark}${foot(W, H, top, { u: Math.round(W / 6.5), line: Math.max(4, W / 170), shellAt: 0.84 })}${body}${u2}`);
}

/** Portrait, square and story: a loud headline, the logo, the tag, the address,
 *  and the sea at the foot. */
export function poster(W, H, { ground = 'teal', lockW = 0.72, band = 0.16, head = true, seed = 5, tagline = TAGLINE } = {}) {
  const bg = GROUND[ground];
  const L = logoFor(ground);
  const top = H * (1 - band);
  const m = W * 0.08;
  const lw = W * lockW;
  const lh = heightAt(L.box, lw);
  const size = Math.round(W * 0.036);
  const hs = W * 0.15;
  const keep = [];
  const blocks = [];
  if (head) {
    blocks.push({ h: headH(hs), gap: 0, draw: (y, k) => {
      keep.push([W * 0.06, y - 20, W * 0.88, headH(hs) * k + 40]);
      return headline(HEADLINE, { x: W / 2, y: y + hs * k * HEAD_CAP, size: hs * k, lh: HEAD_LH, colours: [C.cream, ground === 'cream' ? C.pink : C.gold], ow: ground === 'cream' ? hs * k * 0.08 : 0 });
    } });
  }
  blocks.push({ h: lh, gap: head ? hs * 0.4 : 0, draw: (y, k) => { keep.push([W / 2 - (lw * k) / 2 - 30, y - 30, lw * k + 60, lh * k + 60]); return place(L.body, L.box, W / 2, y + (lh * k) / 2, lw * k); } });
  blocks.push({ h: size * 1.42, gap: size * 1.3, draw: (y, k) => { const t = tag(tagline, { x: W / 2, y, size: size * k }); keep.push([t.x0 - 20, y - 20, t.w + 40, t.h + 40]); return t.svg; } });
  blocks.push({ h: size * 0.9 * 0.72, gap: size * 1.3, draw: (y, k) => { keep.push([W * 0.25, y - 20, W * 0.5, size * 1.2 * k + 40]); return label(URL_TXT, { x: W / 2, y: y + size * 0.9 * 0.72 * k, size: size * 0.9 * k, fill: ground === 'cream' ? C.ink : C.cream }); } });
  const body = column(blocks, m * 1.1, top - m * 0.7);
  const spark = sparks(W, H, 8, seed, { y1: top - 40, r0: W / 110, r1: W / 48, avoid: keep });
  return svgDoc(W, H, `<rect width="${W}" height="${H}" fill="${bg}"/>${spark}${body}${foot(W, H, top, { u: Math.round(W / 3.6), line: Math.max(6, W / 110), shellAt: 0.84 })}`);
}

/** Wide header (X): the one-line wordmark, kept in the middle band because
 *  phones crop the top and bottom, and the avatar covers the lower left. */
export function banner(W, H, { lockX = 0.56, lockW = 0.54, seed = 7 } = {}) {
  const L = lineFor('teal');
  const top = H * 0.76;
  const cx = W * lockX;
  const lw = W * lockW;
  const lh = heightAt(L.box, lw);
  const size = Math.round(lh * 0.28);
  const keep = [];
  const body = column([
    { h: lh, gap: 0, draw: (y, k) => { keep.push([cx - (lw * k) / 2 - 30, y - 30, lw * k + 60, lh * k + 60]); return place(L.body, L.box, cx, y + (lh * k) / 2, lw * k); } },
    { h: size * 1.42, gap: size * 0.9, draw: (y, k) => { const t = tag(TAGLINE, { x: cx, y, size: size * k }); keep.push([t.x0 - 20, y - 20, t.w + 40, t.h + 40]); return t.svg; } },
  ], H * 0.14, top - H * 0.08);
  return svgDoc(W, H, `<rect width="${W}" height="${H}" fill="${C.teal}"/>${sparks(W, H, 14, seed, { y0: 16, y1: top - 20, r0: W / 300, r1: W / 120, avoid: keep })}${foot(W, H, top, { u: Math.round(W / 8), line: Math.max(4, W / 260), shellAt: 0.9 })}${body}`);
}

/** dApp Store banner, 1200 x 600: the logo on the left, the pitch on the right. */
export function storeBanner(W = 1200, H = 600) {
  const L = stackFor('teal');
  const top = H * 0.8;
  const lw = W * 0.44;
  const lh = heightAt(L.box, lw);
  const cx = W * 0.29;
  const cy = top * 0.5;
  const rx = W * 0.555;
  const widest = Math.max(...HEADLINE.map((ln) => textPath(ln.toUpperCase(), { font: FONTS.paint, size: 100 }).width));
  const hs = Math.min(W * 0.075, ((W - rx - W * 0.05) * 100) / widest);
  const size = Math.round(W * 0.022);
  const keep = [[cx - lw / 2 - 20, cy - lh / 2 - 20, lw + 40, lh + 40]];
  const right = column([
    { h: headH(hs), gap: 0, draw: (y, k) => headline(HEADLINE, { x: rx, y: y + hs * k * HEAD_CAP, size: hs * k, lh: HEAD_LH, colours: [C.cream, C.gold], anchor: 'start' }) },
    { h: size * 1.42, gap: size * 1.1, draw: (y, k) => tag(TAGLINE, { x: rx, y, size: size * k, anchor: 'start' }).svg },
    { h: size * 1.42, gap: size * 0.55, draw: (y, k) => tag('Free to play · Built for Seeker', { x: rx, y, size: size * k, fill: C.surf, anchor: 'start' }).svg },
  ], H * 0.1, top - H * 0.08);
  keep.push([rx - 20, H * 0.06, W - rx, top - H * 0.1]);
  return svgDoc(W, H, `<rect width="${W}" height="${H}" fill="${C.teal}"/>${sparks(W, H, 7, 23, { y1: top - 24, r0: 7, r1: 15, avoid: keep })}${foot(W, H, top, { u: 190, line: 7, shellAt: 0.9 })}${place(L.body, L.box, cx, cy, lw)}${right}`);
}

/** dApp Store feature graphic, 1200 x 1200 (the Editor's Choice carousel). */
export function storeFeature(W = 1200) {
  return poster(W, W, { lockW: 0.66, band: 0.15, seed: 31 });
}

/** Square avatar. Everything that matters sits inside the centre circle, so a
 *  round crop never clips it. `kind` symbol: the ball over the sea; logo: the
 *  stacked logo on Teal. */
export function pfp(kind = 'symbol', { W = 1080, ground = 'teal' } = {}) {
  if (kind === 'symbol') {
    return svgDoc(W, W, `<g transform="scale(${f(W / TILE)})">${symbol(COLOR, { square: true, ground: GROUND[ground] })}</g>`);
  }
  const L = stackFor('teal');
  const top = W * 0.74;
  return svgDoc(W, W, `<rect width="${W}" height="${W}" fill="${C.teal}"/>${foot(W, W, top, { u: W / 3.4, line: W / 110 })}${place(L.body, L.box, W / 2, W * 0.45, W * 0.64)}`);
}

/** Instagram highlight cover: one colour on a colour, the symbol's line work. */
export function highlight(bg, ink) {
  const id = nid('h');
  const W = 1080;
  const H = 1920;
  const s = 720 / TILE;
  const x = (W - 720) / 2;
  const y = (H - 720) / 2;
  return svgDoc(W, H, `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><g transform="translate(${f(x)} ${f(y)}) scale(${f(s)})">${symbol(MASK, { square: true, palmOn: false })}</g></mask></defs><rect width="${W}" height="${H}" fill="${bg}"/><g mask="url(#${id})"><rect width="${W}" height="${H}" fill="${ink}"/></g>`);
}

/** WhatsApp sticker, 512 x 512 with a 16 px margin, a Cream outline so it
 *  reads on light and dark chats. */
export function sticker(kind) {
  const W = 512;
  if (kind === 'logo') return svgDoc(W, W, place(logo(halo(22)) + logo(COLOR), BOX.logoHalo22, 256, 256, 472));
  if (kind === 'symbol') return svgDoc(W, W, `<rect x="16" y="16" width="480" height="480" rx="${f(480 * 0.23)}" fill="${C.cream}"/><g transform="translate(30 30) scale(${f(452 / TILE)})">${symbol(COLOR)}</g>`);
  if (kind === 'ball') {
    return svgDoc(W, W, `<circle cx="256" cy="256" r="236" fill="${C.cream}"/><circle cx="268" cy="268" r="208" fill="${C.ink}"/><circle cx="252" cy="252" r="196" fill="${C.gold}" stroke="${C.ink}" stroke-width="22"/><circle cx="252" cy="252" r="114" fill="${C.cream}"/><path d="${textPath('1', { font: FONTS.sign, size: 190, x: 252, y: 252 + 67, anchor: 'middle' }).d}" fill="${C.ink}"/>`);
  }
  return svgDoc(W, W, `<rect x="16" y="16" width="480" height="480" rx="${f(480 * 0.23)}" fill="${C.cream}"/><g transform="translate(30 30) scale(${f(452 / TILE)})">${appIcon(COLOR)}</g>`);
}

/** The link card every page shares (og:image), 1200 x 630. */
export const og = () => card(1200, 630, { lockW: 0.44, band: 0.2 });
