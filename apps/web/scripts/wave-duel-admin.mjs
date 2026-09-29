#!/usr/bin/env node
// Operate the wave_duel program on a cluster with a key pair file (the deployer on devnet):
//
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs init-config [feeBps] [treasury]
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs show [host code]
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs round [stakeSol]
//
// Environment: RPC_URL (default devnet), KEYPAIR (default .secrets/devnet-deployer.json),
// WAVE_DUEL_PROGRAM (default the devnet deployment). `round` funds two throwaway wallets from the
// key pair, plays open → join → settle, and checks the payout against the engine's own replay.
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
} else {
  console.error(`unknown command ${cmd}`);
  process.exit(2);
}
