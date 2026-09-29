#!/usr/bin/env node
// A live Wave Rush room between two browsers through the real transport (a Nostr relay on
// localhost from scripts/nostr-relay.mjs, WebRTC between two Chromium contexts): the host on a
// laptop window, the guest on a phone. Both buy cards, the host starts, both must settle the
// same result, the coin ledgers must move by exactly cards and prizes, the Provably-fair log
// must list the room, and a guest who joins during the round must be seated for the next one.
// The lobby, the drawing and the results are also put through the fit audit at both sizes.
// (scripts/live-room-e2e.mjs covers the duel's shout over the same transport.)
//
//   pnpm --filter @beach-bingo/web build && node scripts/qa/live.mjs
import { startRelay } from '../nostr-relay.mjs';
import { VIEWPORTS, bodyText, coins, fitProblems, launch, player, reporter, requireBuild, serveDist, shot, stored, text } from './lib.mjs';

requireBuild();
const relay = await startRelay(0);
const { server, url } = await serveDist();
const browser = await launch();
const R = reporter('live: ');
const fit = async (page, screen) => {
  await page.waitForTimeout(900); // let the pop-in animation land first
  const problems = await fitProblems(page);
  R.ok(`fit ${screen}`, problems.length === 0, problems.join('; '));
  await shot(page, `live-${screen}`);
};
const results = async (page) => ({
  title: await text(page, '.popup .ribbon__title'),
  lines: await page.locator('.room__results li').allTextContents(),
  note: await text(page, '.popup .small-note'),
  balls: await text(page, '.room__info .room-stat:nth-child(3) b'),
  win: Number(((await page.locator('.popup .reward-pill').innerText().catch(() => '+0')).match(/\d[\d,]*/) || ['0'])[0].replace(/,/g, '')),
});

const seedFor = (name) => ({ onboarded: true, coins: 1000, profile: { name, avatar: '🦀' } });
const host = await player(browser, { viewport: VIEWPORTS.laptop, relayUrl: relay.url, seed: seedFor('Ana') });
const guest = await player(browser, { viewport: VIEWPORTS.phone, relayUrl: relay.url, seed: seedFor('Bo') });
const late = await player(browser, { viewport: VIEWPORTS.phone, relayUrl: relay.url, seed: seedFor('Cy') });

try {
  // Host opens a Wave Rush room from the practice lobby's link.
  await host.page.goto(url, { waitUntil: 'networkidle' });
  await host.page.locator('.splash__play').click({ force: true });
  await host.page.locator('.mode-sign').nth(1).click({ force: true });
  await host.page.locator('.mode-card', { hasText: 'Wave Rush' }).first().click({ force: true });
  await host.page.getByRole('button', { name: /Play with friends/ }).click({ force: true });
  await host.page.locator('.room__lobby h2', { hasText: /^Room [A-Z2-9]{5}$/ }).waitFor({ timeout: 20_000 });
  const code = (await text(host.page, '.room__lobby h2')).replace('Room ', '');
  R.ok(`host opens a room with a five-letter code (${code})`, /^[A-Z2-9]{5}$/.test(code));
  R.ok('host lobby shows the commitment and one relay', /seed commitment [0-9a-f]{12}…/.test(await text(host.page, '.room__fair')) && /1 relay connected/.test(await text(host.page, '.room__fair')), await text(host.page, '.room__fair'));
  await fit(host.page, 'host-lobby-laptop');

  // Guest joins by code from the rooms list.
  await guest.page.goto(url, { waitUntil: 'networkidle' });
  await guest.page.locator('.splash__play').click({ force: true });
  await guest.page.locator('.mode-sign').nth(1).click({ force: true });
  await guest.page.fill('#join-code', code.toLowerCase());
  await guest.page.getByRole('button', { name: 'Join' }).click({ force: true });
  await guest.page.locator('.room__lobby h2', { hasText: `Room ${code}` }).waitFor({ timeout: 40_000 });
  await host.page.locator('.room__players li', { hasText: 'Bo' }).waitFor({ timeout: 30_000 });
  await guest.page.locator('.room__players li', { hasText: 'Ana' }).waitFor({ timeout: 30_000 });
  R.ok('guest reaches the lobby by code and both see each other', true);
  const hostFair = await text(host.page, '.room__fair');
  const guestFair = await text(guest.page, '.room__fair');
  R.ok('both show the same commitment', hostFair.split(' · ')[1] === guestFair.split(' · ')[1], `${hostFair} | ${guestFair}`);
  await fit(guest.page, 'guest-lobby-phone');

  // Cards: the host takes 2 (20 coins), the guest 1 (10 coins).
  const h0 = await coins(host.page);
  const g0 = await coins(guest.page);
  await host.page.getByRole('button', { name: /\+2 cards/ }).click({ force: true });
  await guest.page.getByRole('button', { name: /\+1 card ·/ }).click({ force: true });
  await host.page.locator('.room__players li', { hasText: /Bo.*1 card/ }).waitFor({ timeout: 15_000 });
  await guest.page.locator('.room__players li', { hasText: /Ana.*2 cards/ }).waitFor({ timeout: 15_000 });
  R.ok('cards are paid for at once (host −20, guest −10)', (await coins(host.page)) === h0 - 20 && (await coins(guest.page)) === g0 - 10, `${h0}->${await coins(host.page)} ${g0}->${await coins(guest.page)}`);
  const preview = await text(host.page, '.room__info .room-stat b');
  R.ok('the prize pool preview is 88% of 30 coins on both screens', preview === '26' && (await text(guest.page, '.room__info .room-stat b')) === '26', preview);
  R.ok('the guest sees "Waiting for Ana to start…"', /Waiting for Ana to start/.test(await text(guest.page, '.room__count')));

  // Start, countdown, drawing; a late guest joins mid-round and watches.
  const startBtn = host.page.getByRole('button', { name: /Start · 2 players/ });
  await startBtn.waitFor({ timeout: 10_000 });
  await startBtn.click({ force: true });
  await host.page.locator('.room__count', { hasText: /Starting in/ }).waitFor({ timeout: 10_000 });
  await guest.page.locator('.room__count', { hasText: /Starting in/ }).waitFor({ timeout: 10_000 });
  R.ok('both count down and each sees their own cards', (await guest.page.locator('.room__card').count()) === 1 && (await host.page.locator('.room__card').count()) === 2);
  await late.page.goto(`${url}#join=${code}`, { waitUntil: 'networkidle' });
  await late.page.locator('.splash__join').waitFor({ timeout: 10_000 });
  R.ok('an invite link shows "Room … is waiting" on the splash', /Room .* is waiting for you/.test(await bodyText(late.page)));
  await late.page.locator('.splash__play').click({ force: true });
  await guest.page.locator('.room__caller .ball').first().waitFor({ timeout: 15_000 });
  await host.page.waitForTimeout(3000);
  await fit(host.page, 'host-drawing-laptop');
  await fit(guest.page, 'guest-drawing-phone');
  const lateWatching = await late.page.locator('.room__opponent', { hasText: /watching this round/ }).waitFor({ timeout: 30_000 }).then(() => true, () => false);
  R.ok('a player who joins mid-round watches it', lateWatching, (await bodyText(late.page)).slice(0, 200));

  // Results must match on every screen.
  await host.page.locator('.popup').waitFor({ timeout: 90_000 });
  await guest.page.locator('.popup').waitFor({ timeout: 20_000 });
  const rh = await results(host.page);
  const rg = await results(guest.page);
  R.ok(`same result on both screens: ${rh.lines.join(' | ')}`, rh.lines.join('|') === rg.lines.join('|') && rh.balls === rg.balls);
  R.ok('results show seed, commitment and roster hash', /matches commitment/.test(rh.note) && /roster hash/.test(rg.note), rh.note);
  // "Full House on ball 21: Ana · 26" — or, on the same ball, "…: Ana, Bo · 13" and the pool is shared.
  const winner = rh.lines[0] ?? '';
  const winners = (winner.split(':')[1] ?? '').split('·')[0].split(',').map((s) => s.trim());
  const hostWon = winners.includes('Ana');
  const guestWon = winners.includes('Bo');
  R.ok(`somebody won the full house (${winner})`, hostWon || guestWon);
  const pool = 26;
  const share = hostWon && guestWon ? pool / 2 : pool;
  R.ok('host coins = 1000 − 20 + prize', (await coins(host.page)) === h0 - 20 + (hostWon ? Math.floor(share) : 0), `${await coins(host.page)} win=${rh.win}`);
  R.ok('guest coins = 1000 − 10 + prize', (await coins(guest.page)) === g0 - 10 + (guestWon ? Math.floor(share) : 0), `${await coins(guest.page)} win=${rg.win}`);
  R.ok('the winner sees "You Win", the other "Round Over"', (hostWon ? rh.title === 'You Win' : rh.title === 'Round Over') && (guestWon ? rg.title === 'You Win' : rg.title === 'Round Over'), `${rh.title} / ${rg.title}`);
  await fit(host.page, 'host-results-laptop');
  await fit(guest.page, 'guest-results-phone');
  const lateResults = await late.page.locator('.popup', { hasText: /You watched this one|Round Over/ }).waitFor({ timeout: 15_000 }).then(() => true, () => false);
  R.ok('the late joiner sees the results as a spectator', lateResults);

  // Round 2: fresh commitment; the late joiner can now buy in.
  await host.page.getByRole('button', { name: 'Play again' }).click({ force: true });
  await guest.page.getByRole('button', { name: /Join next round|Play again/ }).click({ force: true });
  await late.page.getByRole('button', { name: /Join next round|Play again/ }).click({ force: true });
  await host.page.locator('.room__fair', { hasText: /Round 2/ }).waitFor({ timeout: 10_000 });
  await guest.page.locator('.room__fair', { hasText: /Round 2/ }).waitFor({ timeout: 10_000 });
  const fair2 = await text(host.page, '.room__fair');
  R.ok('round 2 lobby has a new commitment on both screens', fair2.split(' · ')[1] !== hostFair.split(' · ')[1] && (await text(guest.page, '.room__fair')).split(' · ')[1] === fair2.split(' · ')[1]);
  await late.page.getByRole('button', { name: /\+1 card ·/ }).click({ force: true });
  await host.page.locator('.room__players li', { hasText: /Cy.*1 card/ }).waitFor({ timeout: 15_000 });
  R.ok('the late joiner buys a card for round 2 and the host sees it', true);

  // The guest leaves the lobby: its card is refunded.
  const g1 = await coins(guest.page);
  await guest.page.getByRole('button', { name: /\+1 card ·/ }).click({ force: true });
  await guest.page.waitForTimeout(300);
  await guest.page.locator('.gamehead__back').click({ force: true });
  await guest.page.locator('.mode-card').first().waitFor();
  R.ok('leaving a lobby refunds the cards bought for it', (await coins(guest.page)) === g1, `${g1} -> ${await coins(guest.page)}`);
  await host.page.locator('.room__players li', { hasText: 'Bo' }).waitFor({ state: 'detached', timeout: 20_000 });
  R.ok('the host sees the guest leave', true);

  // Fairness log on the host lists the room with the revealed seed.
  await host.page.locator('.gamehead__back').click({ force: true });
  await host.page.locator('.mode-card').first().waitFor();
  await host.page.locator('[aria-label="Settings"]').click({ force: true });
  await host.page.getByRole('button', { name: /Provably fair/ }).click({ force: true });
  await host.page.locator('.popup--wide').waitFor({ timeout: 15_000 });
  const log = await host.page.locator('.round-log li').allTextContents();
  R.ok(`the Provably-fair log lists the room with its seed (${(log[0] ?? '').replace(/\s+/g, ' ').slice(0, 80)})`, log.some((l) => /waveRush/.test(l) && l.includes(code) && /seed [0-9a-f]{16}/.test(l)));
  R.ok('the room is logged once per round, not per screen', log.filter((l) => l.includes(code)).length === 1, String(log.filter((l) => l.includes(code)).length));
  await fit(host.page, 'host-fairness-log');
  await late.page.locator('.room__lobby h2', { hasText: 'Room closed' }).waitFor({ timeout: 20_000 });
  R.ok('a guest left in the lobby is told the host closed the room', true);
  R.ok('the late joiner got its round-2 card refunded when the room closed', (await coins(late.page)) === 1000, String(await coins(late.page)));
  for (const p of [host, guest, late]) {
    const errs = p.errors.filter((e) => !/trystero|ERR_INTERNET/.test(e));
    R.ok(`no page errors (${(await stored(p.page)).profile?.name})`, errs.length === 0, errs.join(' | '));
    R.ok(`no failed requests (${(await stored(p.page)).profile?.name})`, p.bad.length === 0, p.bad.join(' | '));
  }
} catch (e) {
  R.ok('live run completed', false, String(e.message || e).split('\n')[0]);
} finally {
  await browser.close();
  server.close();
  await relay.close();
}
const failed = R.failures();
console.log(`\n${R.results.length - failed.length}/${R.results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
