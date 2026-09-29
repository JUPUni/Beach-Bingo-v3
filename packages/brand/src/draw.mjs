/* The Beach Bingo logo, drawn in code. One drawing feeds every file in the kit,
   the app icons and the store art, so a change here reaches all of them.

   The idea is the original icon's: a palm, BEACH stacked on BiNGO, a bingo ball
   dotting the i, the sea underneath with a shell on it, all on a teal tile.
   The language is Fete Labs': flat fills from the Fete Labs palette, Bungee
   (the Fete Labs sign face), one Ink outline around everything and a hard Ink
   block shadow, no gradients and no blur. It leans -4 degrees, the way the Fete
   Labs test tube leans. */

import { C } from './palette.mjs';
import { FONTS, STEM, glyphD, layout, textPath } from './type.mjs';

export const f = (v) => +(+v).toFixed(2);

/* ── paint modes ──────────────────────────────────────────────────────────
   color  the drawing.
   mask   Ink becomes white and every other fill black. Inside a <mask> that
          gives the one-colour logo: the line work stays, the fills drop out.
   halo   every shape in one colour, fattened by `w` on each side: the sticker
          outline that goes under the drawing on dark or busy grounds. */

export const COLOR = { mode: 'color' };
export const MASK = { mode: 'mask' };
export const halo = (w, colour = C.cream) => ({ mode: 'halo', w, colour });

function paint(K, c) {
  if (c === 'none' || c == null) return c;
  if (K.mode === 'mask') return c === C.ink ? '#fff' : '#000';
  if (K.mode === 'halo') return K.colour;
  return c;
}

/** One shape, painted for the mode. */
export function P(K, d, { fill = 'none', stroke = null, sw = 0, t = '', cap = 'round' } = {}) {
  let F = paint(K, fill);
  let S = stroke ? paint(K, stroke) : null;
  let W = sw;
  if (K.mode === 'halo') {
    S = K.colour;
    W = (stroke ? sw : 0) + 2 * K.w;
  }
  const tr = t ? ` transform="${t}"` : '';
  const st = S ? ` stroke="${S}" stroke-width="${f(W)}" stroke-linejoin="round" stroke-linecap="${cap}"` : '';
  return `<path d="${d}"${tr} fill="${F}"${st}/>`;
}

export const circleD = (cx, cy, r) =>
  `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;

let uid = 0;
/** Ids must be unique across a whole HTML page that inlines many SVGs. */
export const nid = (p) => `bb${p}${(uid += 1)}`;

/* ── the words ────────────────────────────────────────────────────────────
   Bungee caps. A lowercase i is cut from Bungee's plain-stem I: x-height tall,
   with the bingo ball for its dot, as in the original icon. */

export const XH = 0.47; // the i's stem, in em
export const LINE = 0.9; // BEACH baseline to BiNGO baseline, in em

export function word(str, { size, x = 0, y = 0, anchor = 'start' }) {
  const font = FONTS.sign;
  const s = size / font.unitsPerEm;
  const glyphs = [...str].map((ch) => (ch === 'i' ? STEM : font.charToGlyph(ch)));
  const { pos, width } = layout(glyphs, font, size);
  const x0 = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x;
  let d = '';
  let patch = '';
  let dot = null;
  glyphs.forEach((g, i) => {
    const gx = x0 + pos[i];
    if (str[i] === 'C') {
      // The C's mouth is wider than the outline can bridge; fill it in the backing only.
      patch += `M${f(gx + 286 * s)} ${f(y - 527 * s)}H${f(gx + 584 * s)}V${f(y - 191 * s)}H${f(gx + 286 * s)}Z`;
    }
    if (str[i] !== 'i') {
      d += glyphD(g, gx, y, size);
      return;
    }
    const bb = g.getBoundingBox();
    const cx = gx + ((bb.x1 + bb.x2) / 2) * s;
    const w = 212 * s;
    const h = XH * size;
    const r = 18 * s;
    const L = cx - w / 2;
    const R = cx + w / 2;
    d += `M${f(L + r)} ${f(y)}H${f(R - r)}Q${f(R)} ${f(y)} ${f(R)} ${f(y - r)}V${f(y - h + r)}Q${f(R)} ${f(y - h)} ${f(R - r)} ${f(y - h)}H${f(L + r)}Q${f(L)} ${f(y - h)} ${f(L)} ${f(y - h + r)}V${f(y - r)}Q${f(L)} ${f(y)} ${f(L + r)} ${f(y)}Z`;
    dot = { cx, stemTop: y - h };
  });
  return { d, patch, dot, width, x0, capTop: y - 0.72 * size };
}

/** Sign-painted letters: one Ink backing under every item (so the gaps between
 *  letters close into one outline), a hard Ink block shadow down and right,
 *  then the faces. `items` are {d, fill, patch?}; a patch goes in the backing only. */
export function signLetters(K, items, { S, back = 0.26, depth = 0.075 }) {
  const all = items.map((i) => i.d + (i.patch || '')).join('');
  const bw = S * back;
  const dp = S * depth;
  let out = '';
  for (const k of [1, 2 / 3, 1 / 3]) out += P(K, all, { fill: C.ink, stroke: C.ink, sw: bw, t: `translate(${f(dp * k)} ${f(dp * k)})` });
  out += P(K, all, { fill: C.ink, stroke: C.ink, sw: bw });
  for (const i of items) out += P(K, i.d, { fill: i.fill });
  return out;
}

/* ── the ball ─────────────────────────────────────────────────────────── */

export function ball(K, { cx, cy, r }, { line, num = '1', shadow = 0 }) {
  let out = '';
  if (shadow) out += P(K, circleD(cx + shadow, cy + shadow, r + line / 2), { fill: C.ink });
  out += P(K, circleD(cx, cy, r), { fill: C.gold, stroke: C.ink, sw: line });
  out += P(K, circleD(cx, cy, r * 0.58), { fill: C.cream });
  if (num) out += P(K, textPath(num, { font: FONTS.sign, size: r * 0.95, x: cx, y: cy + r * 0.34, anchor: 'middle' }).d, { fill: C.ink });
  return out;
}

/* ── the palm ─────────────────────────────────────────────────────────── */

const qb = (P0, P1, P2, t) => [
  (1 - t) ** 2 * P0[0] + 2 * (1 - t) * t * P1[0] + t * t * P2[0],
  (1 - t) ** 2 * P0[1] + 2 * (1 - t) * t * P1[1] + t * t * P2[1],
];
const qd = (P0, P1, P2, t) => {
  const dx = 2 * (1 - t) * (P1[0] - P0[0]) + 2 * t * (P2[0] - P1[0]);
  const dy = 2 * (1 - t) * (P1[1] - P0[1]) + 2 * t * (P2[1] - P1[1]);
  const m = Math.hypot(dx, dy);
  return [dx / m, dy / m];
};

/** One frond pointing +x from the crown, length 1: it lifts, then droops, and
 *  its lower edge has one or two cuts. */
function frond({ lift = 0.2, droop = 0.18, width = 0.26, cuts = [0.5], cut = 0.62 }) {
  const P0 = [0, 0];
  const P1 = [0.45, -lift * 2];
  const P2 = [1, droop];
  const up = [];
  const dn = [];
  const wU = (t) => width * 0.32 * Math.sin(Math.PI * t) ** 0.9;
  const wD = (t) => width * Math.sin(Math.PI * Math.min(0.999, t)) ** 0.62 * (1 - 0.35 * t);
  const N = 40;
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    const [x, y] = qb(P0, P1, P2, t);
    const [dx, dy] = qd(P0, P1, P2, t);
    up.push([x + dy * wU(t), y - dx * wU(t)]);
    let w = wD(t);
    for (const c of cuts) {
      const u = (t - c) / 0.07;
      if (u > -1 && u < 0.35) w *= u < 0 ? 1 - cut * (1 + u) : 1 - cut * (1 - u / 0.35);
    }
    dn.push([x - dy * w, y + dx * w]);
  }
  const rib = [];
  for (let i = 2; i <= 15; i += 1) rib.push(qb(P0, P1, P2, i / 20));
  return { outline: [...up, ...dn.reverse()], rib };
}

// Upright fronds go behind, the two drooping ones in front.
const BACK = [
  [-104, 0.74, { lift: 0.1, droop: 0.08, width: 0.24, cuts: [0.55] }],
  [-74, 0.76, { lift: 0.1, droop: 0.1, width: 0.24, cuts: [0.55] }],
  [-140, 0.98, { lift: 0.2, droop: 0.2 }],
  [-40, 0.98, { lift: 0.2, droop: 0.2 }],
];
const FRONT = [
  [-174, 0.96, { lift: 0.12, droop: 0.36, cuts: [0.45, 0.7] }],
  [-6, 0.96, { lift: 0.12, droop: 0.36, cuts: [0.45, 0.7] }],
];

function crown(cx, cy, s, fronds) {
  let d = '';
  let ribs = '';
  const pts = [];
  for (const [ang, len, opts] of fronds) {
    const left = Math.abs((((ang % 360) + 360) % 360) - 180) < 90;
    const a = ((left ? 180 - ang : ang) * Math.PI) / 180;
    const T = ([x, y]) => {
      const X = x * len * s;
      const Y = y * len * s;
      const rx = X * Math.cos(a) - Y * Math.sin(a);
      const ry = X * Math.sin(a) + Y * Math.cos(a);
      return [cx + (left ? -rx : rx), cy + ry];
    };
    const fr = frond(opts);
    const o = fr.outline.map(T);
    pts.push(...o);
    d += `M${o.map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`;
    ribs += `M${fr.rib.map(T).map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}`;
  }
  return { d, ribs, pts };
}

/** A trunk from the crown down to (bx,by): curved, wider at the foot, ringed. */
function trunk(cx, cy, bx, by, w0, w1, bend, rings) {
  const P0 = [cx, cy];
  const P2 = [bx, by];
  const P1 = [(cx + bx) / 2 + bend, (cy + by) / 2];
  const L = [];
  const R = [];
  for (let i = 0; i <= 20; i += 1) {
    const t = i / 20;
    const [x, y] = qb(P0, P1, P2, t);
    const [dx, dy] = qd(P0, P1, P2, t);
    const w = (w0 + (w1 - w0) * t) / 2;
    L.push([x - dy * w, y + dx * w]);
    R.push([x + dy * w, y - dx * w]);
  }
  let ring = '';
  for (let k = 1; k <= rings; k += 1) {
    const t = k / (rings + 1);
    const [x, y] = qb(P0, P1, P2, t);
    const [dx, dy] = qd(P0, P1, P2, t);
    const w = (w0 + (w1 - w0) * t) / 2;
    ring += `M${f(x - dy * w)} ${f(y + dx * w)}Q${f(x + dx * w * 0.35)} ${f(y + dy * w * 0.35)} ${f(x + dy * w)} ${f(y - dx * w)}`;
  }
  return { body: `M${[...L, ...R.reverse()].map(([x, y]) => `${f(x)} ${f(y)}`).join('L')}Z`, ring };
}

/** The palm: crown at (cx,cy), fronds about `size` long. */
export function palm(K, cx, cy, size, { line, trunkTo = null, nuts = true }) {
  let out = '';
  if (trunkTo) {
    const tr = trunk(cx, cy + 4, trunkTo[0], trunkTo[1], size * 0.13, size * 0.19, -size * 0.21, 3);
    out += P(K, tr.body, { fill: C.coconut, stroke: C.ink, sw: line });
    out += P(K, tr.ring, { stroke: C.ink, sw: line * 0.7 });
  }
  for (const set of [BACK, FRONT]) {
    const cr = crown(cx, cy, size, set);
    out += P(K, cr.d, { fill: C.lime, stroke: C.ink, sw: line });
    out += P(K, cr.ribs, { stroke: C.ink, sw: line * 0.6 });
  }
  if (nuts) {
    const r = size * 0.079;
    for (const [dx, dy] of [[-0.074, 0.063], [0.074, 0.063], [0, 0.126]]) {
      out += P(K, circleD(cx + dx * size, cy + dy * size, r), { fill: C.coconut, stroke: C.ink, sw: line * 0.8 });
    }
  }
  return out;
}

/* ── the sea ──────────────────────────────────────────────────────────── */

function wave(x0, x1, y, u, a, bottom, phase) {
  let x = x0 - u + (((phase % u) + u) % u);
  const start = x;
  let d = `M${f(x)} ${f(y)}`;
  for (; x < x1 + u; x += u) d += `q${f(u / 4)} ${f(-a)} ${f(u / 2)} 0t${f(u / 2)} 0`;
  return { fill: `${d}V${f(bottom)}H${f(start)}Z`, line: d };
}

/** Two waves, Surf over Deep, each crest drawn in Ink. u is one wavelength. */
export function sea(K, { x0 = 0, x1, y, u, line, bottom, phase = 0 }) {
  const a = wave(x0, x1, y, u, u * 0.15, bottom, phase);
  const b = wave(x0, x1, y + u * 0.27, u, u * 0.135, bottom, phase + u / 2);
  return P(K, a.fill, { fill: C.surf }) + P(K, b.fill, { fill: C.deep })
    + P(K, b.line, { stroke: C.ink, sw: line }) + P(K, a.line, { stroke: C.ink, sw: line });
}

/** A scallop shell standing on its hinge at (cx, cy + 0.72r). */
export function shell(K, cx, cy, r, { line, fill = C.pink }) {
  const n = 6;
  let d = '';
  for (let i = 0; i <= n; i += 1) {
    const a = Math.PI + (i / n) * Math.PI;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r + (i === 0 || i === n ? r * 0.05 : 0);
    if (i === 0) d += `M${f(cx - r * 0.18)} ${f(cy + r * 0.5)}L${f(x)} ${f(y)}`;
    else {
      const am = Math.PI + ((i - 0.5) / n) * Math.PI;
      d += `Q${f(cx + Math.cos(am) * r * 1.2)} ${f(cy + Math.sin(am) * r * 1.2)} ${f(x)} ${f(y)}`;
    }
  }
  d += `L${f(cx + r * 0.18)} ${f(cy + r * 0.5)}Z`;
  const ear = `M${f(cx - r * 0.42)} ${f(cy + r * 0.28)}L${f(cx - r * 0.18)} ${f(cy + r * 0.5)}L${f(cx - r * 0.06)} ${f(cy + r * 0.72)}H${f(cx + r * 0.06)}L${f(cx + r * 0.18)} ${f(cy + r * 0.5)}L${f(cx + r * 0.42)} ${f(cy + r * 0.28)}Z`;
  let ribs = '';
  for (let i = 1; i < n; i += 1) {
    const a = Math.PI + (i / n) * Math.PI;
    ribs += `M${f(cx)} ${f(cy + r * 0.45)}L${f(cx + Math.cos(a) * r * 0.78)} ${f(cy + Math.sin(a) * r * 0.78)}`;
  }
  return P(K, ear, { fill, stroke: C.ink, sw: line }) + P(K, d, { fill, stroke: C.ink, sw: line }) + P(K, ribs, { stroke: C.ink, sw: line * 0.7 });
}

/* ── the stacked logo ─────────────────────────────────────────────────────
   Drawn at type size S about the origin: BEACH's baseline is y=0, centred on
   x=0; BiNGO sits LINE em below. The palm grows from behind the B. The whole
   thing leans `tilt` degrees about the middle of the two words. */

export const TILT = -4;
export const BALL_R = 0.16;

export function words(S) {
  const beach = word('BEACH', { size: S, x: 0, y: 0, anchor: 'middle' });
  const bingo = word('BiNGO', { size: S, x: 0, y: S * LINE, anchor: 'middle' });
  const r = BALL_R * S;
  const dot = { cx: bingo.dot.cx, cy: bingo.dot.stemTop - 0.06 * S - r, r };
  return { beach, bingo, dot };
}

export function stack(K, { S = 200, tilt = TILT, palmOn = true, num = '1' } = {}) {
  const { beach, bingo, dot } = words(S);
  let out = '';
  if (palmOn) {
    const px = beach.x0 + S * 0.72;
    const py = beach.capTop - S * 0.24;
    out += palm(K, px, py, S * 0.95, { line: S * 0.055, trunkTo: [px + S * 0.14, 0] });
  }
  out += signLetters(K, [{ d: beach.d, patch: beach.patch, fill: C.pink }, { d: bingo.d, patch: bingo.patch, fill: C.cream }, { d: circleD(dot.cx, dot.cy, dot.r), fill: C.gold }], { S });
  out += ball(K, dot, { line: S * 0.045, num });
  return `<g transform="rotate(${tilt} 0 ${f(S * 0.2)})">${out}</g>`;
}

/** One line: BEACH BiNGO, upright, for headers and small spaces. Origin at the
 *  left end of the baseline. */
export function wordLine(K, { S = 200, gap = 0.34 } = {}) {
  const beach = word('BEACH', { size: S, x: 0, y: 0 });
  const bingo = word('BiNGO', { size: S, x: beach.width + gap * S, y: 0 });
  const r = BALL_R * S;
  const dot = { cx: bingo.dot.cx, cy: bingo.dot.stemTop - 0.06 * S - r, r };
  const out = signLetters(K, [{ d: beach.d, patch: beach.patch, fill: C.pink }, { d: bingo.d, patch: bingo.patch, fill: C.cream }, { d: circleD(dot.cx, dot.cy, dot.r), fill: C.gold }], { S })
    + ball(K, dot, { line: S * 0.045 });
  return { svg: out, width: bingo.x0 + bingo.width };
}

/* ── tiles ────────────────────────────────────────────────────────────────
   Both on a 1024 tile. The corner is Fete Labs' app-icon corner (46 of 200). */

export const TILE = 1024;
export const CORNER = 236;

/** The app icon: the stacked logo on Teal over the sea, a shell on the swell. */
export function appIcon(K = COLOR, { square = false, sea: seaOn = true, clip = true } = {}) {
  const W = TILE;
  const S = 222;
  const id = nid('t');
  const sy = 800;
  let body = P(K, `M0 0H${W}V${W}H0Z`, { fill: C.teal });
  if (seaOn) {
    body += sea(K, { x1: W, y: sy, u: 256, line: 22, bottom: W, phase: 40 });
    body += shell(K, 796, sy - 40, 56, { line: 14 });
  }
  body += `<g transform="translate(512 474)">${stack(K, { S })}</g>`;
  if (!clip || square) return body;
  return `<defs><clipPath id="${id}"><rect width="${W}" height="${W}" rx="${CORNER}"/></clipPath></defs><g clip-path="url(#${id})">${body}</g>`;
}

/** The symbol: the ball coming up out of the sea, the palm leaning in. It
 *  stands in for the logo below 64 px, and as the avatar. */
export function symbol(K = COLOR, { square = false, palmOn = true, ground = C.teal, num = '1' } = {}) {
  const W = TILE;
  const line = 26;
  const r = 236;
  const cx = 512;
  const cy = 540;
  const id = nid('s');
  let body = P(K, `M0 0H${W}V${W}H0Z`, { fill: ground });
  if (palmOn) body += palm(K, 232, 236, 285, { line: 17 });
  body += ball(K, { cx, cy, r }, { line, shadow: 22, num });
  body += sea(K, { x1: W, y: 704, u: 340, line, bottom: W, phase: 170 });
  if (square) return body;
  return `<defs><clipPath id="${id}"><rect width="${W}" height="${W}" rx="${CORNER}"/></clipPath></defs><g clip-path="url(#${id})">${body}</g>`;
}

/* ── the free-standing logo ───────────────────────────────────────────────
   The stacked logo with the sea under it, as a band the width of the words,
   and the shell standing on the band. This is the primary logo. It carries
   its own Ink outline, so it holds on Teal, Cream, white and photographs; on
   Ink, use the sticker version (a Cream halo round the whole silhouette). */

/** The band's geometry at type size S, in the logo's (untilted) space. */
export function bandBox(S) {
  const { beach, bingo } = words(S);
  const w = Math.max(beach.width, bingo.width) + S * 0.12;
  return { x0: -w / 2, y0: S * LINE + S * 0.21, w, h: S * 0.5 };
}

export function logo(K = COLOR, { S = 200, tilt = TILT, band = true } = {}) {
  let back = '';
  let front = '';
  if (band) {
    const { x0, y0, w, h } = bandBox(S);
    const rr = h / 2;
    const pill = `M${f(x0 + rr)} ${f(y0)}H${f(x0 + w - rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x0 + w - rr)} ${f(y0 + h)}H${f(x0 + rr)}A${f(rr)} ${f(rr)} 0 0 1 ${f(x0 + rr)} ${f(y0)}Z`;
    const bw = S * 0.26;
    const dp = S * 0.075;
    for (const k of [1, 2 / 3, 1 / 3]) back += P(K, pill, { fill: C.ink, stroke: C.ink, sw: bw, t: `translate(${f(dp * k)} ${f(dp * k)})` });
    back += P(K, pill, { fill: C.ink, stroke: C.ink, sw: bw });
    if (K.mode !== 'halo') {
      const id = nid('b');
      const u = S * 0.92;
      let d = `M${f(x0 - u * 0.3)} ${f(y0 + h * 0.5)}`;
      for (let x = x0 - u * 0.3; x < x0 + w + u; x += u) d += `q${f(u / 4)} ${f(-S * 0.1)} ${f(u / 2)} 0t${f(u / 2)} 0`;
      back += `<defs><clipPath id="${id}"><path d="${pill}"/></clipPath></defs><g clip-path="url(#${id})">`
        + P(K, pill, { fill: C.surf })
        + P(K, `${d}V${f(y0 + h + S)}H${f(x0 - u * 0.3)}Z`, { fill: C.deep })
        + P(K, d, { stroke: C.ink, sw: S * 0.06 })
        + '</g>';
    }
    back += shell(K, x0 + w - S * 0.36, y0 + h * 0.4, S * 0.17, { line: S * 0.045 });
  }
  return `<g transform="rotate(${tilt} 0 ${f(S * 0.2)})">${back}${stack(K, { S, tilt: 0 })}${front}</g>`;
}
