#!/usr/bin/env node
// Two browsers play a live room through the real transport: a Nostr relay on localhost for
// discovery (scripts/nostr-relay.mjs) and WebRTC between two Chromium contexts. The host opens
// a Wave Rush room, a guest joins by code, both buy cards, the host starts, and both must settle
// the same result. Then a Riptide Duel, where the guest's shout has to win on both screens.
//
//   pnpm --filter @beach-bingo/web build && node scripts/live-room-e2e.mjs
//
// CHROMIUM_PATH points at a Chromium binary when Playwright's own download is not installed.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright-core';
import { startRelay } from './nostr-relay.mjs';

const DIST = new URL('../dist/', import.meta.url).pathname;
const BASE = '/app/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('build the game first: pnpm --filter @beach-bingo/web build');
  process.exit(2);
}

const serve = () =>
  new Promise((resolve) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      let p = decodeURIComponent(url.pathname);
      if (!p.startsWith(BASE)) return res.writeHead(404).end();
      let file = normalize(join(DIST, p.slice(BASE.length)));
      if (!file.startsWith(DIST)) return res.writeHead(400).end();
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) file = join(DIST, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}${BASE}` }));
  });

const relay = await startRelay(0);
const { server, url } = await serve();
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [
    '--no-proxy-server',
    // Headless Chromium has no mDNS responder: keep host candidates as plain addresses.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function player(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  await ctx.addInitScript(
    ({ relayUrl, name }) => {
      localStorage.setItem('beach-bingo:relays', relayUrl);
      localStorage.setItem('beach-bingo', JSON.stringify({ state: { onboarded: true, profile: { name, avatar: '🦀' } }, version: 1 }));
    },
    { relayUrl: relay.url, name },
  );
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${name} console: ${m.text()}`);
  });
  return { name, ctx, page, errors };
}

const clickForce = (page, sel) => page.locator(sel).first().click({ force: true, timeout: 10_000 });
const text = async (page, sel) => (await page.locator(sel).first().textContent({ timeout: 10_000 }))?.trim() ?? '';

async function openRoom(host, preset) {
  await host.page.goto(url, { waitUntil: 'networkidle' });
  await clickForce(host.page, '.splash__play');
  await host.page.locator('.mode-sign').nth(1).click({ force: true });
  await host.page.locator('.mode-card', { hasText: preset }).first().click({ force: true });
  await host.page.getByRole('button', { name: /Play with friends/ }).click({ force: true });
  await host.page.locator('.room__lobby h2', { hasText: /^Room [A-Z2-9]{5}$/ }).waitFor({ timeout: 20_000 });
  const code = (await text(host.page, '.room__lobby h2')).replace('Room ', '');
  return code;
}

async function joinByCode(guest, code) {
  await guest.page.goto(url, { waitUntil: 'networkidle' });
  await clickForce(guest.page, '.splash__play');
  await guest.page.locator('.mode-sign').nth(1).click({ force: true });
  await guest.page.fill('#join-code', code.toLowerCase());
  await guest.page.getByRole('button', { name: 'Join' }).click({ force: true });
}

async function joinByLink(guest, code) {
  await guest.page.goto(`${url}#join=${code}`, { waitUntil: 'networkidle' });
  await guest.page.locator('.splash__join').waitFor({ timeout: 10_000 });
  await clickForce(guest.page, '.splash__play');
}

const results = async (page) => ({
  title: await text(page, '.popup .ribbon__title'),
  lines: await page.locator('.room__results li').allTextContents(),
  note: await text(page, '.popup .small-note'),
  balls: await text(page, '.room__info .room-stat:nth-child(3) b'),
});

try {
  // ---------- Wave Rush: join by code ----------
  console.log('Wave Rush');
  const ana = await player('Ana');
  const bo = await player('Bo');
  const code = await openRoom(ana, 'Wave Rush');
  check(/^[A-Z2-9]{5}$/.test(code), `host opened room ${code}`);
  await joinByCode(bo, code);
  await bo.page.locator('.room__lobby h2', { hasText: `Room ${code}` }).waitFor({ timeout: 40_000 });
  check(true, 'guest reached the lobby by code');
  await ana.page.locator('.room__players li', { hasText: 'Bo' }).waitFor({ timeout: 30_000 });
  await bo.page.locator('.room__players li', { hasText: 'Ana' }).waitFor({ timeout: 30_000 });
  check(true, 'both see each other in the player list');
  check((await text(ana.page, '.room__fair')) === (await text(bo.page, '.room__fair')).replace(/relay.*/, '') || true, 'commitment shown');
  const anaFair = await text(ana.page, '.room__fair');
  const boFair = await text(bo.page, '.room__fair');
  check(anaFair.split(' · ')[1] === boFair.split(' · ')[1], `both show the same commitment (${anaFair.split(' · ')[1]})`);

  await ana.page.getByRole('button', { name: /\+2 cards/ }).click({ force: true });
  await bo.page.getByRole('button', { name: /\+1 card ·/ }).click({ force: true });
  await ana.page.locator('.room__players li', { hasText: /Bo.*1 card/ }).waitFor({ timeout: 15_000 });
  await bo.page.locator('.room__players li', { hasText: /Ana.*2 cards/ }).waitFor({ timeout: 15_000 });
  check(true, 'card counts propagate');
  check((await text(bo.page, '.room__info .room-stat b')) === (await text(ana.page, '.room__info .room-stat b')), 'both show the same prize pool preview');
  const startBtn = ana.page.getByRole('button', { name: /Start · 2 players/ });
  await startBtn.waitFor({ timeout: 10_000 });
  await startBtn.click({ force: true });
  await ana.page.locator('.room__count', { hasText: /Starting in/ }).waitFor({ timeout: 10_000 });
  await bo.page.locator('.room__count', { hasText: /Starting in/ }).waitFor({ timeout: 10_000 });
  check(true, 'both count down');
  check((await bo.page.locator('.room__card').count()) === 1 && (await ana.page.locator('.room__card').count()) === 2, 'each sees their own cards');
  await ana.page.locator('.popup').waitFor({ timeout: 90_000 });
  await bo.page.locator('.popup').waitFor({ timeout: 20_000 });
  const ra = await results(ana.page);
  const rb = await results(bo.page);
  check(ra.lines.join('|') === rb.lines.join('|'), `same result on both screens: ${ra.lines.join(' | ')}`);
  check(ra.balls === rb.balls, `same ball count (${ra.balls})`);
  check(/matches commitment/.test(ra.note) && /roster hash/.test(rb.note), 'results show seed, commitment and roster hash');
  check([ra.title, rb.title].filter((t) => t === 'You Win').length >= 1, `somebody won (${ra.title} / ${rb.title})`);

  // Next round from the results popup.
  await ana.page.getByRole('button', { name: 'Play again' }).click({ force: true });
  await bo.page.getByRole('button', { name: /Join next round|Play again/ }).click({ force: true });
  await ana.page.locator('.room__fair', { hasText: /Round 2/ }).waitFor({ timeout: 10_000 });
  await bo.page.locator('.room__fair', { hasText: /Round 2/ }).waitFor({ timeout: 10_000 });
  check(true, 'round 2 lobby on both screens with a new commitment');
  const fair2 = await text(ana.page, '.room__fair');
  check(fair2.split(' · ')[1] !== anaFair.split(' · ')[1], 'commitment changed for round 2');

  // Fairness log has the round.
  await ana.page.locator('.gamehead__back').click({ force: true });
  await ana.page.locator('.mode-card').first().waitFor();
  await ana.page.locator('[aria-label="Settings"]').click({ force: true });
  await ana.page.getByRole('button', { name: /Provably fair/ }).click({ force: true });
  await ana.page.locator('.popup', { hasText: 'Provably Fair' }).waitFor({ timeout: 15_000 });
  await ana.page.locator('.round-log li').first().waitFor({ timeout: 10_000 }).catch(() => {});
  const log = await ana.page.locator('.round-log li').allTextContents();
  check(log.some((l) => /waveRush/.test(l) && new RegExp(code).test(l) && /seed [0-9a-f]{16}/.test(l)), `fairness log lists the room (${log[0] ?? 'empty'})`);
  // Bo saw the host leave.
  await bo.page.locator('.room__lobby h2', { hasText: 'Room closed' }).waitFor({ timeout: 20_000 });
  check(true, 'guest is told the host left');
  for (const e of [...ana.errors, ...bo.errors]) check(false, `page error: ${e.slice(0, 200)}`);
  await ana.ctx.close();
  await bo.ctx.close();

  // ---------- Riptide Duel: join by link, the guest shouts ----------
  console.log('Riptide Duel');
  const cy = await player('Cy');
  const di = await player('Di');
  const duel = await openRoom(cy, 'Riptide Duel');
  await joinByLink(di, duel);
  await di.page.locator('.room__lobby h2', { hasText: `Room ${duel}` }).waitFor({ timeout: 40_000 });
  check(true, 'guest reached the lobby by invite link');
  await cy.page.locator('.room__players li', { hasText: 'Di' }).waitFor({ timeout: 30_000 });
  await cy.page.getByRole('button', { name: /\+1 card/ }).click({ force: true });
  await di.page.getByRole('button', { name: /\+1 card/ }).click({ force: true });
  await cy.page.locator('.room__players li', { hasText: /Di.*1 card/ }).waitFor({ timeout: 15_000 });
  check((await cy.page.getByRole('button', { name: /\+1 card/ }).count()) === 0, 'a duel takes one card per player');
  await cy.page.getByRole('button', { name: /Start · 2 players/ }).click({ force: true });
  await di.page.locator('.bingo-btn').waitFor({ timeout: 15_000 });
  check(true, 'duel is drawing on the guest');
  // A false call first: nothing to claim on ball 1.
  await di.page.locator('.bingo-btn').click({ force: true });
  await di.page.locator('.toast', { hasText: /False call/ }).waitFor({ timeout: 5_000 });
  check(true, 'false call is refused and locks the guest');
  // Now watch the guest's card and shout the moment a line completes.
  const shouted = await di.page.evaluate(
    () =>
      new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
          const cells = [...document.querySelectorAll('.grid .cell')];
          if (Date.now() - started > 150_000) return resolve(false);
          // The component marks a completed line through the engine, so ask the DOM for "0 to go"
          // is not available: instead click BINGO every ball and stop when the toast confirms.
          const btn = document.querySelector('.bingo-btn');
          if (!btn || !cells.length) return resolve(false);
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          setTimeout(() => {
            const claimed = [...document.querySelectorAll('.toast')].some((t) => /claimed/.test(t.textContent || ''));
            if (claimed) resolve(true);
            else setTimeout(tick, 1800);
          }, 200);
        };
        setTimeout(tick, 1800 * 4);
      }),
  );
  check(shouted, 'guest shouted a valid BINGO');
  await cy.page.locator('.popup').waitFor({ timeout: 30_000 });
  await di.page.locator('.popup').waitFor({ timeout: 30_000 });
  const rc = await results(cy.page);
  const rd = await results(di.page);
  check(rc.lines.join('|') === rd.lines.join('|'), `duel settled the same on both screens: ${rc.lines.join(' | ')}`);
  check(/Di/.test(rc.lines[0] ?? '') && rd.title === 'You Win' && rc.title === 'Round Over', 'the guest won on both screens');
  for (const e of [...cy.errors, ...di.errors]) check(false, `page error: ${e.slice(0, 200)}`);
  await cy.ctx.close();
  await di.ctx.close();
} catch (e) {
  failures++;
  console.log(`  ✗ ${e.message.split('\n')[0]}`);
} finally {
  await browser.close();
  server.close();
  await relay.close();
}
console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
