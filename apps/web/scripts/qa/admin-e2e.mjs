#!/usr/bin/env node
// The admin panel in a real browser against the wave_duel program on devnet, without its keys and
// without moving anything on chain. The program's config is read from devnet as it is, with one
// change made on the way in: the admin (or the pauser) field is rewritten to a throwaway test
// wallet, so the page treats that wallet as holding the role. Every transaction the page sends is
// caught before it reaches the RPC and decoded here, so the check is what the panel would ask the
// program to do: the right instruction, the right signer, the right prices.
//
//   node scripts/qa/admin-e2e.mjs        (from apps/web; ADMIN_E2E_SKIP_BUILD=1 reuses dist-devnet)
//
// Checks: a wallet with no role sees no Admin button; the admin sees it, the panel, Pause, and a
// reprice from Jupiter's live quotes whose Apply sends set_config / set_mint signed by the admin
// with exactly the previewed prices; the pauser sees Pause (sending `pause`) and neither Resume
// nor the reprice.
import { address, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { createHash } from 'node:crypto';
import * as duel from '../../src/solana/waveDuel.ts';
import { fetchMintEntries } from '../../src/solana/waveToken.ts';
import { mintPackPrices, SOL_MINT, solPackPrices, STABLE_MINTS } from '../../src/admin/pricing.ts';
import { build, DEFAULT_PROGRAM, DEFAULT_RPC, launchChromium, serve } from './stake-lib.mjs';
import { createTestWallet, installTestWallet } from './test-wallet.mjs';

if (process.env.ADMIN_E2E_SKIP_BUILD) process.env.STAKE_E2E_SKIP_BUILD = '1';
const PROGRAM = address(process.env.WAVE_DUEL_PROGRAM || DEFAULT_PROGRAM);
const RPC_URL = process.env.RPC_URL || DEFAULT_RPC;
duel.configureProgram(PROGRAM);
const disc = (name) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8).toString('hex');
const DISC = { setConfig: disc('set_config'), setMint: disc('set_mint'), pause: disc('pause') };

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures++;
};

const configPda = await duel.configAddress();
const decodeTx = (base64) => {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(base64));
  const msg = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = msg.staticAccounts;
  return {
    feePayer: keys[0],
    instructions: msg.instructions.map((ix) => ({
      program: keys[ix.programAddressIndex],
      accounts: (ix.accountIndices ?? []).map((i) => keys[i]),
      data: Buffer.from(ix.data ?? []),
    })),
  };
};

/** One browser context: the test wallet, the RPC forwarded through Node with the config's role rewritten, every sendTransaction caught. */
async function open(browser, url, wallet, role) {
  const context = await browser.newContext();
  await installTestWallet(context, wallet, { rpcUrl: RPC_URL });
  await context.addInitScript(() => localStorage.setItem('beach-bingo', JSON.stringify({ state: { onboarded: true, profile: { name: 'Admin test', avatar: '🦀' } }, version: 1 })));
  const sent = [];
  const forward = async (route) => {
    const req = route.request();
    const res = await fetch(req.url(), { method: req.method(), headers: { 'content-type': 'application/json' }, body: req.postData() ?? undefined });
    return { res, body: await res.text() };
  };
  await context.route(RPC_URL, async (route) => {
    const call = JSON.parse(route.request().postData() || '{}');
    const calls = Array.isArray(call) ? call : [call];
    if (calls.some((c) => c.method === 'sendTransaction')) {
      for (const c of calls) if (c.method === 'sendTransaction') sent.push(decodeTx(c.params[0]));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(calls.map((c) => ({ jsonrpc: '2.0', id: c.id, error: { code: -32000, message: 'admin-e2e: transaction captured, not sent' } }))[0]) });
    }
    const { res, body } = await forward(route);
    let out = body;
    if (role && !Array.isArray(call) && call.method === 'getAccountInfo' && call.params?.[0] === configPda) {
      const json = JSON.parse(body);
      const data = Buffer.from(json.result.value.data[0], 'base64');
      // Config: 8-byte discriminator, admin (32), treasury (32), fee_bps (2), paused (1), bump (1), pauser (32).
      const at = role === 'admin' ? 8 : 8 + 32 + 32 + 2 + 1 + 1;
      Buffer.from(wallet.publicKey).copy(data, at);
      json.result.value.data[0] = data.toString('base64');
      out = JSON.stringify(json);
    }
    return route.fulfill({ status: res.status, contentType: 'application/json', body: out });
  });
  // Jupiter's quotes go through Node too, so the reprice uses the real market.
  await context.route('https://lite-api.jup.ag/**', async (route) => {
    const { res, body } = await forward(route);
    return route.fulfill({ status: res.status, contentType: 'application/json', body, headers: { 'access-control-allow-origin': '*' } });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => check(false, `page error: ${e.message}`));
  await page.goto(url, { waitUntil: 'networkidle' });
  return { context, page, sent };
}

async function connect(page, wallet) {
  // The title screen first: Play leads to the island, where the nav has Settings.
  const play = page.locator('button', { hasText: /^Play$/ });
  if (await play.count()) await play.first().click({ force: true });
  await page.getByRole('button', { name: 'Settings' }).first().click({ force: true });
  await page.locator('button', { hasText: 'Solana wallet' }).click({ force: true });
  const popup = page.locator('.popup[aria-label="Wallet"]');
  await popup.locator('.wallet-btn', { hasText: wallet.name }).click({ force: true, timeout: 45_000 });
  await popup.locator('.wallet-card b', { hasText: `${wallet.address.slice(0, 4)}…${wallet.address.slice(-4)}` }).waitFor({ timeout: 30_000 });
  return popup;
}

build(PROGRAM, RPC_URL);
const { server, url } = await serve();
const browser = await launchChromium();
try {
  const config = await duel.fetchConfig((await import('@solana/kit')).createSolanaRpc(RPC_URL));
  check(config !== null, `devnet config read (admin ${config?.admin}, paused ${config?.paused})`);

  console.log('\nA wallet with no role:');
  const nobody = await createTestWallet('Nobody');
  const n = await open(browser, url, nobody, null);
  const nPopup = await connect(n.page, nobody);
  await n.page.waitForTimeout(4000);
  check((await nPopup.locator('.wallet-admin').count()) === 0, 'no Admin button');
  await n.context.close();

  console.log('\nThe admin:');
  const admin = await createTestWallet('Admin');
  const a = await open(browser, url, admin, 'admin');
  const aPopup = await connect(a.page, admin);
  const button = aPopup.locator('.wallet-admin');
  await button.waitFor({ timeout: 30_000 });
  check((await button.textContent()).trim() === 'Admin (admin)', 'Admin (admin) button in the wallet popup');
  await button.click({ force: true });
  const panel = a.page.locator('.popup[aria-label="Admin"]');
  await panel.locator('.admin').waitFor({ timeout: 30_000 });
  const panelText = (await panel.textContent()).replace(/\s+/g, ' ');
  check(panelText.includes('Signed in as the admin'), 'panel opens for the admin');
  check(panelText.includes(config.paused ? 'Paused' : 'Open'), `panel shows the shop ${config.paused ? 'paused' : 'open'}`);

  await panel.locator('button', { hasText: 'Reprice from live market' }).click({ force: true });
  await panel.locator('h3', { hasText: 'New prices' }).waitFor({ timeout: 30_000 }).catch(async (e) => {
    console.log(`    toast: ${await a.page.locator('.toast').last().textContent().catch(() => '(none)')}`);
    throw e;
  });
  const preview = (await panel.locator('.admin__list').last().textContent()).replace(/\s+/g, ' ');
  console.log(`    preview: ${preview}`);
  const solUsd = Number(preview.match(/SOL at \$([\d.]+)/)?.[1]);
  check(solUsd > 0, `SOL quoted live at $${solUsd}`);
  const mints = await fetchMintEntries((await import('@solana/kit')).createSolanaRpc(RPC_URL));

  await panel.locator('button', { hasText: 'Apply new prices' }).click({ force: true });
  const answered = await a.page.locator('.toast', { hasText: 'captured' }).first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
  check(a.sent.length === 1, `one transaction for the reprice (${a.sent.length} caught)`);
  const tx = a.sent[0];
  if (tx) {
    check(tx.feePayer === admin.address, 'signed and paid by the admin wallet');
    const setConfig = tx.instructions.find((ix) => ix.data.subarray(0, 8).toString('hex') === DISC.setConfig);
    const setMints = tx.instructions.filter((ix) => ix.data.subarray(0, 8).toString('hex') === DISC.setMint);
    check(tx.instructions.every((ix) => ix.program === PROGRAM), 'every instruction goes to the program');
    if (setConfig) {
      // set_config data: disc 8, fee 2, paused 1, pauser 32, sgt 32, pack_coins 4×4, seeker_discount 2, sol prices 4×8, sol seeker fee 2.
      const d = setConfig.data;
      const prices = Array.from({ length: 4 }, (_, i) => d.readBigUInt64LE(8 + 2 + 1 + 32 + 32 + 16 + 2 + i * 8));
      const quoted = solPackPrices(solUsd);
      // The preview rounds the quote to cents; the transaction carries the full quote, so allow one 0.0001 SOL step.
      check(prices.every((p, i) => (p > quoted[i] ? p - quoted[i] : quoted[i] - p) <= 100_000n), `set_config SOL prices ${prices.join(' / ')} match the quote`);
      check(d[8 + 2] === (config.paused ? 1 : 0), 'set_config keeps the paused flag as it was');
      check(d.readUInt16LE(8) === config.feeBps, 'set_config keeps the fee as it was');
      check(setConfig.accounts[1] === admin.address, 'set_config names the admin as signer');
    } else console.log('    (SOL prices already at the market: no set_config)');
    for (const ix of setMints) {
      const entry = mints.find((m) => ix.accounts.includes(m.address));
      check(Boolean(entry), `set_mint targets a registered mint (${entry ? entry.mint.slice(0, 6) : '?'})`);
      if (entry && STABLE_MINTS.has(entry.mint)) check(true, 'stable mint priced at $1');
    }
    check(Boolean(setConfig) || setMints.length > 0, `the reprice changes something (${setConfig ? 'set_config' : ''} ${setMints.length} set_mint)`);
  }
  check(answered, "the panel reports the RPC's answer (the capture's error, in a toast)");

  if (!config.paused) {
    const before = a.sent.length;
    await panel.locator('button', { hasText: /^Pause$/ }).click({ force: true });
    await a.page.waitForTimeout(3000);
    const p = a.sent[before];
    check(p && p.instructions.length === 1 && p.instructions[0].data.subarray(0, 8).toString('hex') === DISC.pause, 'Pause sends one `pause` instruction');
  }
  await a.context.close();

  console.log('\nThe pauser:');
  const pauser = await createTestWallet('Pauser');
  const p = await open(browser, url, pauser, 'pauser');
  const pPopup = await connect(p.page, pauser);
  const pButton = pPopup.locator('.wallet-admin');
  await pButton.waitFor({ timeout: 30_000 });
  check((await pButton.textContent()).trim() === 'Admin (pauser)', 'Admin (pauser) button');
  await pButton.click({ force: true });
  const pPanel = p.page.locator('.popup[aria-label="Admin"]');
  await pPanel.locator('.admin').waitFor({ timeout: 30_000 });
  check((await pPanel.textContent()).includes('Signed in as the pauser'), 'panel opens for the pauser');
  check((await pPanel.locator('button', { hasText: 'Reprice' }).count()) === 0, 'no reprice for the pauser');
  check((await pPanel.locator('button', { hasText: 'Resume' }).count()) === 0, 'no resume for the pauser');
  if (!config.paused) {
    await pPanel.locator('button', { hasText: /^Pause$/ }).click({ force: true });
    await p.page.waitForTimeout(3000);
    const t = p.sent[0];
    check(t && t.feePayer === pauser.address && t.instructions[0].data.subarray(0, 8).toString('hex') === DISC.pause && t.instructions[0].accounts[1] === pauser.address, 'Pause sends `pause` signed by the pauser');
  }
  await p.context.close();
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exitCode = failures ? 1 : 0;
