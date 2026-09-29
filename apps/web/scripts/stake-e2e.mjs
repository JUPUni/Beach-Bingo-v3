#!/usr/bin/env node
// Two browsers play a STAKED Wave Rush room against the wave_duel program on Solana devnet, the
// way two phones would: a local Nostr relay for discovery (scripts/nostr-relay.mjs), WebRTC between
// two Chromium contexts, and a Wallet Standard test wallet injected into each page
// (scripts/qa/test-wallet.mjs) so the app's own wallet layer signs and sends every transaction.
//
// The host opens an escrow with the smallest preset, cancels it (the stake comes back), opens it
// again; the guest joins by code and deposits; the host starts once the chain says `ready`; both
// play to the results; the host settles on chain; the guest's screen sees it settled. The chain's
// payout is checked against the engine's own replay (buildRoom with the escrow's entropy and the
// revealed seed), the coin balance in the top bar must never move, and any page error fails the run.
//
//   node scripts/stake-e2e.mjs                       (from apps/web; Node 22.18+ strips the .ts imports itself)
//
// It builds the game itself with the devnet flags into apps/web/dist-devnet (the production dist
// is untouched) and serves that under /app/. Environment: KEYPAIR (a funded devnet key pair;
// default .secrets/devnet-deployer.json at the repo root, or the main checkout's when run from a
// git worktree), RPC_URL, WAVE_DUEL_PROGRAM, CHROMIUM_PATH, STAKE_E2E_SKIP_BUILD=1 to reuse
// dist-devnet. Behind an HTTPS_PROXY (the sandbox) Chromium is pointed at it for devnet; loopback
// stays direct. Each throwaway wallet gets 0.08 SOL and is swept back to the payer at the end.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  AccountRole,
  address,
  createKeyPairFromBytes,
  createSolanaRpc,
  getAddressFromPublicKey,
  getCompiledTransactionMessageDecoder,
  getStructEncoder,
  getU32Encoder,
  getU64Encoder,
} from '@solana/kit';
import { commitSeed, rooms, sha256Hex } from '@beach-bingo/engine';
import { buildRoom } from '../src/rooms/live/protocol.ts';
import * as duel from '../src/solana/waveDuel.ts';
import { startRelay } from './nostr-relay.mjs';
import { createTestWallet, installTestWallet } from './qa/test-wallet.mjs';

const WEB = fileURLToPath(new URL('../', import.meta.url));
const ROOT = resolve(WEB, '../..');
const DIST = join(WEB, 'dist-devnet/');
const BASE = '/app/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

const PROGRAM = process.env.WAVE_DUEL_PROGRAM || '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH';
const DEFAULT_RPC = 'https://api.devnet.solana.com';
const RPC_URL = process.env.RPC_URL || DEFAULT_RPC;
const STAKE = 10_000_000n; // the smallest lobby preset: 0.01 SOL
const STAKE_LABEL = duel.formatSol(STAKE);
const PURSE = 80_000_000n; // per throwaway wallet: the stake, the room's rent, a few fees
const TX_FEE = 5_000n;
const ZERO_ENTROPY = '0'.repeat(64);

duel.configureProgram(address(PROGRAM));
const rpc = createSolanaRpc(RPC_URL);
const explorer = (signature) => duel.explorerUrl(signature, 'devnet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const shortAddress = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const fmt = (lamports) => `${lamports < 0n ? '-' : ''}${duel.formatSol(lamports < 0n ? -lamports : lamports)}`;

/* ---------- Setup: key pair, build, static server, Chromium ---------- */

function keypairPath() {
  if (process.env.KEYPAIR) return process.env.KEYPAIR;
  const candidates = [join(ROOT, '.secrets/devnet-deployer.json')];
  try {
    // A git worktree keeps its secrets in the main checkout.
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    candidates.push(join(dirname(resolve(ROOT, common)), '.secrets/devnet-deployer.json'));
  } catch {
    /* not a git checkout */
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    console.error(`no funded devnet key pair: set KEYPAIR or put one at ${candidates[0]}`);
    process.exit(2);
  }
  return found;
}

function build() {
  if (process.env.STAKE_E2E_SKIP_BUILD && existsSync(join(DIST, 'index.html'))) {
    console.log('build: reusing dist-devnet (STAKE_E2E_SKIP_BUILD)');
    return;
  }
  const env = { ...process.env, VITE_SOLANA_CLUSTER: 'devnet', VITE_ENABLE_ONCHAIN_STAKES: 'true', VITE_WAVE_DUEL_PROGRAM: PROGRAM };
  if (RPC_URL !== DEFAULT_RPC) env.VITE_SOLANA_RPC_URL = RPC_URL;
  const out = execFileSync(join(WEB, 'node_modules/.bin/vite'), ['build', '--outDir', 'dist-devnet'], { cwd: WEB, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const built = out.split('\n').find((l) => /built in/.test(l))?.trim() ?? 'built';
  console.log(`build: ${built} → dist-devnet (cluster devnet, stakes on, program ${PROGRAM})`);
}

const serve = () =>
  new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, 'http://x');
      const p = decodeURIComponent(url.pathname);
      if (!p.startsWith(BASE)) return res.writeHead(404).end();
      let file = normalize(join(DIST, p.slice(BASE.length)));
      if (!file.startsWith(DIST)) return res.writeHead(400).end();
      if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
      if (!existsSync(file)) file = join(DIST, 'index.html');
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolveServer({ server, url: `http://127.0.0.1:${server.address().port}${BASE}` }));
  });

function chromiumPath() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* no default install */
  }
  // Playwright's browsers folder with another revision than this playwright-core expects.
  const home = process.env.PLAYWRIGHT_BROWSERS_PATH || join(process.env.HOME || '', '.cache/ms-playwright');
  try {
    const dirs = readdirSync(home)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const d of dirs) {
      const p = join(home, d, 'chrome-linux/chrome');
      if (existsSync(p)) return p;
    }
  } catch {
    /* nothing there */
  }
  return undefined;
}

/* ---------- Chain helpers (the public RPC rate-limits: everything retries gently) ---------- */

async function retry(fn, tries = 8) {
  let wait = 1500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (attempt >= tries || /transaction failed/.test(message)) throw e;
      await sleep(wait);
      wait = Math.min(wait * 2, 8000);
    }
  }
}
const balance = (addr) => retry(async () => (await rpc.getBalance(address(addr), { commitment: 'confirmed' }).send()).value);
const readRoom = (pda) => retry(() => duel.fetchRoom(rpc, pda));
async function until(what, fn, ok, timeoutMs = 120_000, everyMs = 2500) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}
const loadWallet = async (path) => {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  const keyPair = await createKeyPairFromBytes(bytes);
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
};
const transferIx = (from, to, lamports) => ({
  programAddress: duel.SYSTEM_PROGRAM,
  accounts: [
    { address: address(from), role: AccountRole.WRITABLE_SIGNER },
    { address: address(to), role: AccountRole.WRITABLE },
  ],
  data: getStructEncoder([
    ['ix', getU32Encoder()],
    ['lamports', getU64Encoder()],
  ]).encode({ ix: 2, lamports }),
});
const sendFrom = (wallet, instructions) => retry(() => duel.sendSigned(rpc, wallet.address, [wallet.keyPair], instructions), 3);

/** What the engine says about a settled room, exactly as waveDuel.test.ts and the admin script compute it. */
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
const show = (g) => `host ${fmt(g.host)} · guest ${fmt(g.guest)} · treasury ${fmt(g.treasury)}`;

/* ---------- Checks ---------- */

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures++;
};
const text = async (page, sel) => (await page.locator(sel).first().textContent({ timeout: 10_000 }))?.trim() ?? '';
const coins = async (page) => Number((await text(page, '.gamehead__coins')).replace(/[^\d]/g, ''));
const clickForce = (page, sel) => page.locator(sel).first().click({ force: true, timeout: 10_000 });
/** Click a button by its text once it is rendered enabled (a force click on a disabled button does nothing). */
const press = (page, hasText, scope = '', timeout = 60_000) => page.locator(`${scope} button:not([disabled])`.trim(), { hasText }).first().click({ force: true, timeout });

/* ---------- Go ---------- */

const KEYPAIR = keypairPath();
build();
const payer = await loadWallet(KEYPAIR);
const config = await retry(() => duel.fetchConfig(rpc));
if (!config) {
  console.error('the wave_duel config is not initialised on this cluster (wave-duel-admin.mjs init-config)');
  process.exit(2);
}
const payerBefore = await balance(payer.address);
console.log(`program ${PROGRAM} · rpc ${RPC_URL} · fee ${config.feeBps} bps · treasury ${config.treasury}`);
console.log(`payer ${payer.address} (${fmt(payerBefore)})`);
if (payerBefore < PURSE * 2n + 1_000_000n) {
  console.error(`the payer needs at least ${fmt(PURSE * 2n)} to fund two wallets`);
  process.exit(2);
}

const relay = await startRelay(0);
const { server, url } = await serve();
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  executablePath: chromiumPath(),
  args: [
    // Behind the sandbox's egress proxy the pages reach devnet through it; loopback (the static server,
    // the relay) is bypassed by default. Elsewhere the pages talk to devnet directly.
    proxy ? `--proxy-server=${proxy}` : '--no-proxy-server',
    // Headless Chromium has no mDNS responder: keep host candidates as plain addresses.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});

/** The wallet hook: every transaction a page signs is named here, and a settle is predicted before it is sent. */
const DISC = Object.fromEntries(['open_room', 'join_room', 'cancel_room', 'settle', 'claim_timeout'].map((n) => [sha256Hex(`global:${n}`).slice(0, 16), n]));
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
      const settle = programInstructions(event.messageHex).find((ix) => ix.name === 'settle');
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
async function predictSettlement(seedHex) {
  // The escrow as it stands the moment before the settle transaction goes out.
  const room = await readRoom(roomPda);
  if (!room || room.state !== 'ready') throw new Error('settle signed but the room is not ready on chain');
  if (commitSeed(seedHex) !== room.commitment) throw new Error('the revealed seed does not match the escrow commitment');
  const before = { host: await balance(room.host), guest: await balance(room.guest), treasury: await balance(config.treasury) };
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
    // The browser logs every non-2xx response (the public RPC's 429s) as a console error; that is
    // not an app error. Everything the app itself reports as an error fails the run.
    if (/Failed to load resource/.test(m.text())) noise.push(m.text());
    else errors.push(`${name} console: ${m.text()}`);
  });
  return { name, wallet, ctx, page, errors, noise };
}

async function openRoom(host) {
  await host.page.goto(url, { waitUntil: 'networkidle' });
  await clickForce(host.page, '.splash__play');
  await host.page.locator('.mode-sign').nth(1).click({ force: true });
  await host.page.locator('.mode-card', { hasText: 'Wave Rush' }).first().click({ force: true });
  await host.page.getByRole('button', { name: /Play with friends/ }).click({ force: true });
  await host.page.locator('.room__lobby h2', { hasText: /^Room [A-Z2-9]{5}$/ }).waitFor({ timeout: 20_000 });
  return (await text(host.page, '.room__lobby h2')).replace('Room ', '');
}

async function joinByCode(guest, code) {
  await guest.page.goto(url, { waitUntil: 'networkidle' });
  await clickForce(guest.page, '.splash__play');
  await guest.page.locator('.mode-sign').nth(1).click({ force: true });
  await guest.page.fill('#join-code', code.toLowerCase());
  await guest.page.getByRole('button', { name: 'Join' }).click({ force: true });
  await guest.page.locator('.room__lobby h2', { hasText: `Room ${code}` }).waitFor({ timeout: 40_000 });
}

/**
 * The stake panel's "Connect wallet" opens the wallet popup, which lists the injected wallet; pick it,
 * optionally sign in with Solana (the app verifies the SIWS output itself), and close the popup.
 */
async function connectWallet(p, { signIn = false } = {}) {
  await press(p.page, /^Connect wallet$/, '.stake');
  const popup = p.page.locator('.popup[aria-label="Wallet"]');
  await popup.waitFor({ timeout: 20_000 });
  await popup.locator('.wallet-btn', { hasText: p.wallet.name }).waitFor({ timeout: 20_000 });
  const listed = await popup.locator('.wallet-btn').allTextContents();
  check(listed.length === 1 && listed[0].trim() === p.wallet.name, `${p.name}'s wallet popup lists the test wallet (${listed.join(', ')})`);
  const network = await popup.textContent();
  check(/Network: devnet/.test(network) && /Devnet stakes are enabled/.test(network), `${p.name}'s wallet popup says devnet, stakes enabled`);
  await popup.locator('.wallet-btn', { hasText: p.wallet.name }).click({ force: true });
  await popup.locator('.wallet-card b', { hasText: shortAddress(p.wallet.address) }).waitFor({ timeout: 30_000 });
  await popup.locator('.wallet-card small', { hasText: /\d SOL/ }).waitFor({ timeout: 30_000 });
  const card = (await popup.locator('.wallet-card').textContent()).trim().replace(/\s+/g, ' ');
  check(card.includes(`${p.wallet.name} · ${duel.formatSol(PURSE)}`), `${p.name} connected ${shortAddress(p.wallet.address)} and sees its balance (${card})`);
  const connected = await p.page.evaluate(() => window.__beachBingoTestWallet.connected);
  check(connected, `${p.name}'s wallet reports connected`);
  if (signIn) {
    await popup.locator('button', { hasText: /^Sign in$/ }).click({ force: true });
    await popup.locator('.wallet-card__ok').waitFor({ timeout: 20_000 });
    check(true, `${p.name} signed in with Solana and the app verified the signature`);
  }
  await popup.locator('.ribbon__close').click({ force: true });
  await popup.waitFor({ state: 'detached', timeout: 10_000 });
}

async function openEscrow(host) {
  const preset = host.page.locator('.stake .segmented button', { hasText: STAKE_LABEL });
  await preset.click({ force: true, timeout: 20_000 });
  check((await preset.getAttribute('aria-checked')) === 'true', `${STAKE_LABEL} preset selected`);
  await press(host.page, new RegExp(`^Open escrow · ${STAKE_LABEL.replace('.', '\\.')}$`), '.stake');
  await host.page.locator('.stake__title', { hasText: new RegExp(`Escrow .* · ${STAKE_LABEL.replace('.', '\\.')} each · open`) }).waitFor({ timeout: 120_000 });
}

const wallets = { host: await createTestWallet('Test Wallet (Ana)'), guest: await createTestWallet('Test Wallet (Bo)') };
console.log(`throwaway wallets: host ${wallets.host.address} · guest ${wallets.guest.address}`);
let funded = false;
let ana = null;
let bo = null;
try {
  const fund = await sendFrom(payer, [transferIx(payer.address, wallets.host.address, PURSE), transferIx(payer.address, wallets.guest.address, PURSE)]);
  funded = true;
  links.push({ label: 'fund both wallets (payer)', signature: fund.signature });
  console.log(`funded both with ${fmt(PURSE)}: ${explorer(fund.signature)}`);

  console.log('Staked Wave Rush');
  ana = await player('Ana', wallets.host);
  bo = await player('Bo', wallets.guest);

  /* ---------- Host: lobby, wallet, escrow ---------- */
  const code = await openRoom(ana);
  check(/^[A-Z2-9]{5}$/.test(code), `host opened room ${code}`);
  roomPda = await duel.roomAddress(address(wallets.host.address), code);
  const anaCoins = await coins(ana.page);
  const commitmentPrefix = /commitment ([0-9a-f]{12})/.exec(await text(ana.page, '.room__fair'))?.[1];
  check(!!commitmentPrefix, `lobby shows the seed commitment (${commitmentPrefix}…)`);
  check((await text(ana.page, '.stake__title')) === 'Play for SOL on devnet', 'the stake panel offers SOL on devnet');
  await connectWallet(ana, { signIn: true });
  const hostBefore = await balance(wallets.host.address);

  await openEscrow(ana);
  let room = await until('the room account on chain', () => readRoom(roomPda), (r) => r?.state === 'open');
  check(room.host === wallets.host.address && room.stake === STAKE && room.code === code && room.guest === null, `on chain: room ${shortAddress(roomPda)} open · host ${shortAddress(room.host)} · ${fmt(room.stake)} · code ${room.code}`);
  check(room.commitment.startsWith(commitmentPrefix), 'the escrow was opened with the lobby commitment');
  check(room.lamports > STAKE, `the room holds the stake plus rent (${fmt(room.lamports)})`);
  check((await text(ana.page, '.room__info .room-stat')).includes('Stake') && (await text(ana.page, '.room__info .room-stat b')) === '◎0.01', 'the info bar shows the stake instead of a prize pool');
  check((await ana.page.getByRole('button', { name: /\+\d card/ }).count()) === 0, 'no cards are for sale in a staked room');

  /* ---------- Host cancels the unjoined escrow: the stake comes back ---------- */
  await press(ana.page, /^Cancel and take my stake back$/, '.stake');
  await ana.page.locator('.stake button', { hasText: /^Open escrow/ }).waitFor({ timeout: 120_000 });
  await until('the room account to close', () => readRoom(roomPda), (r) => r === null);
  check(true, 'cancelled: the room account is gone and the lobby offers the picker again');
  const afterCancel = await balance(wallets.host.address);
  check(hostBefore - afterCancel === 2n * TX_FEE, `the stake and rent came back; the host is down exactly two transaction fees (${hostBefore - afterCancel} lamports)`);
  check(((await text(ana.page, '.room__info .room-stat')).includes('Prize pool')), 'the info bar is back to a prize pool');

  /* ---------- Host opens it again; the guest joins and deposits ---------- */
  await openEscrow(ana);
  room = await until('the reopened room on chain', () => readRoom(roomPda), (r) => r?.state === 'open');
  check(room.commitment.startsWith(commitmentPrefix), 'reopened with the same commitment');

  await joinByCode(bo, code);
  await ana.page.locator('.room__players li', { hasText: 'Bo' }).waitFor({ timeout: 30_000 });
  await bo.page.locator('.stake__title', { hasText: `Staked room · ${STAKE_LABEL} each` }).waitFor({ timeout: 30_000 });
  check(true, `guest's lobby shows the stake (${await text(bo.page, '.stake__title')})`);
  check((await text(bo.page, '.room__info .room-stat b')) === '◎0.01', "guest's info bar shows ◎0.01");
  check(/Ana.*1 card/.test(await bo.page.locator('.room__players li', { hasText: 'Ana' }).textContent()), "guest sees the host's seat as one card");
  check((await bo.page.getByRole('button', { name: /\+\d card/ }).count()) === 0, 'the guest cannot buy cards either');
  const boCoins = await coins(bo.page);
  await connectWallet(bo);
  const guestBefore = await balance(wallets.guest.address);
  await press(bo.page, new RegExp(`^Deposit ${STAKE_LABEL.replace('.', '\\.')} and play$`), '.stake', 90_000);
  await bo.page.locator('.stake .small-note', { hasText: /Your deposit is in/ }).waitFor({ timeout: 120_000 });
  room = await until('the room to be ready on chain', () => readRoom(roomPda), (r) => r?.state === 'ready');
  check(room.guest === wallets.guest.address && room.entropy !== ZERO_ENTROPY && room.joinedSlot > 0n && room.lamports > 2n * STAKE, `on chain: ready · guest ${shortAddress(room.guest)} · entropy ${room.entropy.slice(0, 12)}… · joined slot ${room.joinedSlot}`);
  check(guestBefore - (await balance(wallets.guest.address)) === STAKE + TX_FEE, 'the guest paid exactly the stake and one fee');
  check(/Ana.*1 card/.test(await bo.page.locator('.room__players li', { hasText: 'Ana' }).textContent()), "guest still sees the host's seat");

  /* ---------- Start: the host's button enables once the chain says ready ---------- */
  await ana.page.locator('.stake .small-note', { hasText: /Both deposits are in/ }).waitFor({ timeout: 60_000 });
  const start = ana.page.locator('button:not([disabled])', { hasText: /Start · 2 players/ });
  await start.waitFor({ timeout: 60_000 });
  check(true, "host's Start enabled with both deposits on chain");
  check(await ana.page.locator('.stake__title', { hasText: /· ready$/ }).isVisible(), "host's stake panel reads 'ready'");
  await start.click({ force: true });
  await ana.page.locator('.room__count', { hasText: /Starting in/ }).waitFor({ timeout: 15_000 });
  await bo.page.locator('.room__count', { hasText: /Starting in/ }).waitFor({ timeout: 15_000 });
  check(true, 'both count down');
  check((await ana.page.locator('.room__card').count()) === 1 && (await bo.page.locator('.room__card').count()) === 1, 'one card each');
  await ana.page.locator('.popup').waitFor({ timeout: 120_000 });
  await bo.page.locator('.popup').waitFor({ timeout: 30_000 });
  const results = async (page) => ({
    title: await text(page, '.popup .ribbon__title'),
    lines: await page.locator('.room__results li').allTextContents(),
    balls: await text(page, '.room__info .room-stat:nth-child(3) b'),
  });
  const ra = await results(ana.page);
  const rb = await results(bo.page);
  check(ra.lines.join('|') === rb.lines.join('|') && ra.balls === rb.balls, `same result on both screens after ${ra.balls} balls: ${ra.lines.join(' | ')}`);
  check([ra.title, rb.title].includes('You Win'), `somebody won (Ana: ${ra.title} / Bo: ${rb.title})`);
  check((await coins(ana.page)) === anaCoins && (await coins(bo.page)) === boCoins, `coins never moved during the round (Ana ${anaCoins}, Bo ${boCoins})`);

  /* ---------- Settle from the host's results popup; the guest's screen sees it ---------- */
  const settleBtn = bo.page.locator('.popup .stake button', { hasText: /^Settle on chain$/ });
  check(await settleBtn.isVisible(), "the guest's popup also offers to settle (either player can)");
  const before = await readRoom(roomPda);
  check(before?.state === 'ready' && before.entropy === room.entropy, 'the escrow is still ready on chain before settling');
  await press(ana.page, /^Settle on chain$/, '.popup .stake', 30_000);
  const link = ana.page.locator('.popup .stake a[href*="explorer.solana.com/tx/"]');
  await link.waitFor({ timeout: 150_000 });
  check(hookError === null, `the settle was predicted before it was sent${hookError ? ` (${hookError})` : ''}`);
  const settleUrl = await link.getAttribute('href');
  const settleSig = /tx\/([1-9A-HJ-NP-Za-km-z]+)/.exec(settleUrl)?.[1];
  const hostSent = await ana.page.evaluate(() => window.__beachBingoTestWallet.sent.map((s) => s.signature));
  check(hostSent.at(-1) === settleSig && /Settled ✓/.test(await text(ana.page, '.popup .stake')), `host shows Settled ✓ with the explorer link ${settleUrl}`);
  await bo.page.locator('.popup .stake button', { hasText: /^Settled by the other player$/ }).waitFor({ timeout: 60_000 });
  check(true, "guest's screen reads 'Settled by the other player'");
  await until('the room account to close after settling', () => readRoom(roomPda), (r) => r === null);
  check(true, 'the room account is gone');

  check(prediction !== null, 'the engine replay ran on the pre-settlement entropy and the revealed seed');
  if (prediction) {
    const after = { host: await balance(wallets.host.address), guest: await balance(wallets.guest.address), treasury: await balance(config.treasury) };
    const pot = prediction.room.stake * 2n;
    const rent = prediction.room.lamports - pot; // the account's rent goes back to the host, who paid it
    const gained = {
      host: after.host - prediction.before.host - rent + TX_FEE, // the host also paid the settle's fee
      guest: after.guest - prediction.before.guest,
      treasury: after.treasury - prediction.before.treasury,
    };
    const expected = expectedGains(prediction.winners, pot, config.feeBps);
    check(same(gained, expected), `the chain paid whom the engine named (${prediction.winners.join(' and ')} on ball ${prediction.ball}): ${show(gained)}`);
    if (!same(gained, expected)) console.log(`    expected ${show(expected)}`);
    const screensAgree = (ra.title === 'You Win') === prediction.winners.includes('host') && (rb.title === 'You Win') === prediction.winners.includes('guest');
    check(screensAgree, 'both screens named the same winner as the engine and the chain');
    check(prediction.ball === Number(ra.balls), `the screens stopped on the engine's winning ball (${ra.balls})`);
  }
  check((await coins(ana.page)) === anaCoins && (await coins(bo.page)) === boCoins, 'coins in the top bar are unchanged after settling');

  for (const p of [ana, bo]) {
    for (const e of p.errors) check(false, `page error: ${e.slice(0, 300)}`);
    if (p.noise.length) console.log(`    (${p.name}: ${p.noise.length} resource-load console line(s) ignored, e.g. ${p.noise[0].slice(0, 120)})`);
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
    // Leave nothing on devnet: an escrow still open is cancelled from here, and the wallets are swept back to the payer.
    try {
      const left = roomPda ? await readRoom(roomPda) : null;
      if (left?.state === 'open') {
        const cancelled = await sendFrom(wallets.host, [await duel.cancelRoomIx(address(wallets.host.address), roomPda)]);
        console.log(`cleanup: cancelled the open escrow ${explorer(cancelled.signature)}`);
      } else if (left?.state === 'ready') {
        console.log(`cleanup: room ${roomPda} is still ready on chain; the guest can claim it after the timeout (wave-duel-admin.mjs)`);
      }
    } catch (e) {
      console.log(`cleanup: could not inspect the escrow (${e instanceof Error ? e.message : e})`);
    }
    for (const w of [wallets.host, wallets.guest]) {
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
