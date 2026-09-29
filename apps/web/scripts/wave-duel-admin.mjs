#!/usr/bin/env node
// Operate the wave_duel program on a cluster with a key pair file (the deployer on devnet):
//
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs init-config [feeBps] [treasury]
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs show [host code]
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs round [stakeSol]
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs hall [stakeSol] [cards per seat...]
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
  createSolanaRpc,
  generateKeyPair,
  getAddressFromPublicKey,
  getStructEncoder,
  getU32Encoder,
  getU64Encoder,
} from '@solana/kit';
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
  openRoomIx,
  roomAddress,
  sendSigned,
  settleIx,
  SYSTEM_PROGRAM,
} from '../src/solana/waveDuel.ts';
import { fetchHall, hallAddress, hallRoster, joinHallIx, lockHallIx, openHallIx, settleHallIxs, splitHallPot } from '../src/solana/waveHall.ts';

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
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
