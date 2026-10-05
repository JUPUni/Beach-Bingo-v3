#!/usr/bin/env node
// Operate the wave_duel program on a cluster with a key pair file (the deployer on devnet):
//
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs init-config [feeBps] [treasury]
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs show [host code]
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs round [stakeSol]
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs hall [stakeSol] [cards per seat...]
//
// The token registry, the config's new fields and the devnet mocks:
//
//   ... wave-duel-admin.mjs migrate-config                       grow a first-deployment config to the current layout (once)
//   ... wave-duel-admin.mjs set-config key=value ...             fee, paused, pauser, sgt, packs, seekerDiscount, solPrices, solSeekerFee, treasury
//   ... wave-duel-admin.mjs register-mint <mint> <min> <max> <feeBps> <seekerFeeBps> [discountBps] [packPrices csv]
//   ... wave-duel-admin.mjs set-mint <mint> key=value ...        min, max, fee, seekerFee, discount, prices, enabled
//   ... wave-duel-admin.mjs transfer-admin <wallet> --confirm <wallet>   hand the admin role to another wallet (a multisig vault on mainnet); typed twice, no way back
//   ... wave-duel-admin.mjs show-mints
//   ... wave-duel-admin.mjs create-devnet-mint <spl|token2022> <decimals> <amount> [wallet] [--freeze] [--pyusd-like]
//   ... wave-duel-admin.mjs create-devnet-sgt [wallet]
//
// The token proofs on devnet (amounts in display units; every throwaway wallet is funded with SOL
// and the token from the key pair and swept back at the end):
//
//   ... wave-duel-admin.mjs token-round <mint> [stake]                 open_room_token → join_room_token → settle_token, checked against the engine replay
//   ... wave-duel-admin.mjs token-hall <mint> [stakePerCard] [cards...] a token hall of 2..8 seats (default 2/1/3), a guest locks, settle_hall_token
//   ... wave-duel-admin.mjs prove-seeker [mint]                        the key pair's mock SGT lowers an open room's (and hall's) fee to the Seeker tier
//   ... wave-duel-admin.mjs shop-buy <sol|mint> <pack> [--seeker]      buy_pack / buy_pack_token; the Buyer PDA, the CoinsBought event and the price arithmetic
//   ... wave-duel-admin.mjs faucet <mint> <wallet> <amount>            send a wallet test tokens from the key pair's account
//
// Stakes and prices are base units. `create-devnet-mint` makes a look-alike with the deployer as
// authority (JUP, SKR; `--freeze` for a USDC-like freeze authority; `--pyusd-like` for Token-2022
// with a permanent delegate, a zero transfer fee, an empty transfer hook and a metadata pointer) and
// mints `amount` whole tokens to `wallet` (default: the deployer). `create-devnet-sgt` makes a mock
// Seeker Genesis Token group and mints one member token to `wallet`; put the group it prints in
// `set-config sgt=<group>` so `prove_seeker_*` and the Seeker shop discount work on devnet.
//
// Environment: RPC_URL (default devnet; a mainnet provider URL switches the explorer links too), KEYPAIR (default .secrets/devnet-deployer.json at the
// repo root, or the main checkout's from a git worktree), WAVE_DUEL_PROGRAM (default the devnet
// deployment). `round` funds two throwaway wallets from the key pair, plays open → join → settle,
// and checks the payout against the engine's own replay; `hall` does the same for a multi-seat
// hall (open → joins → a guest locks → settle).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AccountRole,
  address,
  createKeyPairFromBytes,
  createNoopSigner,
  createSolanaRpc,
  generateKeyPair,
  getAddressEncoder,
  getAddressFromPublicKey,
  getStructEncoder,
  getU32Encoder,
  getU64Encoder,
  none,
  some,
} from '@solana/kit';
import {
  getCreateAssociatedTokenIdempotentInstruction,
  getInitializeGroupMemberPointerInstruction,
  getInitializeGroupPointerInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializePermanentDelegateInstruction,
  getInitializeTokenGroupInstruction,
  getInitializeTokenGroupMemberInstruction,
  getInitializeTransferFeeConfigInstruction,
  getInitializeTransferHookInstruction,
  getMintSize,
  getMintToInstruction,
} from '@solana-program/token-2022';
import { commitSeed, createServerSeed, rooms } from '../../../packages/engine/src/index.ts';
import { buildRoom, makeCode } from '../src/rooms/live/protocol.ts';
import {
  cancelRoomIx,
  configAddress,
  configureProgram,
  fetchConfig,
  fetchRoom,
  formatSol,
  initConfigIx,
  joinRoomIx,
  migrateConfigIx,
  openRoomIx,
  roomAddress,
  sendSigned,
  setConfigIx,
  transferAdminIx,
  settleIx,
  SYSTEM_PROGRAM,
} from '../src/solana/waveDuel.ts';
import { fetchHall, hallAddress, hallRoster, joinHallIx, lockHallIx, openHallIx, settleHallIxs, splitHallPot } from '../src/solana/waveHall.ts';
import {
  ataAddress,
  cancelHallTokenIx,
  cancelRoomTokenIx,
  fetchMintEntries,
  fetchMintEntry,
  joinHallTokenIx,
  joinRoomTokenIx,
  openHallTokenIx,
  openRoomTokenIx,
  proveSeekerHallIx,
  proveSeekerRoomIx,
  registerMintIx,
  setMintIx,
  settleHallTokenIxs,
  settleTokenIx,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  vaultAddress,
} from '../src/solana/waveToken.ts';
import { buyPackIx, buyPackTokenIx, fetchBuyer, fetchCoinsBought, packPrice } from '../src/solana/shop.ts';
import { findSeekerToken } from '../src/solana/sgt.ts';
import { knownSymbol } from '../src/solana/tokens.ts';
import { fmtUnits, fundTokens, sweepTokens, toBase, tokenBalance } from './qa/token-lib.mjs';

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const KEYPAIR = process.env.KEYPAIR || defaultKeypair();
const PROGRAM = address(process.env.WAVE_DUEL_PROGRAM || '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH');
const SOL = 1_000_000_000n;
/** SOL each throwaway wallet of a token proof gets: the escrow's and the vault's rent, a few fees. */
const TOKEN_PURSE = 30_000_000n;

/** `.secrets/devnet-deployer.json` at the repo root, or the main checkout's when this is a git worktree. */
function defaultKeypair() {
  const here = new URL('../../../.secrets/devnet-deployer.json', import.meta.url).pathname;
  if (existsSync(here)) return here;
  try {
    const scripts = dirname(fileURLToPath(import.meta.url));
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: scripts, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const main = join(dirname(resolve(scripts, common)), '.secrets/devnet-deployer.json');
    if (existsSync(main)) return main;
  } catch {
    /* not a git checkout */
  }
  return here;
}

configureProgram(PROGRAM);
const rpc = createSolanaRpc(RPC_URL);
// Explorer links follow the RPC: no cluster parameter on mainnet.
const CLUSTER_QS = /devnet/i.test(RPC_URL) ? '?cluster=devnet' : /testnet/i.test(RPC_URL) ? '?cluster=testnet' : '';
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}${CLUSTER_QS}`;

const loadWallet = async (path) => {
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')));
  const keyPair = await createKeyPairFromBytes(bytes);
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
};
const newWallet = async () => {
  const keyPair = await generateKeyPair();
  return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
};
const transferIx = (from, to, lamports) => ({
  programAddress: SYSTEM_PROGRAM,
  accounts: [
    { address: from, role: AccountRole.WRITABLE_SIGNER },
    { address: to, role: AccountRole.WRITABLE },
  ],
  data: getStructEncoder([
    ['ix', getU32Encoder()],
    ['lamports', getU64Encoder()],
  ]).encode({ ix: 2, lamports }),
});
const shortAddr = (a) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const balance = async (addr) => (await rpc.getBalance(addr, { commitment: 'confirmed' }).send()).value;

const payer = await loadWallet(KEYPAIR);
const [cmd = 'show', ...args] = process.argv.slice(2);
console.log(`program ${PROGRAM} · rpc ${RPC_URL} · payer ${payer.address} (${formatSol(await balance(payer.address))})`);

if (cmd === 'init-config') {
  const feeBps = Number(args[0] || 500);
  const treasury = address(args[1] || payer.address);
  const existing = await fetchConfig(rpc);
  if (existing) {
    console.log('config exists:', existing);
  } else {
    const sent = await sendSigned(rpc, payer.address, [payer.keyPair], [await initConfigIx(payer.address, treasury, feeBps)]);
    console.log(`config initialised: fee ${feeBps} bps, treasury ${treasury}`);
    console.log(explorer(sent.signature));
  }
  console.log('config pda', await configAddress());
} else if (cmd === 'show') {
  console.log('config', await fetchConfig(rpc));
  if (args[0] && args[1]) console.log('room', await fetchRoom(rpc, await roomAddress(address(args[0]), args[1])));
} else if (cmd === 'round') {
  const stake = BigInt(Math.round(Number(args[0] || '0.05') * 1e9));
  const config = await fetchConfig(rpc);
  if (!config) throw new Error('init-config first');
  const host = await newWallet();
  const guest = await newWallet();
  const purse = stake + 30_000_000n; // stake, rent and fees
  console.log(`funding host ${host.address} and guest ${guest.address} with ${formatSol(purse)} each`);
  const funded = await sendSigned(rpc, payer.address, [payer.keyPair], [transferIx(payer.address, host.address, purse), transferIx(payer.address, guest.address, purse)]);
  console.log('  funded', explorer(funded.signature));

  const serverSeed = createServerSeed();
  const commitment = commitSeed(serverSeed);
  const code = makeCode();
  const opened = await sendSigned(rpc, host.address, [host.keyPair], [await openRoomIx(host.address, code, stake, commitment)]);
  const roomPda = await roomAddress(host.address, code);
  console.log(`  opened room ${code} at ${roomPda} with ${formatSol(stake)}: ${explorer(opened.signature)}`);

  const joined = await sendSigned(rpc, guest.address, [guest.keyPair], [await joinRoomIx(guest.address, roomPda)]);
  const room = await fetchRoom(rpc, roomPda);
  console.log(`  guest joined: ${explorer(joined.signature)}`);
  console.log(`  state ${room.state} · entropy ${room.entropy.slice(0, 16)}… · joined slot ${room.joinedSlot}`);

  // The engine's own answer, from the seed and the entropy the chain fixed.
  const replay = buildRoom(
    rooms.ROOM_PRESETS.waveRush,
    commitment,
    serverSeed,
    [
      { id: 'host', name: 'Host', cards: 1 },
      { id: 'guest', name: 'Guest', cards: 1 },
    ],
    room.entropy,
  );
  while (replay.phase === 'drawing') rooms.drawNext(replay);
  const win = replay.wins[0];
  const winners = win.winners.map((w) => w.playerId);
  console.log(`  engine says: ${winners.join(' and ')} on ball ${win.ballCount}`);

  const before = { host: await balance(host.address), guest: await balance(guest.address), treasury: await balance(config.treasury) };
  const settled = await sendSigned(rpc, payer.address, [payer.keyPair], [await settleIx(room, config.treasury, payer.address, serverSeed)]);
  console.log(`  settled by the payer: ${explorer(settled.signature)}`);
  const after = { host: await balance(host.address), guest: await balance(guest.address), treasury: await balance(config.treasury) };
  const pot = stake * 2n;
  const fee = (pot * BigInt(config.feeBps)) / 10_000n;
  const prize = pot - fee;
  const rent = room.lamports - pot;
  const gained = { host: after.host - before.host - rent, guest: after.guest - before.guest, treasury: after.treasury - before.treasury };
  console.log(`  pot ${formatSol(pot)} · fee ${formatSol(fee)} · host +${formatSol(gained.host)} · guest +${formatSol(gained.guest)} · treasury +${formatSol(gained.treasury)}`);
  const expected =
    winners.length === 2
      ? { host: prize / 2n, guest: prize / 2n, treasury: fee + (prize % 2n) }
      : winners[0] === 'host'
        ? { host: prize, guest: 0n, treasury: fee }
        : { host: 0n, guest: prize, treasury: fee };
  // The payer settled; when the payer is also the treasury it paid the transaction fee out of the same account.
  if (config.treasury === payer.address) expected.treasury -= 5_000n;
  const agree = gained.host === expected.host && gained.guest === expected.guest && gained.treasury === expected.treasury;
  console.log(agree ? '  ✓ the chain paid exactly whom the engine named' : `  ✗ mismatch: expected ${JSON.stringify(expected, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
  console.log(`  room closed: ${(await fetchRoom(rpc, roomPda)) === null}`);
  // Sweep the throwaway wallets back to the payer: devnet SOL is free, but not unlimited.
  for (const w of [host, guest]) {
    const left = await balance(w.address);
    if (left > 10_000n) await sendSigned(rpc, w.address, [w.keyPair], [transferIx(w.address, payer.address, left - 5_000n)]);
  }
  console.log(`  swept back to the payer (${formatSol(await balance(payer.address))})`);
  if (!agree) process.exit(1);
} else if (cmd === 'hall') {
  // A staked hall on devnet: the host and the guests buy the card counts given (default 2, 1, 3),
  // a guest locks the table, the payer settles, and every seat's payout is checked against the
  // engine's own replay of the round.
  const stake = BigInt(Math.round(Number(args[0] || '0.01') * 1e9));
  const counts = args.length > 1 ? args.slice(1).map((n) => Number(n)) : [2, 1, 3];
  if (counts.length < 2 || counts.length > 8 || counts.some((n) => !(n >= 1 && n <= 4))) throw new Error('give 2..8 card counts of 1..4');
  const config = await fetchConfig(rpc);
  if (!config) throw new Error('init-config first');
  const seats = await Promise.all(counts.map(() => newWallet()));
  const [host, ...guests] = seats;
  console.log(`funding ${seats.length} seats: ${seats.map((w, i) => `${shortAddr(w.address)} ×${counts[i]}`).join(', ')}`);
  const funded = await sendSigned(
    rpc,
    payer.address,
    [payer.keyPair],
    seats.map((w, i) => transferIx(payer.address, w.address, stake * BigInt(counts[i]) + 20_000_000n)),
  );
  console.log('  funded', explorer(funded.signature));

  const serverSeed = createServerSeed();
  const commitment = commitSeed(serverSeed);
  const code = makeCode();
  // One seat more than the roster, so the table does not lock itself: a guest closes the sales.
  const maxPlayers = Math.min(8, counts.length + 1);
  const opened = await sendSigned(rpc, host.address, [host.keyPair], [await openHallIx(host.address, code, stake, maxPlayers, counts[0], commitment)]);
  const hallPda = await hallAddress(host.address, code);
  console.log(`  opened hall ${code} at ${hallPda}: ${counts[0]} card(s) at ${formatSol(stake)} each, ${maxPlayers} seats: ${explorer(opened.signature)}`);
  for (const [i, guest] of guests.entries()) {
    const joined = await sendSigned(rpc, guest.address, [guest.keyPair], [await joinHallIx(guest.address, hallPda, counts[i + 1])]);
    console.log(`  seat ${i + 2} joined with ${counts[i + 1]} card(s): ${explorer(joined.signature)}`);
  }
  let hall = await fetchHall(rpc, hallPda);
  if (hall.state === 'open') {
    const locked = await sendSigned(rpc, guests[0].address, [guests[0].keyPair], [await lockHallIx(guests[0].address, hallPda)]);
    console.log(`  seat 2 locked the table: ${explorer(locked.signature)}`);
    hall = await fetchHall(rpc, hallPda);
  }
  console.log(`  state ${hall.state} · ${hall.cardsSold} cards · entropy ${hall.entropy.slice(0, 16)}… · locked slot ${hall.lockedSlot}`);

  // The engine's own answer: the roster in seat order, the escrow's entropy as the client seed.
  const replay = buildRoom(rooms.ROOM_PRESETS.waveRush, commitment, serverSeed, hallRoster(hall), hall.entropy);
  while (replay.phase === 'drawing') rooms.drawNext(replay);
  const win = replay.wins[0];
  const winningCards = hall.seats.map(() => 0);
  for (const w of win.winners) winningCards[hall.seats.findIndex((s) => s.player === w.playerId)] += 1;
  console.log(`  engine says: ball ${win.ballCount}, winning cards per seat [${winningCards.join(', ')}]`);

  const before = await Promise.all([...seats.map((w) => balance(w.address)), balance(config.treasury)]);
  const settled = await sendSigned(rpc, payer.address, [payer.keyPair], await settleHallIxs(hall, config.treasury, payer.address, serverSeed));
  console.log(`  settled by the payer: ${explorer(settled.signature)}`);
  const after = await Promise.all([...seats.map((w) => balance(w.address)), balance(config.treasury)]);
  const split = splitHallPot(hall.stakePerCard, hall.cardsSold, config.feeBps, win.winners.length);
  const gained = after.map((v, i) => v - before[i]);
  gained[0] -= hall.lamports - split.pot; // the host paid the account's rent and gets it back on close
  const expected = [...winningCards.map((n) => split.share * BigInt(n)), split.fee + split.dust];
  if (config.treasury === payer.address) expected[expected.length - 1] -= 5_000n; // the payer settled out of the treasury's own account
  console.log(`  pot ${formatSol(split.pot)} · fee ${formatSol(split.fee)} · ${win.winners.length} winning card(s) × ${formatSol(split.share)} · dust ${split.dust} lamports`);
  const agree = gained.every((g, i) => g === expected[i]);
  console.log(agree ? '  ✓ the chain paid every seat exactly what the engine says' : `  ✗ mismatch: got [${gained.join(', ')}], expected [${expected.join(', ')}]`);
  console.log(`  hall closed: ${(await fetchHall(rpc, hallPda)) === null}`);
  for (const w of seats) {
    const left = await balance(w.address);
    if (left > 10_000n) await sendSigned(rpc, w.address, [w.keyPair], [transferIx(w.address, payer.address, left - 5_000n)]);
  }
  console.log(`  swept back to the payer (${formatSol(await balance(payer.address))})`);
  if (!agree) process.exit(1);
} else if (cmd === 'migrate-config') {
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair], [await migrateConfigIx(payer.address)]);
  console.log('config migrated', explorer(sent.signature));
  console.log('config', await fetchConfig(rpc));
} else if (cmd === 'set-config') {
  // Starts from the config as it is; `treasury=` names the account, everything else a field.
  const current = await fetchConfig(rpc);
  if (!current) throw new Error('init-config first');
  const kv = keyValues(args);
  const csv = (v, map) => v.split(',').map(map);
  const terms = {
    feeBps: kv.fee !== undefined ? Number(kv.fee) : current.feeBps,
    paused: kv.paused !== undefined ? kv.paused === 'true' : current.paused,
    pauser: kv.pauser ? address(kv.pauser) : current.pauser,
    sgtGroup: kv.sgt ? address(kv.sgt) : current.sgtGroup,
    packCoins: kv.packs ? csv(kv.packs, Number) : current.packCoins,
    seekerDiscountBps: kv.seekerDiscount !== undefined ? Number(kv.seekerDiscount) : current.seekerDiscountBps,
    solPackPrices: kv.solPrices ? csv(kv.solPrices, BigInt) : current.solPackPrices,
    solSeekerFeeBps: kv.solSeekerFee !== undefined ? Number(kv.solSeekerFee) : current.solSeekerFeeBps,
  };
  const treasury = kv.treasury ? address(kv.treasury) : current.treasury;
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair], [await setConfigIx(payer.address, treasury, terms)]);
  console.log('config set', explorer(sent.signature));
  console.log('config', await fetchConfig(rpc));
} else if (cmd === 'register-mint') {
  const [mintArg, min, max, feeBps, seekerFeeBps, discountBps = '0', prices = '0,0,0,0'] = args;
  if (!mintArg || !min || !max || feeBps === undefined || seekerFeeBps === undefined) throw new Error('register-mint <mint> <min> <max> <feeBps> <seekerFeeBps> [discountBps] [packPrices csv]');
  const mint = address(mintArg);
  const config = await fetchConfig(rpc);
  if (!config) throw new Error('init-config first');
  const tokenProgram = await tokenProgramOf(mint);
  // The treasury's token account must exist before registration; the deployer creates it if needed.
  const treasuryAta = await ataAddress(config.treasury, mint, tokenProgram);
  if (!(await rpc.getAccountInfo(treasuryAta, { encoding: 'base64' }).send()).value) {
    const created = await sendSigned(rpc, payer.address, [payer.keyPair], [
      getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer.address), ata: treasuryAta, owner: config.treasury, mint, tokenProgram }),
    ]);
    console.log(`  treasury token account ${treasuryAta} created: ${explorer(created.signature)}`);
  }
  const terms = { minStake: BigInt(min), maxStake: BigInt(max), feeBps: Number(feeBps), seekerFeeBps: Number(seekerFeeBps), packPrices: prices.split(',').map(BigInt), discountBps: Number(discountBps) };
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair], [await registerMintIx(payer.address, config.treasury, mint, tokenProgram, terms)]);
  console.log(`mint registered under ${tokenProgram === TOKEN_PROGRAM ? 'SPL Token' : 'Token-2022'}: ${explorer(sent.signature)}`);
  console.log(await fetchMintEntry(rpc, mint));
} else if (cmd === 'set-mint') {
  const [mintArg, ...rest] = args;
  if (!mintArg) throw new Error('set-mint <mint> key=value ... (min, max, fee, seekerFee, discount, prices, enabled)');
  const mint = address(mintArg);
  const entry = await fetchMintEntry(rpc, mint);
  if (!entry) throw new Error('mint is not registered');
  const kv = keyValues(rest);
  const terms = {
    minStake: kv.min ? BigInt(kv.min) : entry.minStake,
    maxStake: kv.max ? BigInt(kv.max) : entry.maxStake,
    feeBps: kv.fee !== undefined ? Number(kv.fee) : entry.feeBps,
    seekerFeeBps: kv.seekerFee !== undefined ? Number(kv.seekerFee) : entry.seekerFeeBps,
    packPrices: kv.prices ? kv.prices.split(',').map(BigInt) : entry.packPrices,
    discountBps: kv.discount !== undefined ? Number(kv.discount) : entry.discountBps,
  };
  const enabled = kv.enabled !== undefined ? kv.enabled === 'true' : entry.enabled;
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair], [await setMintIx(payer.address, mint, terms, enabled)]);
  console.log('mint updated', explorer(sent.signature));
  console.log(await fetchMintEntry(rpc, mint));
} else if (cmd === 'transfer-admin') {
  // The new admin does not sign, so the address is typed twice: a typo would strand the config.
  const [newArg, flag, confirmArg] = args;
  if (!newArg || flag !== '--confirm' || confirmArg !== newArg) throw new Error('transfer-admin <wallet> --confirm <wallet> (the same address twice; there is no way back without the new key)');
  const newAdmin = address(newArg);
  const config = await fetchConfig(rpc);
  if (!config) throw new Error('init-config first');
  if (config.admin !== payer.address) throw new Error(`the key pair ${payer.address} is not the admin (${config.admin})`);
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair], [await transferAdminIx(payer.address, newAdmin)]);
  console.log(`admin handed to ${newAdmin}: ${explorer(sent.signature)}`);
  console.log('config', await fetchConfig(rpc));
} else if (cmd === 'show-mints') {
  for (const entry of await fetchMintEntries(rpc)) console.log(entry);
} else if (cmd === 'create-devnet-mint') {
  const [kind, decimalsArg, amountArg, walletArg] = args.filter((a) => !a.startsWith('--'));
  const flags = new Set(args.filter((a) => a.startsWith('--')));
  if (!['spl', 'token2022'].includes(kind) || !decimalsArg || !amountArg) throw new Error('create-devnet-mint <spl|token2022> <decimals> <amount> [wallet] [--freeze] [--pyusd-like]');
  const program = kind === 'spl' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM;
  const decimals = Number(decimalsArg);
  const to = address(walletArg || payer.address);
  const pyusdLike = flags.has('--pyusd-like');
  if (pyusdLike && program !== TOKEN_2022_PROGRAM) throw new Error('--pyusd-like needs token2022');
  const zeroFee = { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 };
  const extensions = pyusdLike
    ? [
        { __kind: 'PermanentDelegate', delegate: payer.address },
        { __kind: 'TransferFeeConfig', transferFeeConfigAuthority: payer.address, withdrawWithheldAuthority: payer.address, withheldAmount: 0n, olderTransferFee: zeroFee, newerTransferFee: zeroFee },
        { __kind: 'TransferHook', authority: payer.address, programId: SYSTEM_PROGRAM },
        { __kind: 'MetadataPointer', authority: some(payer.address), metadataAddress: none() },
      ]
    : [];
  const mint = await createMint({
    program,
    decimals,
    freezeAuthority: flags.has('--freeze') || pyusdLike ? payer.address : null,
    extensions,
    before: (m) =>
      pyusdLike
        ? [
            getInitializePermanentDelegateInstruction({ mint: m, delegate: payer.address }),
            getInitializeTransferFeeConfigInstruction({ mint: m, transferFeeConfigAuthority: payer.address, withdrawWithheldAuthority: payer.address, transferFeeBasisPoints: 0, maximumFee: 0n }),
            getInitializeTransferHookInstruction({ mint: m, authority: payer.address, programId: null }),
            getInitializeMetadataPointerInstruction({ mint: m, authority: payer.address, metadataAddress: m }),
          ]
        : [],
  });
  const amount = BigInt(amountArg) * 10n ** BigInt(decimals);
  const ata = await mintTo(mint, program, to, amount);
  console.log(`mint ${mint} (${kind}, ${decimals} decimals${pyusdLike ? ', PYUSD-like extensions' : ''}${flags.has('--freeze') ? ', freeze authority' : ''}); ${amountArg} minted to ${to} at ${ata}`);
} else if (cmd === 'create-devnet-sgt') {
  // A mock Seeker Genesis Token: a Token-2022 group, and one member token for the wallet. The
  // member's metadata pointer and group membership both name the group, as the real SGT's do.
  const to = address(args[0] || payer.address);
  const group = await createMint({
    program: TOKEN_2022_PROGRAM,
    decimals: 0,
    freezeAuthority: null,
    extensions: [{ __kind: 'GroupPointer', authority: some(payer.address), groupAddress: none() }],
    later: [{ __kind: 'TokenGroup', updateAuthority: some(payer.address), mint: payer.address, size: 0n, maxSize: 1_000_000n }],
    before: (m) => [getInitializeGroupPointerInstruction({ mint: m, authority: payer.address, groupAddress: m })],
    after: (m) => [getInitializeTokenGroupInstruction({ group: m, mint: m, mintAuthority: createNoopSigner(payer.address), updateAuthority: payer.address, maxSize: 1_000_000n })],
  });
  const { member, ata } = await createSgtMember(group, to);
  console.log(`mock SGT group ${group}; member mint ${member} held by ${to} at ${ata}`);
  console.log(`now: wave-duel-admin.mjs set-config sgt=${group}`);
} else if (cmd === 'faucet') {
  const [mintArg, walletArg, amountArg] = args;
  if (!mintArg || !walletArg || !amountArg) throw new Error('faucet <mint> <wallet> <amount in display units>');
  const entry = await needEntry(address(mintArg));
  const amount = toBase(amountArg, entry.decimals);
  const { atas, signature } = await fundTokens(rpc, payer, entry, [address(walletArg)], amount);
  console.log(`sent ${fmtUnits(amount, entry, symbol(entry))} to ${walletArg} at ${atas[0]}: ${explorer(signature)}`);
} else if (cmd === 'token-round') {
  // A staked room in a registered token: two throwaway wallets get SOL (rent and fees) and the
  // token from the key pair; open_room_token → join_room_token → settle_token by the payer; every
  // token account's base units are checked against the engine's replay; the vault and the room
  // must be gone; tokens and SOL go back to the key pair.
  if (!args[0]) throw new Error('token-round <mint> [stake]');
  const entry = await needEntry(address(args[0]));
  const sym = symbol(entry);
  const stake = args[1] ? toBase(args[1], entry.decimals) : entry.minStake;
  const host = await newWallet();
  const guest = await newWallet();
  console.log(`funding host ${host.address} and guest ${guest.address}: ${formatSol(TOKEN_PURSE)} and ${fmtUnits(stake, entry, sym)} each`);
  const funded = await sendSigned(rpc, payer.address, [payer.keyPair], [transferIx(payer.address, host.address, TOKEN_PURSE), transferIx(payer.address, guest.address, TOKEN_PURSE)]);
  console.log('  funded SOL', explorer(funded.signature));
  const tokens = await fundTokens(rpc, payer, entry, [host.address, guest.address], stake);
  const [hostAta, guestAta] = tokens.atas;
  console.log(`  funded ${sym}`, explorer(tokens.signature));

  const serverSeed = createServerSeed();
  const commitment = commitSeed(serverSeed);
  const code = makeCode();
  const opened = await sendSigned(rpc, host.address, [host.keyPair], [await openRoomTokenIx(host.address, code, stake, commitment, entry)]);
  const roomPda = await roomAddress(host.address, code);
  const vault = await vaultAddress(roomPda, entry.mint, entry.tokenProgram);
  console.log(`  opened room ${code} at ${roomPda} with ${fmtUnits(stake, entry, sym)}; vault ${vault}: ${explorer(opened.signature)}`);
  let room = await fetchRoom(rpc, roomPda);
  const joined = await sendSigned(rpc, guest.address, [guest.keyPair], [await joinRoomTokenIx(guest.address, room)]);
  room = await fetchRoom(rpc, roomPda);
  console.log(`  guest joined: ${explorer(joined.signature)}`);
  console.log(`  state ${room.state} · mint ${room.mint} · fee ${room.feeBps} bps · entropy ${room.entropy.slice(0, 16)}… · vault holds ${await tokenBalance(rpc, vault)} base units`);
  if (room.mint !== entry.mint || room.tokenProgram !== entry.tokenProgram || room.feeBps !== entry.feeBps) throw new Error('the room snapshot does not match the registry entry');

  const replay = buildRoom(
    rooms.ROOM_PRESETS.waveRush,
    commitment,
    serverSeed,
    [
      { id: 'host', name: 'Host', cards: 1 },
      { id: 'guest', name: 'Guest', cards: 1 },
    ],
    room.entropy,
  );
  while (replay.phase === 'drawing') rooms.drawNext(replay);
  const win = replay.wins[0];
  const winners = win.winners.map((w) => w.playerId);
  console.log(`  engine says: ${winners.join(' and ')} on ball ${win.ballCount}`);

  const read = async () => ({ host: await tokenBalance(rpc, hostAta), guest: await tokenBalance(rpc, guestAta), treasury: await tokenBalance(rpc, entry.treasuryAta), hostSol: await balance(host.address) });
  const before = await read();
  const settled = await sendSigned(rpc, payer.address, [payer.keyPair], [await settleTokenIx(room, payer.address, serverSeed)]);
  console.log(`  settled by the payer: ${explorer(settled.signature)}`);
  const after = await read();
  const pot = stake * 2n;
  const fee = (pot * BigInt(room.feeBps)) / 10_000n;
  const prize = pot - fee;
  const gained = { host: after.host - before.host, guest: after.guest - before.guest, treasury: after.treasury - before.treasury };
  const expected =
    winners.length === 2
      ? { host: prize / 2n, guest: prize / 2n, treasury: fee + (prize % 2n) }
      : winners[0] === 'host'
        ? { host: prize, guest: 0n, treasury: fee }
        : { host: 0n, guest: prize, treasury: fee };
  const agree = gained.host === expected.host && gained.guest === expected.guest && gained.treasury === expected.treasury;
  console.log(`  pot ${fmtUnits(pot, entry, sym)} · fee ${fmtUnits(fee, entry, sym)} · host +${gained.host} · guest +${gained.guest} · treasury +${gained.treasury} base units`);
  console.log(agree ? '  ✓ every token account holds exactly what the engine replay says' : `  ✗ mismatch: expected ${show(expected)}`);
  const closed = (await fetchRoom(rpc, roomPda)) === null && !(await rpc.getAccountInfo(vault, { encoding: 'base64' }).send()).value;
  console.log(`  ${closed ? '✓' : '✗'} room and vault closed; the host got the rent back (+${formatSol(after.hostSol - before.hostSol)})`);
  await sweepAll([host, guest], entry);
  if (!agree || !closed) process.exit(1);
} else if (cmd === 'token-hall') {
  // A token hall: the host and the guests buy the card counts given (default 2, 1, 3), a guest
  // locks, the payer settles with the roster's token accounts, and every seat's token account is
  // checked to the base unit against the engine's replay.
  if (!args[0]) throw new Error('token-hall <mint> [stakePerCard] [cards per seat...]');
  const entry = await needEntry(address(args[0]));
  const sym = symbol(entry);
  const stake = args[1] ? toBase(args[1], entry.decimals) : entry.minStake;
  const counts = args.length > 2 ? args.slice(2).map((n) => Number(n)) : [2, 1, 3];
  if (counts.length < 2 || counts.length > 8 || counts.some((n) => !(n >= 1 && n <= 4))) throw new Error('give 2..8 card counts of 1..4');
  const seats = await Promise.all(counts.map(() => newWallet()));
  const [host, ...guests] = seats;
  const most = BigInt(Math.max(...counts));
  console.log(`funding ${seats.length} seats with ${formatSol(TOKEN_PURSE)} and ${fmtUnits(stake * most, entry, sym)}: ${seats.map((w, i) => `${shortAddr(w.address)} ×${counts[i]}`).join(', ')}`);
  const funded = await sendSigned(rpc, payer.address, [payer.keyPair], seats.map((w) => transferIx(payer.address, w.address, TOKEN_PURSE)));
  console.log('  funded SOL', explorer(funded.signature));
  const tokens = await fundTokens(rpc, payer, entry, seats.map((w) => w.address), stake * most);
  console.log(`  funded ${sym}`, explorer(tokens.signature));

  const serverSeed = createServerSeed();
  const commitment = commitSeed(serverSeed);
  const code = makeCode();
  const maxPlayers = Math.min(8, counts.length + 1); // one seat spare, so a guest locks
  const opened = await sendSigned(rpc, host.address, [host.keyPair], [await openHallTokenIx(host.address, code, stake, maxPlayers, counts[0], commitment, entry)]);
  const hallPda = await hallAddress(host.address, code);
  const vault = await vaultAddress(hallPda, entry.mint, entry.tokenProgram);
  console.log(`  opened hall ${code} at ${hallPda}: ${counts[0]} card(s) at ${fmtUnits(stake, entry, sym)} each, ${maxPlayers} seats; vault ${vault}: ${explorer(opened.signature)}`);
  let hall = await fetchHall(rpc, hallPda);
  for (const [i, guest] of guests.entries()) {
    const joined = await sendSigned(rpc, guest.address, [guest.keyPair], [await joinHallTokenIx(guest.address, hall, counts[i + 1])]);
    console.log(`  seat ${i + 2} joined with ${counts[i + 1]} card(s): ${explorer(joined.signature)}`);
    hall = await fetchHall(rpc, hallPda);
  }
  if (hall.state === 'open') {
    const locked = await sendSigned(rpc, guests[0].address, [guests[0].keyPair], [await lockHallIx(guests[0].address, hallPda)]);
    console.log(`  seat 2 locked the table: ${explorer(locked.signature)}`);
    hall = await fetchHall(rpc, hallPda);
  }
  console.log(`  state ${hall.state} · ${hall.cardsSold} cards · mint ${hall.mint} · fee ${hall.feeBps} bps · entropy ${hall.entropy.slice(0, 16)}… · vault holds ${await tokenBalance(rpc, vault)} base units`);

  const replay = buildRoom(rooms.ROOM_PRESETS.waveRush, commitment, serverSeed, hallRoster(hall), hall.entropy);
  while (replay.phase === 'drawing') rooms.drawNext(replay);
  const win = replay.wins[0];
  const winningCards = hall.seats.map(() => 0);
  for (const w of win.winners) winningCards[hall.seats.findIndex((s) => s.player === w.playerId)] += 1;
  console.log(`  engine says: ball ${win.ballCount}, winning cards per seat [${winningCards.join(', ')}]`);

  const atas = await Promise.all(seats.map((w) => ataAddress(w.address, entry.mint, entry.tokenProgram)));
  const read = () => Promise.all([...atas.map((a) => tokenBalance(rpc, a)), tokenBalance(rpc, entry.treasuryAta)]);
  const before = await read();
  const hostSolBefore = await balance(host.address);
  const settleIxs = await settleHallTokenIxs(hall, payer.address, serverSeed);
  const settled = await sendSigned(rpc, payer.address, [payer.keyPair], settleIxs);
  console.log(`  settled by the payer (${settleIxs.length} instructions: the compute limit, then the reveal): ${explorer(settled.signature)}`);
  const after = await read();
  const split = splitHallPot(hall.stakePerCard, hall.cardsSold, hall.feeBps, win.winners.length);
  const gained = after.map((v, i) => v - before[i]);
  const expected = [...winningCards.map((n) => split.share * BigInt(n)), split.fee + split.dust];
  console.log(`  pot ${fmtUnits(split.pot, entry, sym)} · fee ${fmtUnits(split.fee, entry, sym)} · ${win.winners.length} winning card(s) × ${fmtUnits(split.share, entry, sym)} · dust ${split.dust} base units`);
  const agree = gained.every((g, i) => g === expected[i]);
  console.log(agree ? '  ✓ every seat and the treasury hold exactly what the engine replay says' : `  ✗ mismatch: got [${gained.join(', ')}], expected [${expected.join(', ')}]`);
  const closed = (await fetchHall(rpc, hallPda)) === null && !(await rpc.getAccountInfo(vault, { encoding: 'base64' }).send()).value;
  console.log(`  ${closed ? '✓' : '✗'} hall and vault closed; the host got the rent back (+${formatSol((await balance(host.address)) - hostSolBefore)})`);
  await sweepAll(seats, entry);
  if (!agree || !closed) process.exit(1);
} else if (cmd === 'prove-seeker') {
  // The key pair (the deployer holds the mock SGT) opens a room, proves its Seeker Genesis Token,
  // and the room's snapshotted fee drops to the Seeker tier; the room is then cancelled. With a
  // mint: a token room in it and a one-card hall; without: a SOL room.
  const config = await needConfig();
  const proof = await findSeekerToken(rpc, payer.address, config.sgtGroup);
  if (!proof) throw new Error(`the key pair holds no member token of the configured SGT group ${config.sgtGroup} (create-devnet-sgt)`);
  console.log(`  SGT: mint ${proof.mint} in account ${proof.tokenAccount} (group ${config.sgtGroup})`);
  const entry = args[0] ? await needEntry(address(args[0])) : null;
  const code = makeCode();
  const commitment = commitSeed(createServerSeed());
  const roomPda = await roomAddress(payer.address, code);
  const opened = await sendSigned(rpc, payer.address, [payer.keyPair], [
    entry ? await openRoomTokenIx(payer.address, code, entry.minStake, commitment, entry) : await openRoomIx(payer.address, code, 10_000_000n, commitment),
  ]);
  console.log(`  opened a ${entry ? symbol(entry) : 'SOL'} room ${code} at ${roomPda}: ${explorer(opened.signature)}`);
  let room = await fetchRoom(rpc, roomPda);
  const feeBefore = room.feeBps;
  const proved = await sendSigned(rpc, payer.address, [payer.keyPair], [await proveSeekerRoomIx(room, proof)]);
  room = await fetchRoom(rpc, roomPda);
  const tier = entry ? entry.seekerFeeBps : config.solSeekerFeeBps;
  console.log(`  prove_seeker_room: ${explorer(proved.signature)}`);
  console.log(`  fee ${feeBefore} → ${room.feeBps} bps · seeker ${room.seeker} (the Seeker tier is ${tier} bps)`);
  let ok = room.seeker && room.feeBps === tier && feeBefore === (entry ? entry.feeBps : config.feeBps);
  console.log(ok ? '  ✓ the room moved to the Seeker tier' : '  ✗ the room did not move to the Seeker tier');
  const cancelled = await sendSigned(rpc, payer.address, [payer.keyPair], [entry ? await cancelRoomTokenIx(room) : await cancelRoomIx(payer.address, roomPda)]);
  console.log(`  cancelled, stake back: ${explorer(cancelled.signature)}`);
  if (entry) {
    const hallCode = makeCode();
    const hallPda = await hallAddress(payer.address, hallCode);
    const openedHall = await sendSigned(rpc, payer.address, [payer.keyPair], [await openHallTokenIx(payer.address, hallCode, entry.minStake, 2, 1, commitSeed(createServerSeed()), entry)]);
    console.log(`  opened a ${symbol(entry)} hall ${hallCode}: ${explorer(openedHall.signature)}`);
    let hall = await fetchHall(rpc, hallPda);
    const provedHall = await sendSigned(rpc, payer.address, [payer.keyPair], [await proveSeekerHallIx(hall, proof)]);
    hall = await fetchHall(rpc, hallPda);
    console.log(`  prove_seeker_hall: ${explorer(provedHall.signature)} · fee ${entry.feeBps} → ${hall.feeBps} bps · seeker ${hall.seeker}`);
    const hallOk = hall.seeker && hall.feeBps === entry.seekerFeeBps;
    console.log(hallOk ? '  ✓ the hall moved to the Seeker tier' : '  ✗ the hall did not move to the Seeker tier');
    ok = ok && hallOk;
    const cancelledHall = await sendSigned(rpc, payer.address, [payer.keyPair], [await cancelHallTokenIx(hall)]);
    console.log(`  hall called off, stake back: ${explorer(cancelledHall.signature)}`);
  }
  if (!ok) process.exit(1);
} else if (cmd === 'shop-buy') {
  // buy_pack (sol) or buy_pack_token (<mint>) by the key pair; `--seeker` passes its mock SGT. The
  // Buyer PDA before and after, the CoinsBought event of the confirmed transaction and the token
  // account deltas are checked against the registry's price arithmetic.
  const plain = args.filter((a) => !a.startsWith('--'));
  const seeker = args.includes('--seeker');
  const what = plain[0];
  const pack = Number(plain[1] ?? 0);
  if (!what || !Number.isInteger(pack) || pack < 0 || pack > 3) throw new Error('shop-buy <sol|mint> <pack 0..3> [--seeker]');
  const config = await needConfig();
  const proof = seeker ? await findSeekerToken(rpc, payer.address, config.sgtGroup) : null;
  if (seeker && !proof) throw new Error('the key pair holds no member token of the configured SGT group');
  let buyer = payer;
  let buyerBefore = await fetchBuyer(rpc, payer.address);
  let sent;
  let expectedPaid;
  let moved = null;
  let sweep = null;
  if (what === 'sol') {
    const list = config.solPackPrices[pack];
    if (!list) throw new Error('this pack is not sold for SOL');
    expectedPaid = packPrice(list, seeker ? config.seekerDiscountBps : 0);
    const solBefore = await balance(payer.address);
    sent = await sendSigned(rpc, payer.address, [payer.keyPair], [await buyPackIx(payer.address, config.treasury, pack, proof)]);
    const spent = solBefore - (await balance(payer.address));
    console.log(`  list ${formatSol(list)}${seeker ? ` · Seeker −${config.seekerDiscountBps} bps` : ''} → ${formatSol(expectedPaid)} expected`);
    console.log(
      config.treasury === payer.address
        ? `  the treasury is the key pair itself here, so the price came straight back; the wallet is down ${spent} lamports (the fee${buyerBefore ? '' : ' and the Buyer account rent'})`
        : `  the wallet is down ${formatSol(spent)} (price, fee${buyerBefore ? '' : ', Buyer rent'})`,
    );
  } else {
    // A token purchase pays the buyer's token account into the treasury's: with the key pair as
    // both buyer and treasury those are one account and Anchor refuses the duplicate, so the
    // buyer is a throwaway wallet funded from the key pair (and given its own mock SGT for --seeker).
    const entry = await needEntry(address(what));
    const list = entry.packPrices[pack];
    if (!list) throw new Error(`pack ${pack} is not sold in ${symbol(entry)}`);
    expectedPaid = packPrice(list, entry.discountBps + (seeker ? config.seekerDiscountBps : 0));
    buyer = await newWallet();
    console.log(`  buyer ${buyer.address} (a throwaway funded from the key pair)`);
    const funded = await sendSigned(rpc, payer.address, [payer.keyPair], [transferIx(payer.address, buyer.address, TOKEN_PURSE)]);
    const tokens = await fundTokens(rpc, payer, entry, [buyer.address], list);
    console.log(`  funded ${formatSol(TOKEN_PURSE)} (${explorer(funded.signature)}) and ${fmtUnits(list, entry, symbol(entry))} (${explorer(tokens.signature)})`);
    let buyerProof = null;
    if (seeker) {
      const sgt = await createSgtMember(config.sgtGroup, buyer.address);
      buyerProof = { tokenAccount: sgt.ata, mint: sgt.member };
      console.log(`  mock SGT member ${sgt.member} minted to the buyer`);
    }
    const buyerAta = tokens.atas[0];
    const before = { buyer: await tokenBalance(rpc, buyerAta), treasury: await tokenBalance(rpc, entry.treasuryAta) };
    buyerBefore = await fetchBuyer(rpc, buyer.address);
    sent = await sendSigned(rpc, buyer.address, [buyer.keyPair], [await buyPackTokenIx(buyer.address, entry, pack, buyerProof)]);
    const after = { buyer: await tokenBalance(rpc, buyerAta), treasury: await tokenBalance(rpc, entry.treasuryAta) };
    moved = { buyer: before.buyer - after.buyer, treasury: after.treasury - before.treasury };
    console.log(`  list ${fmtUnits(list, entry, symbol(entry))} · discount ${entry.discountBps}${seeker ? ` + Seeker ${config.seekerDiscountBps}` : ''} bps → ${expectedPaid} base units (${fmtUnits(expectedPaid, entry, symbol(entry))})`);
    console.log(`  buyer account −${moved.buyer} · treasury account +${moved.treasury} base units`);
    sweep = () => sweepAll([buyer], entry);
  }
  console.log(`  ${what === 'sol' ? 'buy_pack' : 'buy_pack_token'}: ${explorer(sent.signature)}`);
  let event = null;
  for (let attempt = 0; attempt < 5 && !event; attempt++) {
    event = await fetchCoinsBought(rpc, sent.signature).catch(() => null);
    if (!event) await new Promise((r) => setTimeout(r, 2000));
  }
  const buyerAfter = await fetchBuyer(rpc, buyer.address);
  console.log('  CoinsBought:', event);
  console.log(`  Buyer PDA ${buyerAfter.address}: coins ${buyerBefore?.coinsTotal ?? 0n} → ${buyerAfter.coinsTotal} · purchases ${buyerBefore?.purchases ?? 0} → ${buyerAfter.purchases} · slot ${buyerAfter.lastSlot}`);
  if (sweep) await sweep();
  const coins = BigInt(config.packCoins[pack]);
  const checks = [
    ['the event names the wallet, the pack, the coins and the Seeker flag', event && event.wallet === buyer.address && event.pack === pack && BigInt(event.coins) === coins && event.seeker === seeker && (what === 'sol' ? event.mint === null : event.mint === what)],
    [`the event's paid (${event?.paid}) matches the registry arithmetic (${expectedPaid})`, event && event.paid === expectedPaid],
    ['the Buyer PDA grew by exactly the pack, one purchase', buyerAfter.coinsTotal - (buyerBefore?.coinsTotal ?? 0n) === coins && buyerAfter.purchases - (buyerBefore?.purchases ?? 0) === 1],
  ];
  if (moved) checks.push(['the token accounts moved exactly the price', moved.buyer === expectedPaid && moved.treasury === expectedPaid]);
  let bad = false;
  for (const [label, pass] of checks) {
    console.log(`  ${pass ? '✓' : '✗'} ${label}`);
    if (!pass) bad = true;
  }
  if (bad) process.exit(1);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}

/* ---------- helpers for the proofs ---------- */

async function needConfig() {
  const config = await fetchConfig(rpc);
  if (!config) throw new Error('init-config first');
  return config;
}

async function needEntry(mint) {
  const entry = await fetchMintEntry(rpc, mint);
  if (!entry) throw new Error(`${mint} is not registered (register-mint)`);
  if (!entry.enabled) throw new Error(`${mint} is disabled in the registry`);
  return entry;
}

function symbol(entry) {
  return knownSymbol(entry.mint) ?? shortAddr(entry.mint);
}

function show(obj) {
  return JSON.stringify(obj, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
}

/** Tokens back to the key pair (accounts closed, rent to the key pair), then the SOL. */
async function sweepAll(wallets, entry) {
  for (const w of wallets) {
    const swept = await sweepTokens(rpc, payer, entry, w).catch((e) => {
      console.log(`  token sweep from ${shortAddr(w.address)} failed: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
      return null;
    });
    if (swept) console.log(`  swept ${swept.held} base units and the account rent back from ${shortAddr(w.address)}: ${explorer(swept.signature)}`);
    const left = await balance(w.address);
    if (left > 10_000n) await sendSigned(rpc, w.address, [w.keyPair], [transferIx(w.address, payer.address, left - 5_000n)]);
  }
  console.log(`  swept back to the payer (${formatSol(await balance(payer.address))})`);
}

/* ---------- helpers for the token commands ---------- */

function keyValues(list) {
  const out = {};
  for (const item of list) {
    const at = item.indexOf('=');
    if (at < 0) throw new Error(`expected key=value, got ${item}`);
    out[item.slice(0, at)] = item.slice(at + 1);
  }
  return out;
}

async function tokenProgramOf(mint) {
  const { value } = await rpc.getAccountInfo(mint, { encoding: 'base64' }).send();
  if (!value) throw new Error(`no account at ${mint}`);
  if (value.owner === TOKEN_PROGRAM) return TOKEN_PROGRAM;
  if (value.owner === TOKEN_2022_PROGRAM) return TOKEN_2022_PROGRAM;
  throw new Error(`${mint} is owned by ${value.owner}, not a token program`);
}

// A function declaration, not a const: the command branches above run before this line would
// initialise a const, and `createMint` (hoisted) calls it from them.
function createAccountIx(from, newAccount, rent, space, owner) {
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      { address: from, role: AccountRole.WRITABLE_SIGNER },
      { address: newAccount, role: AccountRole.WRITABLE_SIGNER },
    ],
    data: getStructEncoder([
      ['ix', getU32Encoder()],
      ['lamports', getU64Encoder()],
      ['space', getU64Encoder()],
      ['owner', getAddressEncoder()],
    ]).encode({ ix: 0, lamports: rent, space, owner }),
  };
}

/** A mint with the deployer as mint authority: extensions first, InitializeMint2, then group/member initialisers (which realloc, so their rent is pre-funded). */
async function createMint({ program, decimals, freezeAuthority, extensions = [], later = [], before = () => [], after = () => [] }) {
  const kp = await newWallet();
  const mint = kp.address;
  const space = program === TOKEN_PROGRAM ? 82 : getMintSize(extensions);
  const finalSpace = program === TOKEN_PROGRAM ? 82 : getMintSize([...extensions, ...later]);
  const rent = await rpc.getMinimumBalanceForRentExemption(BigInt(finalSpace)).send();
  const ixs = [
    createAccountIx(payer.address, mint, rent, BigInt(space), program),
    ...before(mint),
    getInitializeMint2Instruction({ mint, decimals, mintAuthority: payer.address, freezeAuthority }, { programAddress: program }),
    ...after(mint),
  ];
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair, kp.keyPair], ixs);
  console.log(`  mint ${mint} created: ${explorer(sent.signature)}`);
  return mint;
}

/** One member token of the mock SGT `group` (the key pair is its update authority) for `to`: the shape the real Seeker Genesis Token has. */
async function createSgtMember(group, to) {
  const member = await createMint({
    program: TOKEN_2022_PROGRAM,
    decimals: 0,
    freezeAuthority: null,
    extensions: [
      { __kind: 'GroupMemberPointer', authority: some(payer.address), memberAddress: none() },
      { __kind: 'MetadataPointer', authority: some(payer.address), metadataAddress: none() },
    ],
    later: [{ __kind: 'TokenGroupMember', mint: payer.address, group, memberNumber: 0n }],
    before: (m) => [
      getInitializeGroupMemberPointerInstruction({ mint: m, authority: payer.address, memberAddress: m }),
      getInitializeMetadataPointerInstruction({ mint: m, authority: payer.address, metadataAddress: group }),
    ],
    after: (m) => [getInitializeTokenGroupMemberInstruction({ member: m, memberMint: m, memberMintAuthority: createNoopSigner(payer.address), group, groupUpdateAuthority: createNoopSigner(payer.address) })],
  });
  const ata = await mintTo(member, TOKEN_2022_PROGRAM, to, 1n);
  return { member, ata };
}

async function mintTo(mint, program, owner, amount) {
  const ata = await ataAddress(owner, mint, program);
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair], [
    getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer.address), ata, owner, mint, tokenProgram: program }),
    getMintToInstruction({ mint, token: ata, mintAuthority: createNoopSigner(payer.address), amount }, { programAddress: program }),
  ]);
  console.log(`  minted ${amount} base units to ${ata}: ${explorer(sent.signature)}`);
  return ata;
}
