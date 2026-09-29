#!/usr/bin/env node
// Safe-area sweep for the landing page. Serve public/ first, then:
//
//   node scripts/serve.mjs &                       # public/ on :8787, with vercel.json's rewrite
//   CHROME_PATH=<chromium> node scripts/safe-areas.mjs [url] [--control]
//
// Needs a Chromium with Emulation.setSafeAreaInsetsOverride (Chrome 141+).
//
// Every iPhone size with its UIKit
// insets (the iOS Safe Area Guide) and the Android compact / medium / expanded
// frames, upright and sideways. Chromium's Emulation.setSafeAreaInsetsOverride
// sets env(safe-area-inset-*); the page must keep every text line and every
// control out of the inset bands. Sides count anywhere on the page; the top at
// rest, the bottom at the end of the page. A control run neutralises the insets
// in the stylesheet and must fail, or the sweep is measuring nothing.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../packages/brand/package.json', import.meta.url));
const { chromium } = require('playwright-core');
const BASE = process.argv[2] || 'http://127.0.0.1:8787/';
const CONTROL = process.argv.includes('--control');

// [name, width, height, upright {top,bottom}, sideways {left,right,bottom}]
const DEVICES = [
  ['iPhone SE', 375, 667, { t: 20, b: 0 }, { l: 0, r: 0, b: 0 }],
  ['iPhone X/XS/11 Pro', 375, 812, { t: 44, b: 34 }, { l: 44, r: 44, b: 21 }],
  ['iPhone 12/13 mini', 375, 812, { t: 50, b: 34 }, { l: 50, r: 50, b: 21 }],
  ['iPhone XR/11', 414, 896, { t: 48, b: 34 }, { l: 48, r: 48, b: 21 }],
  ['iPhone 12-14, 16e', 390, 844, { t: 47, b: 34 }, { l: 47, r: 47, b: 21 }],
  ['iPhone 14 Plus', 428, 926, { t: 47, b: 34 }, { l: 47, r: 47, b: 21 }],
  ['iPhone 14 Pro-16', 393, 852, { t: 59, b: 34 }, { l: 59, r: 59, b: 21 }],
  ['iPhone 15/16 Plus, Pro Max', 430, 932, { t: 59, b: 34 }, { l: 59, r: 59, b: 21 }],
  ['iPhone 16 Pro, 17, 17 Pro', 402, 874, { t: 62, b: 34 }, { l: 62, r: 62, b: 21 }],
  ['iPhone 16/17 Pro Max', 440, 956, { t: 62, b: 34 }, { l: 62, r: 62, b: 21 }],
  ['iPhone Air (stress 68)', 420, 912, { t: 68, b: 34 }, { l: 68, r: 68, b: 21 }],
  ['Android compact', 412, 917, { t: 0, b: 24 }, { l: 48, r: 24, b: 0 }],
  ['Android medium', 700, 840, { t: 0, b: 24 }, { l: 0, r: 0, b: 24 }],
  ['Android expanded', 1280, 800, { t: 0, b: 48 }, { l: 0, r: 0, b: 48 }],
];

const collect = () => {
  const out = [];
  const vw = document.documentElement.clientWidth;
  const vh = innerHeight;
  const visible = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || n.getAttribute('aria-hidden') === 'true') return false;
    }
    return true;
  };
  // Clip a box to every scrolling ancestor, so a card scrolled half out of the
  // strip counts only for the part that is on screen.
  const clip = (el, r) => {
    let { left, top, right, bottom } = r;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + cs.overflowY)) {
        const b = n.getBoundingClientRect();
        left = Math.max(left, b.left); right = Math.min(right, b.right);
        top = Math.max(top, b.top); bottom = Math.min(bottom, b.bottom);
      }
    }
    return right - left > 0.5 && bottom - top > 0.5 ? { left, top, right, bottom } : null;
  };
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (!t.textContent.trim() || !visible(t.parentElement)) continue;
    const range = document.createRange();
    range.selectNodeContents(t);
    for (const r of range.getClientRects()) {
      const c = clip(t.parentElement, r);
      if (c) out.push({ kind: 'text', what: t.textContent.trim().slice(0, 40), fixed: false, ...c });
    }
  }
  for (const el of document.querySelectorAll('a, button, input, select, [tabindex]:not([tabindex="-1"])')) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // A control inside the screenshot strip is the strip itself: skip the
    // scroll container's own box, its cards are not controls.
    if (el.id === 'strip') continue;
    const c = clip(el, r);
    if (c) out.push({ kind: el.tagName.toLowerCase(), what: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), fixed: getComputedStyle(el).position === 'fixed', ...c });
  }
  return { vw, vh, boxes: out };
};

const browser = await chromium.launch({ ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }), args: ['--no-proxy-server'] });
let fails = 0;
let states = 0;
for (const [name, w, h, up, side] of DEVICES) {
  for (const orient of ['upright', 'sideways']) {
    const vw = orient === 'upright' ? w : h;
    const vh = orient === 'upright' ? h : w;
    const ins = orient === 'upright' ? { top: up.t, bottom: up.b, left: 0, right: 0 } : { top: 0, bottom: side.b, left: side.l, right: side.r };
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, isMobile: vw < 900, hasTouch: vw < 900, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: ins.top, topMax: ins.top, bottom: ins.bottom, bottomMax: ins.bottom, left: ins.left, leftMax: ins.left, right: ins.right, rightMax: ins.right } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE, { waitUntil: 'networkidle' });
    if (CONTROL) {
      // Neutralise every inset in the stylesheet: the page as it would be with no safe-area work.
      await page.addStyleTag({ content: ':root{--l:var(--gut)!important;--r:var(--gut)!important}.hero{padding-top:clamp(12px,2.2vw,26px)!important}.foot{padding-bottom:34px!important}' });
    }
    // The env() values really are live (the harness is measuring something).
    const env = await page.evaluate(() => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
      document.body.append(d);
      const cs = getComputedStyle(d);
      const r = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(parseFloat);
      d.remove();
      return r;
    });
    const want = [ins.top, ins.right, ins.bottom, ins.left];
    if (env.join() !== want.join()) { fails += 1; console.log(`  FAIL ${name} ${orient}: env() reads ${env} not ${want}`); }
    const hits = new Set();
    for (const at of ['rest', 'middle', 'end']) {
      await page.evaluate((a) => {
        const H = document.documentElement.scrollHeight - innerHeight;
        scrollTo({ top: a === 'rest' ? 0 : a === 'middle' ? H / 2 : H, behavior: 'instant' });
      }, at);
      await page.waitForTimeout(120);
      const { vw: cw, vh: ch, boxes } = await page.evaluate(collect);
      states += 1;
      for (const b of boxes) {
        // Wholly off screen (the unfocused skip link) is not in any band.
        if (b.right <= 0 || b.left >= cw) continue;
        const where = [];
        if (b.left < ins.left - 0.5) where.push(`left ${Math.round(b.left)}<${ins.left}`);
        if (b.right > cw - ins.right + 0.5) where.push(`right ${Math.round(b.right)}>${cw - ins.right}`);
        if ((at === 'rest' || b.fixed) && b.top < ins.top - 0.5 && b.bottom > 0) where.push(`top ${Math.round(b.top)}<${ins.top}`);
        if ((at === 'end' || b.fixed) && b.bottom > ch - ins.bottom + 0.5 && b.top < ch) where.push(`bottom ${Math.round(b.bottom)}>${ch - ins.bottom}`);
        if (where.length) hits.add(`${b.kind} "${b.what}" ${where.join(', ')} (${at})`);
      }
    }
    // The skip link, focused, must land inside the safe area too.
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.focus('.skip');
    const skip = await page.evaluate(() => { const r = document.querySelector('.skip').getBoundingClientRect(); return { l: r.left, t: r.top, r: r.right, b: r.bottom }; });
    if (skip.l < ins.left || skip.t < ins.top) hits.add(`focused skip link at ${Math.round(skip.l)},${Math.round(skip.t)} inside the inset`);
    for (const e of errors) hits.add(`pageerror ${e}`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) hits.add(`horizontal overflow ${overflow}px`);
    if (hits.size) {
      fails += hits.size;
      console.log(`  ${name} ${orient} ${vw}x${vh} insets t${ins.top} r${ins.right} b${ins.bottom} l${ins.left}: ${hits.size} in the bands`);
      for (const x of [...hits].slice(0, 6)) console.log(`    ${x}`);
    } else {
      console.log(`ok ${name} ${orient} ${vw}x${vh} insets t${ins.top} r${ins.right} b${ins.bottom} l${ins.left}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`${DEVICES.length * 2} device frames, ${states} page states: ${fails ? `${fails} failure(s)` : 'nothing in an inset band'}${CONTROL ? ' [CONTROL: insets neutralised]' : ''}`);
process.exit(fails ? 1 : 0);
