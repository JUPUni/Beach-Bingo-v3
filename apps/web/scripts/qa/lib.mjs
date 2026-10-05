// Shared pieces of the QA harnesses: a static server for apps/web/dist under /app/, Chromium
// through playwright-core, a per-player browser context that records page errors, console errors
// and failed requests, a seeded localStorage, and the fit audit that lists controls a person
// cannot reach (cut off by the window or covered at their centre) and text that overflows.
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';

export const DIST = new URL('../../dist/', import.meta.url).pathname;
export const BASE_PATH = '/app/';
export const OUT = new URL('./out/', import.meta.url).pathname;
export const CHROME = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
export const STORE_KEY = 'beach-bingo';
export const RELAYS_KEY = 'beach-bingo:relays';

/** The two viewports every screen is checked at: a phone (touch) and a laptop window. */
export const VIEWPORTS = {
  phone: { width: 390, height: 844, mobile: true },
  laptop: { width: 1280, height: 800, mobile: false },
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

export function requireBuild() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('build the game first: pnpm --filter @beach-bingo/web build');
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
}

/** Serve apps/web/dist at http://127.0.0.1:<port>/app/ (SPA fallback to index.html). */
export function serveDist() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      // The site's region function, as Vercel answers it with no headers to read: unknown, which fails open.
      if (p === '/api/geo') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ country: null, region: null }));
      }
      if (!p.startsWith(BASE_PATH)) return res.writeHead(404).end();
      let file = normalize(join(DIST, p.slice(BASE_PATH.length)));
      if (!file.startsWith(DIST)) return res.writeHead(400).end();
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) file = join(DIST, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}${BASE_PATH}` }));
  });
}

export function launch(extraArgs = []) {
  return chromium.launch({
    executablePath: CHROME,
    args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', ...extraArgs],
  });
}

/**
 * A browser context for one player. `seed` is merged into the persisted store (`onboarded` skips
 * nothing: the splash is still shown, it only marks the intro seen), `clock: true` installs
 * Playwright's fake clock so long ball timers can be run forward with `page.clock.runFor`.
 */
export async function player(browser, { viewport = VIEWPORTS.phone, seed = null, seedVersion = 3, clock = false, relayUrl = null, serviceWorkers = 'block' } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    hasTouch: viewport.mobile,
    isMobile: viewport.mobile,
    serviceWorkers,
  });
  await ctx.addInitScript(
    ({ key, relaysKey, seed, seedVersion, relayUrl }) => {
      if (relayUrl) localStorage.setItem(relaysKey, relayUrl);
      // `seedVersion: 1` seeds a save from before the two currencies, to watch the migration run.
      if (seed && !localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ state: seed, version: seedVersion }));
    },
    { key: STORE_KEY, relaysKey: RELAYS_KEY, seed, seedVersion, relayUrl },
  );
  const page = await ctx.newPage();
  if (clock) await page.clock.install();
  const errors = [];
  const bad = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${String(e).split('\n')[0]}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text().split('\n')[0]}`);
  });
  page.on('response', (r) => r.status() >= 400 && bad.push(`${r.status()} ${r.url()}`));
  page.on('requestfailed', (r) => bad.push(`failed ${r.url()} ${r.failure()?.errorText ?? ''}`));
  return { ctx, page, errors, bad, viewport, close: () => ctx.close() };
}

/** The persisted store as the game saved it. */
export const stored = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || '{}').state ?? {}, STORE_KEY);
/** The two ledgers: shells are the free currency every default flow plays with; coins come from the shop. */
export const shells = async (page) => (await stored(page)).shells;
export const coins = async (page) => (await stored(page)).coins;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run fake time forward in steps, calling `until` between steps; resolves when it returns true. */
export async function runUntil(page, stepMs, maxMs, until) {
  for (let t = 0; t < maxMs; t += stepMs) {
    await page.clock.runFor(stepMs);
    await page.waitForTimeout(25);
    if (await until()) return true;
  }
  return false;
}

/** Results collector shared by the harnesses: prints as it goes and keeps a table for the report. */
export function reporter(tag = '') {
  const results = [];
  let failures = 0;
  /** `page` (optional) is screenshotted into out/FAIL-<n>.png when the check fails. */
  const ok = (name, pass, detail = '', page = null) => {
    const line = `${pass ? 'ok  ' : 'FAIL'} ${tag}${name}${pass || !detail ? '' : ` :: ${String(detail).slice(0, 400)}`}`;
    console.log(line);
    results.push({ name: `${tag}${name}`, pass: !!pass, detail: String(detail).slice(0, 400) });
    if (!pass && page) void page.screenshot({ path: `${OUT}FAIL-${++failures}.png` }).catch(() => {});
    return !!pass;
  };
  const note = (text) => console.log(`     ${text}`);
  return { ok, note, results, failures: () => results.filter((r) => !r.pass) };
}

/**
 * The fit audit (after the method in fit.mjs): every control inside the top popup layer, or the
 * whole screen when no popup is open, must be inside the window and be the element at its own
 * centre. Controls inside a scrolling list are scrolled into view first, so only controls no
 * amount of scrolling reveals are reported. Also reports leaf text that overflows its box and
 * any element that sticks out past the stage.
 */
export async function fitProblems(page) {
  return page.evaluate(() => {
    const vw = innerWidth;
    const vh = innerHeight;
    const layers = document.querySelectorAll('.popup-layer');
    const root = layers.length ? layers[layers.length - 1] : document;
    const stage = document.querySelector('.stage')?.getBoundingClientRect();
    const reveal = (el) => {
      for (let a = el.parentElement; a; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (/(auto|scroll)/.test(cs.overflowY) && a.scrollHeight > a.clientHeight + 1) {
          const ar = a.getBoundingClientRect();
          const top = ar.top + a.clientTop;
          const bottom = top + a.clientHeight;
          const r = el.getBoundingClientRect();
          if (r.top < top) a.scrollTop -= top - r.top + 4;
          else if (r.bottom > bottom) a.scrollTop += r.bottom - bottom + 4;
        }
        if (/(auto|scroll)/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1) {
          const ar = a.getBoundingClientRect();
          const left = ar.left + a.clientLeft;
          const right = left + a.clientWidth;
          const r = el.getBoundingClientRect();
          if (r.left < left) a.scrollLeft -= left - r.left + 4;
          else if (r.right > right) a.scrollLeft += r.right - right + 4;
        }
      }
    };
    const label = (el) =>
      (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
    const out = [];
    for (const el of root.querySelectorAll('button, a[href], [role="button"], input, select')) {
      if (el.disabled) continue; // nothing to reach: a spent card's cells, a greyed button
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
      if (el.getBoundingClientRect().width < 2) continue;
      reveal(el);
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const clipped = r.left < -1 || r.top < -1 || r.right > vw + 1 || r.bottom > vh + 1;
      const cx = Math.min(Math.max(r.left + r.width / 2, 0), vw - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 0), vh - 1);
      const hit = document.elementFromPoint(cx, cy);
      const covered = !clipped && hit && !(el === hit || el.contains(hit) || hit.contains(el));
      if (clipped) out.push(`${label(el)} [cut ${Math.round(r.left)},${Math.round(r.top)}-${Math.round(r.right)},${Math.round(r.bottom)}]`);
      else if (covered) out.push(`${label(el)} [under ${String(hit.className || hit.tagName).slice(0, 30)}]`);
    }
    // Text that overflows its own box (nowrap or a fixed height) without being scrollable or ellipsised.
    const decorative = (el) => el.closest('.app__backdrop, .confetti, .splash__cloud, .splash__chest, .splash__chest-shadow, .toasts, .win-banner');
    for (const el of root.querySelectorAll('h1, h2, h3, p, span, b, small, em, li, label, button, div')) {
      if (el.children.length > 0 || !el.textContent?.trim()) continue;
      if (decorative(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const overX = el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0;
      if (overX && cs.overflowX === 'visible' && cs.whiteSpace === 'nowrap') out.push(`text overflows "${label(el)}" by ${el.scrollWidth - el.clientWidth}px`);
      if (overX && cs.textOverflow === 'ellipsis' && cs.overflowX !== 'visible') out.push(`text truncated "${el.textContent.trim().slice(0, 40)}" (…)`);
    }
    // Anything sticking out of the stage (the stage clips it) apart from decorations.
    if (stage) {
      for (const el of root.querySelectorAll('.stage *')) {
        if (decorative(el)) continue;
        const cs = getComputedStyle(el);
        if (cs.position === 'fixed' || cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        if (r.right > stage.right + 2 || r.left < stage.left - 2) {
          const inScroller = [...(function* (n) { for (let a = n.parentElement; a; a = a.parentElement) yield a; })(el)].some((a) => /(auto|scroll)/.test(getComputedStyle(a).overflowX));
          if (!inScroller) out.push(`sticks out of the stage: ${String(el.className || el.tagName).slice(0, 40)} (${Math.round(r.left)}–${Math.round(r.right)} vs ${Math.round(stage.left)}–${Math.round(stage.right)})`);
        }
      }
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`sideways page scroll ${document.documentElement.scrollWidth - innerWidth}px`);
    return [...new Set(out)];
  });
}

/** Screenshot into scripts/qa/out/<name>.png. */
export async function shot(page, name) {
  await page.screenshot({ path: `${OUT}${name}.png` }).catch(() => {});
}

/** Click through the splash to the home screen. */
export async function toHome(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.locator('.splash__play').waitFor({ timeout: 20_000 });
  await page.locator('.splash__play').click({ force: true });
  await page.locator('.home__level').waitFor({ timeout: 10_000 });
}

export const text = async (page, sel) => ((await page.locator(sel).first().textContent({ timeout: 10_000 })) ?? '').replace(/\s+/g, ' ').trim();
export const bodyText = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
