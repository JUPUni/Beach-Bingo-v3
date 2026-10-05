import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64Encoder,
  lamports,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
  type Instruction,
} from '@solana/kit';
import { commitSeed, createServerSeed, rooms, sha256Hex } from '@beach-bingo/engine';
import { buildRoom } from '../rooms/live/protocol.ts';
import { configureProgram, initConfigIx } from './waveDuel.ts';
import {
  cancelHallIx,
  claimTimeoutHallIx,
  decodeHall,
  hallAddress,
  hallRoster,
  HALL_TIMEOUT_SLOTS,
  joinHallIx,
  lockHallIx,
  openHallIx,
  seatCards,
  SETTLE_HALL_COMPUTE_UNITS,
  settleHallIx,
  settleHallIxs,
  splitHallPot,
  type HallAccount,
} from './waveHall.ts';

/**
 * The program's halls, run in LiteSVM from the compiled .so: the client's encodings against the
 * real handlers, who may lock and when, the money paths (settle, cancel, timeout), and the
 * promise that matters most: the chain pays each seat exactly what the engine's replay of the
 * same seed, roster and entropy says.
 *
 * Build the program first: `cd programs/wave_duel && cargo build-sbf`. Without the .so the suite
 * is skipped, so the rest of the tests run on a machine without the Solana toolchain.
 */
const SO = new URL('../../../../programs/wave_duel/target/deploy/wave_duel.so', import.meta.url).pathname;
const PROGRAM = '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH' as Address;
const SOL = 1_000_000_000n;
const STAKE = 100_000_000n; // 0.1 SOL per card
const FEE_BPS = 500;
const TX_FEE = 5_000n;
/** The newest SlotHashes entry the program will read: pinned so the entropy can be recomputed here. */
const SLOT_HASH = new Uint8Array(32).fill(9);

interface Wallet {
  keyPair: CryptoKeyPair;
  address: Address;
}

const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const EVENT_HALL_SETTLED = hexBytes(sha256Hex('event:HallSettled').slice(0, 16));

describe.skipIf(!existsSync(SO))('wave_duel halls on LiteSVM', () => {
  let svm: LiteSVM;
  let admin: Wallet;
  let treasury: Wallet;
  let host: Wallet;
  let guests: Wallet[];
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
  const readHall = async (hostWallet: Wallet, code: string): Promise<HallAccount | null> => {
    const pda = await hallAddress(hostWallet.address, code);
    const account = svm.getAccount(pda);
    return account.exists ? decodeHall(pda, new Uint8Array(account.data), BigInt(account.lamports)) : null;
  };
  /** lib.rs `lock`: sha256(player keys in roster order ‖ card counts ‖ newest slot hash). */
  const entropyOf = (hall: HallAccount): string => {
    const h = createHash('sha256');
    for (const s of hall.seats) h.update(new Uint8Array(getAddressEncoder().encode(s.player)));
    h.update(Uint8Array.from(hall.seats.map((s) => s.cards)));
    h.update(SLOT_HASH);
    return h.digest('hex');
  };
  /** What the engine says about this hall's round, given the same roster order and entropy. */
  const engine = (hall: HallAccount, serverSeed: string) => {
    const state = buildRoom(rooms.ROOM_PRESETS.waveRush, hall.commitment, serverSeed, hallRoster(hall), hall.entropy);
    while (state.phase === 'drawing') rooms.drawNext(state);
    const win = state.wins[0]!;
    return {
      winBall: win.ballCount,
      winningCards: win.winners.length,
      shares: hall.seats.map((s) => win.winners.filter((w) => w.playerId === s.player).length),
    };
  };
  /** The `HallSettled` event from the logs (Anchor: "Program data: <base64>", event discriminator first). */
  const settledEvent = (logs: string[]) => {
    for (const line of logs) {
      if (!line.startsWith('Program data: ')) continue;
      const bytes = getBase64Encoder().encode(line.slice('Program data: '.length)) as Uint8Array;
      if (!bytes.subarray(0, 8).every((b, i) => b === EVENT_HALL_SETTLED[i])) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      // hall (32) and server_seed (32) follow the 8-byte discriminator.
      return { winBall: bytes[72]!, winningCards: view.getUint16(73, true), share: view.getBigUint64(75, true), pot: view.getBigUint64(83, true), fee: view.getBigUint64(91, true) };
    }
    return null;
  };
  /** Settle a locked hall and check that every lamport of the pot went where the engine says. */
  const settleAndCheck = async (hall: HallAccount, seed: string, ixs: Instruction[]) => {
    const seats = hall.seats.map((s) => [host, ...guests].find((w) => w.address === s.player)!);
    const before = seats.map(balance);
    const treasuryBefore = balance(treasury);
    const result = await ok(stranger, ixs);
    expect(result.logs().join('\n')).toContain('Instruction: SettleHall');
    expect(await readHall(host, hall.code)).toBeNull();

    const expected = engine(hall, seed);
    const split = splitHallPot(STAKE, hall.cardsSold, FEE_BPS, expected.winningCards);
    const rent = hall.lamports - split.pot; // the account's rent comes back to the host who paid it
    const gained = seats.map((w, i) => balance(w) - before[i]! - (i === 0 ? rent : 0n));
    expect(gained).toEqual(expected.shares.map((n) => split.share * BigInt(n)));
    expect(balance(treasury) - treasuryBefore).toBe(split.fee + split.dust);
    expect(gained.reduce((a, b) => a + b, 0n) + split.fee + split.dust).toBe(split.pot);
    expect(settledEvent(result.logs())).toEqual({
      winBall: expected.winBall,
      winningCards: expected.winningCards,
      share: split.share,
      pot: split.pot,
      fee: split.fee,
    });
    return result.computeUnitsConsumed();
  };

  beforeAll(async () => {
    svm = new LiteSVM();
    svm.addProgramFromFile(PROGRAM, SO);
    configureProgram(PROGRAM);
    svm.setSlotHashes([{ slot: svm.getClock().slot, hash: getBase58Decoder().decode(SLOT_HASH) }]);
    [admin, treasury, host, stranger, ...guests] = await Promise.all(Array.from({ length: 11 }, wallet));
    for (const w of [admin, treasury, host, stranger, ...guests]) svm.airdrop(w.address, lamports(10n * SOL));
    await ok(admin, [await initConfigIx(admin.address, treasury.address, FEE_BPS)]);
  });

  it('guards the table shape', async () => {
    const c = commitSeed(createServerSeed());
    await fails(host, [await openHallIx(host.address, 'GRDA7', 1n, 4, 1, c)], 'StakeOutOfRange');
    await fails(host, [await openHallIx(host.address, 'GRD0I', STAKE, 4, 1, c)], 'BadCode');
    await fails(host, [await openHallIx(host.address, 'GRDA2', STAKE, 1, 1, c)], 'PlayersOutOfRange');
    await fails(host, [await openHallIx(host.address, 'GRDA3', STAKE, 9, 1, c)], 'PlayersOutOfRange');
    await fails(host, [await openHallIx(host.address, 'GRDA4', STAKE, 4, 0, c)], 'CardsOutOfRange');
    await fails(host, [await openHallIx(host.address, 'GRDA5', STAKE, 4, 5, c)], 'CardsOutOfRange');
  });

  it('seats three players (2/1/3 cards), a guest locks, a stranger settles, and the chain pays what the engine says', async () => {
    const seed = createServerSeed();
    const commitment = commitSeed(seed);
    const code = 'HAWK3';
    const hostBefore = balance(host);
    await ok(host, [await openHallIx(host.address, code, STAKE, 4, 2, commitment)]);
    let hall = (await readHall(host, code))!;
    expect(hall).toMatchObject({ host: host.address, stakePerCard: STAKE, maxPlayers: 4, commitment, code, state: 'open', cardsSold: 2, lockedSlot: 0n, entropy: '0'.repeat(64) });
    expect(hall.seats).toEqual([{ player: host.address, cards: 2 }]);
    expect(hall.lamports).toBeGreaterThan(2n * STAKE);
    expect(hostBefore - balance(host)).toBeGreaterThan(2n * STAKE); // deposit plus rent plus the fee

    await fails(host, [await joinHallIx(host.address, hall.address, 1)], 'AlreadySeated');
    await fails(guests[0]!, [await lockHallIx(guests[0]!.address, hall.address)], 'TooFewPlayers');

    const guestBefore = balance(guests[0]!);
    await ok(guests[0]!, [await joinHallIx(guests[0]!.address, hall.address, 1)]);
    expect(guestBefore - balance(guests[0]!)).toBe(STAKE + TX_FEE);
    await ok(guests[1]!, [await joinHallIx(guests[1]!.address, hall.address, 3)]);
    hall = (await readHall(host, code))!;
    expect(hall.state).toBe('open');
    expect(hall.cardsSold).toBe(6);
    expect(hall.seats).toEqual([
      { player: host.address, cards: 2 },
      { player: guests[0]!.address, cards: 1 },
      { player: guests[1]!.address, cards: 3 },
    ]);
    expect([0, 1, 2].map((s) => seatCards(hall, s))).toEqual([
      [0, 1],
      [2, 2],
      [3, 5],
    ]);
    expect(hall.lamports).toBeGreaterThan(6n * STAKE);

    await fails(guests[0]!, [await joinHallIx(guests[0]!.address, hall.address, 1)], 'AlreadySeated');
    await fails(guests[2]!, [await joinHallIx(guests[2]!.address, hall.address, 0)], 'CardsOutOfRange');
    await fails(guests[2]!, [await joinHallIx(guests[2]!.address, hall.address, 5)], 'CardsOutOfRange');
    await fails(host, [await lockHallIx(host.address, hall.address)], 'HostCannotLock');
    await fails(stranger, [await lockHallIx(stranger.address, hall.address)], 'NotSeated');
    await fails(stranger, [await settleHallIx(hall, treasury.address, stranger.address, seed)], 'HallNotLocked');
    await fails(stranger, [await claimTimeoutHallIx(hall, treasury.address, stranger.address)], 'HallNotLocked');

    // A guest closes sales: the entropy is the roster and the slot hash, as lib.rs says.
    await ok(guests[1]!, [await lockHallIx(guests[1]!.address, hall.address)]);
    hall = (await readHall(host, code))!;
    expect(hall.state).toBe('locked');
    expect(hall.entropy).toBe(entropyOf(hall));
    expect(hall.cardsSold).toBe(6);

    await fails(guests[2]!, [await joinHallIx(guests[2]!.address, hall.address, 1)], 'HallNotOpen');
    await fails(host, [cancelHallIx(hall)], 'HallNotOpen');
    await fails(stranger, [await settleHallIx(hall, treasury.address, stranger.address, 'ab'.repeat(32))], 'BadReveal');
    await fails(stranger, [await claimTimeoutHallIx(hall, treasury.address, stranger.address)], 'TooEarly');
    const swapped = { ...hall, seats: [hall.seats[1]!, hall.seats[0]!, hall.seats[2]!] };
    await fails(stranger, [await settleHallIx(swapped, treasury.address, stranger.address, seed)], 'RosterMismatch');
    const short = { ...hall, seats: hall.seats.slice(0, 2) };
    await fails(stranger, [await settleHallIx(short, treasury.address, stranger.address, seed)], 'RosterMismatch');

    // Anyone may settle with the real seed; a stranger does, so no player pays for it.
    const cu = await settleAndCheck(hall, seed, [await settleHallIx(hall, treasury.address, stranger.address, seed)]);
    console.log(`settle_hall, 6 cards: ${cu} CU`);
    expect(Number(cu)).toBeLessThan(200_000);
  });

  it('locks itself when the last seat fills, and an 8 x 4 hall settles within the compute budget', async () => {
    const seed = createServerSeed();
    const code = 'FUJ88';
    await ok(host, [await openHallIx(host.address, code, STAKE, 8, 4, commitSeed(seed))]);
    let hall = (await readHall(host, code))!;
    for (let i = 0; i < 7; i++) {
      await ok(guests[i]!, [await joinHallIx(guests[i]!.address, hall.address, 4)]);
      hall = (await readHall(host, code))!;
      expect(hall.state).toBe(i < 6 ? 'open' : 'locked');
    }
    expect(hall.seats.length).toBe(8);
    expect(hall.cardsSold).toBe(32);
    expect(hall.entropy).toBe(entropyOf(hall));
    expect(hall.lockedSlot).toBeGreaterThan(0n);
    await fails(stranger, [await joinHallIx(stranger.address, hall.address, 1)], 'HallNotOpen');

    const cu = await settleAndCheck(hall, seed, await settleHallIxs(hall, treasury.address, stranger.address, seed));
    console.log(`settle_hall, 32 cards: ${cu} CU`);
    expect(Number(cu)).toBeLessThan(SETTLE_HALL_COMPUTE_UNITS);
  });

  it('a two-seat hall is the duel: the join locks it and the pot goes where the engine says', async () => {
    const seed = createServerSeed();
    const code = 'DUET2';
    await ok(host, [await openHallIx(host.address, code, STAKE, 2, 1, commitSeed(seed))]);
    let hall = (await readHall(host, code))!;
    await ok(guests[0]!, [await joinHallIx(guests[0]!.address, hall.address, 1)]);
    hall = (await readHall(host, code))!;
    expect(hall.state).toBe('locked');
    expect(hall.cardsSold).toBe(2);
    const cu = await settleAndCheck(hall, seed, await settleHallIxs(hall, treasury.address, stranger.address, seed));
    console.log(`settle_hall, 2 cards: ${cu} CU`);
  });

  it('lets the host cancel an open hall, refunding every seat, and nobody else', async () => {
    const code = 'CANCX';
    const hostBefore = balance(host);
    await ok(host, [await openHallIx(host.address, code, STAKE, 5, 3, commitSeed(createServerSeed()))]);
    let hall = (await readHall(host, code))!;
    await ok(guests[0]!, [await joinHallIx(guests[0]!.address, hall.address, 2)]);
    await ok(guests[1]!, [await joinHallIx(guests[1]!.address, hall.address, 1)]);
    hall = (await readHall(host, code))!;
    expect(hall.cardsSold).toBe(6);

    await fails(stranger, [cancelHallIx({ ...hall, host: stranger.address })], 'ConstraintHasOne');
    await fails(host, [cancelHallIx({ ...hall, seats: hall.seats.slice().reverse() })], 'RosterMismatch');
    await fails(host, [cancelHallIx({ ...hall, seats: hall.seats.slice(0, 1) })], 'RosterMismatch');

    const before = [host, guests[0]!, guests[1]!].map(balance);
    await ok(host, [cancelHallIx(hall)]);
    expect(await readHall(host, code)).toBeNull();
    expect(balance(host) - before[0]!).toBe(hall.lamports - 3n * STAKE - TX_FEE); // its deposit and the rent
    expect(balance(guests[0]!) - before[1]!).toBe(2n * STAKE);
    expect(balance(guests[1]!) - before[2]!).toBe(STAKE);
    // Four transaction fees (the open, the two refused cancels, the cancel), nothing else.
    expect(hostBefore - balance(host)).toBe(4n * TX_FEE);
  });

  it('forfeits the host deposit to the guests, without a fee, when the host never reveals', async () => {
    const code = 'TMQUT';
    await ok(host, [await openHallIx(host.address, code, STAKE, 3, 2, commitSeed(createServerSeed()))]);
    let hall = (await readHall(host, code))!;
    await ok(guests[0]!, [await joinHallIx(guests[0]!.address, hall.address, 4)]);
    await ok(guests[0]!, [await lockHallIx(guests[0]!.address, hall.address)]);
    hall = (await readHall(host, code))!;
    expect(hall.state).toBe('locked');
    await fails(stranger, [await claimTimeoutHallIx(hall, treasury.address, stranger.address)], 'TooEarly');

    svm.warpToSlot(hall.lockedSlot + HALL_TIMEOUT_SLOTS + 1n);
    const before = { host: balance(host), guest: balance(guests[0]!), treasury: balance(treasury) };
    await ok(stranger, [await claimTimeoutHallIx(hall, treasury.address, stranger.address)]);
    expect(await readHall(host, code)).toBeNull();
    // The guest's own four cards back, plus the host's two cards: a silent host pays what losing costs.
    expect(balance(guests[0]!) - before.guest).toBe(6n * STAKE);
    expect(balance(host) - before.host).toBe(hall.lamports - 6n * STAKE); // only the rent
    expect(balance(treasury)).toBe(before.treasury); // one guest: no dust, and no fee
  });
});
