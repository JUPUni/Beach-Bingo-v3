#!/usr/bin/env node
// Three browsers play a STAKED Wave Rush HALL against the wave_duel program on Solana devnet, the
// way three phones would: a local Nostr relay for discovery (scripts/nostr-relay.mjs), WebRTC
// between three Chromium contexts, and a Wallet Standard test wallet injected into each page
// (scripts/qa/test-wallet.mjs) so the app's own wallet layer signs and sends every transaction.
//
// The host opens a table of 4 seats with 2 cards at the smallest preset; two guests join by code
// and buy 1 and 3 cards; a guest locks the table; the host starts once the chain says `locked`;
// all three play to the results on the same ball with the same winners; a guest settles; the
// other screens see it settled. The chain's payout per seat is checked against the engine's own
// replay (buildRoom with the hall's seats and entropy and the revealed seed, split by
// splitHallPot), the coin balance in the top bar must never move, and any page error fails the run.
//
//   node scripts/stake-hall-e2e.mjs                  (from apps/web; Node 22.18+ strips the .ts imports itself)
//
// Same environment as scripts/stake-e2e.mjs (the helpers are shared in scripts/qa/stake-lib.mjs):
// KEYPAIR, RPC_URL, WAVE_DUEL_PROGRAM, CHROMIUM_PATH, STAKE_E2E_SKIP_BUILD=1. Each throwaway
// wallet gets 0.08 SOL and is swept back to the payer at the end.
import { address, createSolanaRpc, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { commitSeed, rooms, sha256Hex } from '@beach-bingo/engine';
import { buildRoom } from '../src/rooms/live/protocol.ts';
import * as duel from '../src/solana/waveDuel.ts';
import * as halls from '../src/solana/waveHall.ts';
import { startRelay } from './nostr-relay.mjs';
import {
  build,
  coins,
  connectWallet as connectWalletIn,
  DEFAULT_PROGRAM,
  DEFAULT_RPC,
  explorer,
  fmt,
  joinByCode as joinByCodeAt,
  keypairPath,
  launchChromium,
  loadWallet,
  openWaveRushRoom,
  press,
  retry,
  serve,
  shortAddress,
  text,
  transferIx,
  TX_FEE,
  until,
  ZERO_ENTROPY,
} from './qa/stake-lib.mjs';
import { createTestWallet, installTestWallet } from './qa/test-wallet.mjs';

const PROGRAM = process.env.WAVE_DUEL_PROGRAM || DEFAULT_PROGRAM;
const RPC_URL = process.env.RPC_URL || DEFAULT_RPC;
const STAKE = 10_000_000n; // the smallest lobby preset: 0.01 SOL a card
const STAKE_LABEL = duel.formatSol(STAKE);
const SEATS = 4;
const CARDS = { host: 2, bo: 1, cy: 3 };
const PURSE = 80_000_000n; // per throwaway wallet: up to three cards, the hall's rent, a few fees

duel.configureProgram(address(PROGRAM));
const rpc = createSolanaRpc(RPC_URL);
const balance = (addr) => retry(async () => (await rpc.getBalance(address(addr), { commitment: 'confirmed' }).send()).value);
const readHall = (pda) => retry(() => halls.fetchHall(rpc, pda));
const sendFrom = (wallet, instructions) => retry(() => duel.sendSigned(rpc, wallet.address, [wallet.keyPair], instructions), 3);
const sol = (lamports) => duel.formatSol(lamports);

/** What the engine says about a locked hall, exactly as waveHall.test.ts computes it: the roster is the seats, the client seed the entropy. */
function engineReplay(hall, serverSeed) {
  const state = buildRoom(rooms.ROOM_PRESETS.waveRush, hall.commitment, serverSeed, halls.hallRoster(hall), hall.entropy);
  while (state.phase === 'drawing') rooms.drawNext(state);
  const win = state.wins[0];
  return { ball: win.ballCount, winningCards: win.winners.length, shares: hall.seats.map((s) => win.winners.filter((w) => w.playerId === s.player).length) };
}

/* ---------- Checks ---------- */

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures++;
};

/* ---------- Go ---------- */

const KEYPAIR = keypairPath();
build(PROGRAM, RPC_URL);
const payer = await loadWallet(KEYPAIR);
const config = await retry(() => duel.fetchConfig(rpc));
if (!config) {
  console.error('the wave_duel config is not initialised on this cluster (wave-duel-admin.mjs init-config)');
  process.exit(2);
}
const payerBefore = await balance(payer.address);
console.log(`program ${PROGRAM} · rpc ${RPC_URL} · fee ${config.feeBps} bps · treasury ${config.treasury}`);
console.log(`payer ${payer.address} (${fmt(payerBefore)})`);
if (payerBefore < PURSE * 3n + 1_000_000n) {
  console.error(`the payer needs at least ${fmt(PURSE * 3n)} to fund three wallets`);
  process.exit(2);
}

const relay = await startRelay(0);
const { server, url } = await serve();
const browser = await launchChromium();

/** The wallet hook: every transaction a page signs is named here, and a settle is predicted before it is sent. */
const DISC = Object.fromEntries(
  ['open_room', 'join_room', 'cancel_room', 'settle', 'claim_timeout', 'open_hall', 'join_hall', 'lock_hall', 'cancel_hall', 'settle_hall', 'claim_timeout_hall'].map((n) => [
    sha256Hex(`global:${n}`).slice(0, 16),
    n,
  ]),
);
const links = [];
let prediction = null;
let hookError = null;
function programInstructions(messageHex) {
  const message = getCompiledTransactionMessageDecoder().decode(Buffer.from(messageHex, 'hex'));
  return message.instructions
    .filter((ix) => message.staticAccounts[ix.programAddressIndex] === PROGRAM)
    .map((ix) => {
      const data = Buffer.from(ix.data ?? []);
      return { name: DISC[data.subarray(0, 8).toString('hex')] ?? 'unknown', data };
    });
}
async function onWalletTransaction(who, event) {
  try {
    const names = programInstructions(event.messageHex).map((ix) => ix.name);
    const label = names.length ? names.join('+') : 'transaction';
    if (event.stage === 'beforeSend') {
      console.log(`    ${who} signs ${label}`);
      const settle = programInstructions(event.messageHex).find((ix) => ix.name === 'settle_hall');
      if (settle) prediction = await predictSettlement(settle.data.subarray(8, 40).toString('hex'));
    } else if (event.stage === 'sent') {
      links.push({ label: `${label} (${who})`, signature: event.signature });
      console.log(`    ${who} sent ${label}: ${explorer(event.signature)}`);
    } else if (event.stage === 'failed') {
      console.log(`    ${who}: ${label} failed: ${event.error}`);
    }
  } catch (e) {
    hookError = e instanceof Error ? e.message : String(e);
    throw e;
  }
}
let hallPda = null;
async function predictSettlement(seedHex) {
  // The table as it stands the moment before the settle transaction goes out.
  const hall = await readHall(hallPda);
  if (!hall || hall.state !== 'locked') throw new Error('settle_hall signed but the hall is not locked on chain');
  if (commitSeed(seedHex) !== hall.commitment) throw new Error('the revealed seed does not match the hall commitment');
  const before = { seats: [], treasury: await balance(config.treasury) };
  for (const s of hall.seats) before.seats.push(await balance(s.player));
  const replay = engineReplay(hall, seedHex);
  console.log(
    `    engine replay (seed ${seedHex.slice(0, 12)}…, entropy ${hall.entropy.slice(0, 12)}…): ${replay.winningCards} winning card(s) on ball ${replay.ball}; cards won per seat ${replay.shares.join('/')}`,
  );
  return { hall, seedHex, before, ...replay };
}

async function player(name, wallet) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  await installTestWallet(ctx, wallet, { rpcUrl: RPC_URL, onTransaction: (event) => onWalletTransaction(name, event) });
  await ctx.addInitScript(
    ({ relayUrl, name }) => {
      localStorage.setItem('beach-bingo:relays', relayUrl);
      localStorage.setItem('beach-bingo', JSON.stringify({ state: { onboarded: true, profile: { name, avatar: '🦀' } }, version: 1 }));
    },
    { relayUrl: relay.url, name },
  );
  const page = await ctx.newPage();
  const errors = [];
  const noise = [];
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // The browser logs every non-2xx response (the public RPC's 429s) as a console error; that is
    // not an app error. Everything the app itself reports as an error fails the run.
    if (/Failed to load resource/.test(m.text())) noise.push(m.text());
    else errors.push(`${name} console: ${m.text()}`);
  });
  return { name, wallet, ctx, page, errors, noise };
}
const connectWallet = (p, opts = {}) => connectWalletIn(p, { check, purse: PURSE, ...opts });
const joinByCode = (p, code) => joinByCodeAt(p.page, url, code);
const seatLine = (page, name) => page.locator('.room__players li', { hasText: name }).first();
/** Pick a value in the labelled picker row of the stake panel ("Seats", "My cards", "Cards"). */
async function pick(page, label, value) {
  const button = page.locator('.stake .stake__row', { hasText: label }).locator('.segmented button', { hasText: new RegExp(`^${value}$`) });
  await button.click({ force: true, timeout: 20_000 });
  check((await button.getAttribute('aria-checked')) === 'true', `${label} ${value} selected`);
}
const results = async (page) => ({
  title: await text(page, '.popup .ribbon__title'),
  lines: await page.locator('.room__results li').allTextContents(),
  balls: await text(page, '.room__info .room-stat:nth-child(3) b'),
});

const wallets = { host: await createTestWallet('Test Wallet (Ana)'), bo: await createTestWallet('Test Wallet (Bo)'), cy: await createTestWallet('Test Wallet (Cy)') };
console.log(`throwaway wallets: host ${wallets.host.address} · Bo ${wallets.bo.address} · Cy ${wallets.cy.address}`);
let funded = false;
let ana = null;
let bo = null;
let cy = null;
const everyone = () => [ana, bo, cy].filter(Boolean);
try {
  const fund = await sendFrom(payer, [
    transferIx(payer.address, wallets.host.address, PURSE),
    transferIx(payer.address, wallets.bo.address, PURSE),
    transferIx(payer.address, wallets.cy.address, PURSE),
  ]);
  funded = true;
  links.push({ label: 'fund three wallets (payer)', signature: fund.signature });
  console.log(`funded three wallets with ${fmt(PURSE)}: ${explorer(fund.signature)}`);

  console.log('Staked Wave Rush hall');
  ana = await player('Ana', wallets.host);
  bo = await player('Bo', wallets.bo);
  cy = await player('Cy', wallets.cy);

  /* ---------- Host: lobby, wallet, the table ---------- */
  const code = await openWaveRushRoom(ana.page, url);
  check(/^[A-Z2-9]{5}$/.test(code), `host opened room ${code}`);
  hallPda = await halls.hallAddress(address(wallets.host.address), code);
  const anaCoins = await coins(ana.page);
  const commitmentPrefix = /commitment ([0-9a-f]{12})/.exec(await text(ana.page, '.room__fair'))?.[1];
  check(!!commitmentPrefix, `lobby shows the seed commitment (${commitmentPrefix}…)`);
  await connectWallet(ana);
  const hostBefore = await balance(wallets.host.address);

  const mode = ana.page.locator('.stake .segmented button', { hasText: /^Hall$/ });
  await mode.click({ force: true, timeout: 20_000 });
  check((await mode.getAttribute('aria-checked')) === 'true', 'the stake panel switched to Hall');
  const preset = ana.page.locator('.stake .segmented button', { hasText: STAKE_LABEL });
  await preset.click({ force: true, timeout: 20_000 });
  check((await preset.getAttribute('aria-checked')) === 'true', `${STAKE_LABEL} a card selected`);
  await pick(ana.page, 'Seats', SEATS);
  await pick(ana.page, 'My cards', CARDS.host);
  await press(ana.page, new RegExp(`^Open a table · ${CARDS.host} cards · ${sol(STAKE * BigInt(CARDS.host)).replace('.', '\\.')}$`), '.stake');
  await ana.page.locator('.stake__title', { hasText: `Staked hall · ${STAKE_LABEL} a card · 1 of ${SEATS} seats · open` }).waitFor({ timeout: 120_000 });
  let hall = await until('the hall account on chain', () => readHall(hallPda), (h) => h?.state === 'open');
  check(
    hall.host === wallets.host.address && hall.stakePerCard === STAKE && hall.maxPlayers === SEATS && hall.code === code && hall.cardsSold === CARDS.host,
    `on chain: hall ${shortAddress(hallPda)} open · host ${shortAddress(hall.host)} · ${fmt(hall.stakePerCard)} a card · ${SEATS} seats · code ${hall.code}`,
  );
  check(hall.seats.length === 1 && hall.seats[0].player === wallets.host.address && hall.seats[0].cards === CARDS.host, `the host holds seat 1 with ${CARDS.host} cards`);
  check(hall.commitment.startsWith(commitmentPrefix), 'the table was opened with the lobby commitment');
  check(hall.lamports > STAKE * BigInt(CARDS.host), `the hall holds the host's deposit plus rent (${fmt(hall.lamports)})`);
  check(hostBefore - (await balance(wallets.host.address)) > STAKE * BigInt(CARDS.host), 'the host paid its cards, the rent and a fee');
  const stat = (page, n) => page.locator('.room__info .room-stat').nth(n);
  check((await stat(ana.page, 0).textContent()).includes('A card') && (await stat(ana.page, 0).locator('b').textContent()) === '◎0.01', 'the info bar shows the stake per card');
  check((await stat(ana.page, 1).textContent()).includes('Seats') && (await stat(ana.page, 1).locator('b').textContent()) === `1/${SEATS}`, `the info bar counts seats (1/${SEATS})`);
  check((await ana.page.getByRole('button', { name: /\+\d card/ }).count()) === 0, 'no cards are for sale in a staked hall');
  check(/you · 2 cards/.test(await seatLine(ana.page, 'Ana').textContent()), "the host's own seat reads 'you · 2 cards'");
  check(await ana.page.locator('button:disabled', { hasText: /^Start · once the table is locked$/ }).isVisible(), "the host's Start waits for the lock");

  /* ---------- Guests buy seats on chain ---------- */
  await joinByCode(bo, code);
  await bo.page.locator('.stake__title', { hasText: `Staked hall · ${STAKE_LABEL} a card · 1 of ${SEATS} seats · open` }).waitFor({ timeout: 30_000 });
  check(true, `guest's lobby shows the table (${await text(bo.page, '.stake__title')})`);
  check(/Ana.*2 cards/.test(await seatLine(bo.page, 'Ana').textContent()), "the guest sees the host's seat with 2 cards");
  check(/no seat yet/.test(await seatLine(bo.page, 'Bo').textContent()), 'the guest is listed without a seat');
  check((await bo.page.getByRole('button', { name: /\+\d card/ }).count()) === 0, 'the guest cannot buy cards with coins');
  const boCoins = await coins(bo.page);
  await connectWallet(bo);
  const boBefore = await balance(wallets.bo.address);
  await pick(bo.page, 'Cards', CARDS.bo);
  await press(bo.page, new RegExp(`^Take a seat · ${sol(STAKE * BigInt(CARDS.bo)).replace('.', '\\.')}$`), '.stake', 90_000);
  await bo.page.locator('.stake .small-note', { hasText: /Your seat is in ✓ · 1 card\./ }).waitFor({ timeout: 120_000 });
  hall = await until('the second seat on chain', () => readHall(hallPda), (h) => h?.seats.length === 2);
  check(hall.state === 'open' && hall.seats[1].player === wallets.bo.address && hall.seats[1].cards === CARDS.bo && hall.cardsSold === CARDS.host + CARDS.bo, `on chain: Bo holds seat 2 with ${CARDS.bo} card · ${hall.cardsSold} cards sold`);
  check(boBefore - (await balance(wallets.bo.address)) === STAKE * BigInt(CARDS.bo) + TX_FEE, 'Bo paid exactly one card and one fee');

  await joinByCode(cy, code);
  await cy.page.locator('.stake__title', { hasText: `2 of ${SEATS} seats · open` }).waitFor({ timeout: 30_000 });
  const cyCoins = await coins(cy.page);
  await connectWallet(cy);
  const cyBefore = await balance(wallets.cy.address);
  await pick(cy.page, 'Cards', CARDS.cy);
  await press(cy.page, new RegExp(`^Take a seat · ${sol(STAKE * BigInt(CARDS.cy)).replace('.', '\\.')}$`), '.stake', 90_000);
  await cy.page.locator('.stake .small-note', { hasText: /Your seat is in ✓ · 3 cards\./ }).waitFor({ timeout: 120_000 });
  hall = await until('the third seat on chain', () => readHall(hallPda), (h) => h?.seats.length === 3);
  const cardsSold = CARDS.host + CARDS.bo + CARDS.cy;
  check(hall.state === 'open' && hall.seats[2].player === wallets.cy.address && hall.seats[2].cards === CARDS.cy && hall.cardsSold === cardsSold, `on chain: Cy holds seat 3 with ${CARDS.cy} cards · ${hall.cardsSold} cards sold · still open`);
  check(cyBefore - (await balance(wallets.cy.address)) === STAKE * BigInt(CARDS.cy) + TX_FEE, 'Cy paid exactly three cards and one fee');

  // Every lobby lists the chain's seats, named by the peers who announced the wallets.
  await ana.page.locator('.room__players li', { hasText: /Cy.*3 cards/ }).waitFor({ timeout: 30_000 });
  for (const p of everyone()) {
    const rows = (await p.page.locator('.room__players li').allTextContents()).map((t) => t.replace(/\s+/g, ' ').trim());
    const ok = rows.length === 3 && /Ana.*2 cards/.test(rows[0]) && /Bo.*1 card/.test(rows[1]) && /Cy.*3 cards/.test(rows[2]) && rows.filter((r) => /you ·/.test(r)).length === 1;
    check(ok, `${p.name}'s lobby lists the three seats in join order with their cards (${rows.join(' | ')})`);
  }
  await ana.page.locator('.stake__title', { hasText: `3 of ${SEATS} seats · open` }).waitFor({ timeout: 30_000 });
  check(await ana.page.locator('button:disabled', { hasText: /^Start · once the table is locked$/ }).isVisible(), "the host's Start is still waiting for the lock");
  check((await stat(ana.page, 1).locator('b').textContent()) === `3/${SEATS}`, `the info bar counts 3/${SEATS} seats`);

  /* ---------- A guest locks the table ---------- */
  check((await ana.page.locator('.stake button', { hasText: /^Lock the table$/ }).count()) === 0, 'the host is not offered the lock');
  await press(bo.page, /^Lock the table$/, '.stake', 60_000);
  hall = await until('the lock on chain', () => readHall(hallPda), (h) => h?.state === 'locked');
  check(hall.entropy !== ZERO_ENTROPY && hall.lockedSlot > 0n && hall.cardsSold === cardsSold, `on chain: locked · entropy ${hall.entropy.slice(0, 12)}… · locked slot ${hall.lockedSlot}`);
  await bo.page.locator('.stake .small-note', { hasText: /The table is locked ✓/ }).waitFor({ timeout: 60_000 });
  check(true, "the locking guest reads 'The table is locked ✓'");
  await cy.page.locator('.stake__title', { hasText: /· locked$/ }).waitFor({ timeout: 60_000 });
  check(true, "the other guest's panel reads 'locked'");

  /* ---------- Start: the host's button enables once the chain says locked ---------- */
  await ana.page.locator('.stake .small-note', { hasText: /The table is locked: 3 players, 6 cards/ }).waitFor({ timeout: 60_000 });
  const start = ana.page.locator('button:not([disabled])', { hasText: /^Start · 3 players$/ });
  await start.waitFor({ timeout: 60_000 });
  check(true, "host's Start enabled with the table locked on chain");
  await start.click({ force: true });
  for (const p of everyone()) await p.page.locator('.room__count', { hasText: /Starting in/ }).waitFor({ timeout: 15_000 });
  check(true, 'all three count down');
  const cardCounts = { Ana: await ana.page.locator('.room__card').count(), Bo: await bo.page.locator('.room__card').count(), Cy: await cy.page.locator('.room__card').count() };
  check(cardCounts.Ana === CARDS.host && cardCounts.Bo === CARDS.bo && cardCounts.Cy === CARDS.cy, `each screen shows its on-chain seat's cards (Ana ${cardCounts.Ana}, Bo ${cardCounts.Bo}, Cy ${cardCounts.Cy})`);
  await ana.page.locator('.popup').waitFor({ timeout: 120_000 });
  await bo.page.locator('.popup').waitFor({ timeout: 30_000 });
  await cy.page.locator('.popup').waitFor({ timeout: 30_000 });
  const ra = await results(ana.page);
  const rb = await results(bo.page);
  const rc = await results(cy.page);
  check(
    ra.lines.join('|') === rb.lines.join('|') && ra.lines.join('|') === rc.lines.join('|') && ra.balls === rb.balls && ra.balls === rc.balls,
    `same result on all three screens after ${ra.balls} balls: ${ra.lines.join(' | ')}`,
  );
  check([ra.title, rb.title, rc.title].includes('You Win'), `somebody won (Ana: ${ra.title} / Bo: ${rb.title} / Cy: ${rc.title})`);
  check((await coins(ana.page)) === anaCoins && (await coins(bo.page)) === boCoins && (await coins(cy.page)) === cyCoins, `coins never moved during the round (Ana ${anaCoins}, Bo ${boCoins}, Cy ${cyCoins})`);

  /* ---------- A guest settles; the other screens see it ---------- */
  for (const p of everyone()) check(await p.page.locator('.popup .stake button', { hasText: /^Settle on chain$/ }).isVisible(), `${p.name}'s popup offers to settle (anyone can)`);
  const before = await readHall(hallPda);
  check(before?.state === 'locked' && before.entropy === hall.entropy, 'the hall is still locked on chain before settling');
  await press(cy.page, /^Settle on chain$/, '.popup .stake', 30_000);
  const link = cy.page.locator('.popup .stake a[href*="explorer.solana.com/tx/"]');
  await link.waitFor({ timeout: 150_000 });
  check(hookError === null, `the settle was predicted before it was sent${hookError ? ` (${hookError})` : ''}`);
  const settleUrl = await link.getAttribute('href');
  const settleSig = /tx\/([1-9A-HJ-NP-Za-km-z]+)/.exec(settleUrl)?.[1];
  const cySent = await cy.page.evaluate(() => window.__beachBingoTestWallet.sent.map((s) => s.signature));
  check(cySent.at(-1) === settleSig && /Settled ✓/.test(await text(cy.page, '.popup .stake')), `Cy shows Settled ✓ with the explorer link ${settleUrl}`);
  await ana.page.locator('.popup .stake button', { hasText: /^Settled by another player$/ }).waitFor({ timeout: 60_000 });
  await bo.page.locator('.popup .stake button', { hasText: /^Settled by another player$/ }).waitFor({ timeout: 60_000 });
  check(true, "the host's and Bo's screens read 'Settled by another player'");
  await until('the hall account to close after settling', () => readHall(hallPda), (h) => h === null);
  check(true, 'the hall account is gone');

  check(prediction !== null, 'the engine replay ran on the pre-settlement seats and entropy and the revealed seed');
  if (prediction) {
    const seats = prediction.hall.seats;
    const split = halls.splitHallPot(prediction.hall.stakePerCard, prediction.hall.cardsSold, config.feeBps, prediction.winningCards);
    const rent = prediction.hall.lamports - split.pot; // the account's rent goes back to the host, who paid it
    const gained = [];
    for (let i = 0; i < seats.length; i++) {
      const settler = seats[i].player === wallets.cy.address; // Cy paid the settle's fee
      gained.push((await balance(seats[i].player)) - prediction.before.seats[i] - (i === 0 ? rent : 0n) + (settler ? TX_FEE : 0n));
    }
    const treasuryGained = (await balance(config.treasury)) - prediction.before.treasury;
    const expected = prediction.shares.map((n) => split.share * BigInt(n));
    const show = (xs) => xs.map((x, i) => `seat ${i + 1} ${fmt(x)}`).join(' · ');
    check(
      gained.every((g, i) => g === expected[i]) && treasuryGained === split.fee + split.dust,
      `the chain paid each seat what the engine's replay says (${prediction.winningCards} winning card(s) on ball ${prediction.ball}, ${fmt(split.share)} a card): ${show(gained)} · treasury ${fmt(treasuryGained)}`,
    );
    if (!gained.every((g, i) => g === expected[i])) console.log(`    expected ${show(expected)} · treasury ${fmt(split.fee + split.dust)}`);
    check(gained.reduce((a, b) => a + b, 0n) + treasuryGained === split.pot, `every lamport of the ${fmt(split.pot)} pot is accounted for`);
    const screens = [
      [ra.title, prediction.shares[0]],
      [rb.title, prediction.shares[1]],
      [rc.title, prediction.shares[2]],
    ];
    check(screens.every(([title, won]) => (title === 'You Win') === won > 0), 'every screen named the same winners as the engine and the chain');
    check(prediction.ball === Number(ra.balls), `the screens stopped on the engine's winning ball (${ra.balls})`);
    const noteOf = async (page) => (await text(page, '.popup .stake')).replace(/\s+/g, ' ');
    const winnersShown = (await Promise.all(everyone().map((p) => noteOf(p.page)))).map((n, i) => [n, prediction.shares[i]]);
    check(
      winnersShown.every(([note, won]) => (won > 0 ? new RegExp(`${won === 1 ? 'One' : won} of your cards (was|were) full on the winning ball: ${fmt(split.share).replace('.', '\\.')} each`).test(note) : /missed the winning ball/.test(note))),
      'each results popup says how many of my cards won and the share each pays',
    );
  }
  check((await coins(ana.page)) === anaCoins && (await coins(bo.page)) === boCoins && (await coins(cy.page)) === cyCoins, 'coins in the top bar are unchanged after settling');

  for (const p of everyone()) {
    for (const e of p.errors) check(false, `page error: ${e.slice(0, 300)}`);
    if (p.noise.length) console.log(`    (${p.name}: ${p.noise.length} resource-load console line(s) ignored, e.g. ${p.noise[0].slice(0, 120)})`);
  }
} catch (e) {
  failures++;
  console.log(`  ✗ ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
  if (hookError) console.log(`  ✗ wallet hook: ${hookError}`);
  for (const p of everyone()) for (const err of p.errors) console.log(`  ✗ page error: ${err.slice(0, 300)}`);
} finally {
  await Promise.allSettled(everyone().map((p) => p.ctx.close()));
  await browser.close();
  server.close();
  await relay.close();
  if (funded) {
    // Leave nothing on devnet: a table still open is called off from here, and the wallets are swept back to the payer.
    try {
      const left = hallPda ? await readHall(hallPda) : null;
      if (left?.state === 'open') {
        const cancelled = await sendFrom(wallets.host, [halls.cancelHallIx(left)]);
        console.log(`cleanup: called off the open table ${explorer(cancelled.signature)}`);
      } else if (left?.state === 'locked') {
        console.log(`cleanup: hall ${hallPda} is still locked on chain; anyone can refund it after the timeout (claim_timeout_hall)`);
      }
    } catch (e) {
      console.log(`cleanup: could not inspect the hall (${e instanceof Error ? e.message : e})`);
    }
    for (const w of [wallets.host, wallets.bo, wallets.cy]) {
      try {
        const left = await balance(w.address);
        if (left > 10_000n) {
          const swept = await sendFrom(w, [transferIx(w.address, payer.address, left - TX_FEE)]);
          links.push({ label: `sweep ${w.name}`, signature: swept.signature });
          console.log(`swept ${fmt(left - TX_FEE)} back from ${w.name}: ${explorer(swept.signature)}`);
        }
      } catch (e) {
        console.log(`sweep from ${w.name} failed (${e instanceof Error ? e.message : e}); its seed is gone with this run`);
      }
    }
    console.log(`payer ${payer.address}: ${fmt(payerBefore)} → ${fmt(await balance(payer.address))}`);
  }
}
if (links.length) {
  console.log('transactions:');
  for (const l of links) console.log(`  ${l.label}: ${explorer(l.signature)}`);
}
console.log(failures ? `${failures} failure(s)` : 'all checks passed');
process.exit(failures ? 1 : 0);
