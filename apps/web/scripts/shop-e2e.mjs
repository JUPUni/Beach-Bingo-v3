#!/usr/bin/env node
// One browser buys the smallest coin pack with the SKR look-alike through the real Coin Shop popup
// against the wave_duel program on devnet: the age gate, the wallet popup (a Wallet Standard test
// wallet injected into the page), the chain shop the devnet build registers for the connected
// wallet, `buy_pack_token` signed by the app's own wallet layer, the coins credited from the
// confirmed transaction. The Buyer PDA, the CoinsBought event, the token account deltas and the
// credited coins must agree; then a fresh browser context with the same wallet "restores" the
// purchase and gets exactly the coins the chain holds that it had not credited yet.
//
//   node scripts/shop-e2e.mjs                        (from apps/web; Node 22.18+ strips the .ts imports itself)
//
// Same environment as scripts/stake-e2e.mjs (KEYPAIR, RPC_URL, WAVE_DUEL_PROGRAM, CHROMIUM_PATH,
// STAKE_E2E_SKIP_BUILD=1), plus SHOP_MINT (default the SKR look-alike). The wallet gets 0.05 SOL
// and the pack's list price in the token, and both are swept back to the key pair at the end.
import { address, createSolanaRpc, getCompiledTransactionMessageDecoder } from '@solana/kit';
import { sha256Hex } from '@beach-bingo/engine';
import { fetchBuyer, fetchCoinsBought, packPrice } from '../src/solana/shop.ts';
import { formatAmount, knownSymbol } from '../src/solana/tokens.ts';
import * as duel from '../src/solana/waveDuel.ts';
import { fetchMintEntry } from '../src/solana/waveToken.ts';
import { build, DEFAULT_PROGRAM, DEFAULT_RPC, explorer, fmt, keypairPath, launchChromium, loadWallet, press, retry, serve, shortAddress, text, transferIx, until } from './qa/stake-lib.mjs';
import { createTestWallet, installTestWallet } from './qa/test-wallet.mjs';
import { fundTokens, sweepTokens, tokenBalance } from './qa/token-lib.mjs';

const PROGRAM = process.env.WAVE_DUEL_PROGRAM || DEFAULT_PROGRAM;
const RPC_URL = process.env.RPC_URL || DEFAULT_RPC;
const MINT = address(process.env.SHOP_MINT || 'GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz');
const PACK = 0;
const PURSE = 50_000_000n; // the Buyer account's rent and a few fees

duel.configureProgram(address(PROGRAM));
const rpc = createSolanaRpc(RPC_URL);
const balance = (addr) => retry(async () => (await rpc.getBalance(address(addr), { commitment: 'confirmed' }).send()).value);
const held = (ata) => retry(() => tokenBalance(rpc, ata));
const sendFrom = (wallet, instructions) => retry(() => duel.sendSigned(rpc, wallet.address, [wallet.keyPair], instructions), 3);
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('beach-bingo') || '{}').state ?? {});

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${what}`);
  if (!ok) failures++;
};

const KEYPAIR = keypairPath();
const payer = await loadWallet(KEYPAIR);
const config = await retry(() => duel.fetchConfig(rpc));
if (!config) {
  console.error('the wave_duel config is not initialised on this cluster');
  process.exit(2);
}
const entry = await retry(() => fetchMintEntry(rpc, MINT));
if (!entry?.enabled || !entry.packPrices[PACK]) {
  console.error(`${MINT} is not an enabled mint selling pack ${PACK}`);
  process.exit(2);
}
const SYMBOL = knownSymbol(MINT) ?? 'token';
const LIST = entry.packPrices[PACK];
const PRICE = packPrice(LIST, entry.discountBps); // no Seeker Genesis Token in a throwaway wallet
const COINS = config.packCoins[PACK];
const amount = (base) => formatAmount(base, entry.decimals, SYMBOL);
const priceLabel = `${(Number(PRICE) / 10 ** entry.decimals).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })} ${SYMBOL}`;
build(PROGRAM, RPC_URL, { sgtGroup: config.sgtGroup });
const payerBefore = await balance(payer.address);
console.log(`program ${PROGRAM} · rpc ${RPC_URL} · mint ${MINT} (${SYMBOL}) · pack ${PACK}: ${COINS} coins for ${amount(LIST)} list, ${entry.discountBps} bps off → ${amount(PRICE)}`);
console.log(`payer ${payer.address} (${fmt(payerBefore)})`);

const { server, url } = await serve();
const browser = await launchChromium();
const DISC = Object.fromEntries(['buy_pack', 'buy_pack_token'].map((n) => [sha256Hex(`global:${n}`).slice(0, 16), n]));
const links = [];
function onWalletTransaction(who, event) {
  const message = getCompiledTransactionMessageDecoder().decode(Buffer.from(event.messageHex, 'hex'));
  const names = message.instructions.filter((ix) => message.staticAccounts[ix.programAddressIndex] === PROGRAM).map((ix) => DISC[Buffer.from(ix.data ?? []).subarray(0, 8).toString('hex')] ?? 'unknown');
  const label = names.length ? names.join('+') : 'transaction';
  if (event.stage === 'sent') {
    links.push({ label: `${label} (${who})`, signature: event.signature });
    console.log(`    ${who} sent ${label}: ${explorer(event.signature)}`);
  } else if (event.stage === 'failed') console.log(`    ${who}: ${label} failed: ${event.error}`);
}

async function player(name, wallet) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true, isMobile: true, serviceWorkers: 'block' });
  await installTestWallet(ctx, wallet, { rpcUrl: RPC_URL, onTransaction: (event) => onWalletTransaction(name, event) });
  await ctx.addInitScript(({ name }) => localStorage.setItem('beach-bingo', JSON.stringify({ state: { onboarded: true, profile: { name, avatar: '🦀' } }, version: 1 })), { name });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${name} console: ${m.text()}`);
  });
  return { name, wallet, ctx, page, errors };
}

/** Splash → home → the coins chip → the 18+ gate (first time) → the Coin Shop popup. */
async function openShop(page, { gate }) {
  await page.locator('button.balance--coins').first().click({ force: true, timeout: 20_000 });
  if (gate) {
    const age = page.locator('.popup[aria-label="Coins are 18+"]');
    await age.waitFor({ timeout: 20_000 });
    for (const box of await age.locator('.check input').all()) await box.check({ force: true });
    await age.locator('button', { hasText: /^Confirm$/ }).click({ force: true });
  }
  const shop = page.locator('.popup[aria-label="Coin Shop"]');
  await shop.waitFor({ timeout: 20_000 });
  return shop;
}

/** The shop's "Connect wallet" opens the wallet popup; pick the test wallet and close it. */
async function connectFromShop(p, shop) {
  await shop.locator('button', { hasText: /^Connect wallet$/ }).click({ force: true, timeout: 20_000 });
  const popup = p.page.locator('.popup[aria-label="Wallet"]');
  await popup.waitFor({ timeout: 20_000 });
  await popup.locator('.wallet-btn', { hasText: p.wallet.name }).click({ force: true, timeout: 20_000 });
  await popup.locator('.wallet-card b', { hasText: shortAddress(p.wallet.address) }).waitFor({ timeout: 30_000 });
  // The bridge reads the wallet's SKR: the badge shows once it has.
  await popup.locator('.badge--skr').waitFor({ timeout: 60_000 }).catch(() => undefined);
  check(await popup.locator('.badge--skr').isVisible(), `${p.name}'s wallet popup shows 'SKR ready'`);
  await popup.locator('.ribbon__close').click({ force: true });
  await popup.waitFor({ state: 'detached', timeout: 10_000 });
}

const wallet = await createTestWallet('Test Wallet (Ana)');
console.log(`throwaway wallet: ${wallet.address}`);
let funded = false;
let ata = null;
let ana = null;
let bea = null;
try {
  const fund = await sendFrom(payer, [transferIx(payer.address, wallet.address, PURSE)]);
  const tokens = await retry(() => fundTokens(rpc, payer, entry, [address(wallet.address)], LIST), 3);
  funded = true;
  ata = tokens.atas[0];
  links.push({ label: 'fund SOL (payer)', signature: fund.signature }, { label: `fund ${SYMBOL} (payer)`, signature: tokens.signature });
  console.log(`funded ${fmt(PURSE)} (${explorer(fund.signature)}) and ${amount(LIST)} (${explorer(tokens.signature)})`);

  console.log('Coin Shop');
  ana = await player('Ana', wallet);
  await ana.page.goto(url, { waitUntil: 'networkidle' });
  await ana.page.locator('.splash__play').click({ force: true, timeout: 20_000 });
  await ana.page.locator('.home__level').waitFor({ timeout: 20_000 });
  let shop = await openShop(ana.page, { gate: true });
  check(/Connect a wallet to buy coins/.test(await shop.textContent()), 'the devnet shop asks for a wallet before selling (no pretend shop)');
  check((await shop.locator('.pack__buy').count()) === 0, 'no Buy buttons without a wallet');
  await connectFromShop(ana, shop);
  shop = await openShop(ana.page, { gate: false });
  await shop.locator('.pack__buy').first().waitFor({ timeout: 60_000 });
  const packs = await shop.locator('.pack').all();
  check(packs.length === 4, `the chain shop lists ${packs.length} packs from the config`);
  const picked = await shop.locator('.segmented button[aria-checked="true"]').textContent();
  check(picked?.trim() === 'SKR', `the shop preselected ${picked?.trim()} for a wallet holding SKR`);
  const firstPrice = (await shop.locator('.pack .pack__body span').first().textContent())?.trim();
  check(firstPrice === priceLabel, `the smallest pack shows the registry price with the SKR saving (${firstPrice})`);
  check(/SKR saves 20% on every pack/.test(await shop.textContent()), 'the saving line reads the registry discount');
  const buyerBefore = await retry(() => fetchBuyer(rpc, address(wallet.address)));
  const before = { wallet: await held(ata), treasury: await held(entry.treasuryAta) };
  const coinsBefore = (await stored(ana.page)).coins ?? 0;
  await press(ana.page, /^Buy$/, '.popup[aria-label="Coin Shop"] .pack:first-child', 30_000);
  await ana.page.locator('.toasts', { hasText: new RegExp(`\\+${COINS.toLocaleString('en-US')} coins`) }).waitFor({ timeout: 150_000 });
  const state = await stored(ana.page);
  check(state.coins === coinsBefore + COINS, `the coins balance went ${coinsBefore} → ${state.coins}`);
  const purchase = state.purchases?.[0];
  check(purchase?.coins === COINS && purchase.mint === 'SKR' && purchase.wallet === wallet.address, `the purchase is recorded against the wallet (${purchase?.signature?.slice(0, 12)}…)`);
  check(state.credited?.[wallet.address] === COINS, `the device remembers ${state.credited?.[wallet.address]} coins credited to this wallet`);
  const signature = purchase?.signature;
  const event = signature ? await retry(() => fetchCoinsBought(rpc, signature)) : null;
  check(event && event.wallet === wallet.address && event.mint === MINT && event.pack === PACK && event.coins === COINS && event.paid === PRICE && event.seeker === false, `CoinsBought: ${event?.coins} coins for ${amount(event?.paid ?? 0n)}, discount ${event?.discountBps} bps, seeker ${event?.seeker}`);
  const buyer = await retry(() => fetchBuyer(rpc, address(wallet.address)));
  check(buyer && buyer.coinsTotal - (buyerBefore?.coinsTotal ?? 0n) === BigInt(COINS) && buyer.purchases === (buyerBefore?.purchases ?? 0) + 1, `the Buyer PDA ${shortAddress(buyer?.address ?? '')} holds ${buyer?.coinsTotal} coins over ${buyer?.purchases} purchase(s)`);
  const after = { wallet: await held(ata), treasury: await held(entry.treasuryAta) };
  check(before.wallet - after.wallet === PRICE && after.treasury - before.treasury === PRICE, `the wallet paid exactly ${amount(PRICE)} and the treasury received it`);
  check(/Your purchases/.test(await shop.textContent()) && (await shop.locator('.shop__history li').count()) >= 1, 'the popup lists the purchase');
  await press(ana.page, /^Restore purchases$/, '.popup[aria-label="Coin Shop"]', 30_000);
  await ana.page.locator('.toasts', { hasText: /Nothing to restore/ }).waitFor({ timeout: 60_000 });
  check((await stored(ana.page)).coins === state.coins, 'a restore on the device that bought credits nothing more');
  for (const e of ana.errors) check(false, `page error: ${e.slice(0, 300)}`);

  /* ---------- A fresh device: the same wallet restores the coins the chain holds ---------- */
  bea = await player('Bea', wallet);
  await bea.page.goto(url, { waitUntil: 'networkidle' });
  await bea.page.locator('.splash__play').click({ force: true, timeout: 20_000 });
  await bea.page.locator('.home__level').waitFor({ timeout: 20_000 });
  let shop2 = await openShop(bea.page, { gate: true });
  await connectFromShop(bea, shop2);
  shop2 = await openShop(bea.page, { gate: false });
  await shop2.locator('.pack__buy').first().waitFor({ timeout: 60_000 });
  check(((await stored(bea.page)).coins ?? 0) === 0, 'the fresh context starts with no coins');
  await press(bea.page, /^Restore purchases$/, '.popup[aria-label="Coin Shop"]', 30_000);
  await bea.page.locator('.toasts', { hasText: new RegExp(`Restored ${COINS.toLocaleString('en-US')} coins`) }).waitFor({ timeout: 60_000 });
  const restored = await stored(bea.page);
  check(restored.coins === COINS && restored.credited?.[wallet.address] === COINS, `the fresh context restored ${restored.coins} coins, exactly the chain's total`);
  await press(bea.page, /^Restore purchases$/, '.popup[aria-label="Coin Shop"]', 30_000);
  await bea.page.locator('.toasts', { hasText: /Nothing to restore/ }).waitFor({ timeout: 60_000 });
  check((await stored(bea.page)).coins === COINS, 'a second restore credits nothing');
  for (const e of bea.errors) check(false, `page error: ${e.slice(0, 300)}`);
} catch (e) {
  failures++;
  console.log(`  ✗ ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
  for (const p of [ana, bea]) for (const err of p?.errors ?? []) console.log(`  ✗ page error: ${err.slice(0, 300)}`);
} finally {
  await Promise.allSettled([ana?.ctx.close(), bea?.ctx.close()]);
  await browser.close();
  server.close();
  if (funded) {
    try {
      const swept = await sweepTokens(rpc, payer, entry, { address: address(wallet.address), keyPair: wallet.keyPair });
      if (swept) {
        links.push({ label: `sweep ${SYMBOL}`, signature: swept.signature });
        console.log(`swept ${amount(swept.held)} and the account rent back: ${explorer(swept.signature)}`);
      }
      const left = await balance(wallet.address);
      if (left > 10_000n) {
        const sol = await sendFrom(wallet, [transferIx(wallet.address, payer.address, left - 5_000n)]);
        links.push({ label: 'sweep SOL', signature: sol.signature });
        console.log(`swept ${fmt(left - 5_000n)} back: ${explorer(sol.signature)}`);
      }
    } catch (e) {
      console.log(`sweep failed (${e instanceof Error ? e.message : e})`);
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
