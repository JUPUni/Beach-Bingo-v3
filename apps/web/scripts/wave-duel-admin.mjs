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
//   ... wave-duel-admin.mjs show-mints
//   ... wave-duel-admin.mjs create-devnet-mint <spl|token2022> <decimals> <amount> [wallet] [--freeze] [--pyusd-like]
//   ... wave-duel-admin.mjs create-devnet-sgt [wallet]
//
// Stakes and prices are base units. `create-devnet-mint` makes a look-alike with the deployer as
// authority (JUP, SKR; `--freeze` for a USDC-like freeze authority; `--pyusd-like` for Token-2022
// with a permanent delegate, a zero transfer fee, an empty transfer hook and a metadata pointer) and
// mints `amount` whole tokens to `wallet` (default: the deployer). `create-devnet-sgt` makes a mock
// Seeker Genesis Token group and mints one member token to `wallet`; put the group it prints in
// `set-config sgt=<group>` so `prove_seeker_*` and the Seeker shop discount work on devnet.
//
// Environment: RPC_URL (default devnet), KEYPAIR (default .secrets/devnet-deployer.json),
// WAVE_DUEL_PROGRAM (default the devnet deployment). `round` funds two throwaway wallets from the
// key pair, plays open → join → settle, and checks the payout against the engine's own replay;
// `hall` does the same for a multi-seat hall (open → joins → a guest locks → settle).
import { readFileSync } from 'node:fs';
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
  settleIx,
  SYSTEM_PROGRAM,
} from '../src/solana/waveDuel.ts';
import { fetchHall, hallAddress, hallRoster, joinHallIx, lockHallIx, openHallIx, settleHallIxs, splitHallPot } from '../src/solana/waveHall.ts';
import { ataAddress, fetchMintEntries, fetchMintEntry, registerMintIx, setMintIx, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../src/solana/waveToken.ts';

const RPC_URL = process.env.RPC_URL || 'https://api.devnet.solana.com';
const KEYPAIR = process.env.KEYPAIR || new URL('../../../.secrets/devnet-deployer.json', import.meta.url).pathname;
const PROGRAM = address(process.env.WAVE_DUEL_PROGRAM || '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH');
const SOL = 1_000_000_000n;

configureProgram(PROGRAM);
const rpc = createSolanaRpc(RPC_URL);
const explorer = (sig) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

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
  console.log(`mock SGT group ${group}; member mint ${member} held by ${to} at ${ata}`);
  console.log(`now: wave-duel-admin.mjs set-config sgt=${group}`);
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
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

const createAccountIx = (from, newAccount, rent, space, owner) => ({
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
});

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

async function mintTo(mint, program, owner, amount) {
  const ata = await ataAddress(owner, mint, program);
  const sent = await sendSigned(rpc, payer.address, [payer.keyPair], [
    getCreateAssociatedTokenIdempotentInstruction({ payer: createNoopSigner(payer.address), ata, owner, mint, tokenProgram: program }),
    getMintToInstruction({ mint, token: ata, mintAuthority: createNoopSigner(payer.address), amount }, { programAddress: program }),
  ]);
  console.log(`  minted ${amount} base units to ${ata}: ${explorer(sent.signature)}`);
  return ata;
}
