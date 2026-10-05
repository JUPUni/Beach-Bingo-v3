// What the staked-room end-to-end scripts share (scripts/stake-e2e.mjs for the 1v1 room,
// scripts/stake-hall-e2e.mjs for a hall): the devnet build into dist-devnet, the static server,
// Chromium, the funded key pair, gentle retries against the public RPC, and the page steps every
// staked run takes (the lobby, joining by code, the wallet popup). Anything that closes over a
// run's own state (its checks, its wallets, its transaction log) stays in the script.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { AccountRole, address, createKeyPairFromBytes, getAddressFromPublicKey, getStructEncoder, getU32Encoder, getU64Encoder } from '@solana/kit';
import * as duel from '../../src/solana/waveDuel.ts';

export const WEB = fileURLToPath(new URL('../../', import.meta.url));
export const ROOT = resolve(WEB, '../..');
export const DIST = join(WEB, 'dist-devnet/');
export const BASE = '/app/';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

export const DEFAULT_PROGRAM = '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH';
export const DEFAULT_RPC = 'https://api.devnet.solana.com';
export const TX_FEE = 5_000n;
export const ZERO_ENTROPY = '0'.repeat(64);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const shortAddress = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export const fmt = (lamports) => `${lamports < 0n ? '-' : ''}${duel.formatSol(lamports < 0n ? -lamports : lamports)}`;
export const explorer = (signature) => duel.explorerUrl(signature, 'devnet');

/* ---------- Setup: key pair, build, static server, Chromium ---------- */

export function keypairPath() {
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

/** The game with the devnet flags, into dist-devnet (the production dist is untouched). */
export function build(program, rpcUrl) {
  if (process.env.STAKE_E2E_SKIP_BUILD && existsSync(join(DIST, 'index.html'))) {
    console.log('build: reusing dist-devnet (STAKE_E2E_SKIP_BUILD)');
    return;
  }
  const env = { ...process.env, VITE_SOLANA_CLUSTER: 'devnet', VITE_ENABLE_ONCHAIN_STAKES: 'true', VITE_WAVE_DUEL_PROGRAM: program };
  if (rpcUrl !== DEFAULT_RPC) env.VITE_SOLANA_RPC_URL = rpcUrl;
  const out = execFileSync(join(WEB, 'node_modules/.bin/vite'), ['build', '--outDir', 'dist-devnet'], { cwd: WEB, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const built = out.split('\n').find((l) => /built in/.test(l))?.trim() ?? 'built';
  console.log(`build: ${built} → dist-devnet (cluster devnet, stakes on, program ${program})`);
}

export const serve = () =>
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

export function chromiumPath() {
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

/** Chromium with devnet through the sandbox's egress proxy when there is one; loopback (the static server, the relay) stays direct. */
export function launchChromium() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  return chromium.launch({
    executablePath: chromiumPath(),
    args: [
      proxy ? `--proxy-server=${proxy}` : '--no-proxy-server',
      // Headless Chromium has no mDNS responder: keep host candidates as plain addresses.
      '--disable-features=WebRtcHideLocalIpsWithMdns',
    ],
  });
}

/* ---------- Chain helpers (the public RPC rate-limits: everything retries gently) ---------- */

export async function retry(fn, tries = 8) {
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

export async function until(what, fn, ok, timeoutMs = 120_000, everyMs = 2500) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (ok(value)) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(everyMs);
  }
}

export const loadWallet = async (path) => {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  const keyPair = await createKeyPairFromBytes(bytes);
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
};

export const transferIx = (from, to, lamports) => ({
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

/* ---------- Page steps ---------- */

export const text = async (page, sel) => (await page.locator(sel).first().textContent({ timeout: 10_000 }))?.trim() ?? '';
export const coins = async (page) => Number((await text(page, '.gamehead__coins')).replace(/[^\d]/g, ''));
export const clickForce = (page, sel) => page.locator(sel).first().click({ force: true, timeout: 10_000 });
/** Click a button by its text once it is rendered enabled (a force click on a disabled button does nothing). */
export const press = (page, hasText, scope = '', timeout = 60_000) => page.locator(`${scope} button:not([disabled])`.trim(), { hasText }).first().click({ force: true, timeout });

/** Host: splash → rooms → Wave Rush → Play with friends; resolves the room code. */
export async function openWaveRushRoom(page, url) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await clickForce(page, '.splash__play');
  await page.locator('.mode-sign').nth(1).click({ force: true });
  await page.locator('.mode-card', { hasText: 'Wave Rush' }).first().click({ force: true });
  await page.getByRole('button', { name: /Play with friends/ }).click({ force: true });
  await page.locator('.room__lobby h2', { hasText: /^Room [A-Z2-9]{5}$/ }).waitFor({ timeout: 20_000 });
  return (await text(page, '.room__lobby h2')).replace('Room ', '');
}

export async function joinByCode(page, url, code) {
  await page.goto(url, { waitUntil: 'networkidle' });
  await clickForce(page, '.splash__play');
  await page.locator('.mode-sign').nth(1).click({ force: true });
  await page.fill('#join-code', code.toLowerCase());
  await page.getByRole('button', { name: 'Join' }).click({ force: true });
  await page.locator('.room__lobby h2', { hasText: `Room ${code}` }).waitFor({ timeout: 40_000 });
}

/**
 * The stake panel's "Connect wallet" opens the wallet popup, which lists the injected wallet; pick it,
 * optionally sign in with Solana (the app verifies the SIWS output itself), and close the popup.
 * `check(ok, what)` is the run's own recorder; `purse` is what the wallet was funded with.
 */
export async function connectWallet(p, { check, purse, signIn = false }) {
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
  check(card.includes(`${p.wallet.name} · ${duel.formatSol(purse)}`), `${p.name} connected ${shortAddress(p.wallet.address)} and sees its balance (${card})`);
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
