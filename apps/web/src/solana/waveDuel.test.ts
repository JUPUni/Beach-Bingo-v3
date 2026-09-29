import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressFromPublicKey,
  getBase58Decoder,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
  type Instruction,
} from '@solana/kit';
import { commitSeed, createServerSeed, rooms } from '@beach-bingo/engine';
import { buildRoom } from '../rooms/live/protocol.ts';
import {
  cancelRoomIx,
  claimTimeoutIx,
  configAddress,
  configureProgram,
  decodeConfig,
  decodeRoom,
  initConfigIx,
  joinRoomIx,
  openRoomIx,
  roomAddress,
  settleIx,
  TIMEOUT_SLOTS,
  type RoomAccount,
} from './waveDuel.ts';

/**
 * The program, run in LiteSVM from the compiled .so: the client's encodings against the real
 * instruction handlers, the money paths, and the promise that matters most: the chain pays the
 * player the engine names when it replays the same seed and entropy.
 *
 * Build the program first: `cd programs/wave_duel && cargo build-sbf`. Without the .so the suite
 * is skipped, so the rest of the tests run on a machine without the Solana toolchain.
 */
const SO = new URL('../../../../programs/wave_duel/target/deploy/wave_duel.so', import.meta.url).pathname;
const PROGRAM = '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH' as Address;
const SOL = 1_000_000_000n;
const STAKE = 100_000_000n; // 0.1 SOL
const FEE_BPS = 500;
const TX_FEE = 5_000n;

interface Wallet {
  keyPair: CryptoKeyPair;
  address: Address;
}

describe.skipIf(!existsSync(SO))('wave_duel on LiteSVM', () => {
  let svm: LiteSVM;
  let admin: Wallet;
  let treasury: Wallet;
  let host: Wallet;
  let guest: Wallet;
  let stranger: Wallet;

  const wallet = async (): Promise<Wallet> => {
    const keyPair = await generateKeyPair();
    return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
  };
  const balance = (w: Wallet): bigint => svm.getBalance(w.address) ?? 0n;
  const run = async (payer: Wallet, ixs: Instruction[], others: Wallet[] = []) => {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await signTransaction([payer.keyPair, ...others.map((w) => w.keyPair)], compileTransaction(message));
    const result = svm.sendTransaction(tx);
    svm.expireBlockhash();
    return result;
  };
  const ok = async (payer: Wallet, ixs: Instruction[], others: Wallet[] = []) => {
    const result = await run(payer, ixs, others);
    if (result instanceof FailedTransactionMetadata) throw new Error(`${JSON.stringify(result.err())}\n${result.meta().logs().join('\n')}`);
    return result;
  };
  const fails = async (payer: Wallet, ixs: Instruction[], code: string) => {
    const result = await run(payer, ixs);
    expect(result).toBeInstanceOf(FailedTransactionMetadata);
    expect((result as FailedTransactionMetadata).meta().logs().join('\n')).toContain(code);
  };
  const readRoom = async (hostWallet: Wallet, code: string): Promise<RoomAccount | null> => {
    const pda = await roomAddress(hostWallet.address, code);
    const account = svm.getAccount(pda);
    return account.exists ? decodeRoom(pda, new Uint8Array(account.data), BigInt(account.lamports)) : null;
  };
  /** What the engine says about this room's round: the winners (0 host, 1 guest). */
  const engineWinners = (room: RoomAccount, serverSeed: string): number[] => {
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
    return state.wins[0]!.winners.map((w) => (w.playerId === 'host' ? 0 : 1));
  };

  beforeAll(async () => {
    svm = new LiteSVM();
    svm.addProgramFromFile(PROGRAM, SO);
    configureProgram(PROGRAM);
    // The program reads the newest SlotHashes entry when a guest joins.
    if (svm.getSlotHashes().length === 0) {
      svm.setSlotHashes([{ slot: svm.getClock().slot, hash: getBase58Decoder().decode(new Uint8Array(32).fill(9)) }]);
    }
    [admin, treasury, host, guest, stranger] = await Promise.all([wallet(), wallet(), wallet(), wallet(), wallet()]);
    for (const w of [admin, treasury, host, guest, stranger]) svm.airdrop(w.address, lamports(10n * SOL));
  });

  it('initialises the config with a fee and a treasury', async () => {
    await ok(admin, [await initConfigIx(admin.address, treasury.address, FEE_BPS)]);
    const account = svm.getAccount(await configAddress());
    expect(account.exists).toBe(true);
    const config = decodeConfig(new Uint8Array((account as { data: Uint8Array }).data));
    expect(config).toEqual({ admin: admin.address, treasury: treasury.address, feeBps: FEE_BPS, paused: false });
  });

  it('guards the stake range and the code alphabet', async () => {
    await fails(host, [await openRoomIx(host.address, 'ABCDE', 1n, commitSeed(createServerSeed()))], 'StakeOutOfRange');
    await fails(host, [await openRoomIx(host.address, 'ABCD0', STAKE, commitSeed(createServerSeed()))], 'BadCode');
  });

  it('plays a staked round: open, join, settle, and the chain pays whom the engine names', async () => {
    const seed = createServerSeed();
    const commitment = commitSeed(seed);
    const code = 'KRT7W';
    const hostBefore = balance(host);
    await ok(host, [await openRoomIx(host.address, code, STAKE, commitment)]);
    let room = (await readRoom(host, code))!;
    expect(room.state).toBe('open');
    expect(room.host).toBe(host.address);
    expect(room.guest).toBeNull();
    expect(room.stake).toBe(STAKE);
    expect(room.commitment).toBe(commitment);
    expect(room.code).toBe(code);
    expect(room.lamports).toBeGreaterThan(STAKE);
    expect(hostBefore - balance(host)).toBeGreaterThan(STAKE); // stake plus rent plus the fee

    await fails(host, [await joinRoomIx(host.address, room.address)], 'SameWallet');

    const guestBefore = balance(guest);
    await ok(guest, [await joinRoomIx(guest.address, room.address)]);
    room = (await readRoom(host, code))!;
    expect(room.state).toBe('ready');
    expect(room.guest).toBe(guest.address);
    expect(room.entropy).not.toBe('0'.repeat(64));
    expect(room.joinedSlot).toBeGreaterThan(0n);
    expect(guestBefore - balance(guest)).toBe(STAKE + TX_FEE);

    await fails(host, [await cancelRoomIx(host.address, room.address)], 'NotOpen');
    await fails(stranger, [await settleIx(room, treasury.address, stranger.address, 'ab'.repeat(32))], 'BadReveal');
    await fails(stranger, [await claimTimeoutIx(room, treasury.address, stranger.address)], 'TooEarly');

    // Anyone may settle with the real seed; a stranger does, so neither player pays for it.
    const before = { host: balance(host), guest: balance(guest), treasury: balance(treasury) };
    const result = await ok(stranger, [await settleIx(room, treasury.address, stranger.address, seed)]);
    expect(result.logs().join('\n')).toContain('Instruction: Settle');
    expect(await readRoom(host, code)).toBeNull();

    const pot = STAKE * 2n;
    const fee = (pot * BigInt(FEE_BPS)) / 10_000n;
    const prize = pot - fee;
    const rent = room.lamports - pot; // the account's rent comes back to the host who paid it
    const gained = {
      host: balance(host) - before.host - rent,
      guest: balance(guest) - before.guest,
      treasury: balance(treasury) - before.treasury,
    };
    const winners = engineWinners(room, seed);
    if (winners.length === 2) {
      expect(gained).toEqual({ host: prize / 2n, guest: prize / 2n, treasury: fee + (prize % 2n) });
    } else if (winners[0] === 0) {
      expect(gained).toEqual({ host: prize, guest: 0n, treasury: fee });
    } else {
      expect(gained).toEqual({ host: 0n, guest: prize, treasury: fee });
    }
  });

  it('gives the guest the pot when the host never reveals', async () => {
    const code = 'TMQUT';
    await ok(host, [await openRoomIx(host.address, code, STAKE, commitSeed(createServerSeed()))]);
    let room = (await readRoom(host, code))!;
    await ok(guest, [await joinRoomIx(guest.address, room.address)]);
    room = (await readRoom(host, code))!;
    await fails(guest, [await claimTimeoutIx(room, treasury.address, guest.address)], 'TooEarly');
    svm.warpToSlot(room.joinedSlot + TIMEOUT_SLOTS + 1n);
    const before = { guest: balance(guest), treasury: balance(treasury) };
    await ok(guest, [await claimTimeoutIx(room, treasury.address, guest.address)]);
    const pot = STAKE * 2n;
    const fee = (pot * BigInt(FEE_BPS)) / 10_000n;
    expect(balance(guest) - before.guest).toBe(pot - fee - TX_FEE);
    expect(balance(treasury) - before.treasury).toBe(fee);
    expect(await readRoom(host, code)).toBeNull();
  });

  it('lets the host cancel before anyone joins, and nobody else', async () => {
    const code = 'CANCX';
    const before = balance(host);
    await ok(host, [await openRoomIx(host.address, code, STAKE, commitSeed(createServerSeed()))]);
    const room = (await readRoom(host, code))!;
    await fails(stranger, [await cancelRoomIx(stranger.address, room.address)], 'ConstraintHasOne');
    await ok(host, [await cancelRoomIx(host.address, room.address)]);
    expect(await readRoom(host, code)).toBeNull();
    expect(before - balance(host)).toBe(2n * TX_FEE); // two transaction fees, nothing else
  });
});
