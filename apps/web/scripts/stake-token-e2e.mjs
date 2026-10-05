#!/usr/bin/env node
// Two browsers play a STAKED Wave Rush room in a registered TOKEN (the SKR look-alike by default)
// against the wave_duel program on Solana devnet, through the real lobby: a local Nostr relay for
// discovery, WebRTC between two Chromium contexts, and a Wallet Standard test wallet injected into
// each page so the app's own wallet layer signs and sends every transaction. The harness funds the
// throwaway wallets with SOL and the token from the key pair.
//
// The host picks the token in the stake panel (SKR is preselected when the wallet holds it) and
// opens the escrow with the smallest preset; the guest joins by code and deposits; the host starts
// once the chain says `ready`; both play to the results; the host settles with `settle_token`; the
// guest's screen sees it settled. Every token account's base units are checked against the
// engine's own replay (buildRoom with the escrow's entropy and the revealed seed), the room and its
// vault must be gone, the coin balance must never move, and any page error fails the run.
//
//   node scripts/stake-token-e2e.mjs                 (from apps/web; Node 22.18+ strips the .ts imports itself)
//
// Same environment as scripts/stake-e2e.mjs (KEYPAIR, RPC_URL, WAVE_DUEL_PROGRAM, CHROMIUM_PATH,
// STAKE_E2E_SKIP_BUILD=1), plus STAKE_MINT (the registered mint to stake; default the SKR
// look-alike). The build gets the program config's SGT group as VITE_SGT_GROUP. Each wallet gets
// 0.08 SOL and one stake of the token, and both are swept back to the key pair at the end.
import { address, createSolanaRpc, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { commitSeed, rooms, sha256Hex } from '@beach-bingo/engine';
import { buildRoom } from '../src/rooms/live/protocol.ts';
import { formatAmount, knownSymbol } from '../src/solana/tokens.ts';
import * as duel from '../src/solana/waveDuel.ts';
import { ataAddress, fetchMintEntry, vaultAddress } from '../src/solana/waveToken.ts';
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
  until,
  ZERO_ENTROPY,
} from './qa/stake-lib.mjs';
import { createTestWallet, installTestWallet } from './qa/test-wallet.mjs';
import { fundTokens, sweepTokens, tokenBalance } from './qa/token-lib.mjs';

const PROGRAM = process.env.WAVE_DUEL_PROGRAM || DEFAULT_PROGRAM;
const RPC_URL = process.env.RPC_URL || DEFAULT_RPC;
const MINT = address(process.env.STAKE_MINT || 'GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz');
const PURSE = 80_000_000n; // SOL per throwaway wallet: the room's and the vault's rent, a few fees

duel.configureProgram(address(PROGRAM));
const rpc = createSolanaRpc(RPC_URL);
const balance = (addr) => retry(async () => (await rpc.getBalance(address(addr), { commitment: 'confirmed' }).send()).value);
const readRoom = (pda) => retry(() => duel.fetchRoom(rpc, pda));
const held = (ata) => retry(() => tokenBalance(rpc, ata));
const sendFrom = (wallet, instructions) => retry(() => duel.sendSigned(rpc, wallet.address, [wallet.keyPair], instructions), 3);

function engineReplay(room, serverSeed) {
  const state = buildRoom(
    rooms.ROOM_PRESETS.waveRush,
    room.commitment,
    serverSeed,
    [
      { id: 'host', name: 'Host', cards: 1 },
      { id: 'guest', name: 'Guest', cards: 1 },
    ],
    room.entropy,
  );
  while (state.phase === 'drawing') rooms.drawNext(state);
  const win = state.wins[0];
  return { winners: win.winners.map((w) => w.playerId), ball: win.ballCount };
}
function expectedGains(winners, pot, feeBps) {
  const fee = (pot * BigInt(feeBps)) / 10_000n;
  const prize = pot - fee;
  if (winners.length === 2) return { host: prize / 2n, guest: prize / 2n, treasury: fee + (prize % 2n) };
  return winners[0] === 'host' ? { host: prize, guest: 0n, treasury: fee } : { host: 0n, guest: prize, treasury: fee };
}
const same = (a, b) => a.host === b.host && a.guest === b.guest && a.treasury === b.treasury;

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures++;
};

/* ---------- Go ---------- */

const KEYPAIR = keypairPath();
const payer = await loadWallet(KEYPAIR);
const config = await retry(() => duel.fetchConfig(rpc));
if (!config) {
  console.error('the wave_duel config is not initialised on this cluster (wave-duel-admin.mjs init-config)');
  process.exit(2);
}
const entry = await retry(() => fetchMintEntry(rpc, MINT));
if (!entry?.enabled) {
  console.error(`${MINT} is not an enabled mint of the registry (wave-duel-admin.mjs show-mints)`);
  process.exit(2);
}
const SYMBOL = knownSymbol(MINT) ?? 'token';
const STAKE = entry.minStake; // the smallest preset the picker offers is the registry minimum
const amount = (base) => formatAmount(base, entry.decimals, SYMBOL);
const STAKE_LABEL = amount(STAKE);
build(PROGRAM, RPC_URL, { sgtGroup: config.sgtGroup });
const payerBefore = await balance(payer.address);
console.log(`program ${PROGRAM} · rpc ${RPC_URL} · mint ${MINT} (${SYMBOL}, fee ${entry.feeBps} bps) · treasury ${config.treasury}`);
console.log(`payer ${payer.address} (${fmt(payerBefore)})`);

const relay = await startRelay(0);
const { server, url } = await serve();
const browser = await launchChromium();

const DISC = Object.fromEntries(
  ['open_room', 'join_room', 'cancel_room', 'settle', 'claim_timeout', 'open_room_token', 'join_room_token', 'cancel_room_token', 'settle_token', 'claim_timeout_token', 'claim_credit', 'prove_seeker_room'].map((n) => [
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
      const settle = programInstructions(event.messageHex).find((ix) => ix.name === 'settle_token');
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
let roomPda = null;
let atas = null;
async function predictSettlement(seedHex) {
  const room = await readRoom(roomPda);
  if (!room || room.state !== 'ready') throw new Error('settle_token signed but the room is not ready on chain');
  if (commitSeed(seedHex) !== room.commitment) throw new Error('the revealed seed does not match the escrow commitment');
  const before = { host: await held(atas.host), guest: await held(atas.guest), treasury: await held(entry.treasuryAta) };
  const replay = engineReplay(room, seedHex);
  console.log(`    engine replay (seed ${seedHex.slice(0, 12)}…, entropy ${room.entropy.slice(0, 12)}…): ${replay.winners.join(' and ')} on ball ${replay.ball}`);
  return { room, seedHex, before, ...replay };
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
    if (/Failed to load resource/.test(m.text())) noise.push(m.text());
    else errors.push(`${name} console: ${m.text()}`);
  });
  return { name, wallet, ctx, page, errors, noise };
}
const connectWallet = (p, opts = {}) => connectWalletIn(p, { check, purse: PURSE, ...opts });
/** Pick a value in a labelled picker row of the stake panel ("Token"). */
async function pick(page, label, value) {
  const button = page.locator('.stake .stake__row', { hasText: label }).locator('.segmented button', { hasText: new RegExp(`^${value}$`) });
  await button.click({ force: true, timeout: 20_000 });
  check((await button.getAttribute('aria-checked')) === 'true', `${label} ${value} selected`);
}

const wallets = { host: await createTestWallet('Test Wallet (Ana)'), guest: await createTestWallet('Test Wallet (Bo)') };
console.log(`throwaway wallets: host ${wallets.host.address} · guest ${wallets.guest.address}`);
let funded = false;
let ana = null;
let bo = null;
try {
  const fund = await sendFrom(payer, [transferIx(payer.address, wallets.host.address, PURSE), transferIx(payer.address, wallets.guest.address, PURSE)]);
  links.push({ label: 'fund both wallets with SOL (payer)', signature: fund.signature });
  const tokens = await retry(() => fundTokens(rpc, payer, entry, [address(wallets.host.address), address(wallets.guest.address)], STAKE), 3);
  funded = true;
  atas = { host: tokens.atas[0], guest: tokens.atas[1] };
  links.push({ label: `fund both wallets with ${SYMBOL} (payer)`, signature: tokens.signature });
  console.log(`funded both with ${fmt(PURSE)} (${explorer(fund.signature)}) and ${STAKE_LABEL} (${explorer(tokens.signature)})`);

  console.log(`Staked Wave Rush in ${SYMBOL}`);
  ana = await player('Ana', wallets.host);
  bo = await player('Bo', wallets.guest);

  /* ---------- Host: lobby, wallet, the token picker, the escrow ---------- */
  const code = await openWaveRushRoom(ana.page, url);
  check(/^[A-Z2-9]{5}$/.test(code), `host opened room ${code}`);
  roomPda = await duel.roomAddress(address(wallets.host.address), code);
  const anaCoins = await coins(ana.page);
  const commitmentPrefix = /commitment ([0-9a-f]{12})/.exec(await text(ana.page, '.room__fair'))?.[1];
  await connectWallet(ana, { signIn: true });
  // The bridge reads the wallet's SKR after the connection: once it has, the picker preselects SKR and the badge shows.
  await ana.page.locator('.stake .badge--skr').waitFor({ timeout: 60_000 }).catch(() => undefined);
  const preselected = await ana.page.locator('.stake .stake__row', { hasText: 'Token' }).locator('.segmented button[aria-checked="true"]').textContent();
  check(preselected?.trim() === SYMBOL || SYMBOL !== 'SKR', `the picker preselected ${preselected?.trim()} for a wallet holding ${SYMBOL}`);
  await pick(ana.page, 'Token', SYMBOL);
  check((await text(ana.page, '.stake__title')) === `Play for ${SYMBOL} on devnet`, `the stake panel offers ${SYMBOL} on devnet`);
  const feeText = await text(ana.page, '.stake .small-note');
  const expectedFee = `House fee ${entry.feeBps / 100}%${SYMBOL === 'SKR' ? ' with SKR' : ''}`;
  check(feeText.includes(expectedFee), `the fee line reads the registry tier (${expectedFee})`);
  check(await ana.page.locator('.stake .badge--skr').isVisible(), "the 'SKR ready' badge shows for a wallet holding SKR");
  const preset = ana.page.locator('.stake .segmented button', { hasText: new RegExp(`^${STAKE_LABEL}$`) });
  await preset.click({ force: true, timeout: 20_000 });
  check((await preset.getAttribute('aria-checked')) === 'true', `${STAKE_LABEL} preset selected`);
  const hostTokensBefore = await held(atas.host);
  await press(ana.page, new RegExp(`^Open escrow · ${STAKE_LABEL}$`), '.stake');
  await ana.page.locator('.stake__title', { hasText: new RegExp(`Escrow .* · ${STAKE_LABEL} each · open`) }).waitFor({ timeout: 120_000 });
  let room = await until('the room account on chain', () => readRoom(roomPda), (r) => r?.state === 'open');
  const vault = await vaultAddress(roomPda, MINT, entry.tokenProgram);
  check(room.host === wallets.host.address && room.stake === STAKE && room.mint === MINT && room.tokenProgram === entry.tokenProgram && room.feeBps === entry.feeBps, `on chain: room ${shortAddress(roomPda)} open · mint ${shortAddress(room.mint)} · ${STAKE_LABEL} · fee ${room.feeBps} bps`);
  check(room.commitment.startsWith(commitmentPrefix), 'the escrow was opened with the lobby commitment');
  check((await held(vault)) === STAKE && hostTokensBefore - (await held(atas.host)) === STAKE, `the vault ${shortAddress(vault)} holds the host's ${STAKE_LABEL}`);
  check((await text(ana.page, '.room__info .room-stat b')) === STAKE_LABEL, `the info bar shows the stake in ${SYMBOL} (${await text(ana.page, '.room__info .room-stat b')})`);
  check((await ana.page.getByRole('button', { name: /\+\d card/ }).count()) === 0, 'no cards are for sale in a staked room');

  /* ---------- Guest joins and deposits the token ---------- */
  await joinByCodeAt(bo.page, url, code);
  await ana.page.locator('.room__players li', { hasText: 'Bo' }).waitFor({ timeout: 30_000 });
  await bo.page.locator('.stake__title', { hasText: `Staked room · ${STAKE_LABEL} each` }).waitFor({ timeout: 30_000 });
  check(true, `guest's lobby shows the token stake (${await text(bo.page, '.stake__title')})`);
  check((await text(bo.page, '.room__info .room-stat b')) === STAKE_LABEL, `guest's info bar shows ${STAKE_LABEL}`);
  const boCoins = await coins(bo.page);
  await connectWallet(bo);
  const guestTokensBefore = await held(atas.guest);
  await press(bo.page, new RegExp(`^Deposit ${STAKE_LABEL} and play$`), '.stake', 90_000);
  await bo.page.locator('.stake .small-note', { hasText: /Your deposit is in/ }).waitFor({ timeout: 120_000 });
  room = await until('the room to be ready on chain', () => readRoom(roomPda), (r) => r?.state === 'ready');
  check(room.guest === wallets.guest.address && room.entropy !== ZERO_ENTROPY && room.joinedSlot > 0n, `on chain: ready · guest ${shortAddress(room.guest)} · entropy ${room.entropy.slice(0, 12)}…`);
  check(guestTokensBefore - (await held(atas.guest)) === STAKE && (await held(vault)) === 2n * STAKE, `the guest paid exactly ${STAKE_LABEL}; the vault holds both stakes`);

  /* ---------- Start, play, settle ---------- */
  await ana.page.locator('.stake .small-note', { hasText: /Both deposits are in/ }).waitFor({ timeout: 60_000 });
  const start = ana.page.locator('button:not([disabled])', { hasText: /Start · 2 players/ });
  await start.waitFor({ timeout: 60_000 });
  await start.click({ force: true });
  await ana.page.locator('.room__count', { hasText: /Starting in/ }).waitFor({ timeout: 15_000 });
  await bo.page.locator('.room__count', { hasText: /Starting in/ }).waitFor({ timeout: 15_000 });
  check(true, 'both count down');
  await ana.page.locator('.popup').waitFor({ timeout: 120_000 });
  await bo.page.locator('.popup').waitFor({ timeout: 30_000 });
  const results = async (page) => ({ title: await text(page, '.popup .ribbon__title'), lines: await page.locator('.room__results li').allTextContents(), balls: await text(page, '.room__info .room-stat:nth-child(3) b') });
  const ra = await results(ana.page);
  const rb = await results(bo.page);
  check(ra.lines.join('|') === rb.lines.join('|') && ra.balls === rb.balls, `same result on both screens after ${ra.balls} balls`);
  check([ra.title, rb.title].includes('You Win'), `somebody won (Ana: ${ra.title} / Bo: ${rb.title})`);
  check((await coins(ana.page)) === anaCoins && (await coins(bo.page)) === boCoins, 'coins never moved during the round');

  await press(ana.page, /^Settle on chain$/, '.popup .stake', 30_000);
  const link = ana.page.locator('.popup .stake a[href*="explorer.solana.com/tx/"]');
  await link.waitFor({ timeout: 150_000 });
  check(hookError === null, `the settle was predicted before it was sent${hookError ? ` (${hookError})` : ''}`);
  check(/Settled ✓/.test(await text(ana.page, '.popup .stake')), `host shows Settled ✓ with the explorer link ${await link.getAttribute('href')}`);
  await bo.page.locator('.popup .stake button', { hasText: /^Settled by the other player$/ }).waitFor({ timeout: 60_000 });
  check(true, "guest's screen reads 'Settled by the other player'");
  await until('the room account to close after settling', () => readRoom(roomPda), (r) => r === null);
  check((await held(vault)) === null, 'the room and its vault are gone');
  check(prediction !== null, 'the engine replay ran on the pre-settlement entropy and the revealed seed');
  if (prediction) {
    const after = { host: await held(atas.host), guest: await held(atas.guest), treasury: await held(entry.treasuryAta) };
    const gained = { host: after.host - prediction.before.host, guest: after.guest - prediction.before.guest, treasury: after.treasury - prediction.before.treasury };
    const expected = expectedGains(prediction.winners, prediction.room.stake * 2n, prediction.room.feeBps);
    const show = (g) => `host +${amount(g.host)} · guest +${amount(g.guest)} · treasury +${amount(g.treasury)}`;
    check(same(gained, expected), `the token accounts hold what the engine named (${prediction.winners.join(' and ')} on ball ${prediction.ball}, fee ${prediction.room.feeBps} bps): ${show(gained)}`);
    if (!same(gained, expected)) console.log(`    expected ${show(expected)}`);
    check((ra.title === 'You Win') === prediction.winners.includes('host') && (rb.title === 'You Win') === prediction.winners.includes('guest'), 'both screens named the same winner as the engine and the chain');
    check(prediction.ball === Number(ra.balls), `the screens stopped on the engine's winning ball (${ra.balls})`);
  }
  check((await coins(ana.page)) === anaCoins && (await coins(bo.page)) === boCoins, 'coins in the top bar are unchanged after settling');
  for (const p of [ana, bo]) {
    for (const e of p.errors) check(false, `page error: ${e.slice(0, 300)}`);
    if (p.noise.length) console.log(`    (${p.name}: ${p.noise.length} resource-load console line(s) ignored)`);
  }
} catch (e) {
  failures++;
  console.log(`  ✗ ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
  if (hookError) console.log(`  ✗ wallet hook: ${hookError}`);
  for (const p of [ana, bo]) for (const err of p?.errors ?? []) console.log(`  ✗ page error: ${err.slice(0, 300)}`);
} finally {
  await Promise.allSettled([ana?.ctx.close(), bo?.ctx.close()]);
  await browser.close();
  server.close();
  await relay.close();
  if (funded) {
    try {
      const left = roomPda ? await readRoom(roomPda) : null;
      if (left?.state === 'open') {
        const cancelled = await sendFrom(wallets.host, [await (await import('../src/solana/waveToken.ts')).cancelRoomTokenIx(left)]);
        console.log(`cleanup: cancelled the open escrow ${explorer(cancelled.signature)}`);
      } else if (left) {
        console.log(`cleanup: room ${roomPda} is still on chain in state ${left.state}${left.settled ? ' (settled, credits outstanding)' : ''}`);
      }
    } catch (e) {
      console.log(`cleanup: could not inspect the escrow (${e instanceof Error ? e.message : e})`);
    }
    for (const w of [wallets.host, wallets.guest]) {
      try {
        const swept = await sweepTokens(rpc, payer, entry, { address: address(w.address), keyPair: w.keyPair });
        if (swept) {
          links.push({ label: `sweep ${SYMBOL} from ${w.name}`, signature: swept.signature });
          console.log(`swept ${amount(swept.held)} and the account rent back from ${w.name}: ${explorer(swept.signature)}`);
        }
        const left = await balance(w.address);
        if (left > 10_000n) {
          const sol = await sendFrom(w, [transferIx(w.address, payer.address, left - 5_000n)]);
          links.push({ label: `sweep SOL from ${w.name}`, signature: sol.signature });
          console.log(`swept ${fmt(left - 5_000n)} back from ${w.name}: ${explorer(sol.signature)}`);
        }
      } catch (e) {
        console.log(`sweep from ${w.name} failed (${e instanceof Error ? e.message : e})`);
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
