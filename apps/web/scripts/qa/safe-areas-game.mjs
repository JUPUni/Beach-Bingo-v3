#!/usr/bin/env node
// Safe-area sweep of the GAME: the same iPhone and Android device frames as the site's
// apps/site/scripts/safe-areas.mjs, with the notch, home indicator and camera cut-out emulated
// through CDP, walked through every screen of the game (splash, home, map, a level, the casino
// games, a hall, a hall mid-round, the live lobby, the popups, the fairness log). No visible text
// line and no control may sit in an inset band. A landscape phone shows the rotate card by
// design, so there only the card is checked.
//
//   node scripts/qa/safe-areas-game.mjs            (from apps/web, against a server on BASE)
//
// Serve a build first, e.g. `pnpm build && npx serve -l 8796 dist` or the QA static server, and
// set BASE (default http://127.0.0.1:8796; the game lives under /app/). CHROME_PATH overrides the
// Chromium binary (Playwright's own is used when it is installed).
import { existsSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
const BASE = process.env.BASE || 'http://127.0.0.1:8796';
const chromePath = () => {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  try {
    return chromium.executablePath();
  } catch {
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    const dir = existsSync(root) ? readdirSync(root).find((d) => d.startsWith('chromium-')) : undefined;
    return dir ? `${root}/${dir}/chrome-linux/chrome` : undefined;
  }
};
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
const seed = { state: { stars: Object.fromEntries(Array.from({ length: 13 }, (_, i) => [i + 1, 1])), onboarded: true }, version: 1 };


const browser = await chromium.launch({ executablePath: chromePath(), args: ['--no-proxy-server'] });
let fails = 0;
let states = 0;
const summary = [];
for (const [name, w, h, up, side] of DEVICES) {
  for (const orient of ['upright', 'sideways']) {
    const vw = orient === 'upright' ? w : h;
    const vh = orient === 'upright' ? h : w;
    const ins = orient === 'upright' ? { top: up.t, bottom: up.b, left: 0, right: 0 } : { top: 0, bottom: side.b, left: side.l, right: side.r };
    const mobile = vw < 900;
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await ctx.addInitScript((s) => { if (!localStorage.getItem('beach-bingo')) localStorage.setItem('beach-bingo', JSON.stringify(s)); }, seed);
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: ins.top, topMax: ins.top, bottom: ins.bottom, bottomMax: ins.bottom, left: ins.left, leftMax: ins.left, right: ins.right, rightMax: ins.right } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const hits = new Set();
    const isHinted = () => page.evaluate(() => { const h = document.querySelector('.rotate-hint'); return !!h && getComputedStyle(h).display !== 'none'; });
    const check = async (screen) => {
      await page.waitForTimeout(500);
      // A landscape phone shows the rotate hint instead of the game: that is the design, so the
      // hint's own text is what must stay out of the inset bands.
      const hinted = await isHinted();
      const { vw: cw, vh: ch, boxes } = await page.evaluate((hint) => {
        const collect = function collect() {
          const out = [];
          const vw = document.documentElement.clientWidth;
          const vh = innerHeight;
          // With a popup open only the popup's own content is on top; the screen under it is dimmed.
          const layers = document.querySelectorAll('.popup-layer');
          const root = layers.length ? layers[layers.length - 1] : document.body;
          const visible = (el) => {
            for (let n = el; n && n !== document.body; n = n.parentElement) {
              const cs = getComputedStyle(n);
              if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0 || n.getAttribute('aria-hidden') === 'true') return false;
            }
            return true;
          };
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
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
          for (let t = walker.nextNode(); t; t = walker.nextNode()) {
            if (!t.textContent.trim() || !visible(t.parentElement)) continue;
            const range = document.createRange();
            range.selectNodeContents(t);
            for (const r of range.getClientRects()) {
              const c = clip(t.parentElement, r);
              if (c) out.push({ kind: 'text', what: t.textContent.trim().slice(0, 40), ...c });
            }
          }
          for (const el of root.querySelectorAll('a, button, input, select')) {
            if (!visible(el)) continue;
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const c = clip(el, r);
            if (c) out.push({ kind: el.tagName.toLowerCase(), what: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40), ...c });
          }
          return { vw, vh, boxes: out };
        };
        
        if (!hint) return collect();
        const h = document.querySelector('.rotate-hint');
        const out = [];
        const walker = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          if (!t.textContent.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(t);
          for (const r of range.getClientRects()) out.push({ kind: 'text', what: t.textContent.trim().slice(0, 40), left: r.left, top: r.top, right: r.right, bottom: r.bottom });
        }
        return { vw: document.documentElement.clientWidth, vh: innerHeight, boxes: out };
      }, hinted);
      states += 1;
      for (const b of boxes) {
        if (b.right <= 0 || b.left >= cw || b.bottom <= 0 || b.top >= ch) continue;
        const where = [];
        if (b.left < ins.left - 0.5) where.push(`left ${Math.round(b.left)}<${ins.left}`);
        if (b.right > cw - ins.right + 0.5) where.push(`right ${Math.round(b.right)}>${cw - ins.right}`);
        if (b.top < ins.top - 0.5) where.push(`top ${Math.round(b.top)}<${ins.top}`);
        if (b.bottom > ch - ins.bottom + 0.5) where.push(`bottom ${Math.round(b.bottom)}>${ch - ins.bottom}`);
        if (where.length) hits.add(`${screen}: ${b.kind} "${b.what}" ${where.join(', ')}`);
      }
    };
    const click = (sel) => page.locator(sel).first().click({ force: true, timeout: 8000 });
    const step = async (screen, fn) => { try { await fn(); await check(screen); } catch (e) { hits.add(`${screen}: could not reach (${String(e.message).split('\n')[0].slice(0, 80)})`); } };
    const home = async () => { await page.goto(`${BASE}/app/`, { waitUntil: 'networkidle' }); await click('.splash__play'); await page.locator('.home__level').waitFor({ timeout: 8000 }); };

    await page.goto(`${BASE}/app/`, { waitUntil: 'networkidle' });
    await check('splash');
    if (await isHinted()) {
      // Nothing else is reachable behind the card; the frame passes on the card alone.
      if (hits.size) { fails += 1; console.log(`FAIL ${name} ${orient} ${vw}x${vh} insets t${ins.top} r${ins.right} b${ins.bottom} l${ins.left}`); for (const h of hits) console.log(`     ${h}`); }
      else console.log(`ok   ${name} ${orient} ${vw}x${vh} insets t${ins.top} r${ins.right} b${ins.bottom} l${ins.left} (rotate card)`);
      summary.push([name, orient, hits.size]);
      await ctx.close();
      continue;
    }
    await step('home', home);
    await step('map', async () => { await click('.home__level'); await page.locator('.level-tile').first().waitFor(); });
    await step('level-14', async () => { await click('[aria-label^="Level 14"]'); await page.getByRole('button', { name: /Play/ }).last().click({ force: true }); await page.locator('.bingo-btn').waitFor(); await page.waitForTimeout(2500); });
    await step('casino-list', async () => { await home(); await page.locator('.mode-sign').nth(0).click({ force: true }); await page.locator('.mode-card').first().waitFor(); });
    await step('tide-pool', async () => { await page.locator('.mode-card', { hasText: 'Tide Pool' }).first().click({ force: true }); await page.waitForTimeout(1500); });
    await step('keno', async () => { await click('.gamehead__back'); await page.locator('.mode-card', { hasText: 'Keno' }).first().click({ force: true }); await page.waitForTimeout(1500); });
    await step('rooms-list', async () => { await home(); await page.locator('.mode-sign').nth(1).click({ force: true }); await page.locator('.mode-card').first().waitFor(); });
    await step('sunset-hall', async () => { await page.locator('.mode-card', { hasText: 'Sunset Hall' }).first().click({ force: true }); await page.waitForTimeout(1500); });
    await step('sunset-hall-playing', async () => { await page.getByRole('button', { name: /\+1 card/ }).first().click({ force: true }); await page.waitForTimeout(9500); });
    await step('live-lobby', async () => { await click('.gamehead__back'); await page.locator('.mode-card', { hasText: 'Wave Rush' }).first().click({ force: true }); await page.getByRole('button', { name: /Play with friends/ }).click({ force: true }); await page.locator('.room__lobby h2').waitFor({ timeout: 10000 }); });
    for (const [popup, sel] of [['settings', '[aria-label="Settings"]'], ['tasks', '[aria-label="Daily tasks"]'], ['coins', '.topbar__coins'], ['profile', '.topbar__avatar']]) {
      await step(`popup:${popup}`, async () => { await home(); await click(sel); await page.locator('.popup').first().waitFor({ timeout: 8000 }); });
    }
    await step('fairness', async () => { await home(); await click('[aria-label="Settings"]'); await page.getByRole('button', { name: /Provably fair/ }).click({ force: true }); await page.locator('.popup', { hasText: 'Provably Fair' }).waitFor({ timeout: 10000 }); });
    if (errors.length) hits.add(`page errors: ${errors[0].slice(0, 100)}`);
    if (hits.size) { fails += 1; console.log(`FAIL ${name} ${orient} ${vw}x${vh} insets t${ins.top} r${ins.right} b${ins.bottom} l${ins.left}`); for (const h of [...hits].slice(0, 12)) console.log(`     ${h}`); }
    else console.log(`ok   ${name} ${orient} ${vw}x${vh} insets t${ins.top} r${ins.right} b${ins.bottom} l${ins.left}`);
    summary.push([name, orient, hits.size]);
    await ctx.close();
  }
}
await browser.close();
console.log(`${DEVICES.length * 2} device frames, ${states} screen states: ${fails ? `${fails} frames with something in an inset band` : 'nothing in an inset band'}`);
process.exit(fails ? 1 : 0);
