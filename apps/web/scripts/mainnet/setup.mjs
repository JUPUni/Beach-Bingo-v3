#!/usr/bin/env node
// The mainnet Coin Shop, set up and kept priced from registry.json (docs/MAINNET.md):
//
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/mainnet/setup.mjs plan [--live]
//   ...                                                                     apply [--live]
//   ...                                                                     reprice [--live]
//   ...                                                                     handover <admin> --confirm <admin> [--upgrade-authority]
//
// plan      reads the chain and prints what apply would send, with the pack prices computed from
//           the registry's USD prices (--live refreshes SOL, JUP and SKR from Jupiter first and
//           writes them back); sends nothing.
// apply     converges the chain on the registry: init-config (needs TREASURY), set-config (SGT
//           group, pack sizes, discounts, SOL prices, PAUSER), register-mint for every missing
//           mint (the treasury's token accounts included), set-mint where an entry differs. Steps
//           already matching the chain are skipped, so it may be run again at any time.
// reprice   only the prices: SOL in the config, each registered mint's pack prices.
// handover  transfer-admin to <admin> (typed twice), then the upgrade authority with the Solana
//           CLI when --upgrade-authority is given (otherwise the command is printed).
//
// Environment: RPC_URL (a mainnet provider URL; default devnet, for rehearsals), KEYPAIR (the
// deployer; default .secrets/mainnet-deployer.json on mainnet, .secrets/devnet-deployer.json
// elsewhere), WAVE_DUEL_PROGRAM, TREASURY, PAUSER (optional), SGT_GROUP (optional override).
// Every transaction goes through wave-duel-admin.mjs, so what this script does, that one can
// do by hand.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { address, createKeyPairFromBytes, createSolanaRpc, getAddressFromPublicKey } from '@solana/kit';
import { configureProgram, fetchConfig } from '../../src/solana/waveDuel.ts';
import { ataAddress, fetchMintEntry } from '../../src/solana/waveToken.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REGISTRY = `${HERE}registry.json`;
const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const MAINNET = !/devnet|testnet|localhost|127\.0\.0\.1/i.test(RPC_URL);
const KEYPAIR = process.env.KEYPAIR || `${ROOT}.secrets/${MAINNET ? 'mainnet' : 'devnet'}-deployer.json`;
const PROGRAM = address(process.env.WAVE_DUEL_PROGRAM || '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH');
configureProgram(PROGRAM);
const rpc = createSolanaRpc(RPC_URL);

const [cmd = 'plan', ...args] = process.argv.slice(2);
const live = args.includes('--live');
const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
const SGT_GROUP = process.env.SGT_GROUP || reg.sgtGroup;

/* ---------- prices ---------- */
const SOL_MINT = 'So11111111111111111111111111111111111111112';
async function refreshPrices() {
  const ids = [SOL_MINT, ...reg.mints.filter((m) => !m.stable).map((m) => m.mint)];
  const r = await fetch(`${reg.priceSource}?ids=${ids.join(',')}`);
  if (!r.ok) throw new Error(`price API: HTTP ${r.status}`);
  const quotes = await r.json();
  const usd = (mint) => {
    const q = quotes[mint];
    if (!q || typeof q.usdPrice !== 'number' || !(q.usdPrice > 0)) throw new Error(`no price for ${mint}`);
    return q.usdPrice;
  };
  reg.sol.usdPrice = usd(SOL_MINT);
  for (const m of reg.mints) if (!m.stable) m.usdPrice = usd(m.mint);
  reg.pricedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(REGISTRY, `${JSON.stringify(reg, null, 2)}\n`);
  console.log(`prices refreshed from ${reg.priceSource}: SOL ${reg.sol.usdPrice}, ${reg.mints.filter((m) => !m.stable).map((m) => `${m.symbol} ${m.usdPrice}`).join(', ')}`);
}
/** Base units for `usd` worth of an asset, rounded to a tidy step (0.0001 SOL; 0.01 of a token worth 50 cents or more, else 0.0001). */
const units = (usd, usdPrice, decimals, step) => BigInt(Math.round(Math.round((usd / usdPrice) * 10 ** decimals) / step) * step);
const solPrices = () => reg.packs.usd.map((usd) => units(usd, reg.sol.usdPrice, 9, 100_000));
const mintPrices = (m) => reg.packs.usd.map((usd) => units(usd, m.usdPrice, m.decimals, m.usdPrice >= 0.5 ? 10 ** (m.decimals - 2) : 10 ** (m.decimals - 4)));
const show = (v, decimals) => (Number(v) / 10 ** decimals).toLocaleString('en-US', { maximumFractionDigits: 4 });
const csv = (xs) => xs.map(String).join(',');
const same = (a, b) => a.length === b.length && a.every((x, i) => BigInt(x) === BigInt(b[i]));

/* ---------- the chain ---------- */
const exists = async (addr) => Boolean((await rpc.getAccountInfo(addr, { encoding: 'base64' }).send()).value);
const owner = async (addr) => (await rpc.getAccountInfo(addr, { encoding: 'base64' }).send()).value?.owner ?? null;
async function readState() {
  const config = await fetchConfig(rpc);
  const mints = [];
  for (const m of reg.mints) {
    const mint = address(m.mint);
    const tokenProgram = await owner(mint);
    const entry = tokenProgram ? await fetchMintEntry(rpc, mint) : null;
    const treasuryAta = config && tokenProgram ? await ataAddress(config.treasury, mint, address(tokenProgram)) : null;
    mints.push({ ...m, onCluster: Boolean(tokenProgram), tokenProgram, entry, treasuryAta, ataExists: treasuryAta ? await exists(treasuryAta) : false, prices: mintPrices(m) });
  }
  return { program: await exists(PROGRAM), config, mints };
}
async function payerAddress() {
  if (!existsSync(KEYPAIR)) return null;
  const keyPair = await createKeyPairFromBytes(Uint8Array.from(JSON.parse(readFileSync(KEYPAIR, 'utf8'))));
  return getAddressFromPublicKey(keyPair.publicKey);
}
const admin = (...a) => {
  console.log(`\n$ wave-duel-admin.mjs ${a.join(' ')}`);
  execFileSync('pnpm', ['--filter', '@beach-bingo/engine', 'exec', 'tsx', '../../apps/web/scripts/wave-duel-admin.mjs', ...a], {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, RPC_URL, KEYPAIR, WAVE_DUEL_PROGRAM: PROGRAM },
  });
};

/** The set-config arguments that would bring `config` to the registry, or [] when it already matches. */
function configChanges(config) {
  const kv = [];
  const want = { fee: reg.fees.feeBps, seekerDiscount: reg.fees.seekerDiscountBps, solSeekerFee: reg.fees.solSeekerFeeBps };
  if (config.feeBps !== want.fee) kv.push(`fee=${want.fee}`);
  if (config.seekerDiscountBps !== want.seekerDiscount) kv.push(`seekerDiscount=${want.seekerDiscount}`);
  if (config.solSeekerFeeBps !== want.solSeekerFee) kv.push(`solSeekerFee=${want.solSeekerFee}`);
  if (config.sgtGroup !== SGT_GROUP) kv.push(`sgt=${SGT_GROUP}`);
  if (!same(config.packCoins, reg.packs.coins)) kv.push(`packs=${csv(reg.packs.coins)}`);
  if (!same(config.solPackPrices, solPrices())) kv.push(`solPrices=${csv(solPrices())}`);
  if (process.env.PAUSER && config.pauser !== process.env.PAUSER) kv.push(`pauser=${process.env.PAUSER}`);
  if (process.env.TREASURY && config.treasury !== process.env.TREASURY) kv.push(`treasury=${process.env.TREASURY}`);
  return kv;
}
/** The set-mint arguments for a registered entry that differs from the registry, or []. */
function mintChanges(m) {
  const e = m.entry;
  const kv = [];
  if (BigInt(e.minStake) !== BigInt(m.minStake)) kv.push(`min=${m.minStake}`);
  if (BigInt(e.maxStake) !== BigInt(m.maxStake)) kv.push(`max=${m.maxStake}`);
  if (e.feeBps !== m.feeBps) kv.push(`fee=${m.feeBps}`);
  if (e.seekerFeeBps !== m.seekerFeeBps) kv.push(`seekerFee=${m.seekerFeeBps}`);
  if (e.discountBps !== m.discountBps) kv.push(`discount=${m.discountBps}`);
  if (!same(e.packPrices, m.prices)) kv.push(`prices=${csv(m.prices)}`);
  if (!e.enabled) kv.push('enabled=true');
  return kv;
}

/* ---------- commands ---------- */
if (live) await refreshPrices();
const payer = await payerAddress();
console.log(`${MAINNET ? 'MAINNET' : 'devnet'} · rpc ${RPC_URL} · program ${PROGRAM}`);
if (payer) console.log(`deployer ${payer}: ${(Number((await rpc.getBalance(payer).send()).value) / 1e9).toFixed(4)} SOL (${KEYPAIR})`);
else console.log(`no key pair at ${KEYPAIR}`);
const state = await readState();
console.log(`program account: ${state.program ? 'deployed' : 'ABSENT (deploy it first; docs/MAINNET.md step 2)'}`);
if (state.config) {
  const c = state.config;
  console.log(`config: admin ${c.admin} · treasury ${c.treasury} · fee ${c.feeBps} bps · paused ${c.paused} · pauser ${c.pauser}`);
  console.log(`        sgt ${c.sgtGroup} · packs ${csv(c.packCoins)} · seeker discount ${c.seekerDiscountBps} bps · SOL prices ${c.solPackPrices.map((p) => show(p, 9)).join(' / ')} SOL`);
} else console.log('config: none yet');
console.log(`\npack prices from registry.json (priced ${reg.pricedAt}; packs ${csv(reg.packs.coins)} coins at $${reg.packs.usd.join(' / $')}):`);
console.log(`  SOL   ${solPrices().map((p) => show(p, 9)).join(' / ')}   (SOL at $${reg.sol.usdPrice})`);
for (const m of state.mints) {
  const status = !m.onCluster ? 'not on this cluster' : m.entry ? `registered${mintChanges(m).length ? `, differs: ${mintChanges(m).join(' ')}` : ', matches'}` : 'not registered';
  console.log(`  ${m.symbol.padEnd(5)} ${m.prices.map((p) => show(p, m.decimals)).join(' / ')}   (${m.symbol} at $${m.usdPrice}${m.discountBps ? `, ${m.discountBps / 100}% off at the till` : ''}) · ${status}${m.treasuryAta ? ` · treasury account ${m.ataExists ? 'exists' : 'to create'}` : ''}`);
}

if (cmd === 'plan') {
  const steps = [];
  if (!state.program) steps.push('deploy the program (manual, docs/MAINNET.md step 2)');
  if (!state.config) steps.push(`init-config 500 ${process.env.TREASURY ?? '<TREASURY>'}`);
  const kv = state.config ? configChanges(state.config) : ['sgt', 'packs', 'seekerDiscount', 'solPrices', 'solSeekerFee', process.env.PAUSER ? 'pauser' : null].filter(Boolean);
  if (kv.length) steps.push(`set-config ${kv.join(' ')}`);
  for (const m of state.mints) {
    if (!m.onCluster) continue;
    if (!m.entry) steps.push(`register-mint ${m.symbol} (${m.ataExists ? 'treasury account exists' : 'creates the treasury account'})`);
    else if (mintChanges(m).length) steps.push(`set-mint ${m.symbol} ${mintChanges(m).join(' ')}`);
  }
  console.log(`\napply would run:${steps.length ? `\n  - ${steps.join('\n  - ')}` : ' nothing; the chain matches the registry'}`);
} else if (cmd === 'apply' || cmd === 'reprice') {
  if (!state.program) throw new Error('the program is not deployed on this cluster');
  if (!payer) throw new Error(`no deployer key pair at ${KEYPAIR}`);
  let config = state.config;
  if (cmd === 'apply' && !config) {
    if (!process.env.TREASURY) throw new Error('TREASURY is required for init-config');
    admin('init-config', '500', process.env.TREASURY);
    config = await fetchConfig(rpc);
  }
  if (!config) throw new Error('no config on this cluster (apply first)');
  const kv = cmd === 'apply' ? configChanges(config) : !same(config.solPackPrices, solPrices()) ? [`solPrices=${csv(solPrices())}`] : [];
  if (kv.length) admin('set-config', ...kv);
  for (const m of state.mints) {
    if (!m.onCluster) continue;
    if (!m.entry) {
      if (cmd === 'apply') admin('register-mint', m.mint, String(m.minStake), String(m.maxStake), String(m.feeBps), String(m.seekerFeeBps), String(m.discountBps), csv(m.prices));
      continue;
    }
    const changes = cmd === 'apply' ? mintChanges(m) : !same(m.entry.packPrices, m.prices) ? [`prices=${csv(m.prices)}`] : [];
    if (changes.length) admin('set-mint', m.mint, ...changes);
  }
  console.log(`\n${cmd} done; run plan to confirm the chain matches the registry`);
} else if (cmd === 'handover') {
  const [who, flag, again] = args.filter((a) => !a.startsWith('--') || a === '--confirm');
  if (!who || flag !== '--confirm' || again !== who) throw new Error('handover <admin> --confirm <admin> [--upgrade-authority]');
  if (!payer) throw new Error(`no deployer key pair at ${KEYPAIR}`);
  admin('transfer-admin', who, '--confirm', who);
  const cli = ['program', 'set-upgrade-authority', PROGRAM, '--new-upgrade-authority', who, '--skip-new-upgrade-authority-signer-check', '-k', KEYPAIR, '-u', RPC_URL];
  if (args.includes('--upgrade-authority')) {
    console.log(`\n$ solana ${cli.join(' ')}`);
    execFileSync('solana', cli, { stdio: 'inherit' });
  } else console.log(`\nnext, the upgrade authority:\n  solana ${cli.join(' ')}`);
} else {
  throw new Error(`unknown command ${cmd} (plan | apply | reprice | handover)`);
}
