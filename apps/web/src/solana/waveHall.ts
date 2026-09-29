import {
  AccountRole,
  address,
  fixDecoderSize,
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getBase64Encoder,
  getBytesDecoder,
  getBytesEncoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getStructEncoder,
  getU16Decoder,
  getU32Encoder,
  getU64Decoder,
  getU64Encoder,
  getU8Decoder,
  getU8Encoder,
  getUtf8Encoder,
  type Address,
  type Instruction,
} from '@solana/kit';
import { sha256Hex } from '@beach-bingo/engine';
import { bytesToHex, configAddress, program, SLOT_HASHES, SYSTEM_PROGRAM, TIMEOUT_SLOTS, type SolanaRpc } from './waveDuel.ts';

/**
 * Client for the `wave_duel` program's halls (programs/wave_duel, "Halls" in lib.rs): a Wave Rush
 * escrow for 2..8 players holding 1..4 cards each. The 1v1 room's client is `waveDuel.ts`; this
 * file shares its program id, config PDA and sending helpers. Layouts are hand-encoded from the
 * program's source, so this file and `lib.rs` must move together.
 *
 * The roster is the join order, the host first, and card numbers follow it: the host holds
 * cards 0..h−1, the next player the next ones, and so on, which is how the engine's `buildRoom`
 * numbers cards when it is given the roster in that order with the hall's entropy as the client
 * seed (`hallRoster` builds that roster).
 */
export const MIN_HALL_PLAYERS = 2;
export const MAX_HALL_PLAYERS = 8;
/** Cards per player (lib.rs MAX_HALL_CARDS, the engine's Wave Rush preset). */
export const MAX_HALL_CARDS = 4;
/** lib.rs TIMEOUT_SLOTS: after this many slots without a reveal anyone may refund the hall. */
export const HALL_TIMEOUT_SLOTS = TIMEOUT_SLOTS;
export const COMPUTE_BUDGET_PROGRAM = address('ComputeBudget111111111111111111111111111111');
/**
 * Compute units a hall settlement is sent with. Measured in LiteSVM (waveHall.test.ts, which
 * asserts the worst case stays under this): a 32-card hall (8 × 4) replays in about 97k CU, a
 * 6-card one in about 29k and a 2-card one in about 19k, so the default 200k per instruction
 * would do. The explicit limit is 1.5× the worst case: a wallet that adds a priority fee pays
 * for the limit, not the use, and it is one constant to raise if the runtime's cost model moves.
 */
export const SETTLE_HALL_COMPUTE_UNITS = 150_000;

const utf8 = getUtf8Encoder();
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const discriminator = (name: string): Uint8Array => hexBytes(sha256Hex(name).slice(0, 16));

const DISC = {
  openHall: discriminator('global:open_hall'),
  joinHall: discriminator('global:join_hall'),
  lockHall: discriminator('global:lock_hall'),
  cancelHall: discriminator('global:cancel_hall'),
  settleHall: discriminator('global:settle_hall'),
  claimTimeoutHall: discriminator('global:claim_timeout_hall'),
  hallAccount: discriminator('account:Hall'),
};

/* ---------- Addresses ---------- */

export async function hallAddress(host: Address, code: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: program(),
    seeds: [utf8.encode('hall'), getAddressEncoder().encode(host), utf8.encode(code)],
  });
  return pda;
}

/* ---------- Accounts ---------- */

export type HallState = 'open' | 'locked';

export interface HallSeat {
  player: Address;
  cards: number;
}

export interface HallAccount {
  address: Address;
  host: Address;
  stakePerCard: bigint;
  maxPlayers: number;
  commitment: string;
  code: string;
  state: HallState;
  /** The roster in join order, the host first. */
  seats: HallSeat[];
  cardsSold: number;
  /** The round's client seed (hex); all zeros until the hall is locked. */
  entropy: string;
  lockedSlot: bigint;
  createdSlot: bigint;
  lamports: bigint;
}

const hallDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['host', getAddressDecoder()],
  ['stakePerCard', getU64Decoder()],
  ['maxPlayers', getU8Decoder()],
  ['commitment', fixDecoderSize(getBytesDecoder(), 32)],
  ['code', fixDecoderSize(getBytesDecoder(), 5)],
  ['state', getU8Decoder()],
  ['players', getArrayDecoder(getAddressDecoder(), { size: MAX_HALL_PLAYERS })],
  ['cards', fixDecoderSize(getBytesDecoder(), MAX_HALL_PLAYERS)],
  ['playerCount', getU8Decoder()],
  ['cardsSold', getU16Decoder()],
  ['entropy', fixDecoderSize(getBytesDecoder(), 32)],
  ['lockedSlot', getU64Decoder()],
  ['createdSlot', getU64Decoder()],
  ['bump', getU8Decoder()],
]);

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Decode a Hall account's bytes (as fetched from any source). */
export function decodeHall(addr: Address, data: Uint8Array, lamports: bigint): HallAccount | null {
  const h = hallDecoder.decode(data);
  if (!same(h.discriminator as Uint8Array, DISC.hallAccount)) return null;
  const cards = h.cards as Uint8Array;
  return {
    address: addr,
    host: h.host,
    stakePerCard: h.stakePerCard,
    maxPlayers: h.maxPlayers,
    commitment: bytesToHex(h.commitment),
    code: new TextDecoder().decode(h.code),
    state: h.state === 1 ? 'locked' : 'open',
    seats: h.players.slice(0, h.playerCount).map((player, i) => ({ player, cards: cards[i]! })),
    cardsSold: h.cardsSold,
    entropy: bytesToHex(h.entropy),
    lockedSlot: h.lockedSlot,
    createdSlot: h.createdSlot,
    lamports,
  };
}

export async function fetchHall(rpc: SolanaRpc, addr: Address): Promise<HallAccount | null> {
  const { value } = await rpc.getAccountInfo(addr, { encoding: 'base64' }).send();
  if (!value) return null;
  return decodeHall(addr, getBase64Encoder().encode(value.data[0]) as Uint8Array, BigInt(value.lamports));
}

/* ---------- The round, as the program sees it ---------- */

/** The seat a wallet holds (−1 if none); seat 0 is the host. */
export const seatOf = (hall: HallAccount, player: Address): number => hall.seats.findIndex((s) => s.player === player);

/** What a seat deposited: its cards at the stake per card. */
export const seatDeposit = (hall: HallAccount, seat: number): bigint => hall.stakePerCard * BigInt(hall.seats[seat]?.cards ?? 0);

/** Card numbers a seat holds, `[first, last]` inclusive, in the program's (and the engine's) numbering. */
export function seatCards(hall: HallAccount, seat: number): [number, number] {
  let first = 0;
  for (let i = 0; i < seat; i++) first += hall.seats[i]!.cards;
  return [first, first + (hall.seats[seat]?.cards ?? 1) - 1];
}

/**
 * The roster to hand `buildRoom` (with `hall.entropy` as the client seed) so that the engine
 * numbers the cards exactly as the program does: join order, ids are the wallets.
 */
export function hallRoster(hall: HallAccount): { id: string; name: string; cards: number }[] {
  return hall.seats.map((s, i) => ({ id: s.player, name: i === 0 ? 'Host' : `Seat ${i + 1}`, cards: s.cards }));
}

export interface HallSplit {
  pot: bigint;
  fee: bigint;
  prize: bigint;
  /** Lamports each winning card is paid. */
  share: bigint;
  /** `prize mod winningCards`, which goes to the treasury with the fee. */
  dust: bigint;
}

/** The program's arithmetic for a settlement: pot = cards × stake, fee in bps, an equal share per winning card. */
export function splitHallPot(stakePerCard: bigint, cardsSold: number, feeBps: number, winningCards: number): HallSplit {
  const pot = stakePerCard * BigInt(cardsSold);
  const fee = (pot * BigInt(feeBps)) / 10_000n;
  const prize = pot - fee;
  const share = winningCards > 0 ? prize / BigInt(winningCards) : 0n;
  return { pot, fee, prize, share, dust: prize - share * BigInt(winningCards) };
}

/* ---------- Instructions ---------- */

const meta = (addr: Address, role: AccountRole) => ({ address: addr, role });
/** The roster as remaining accounts, in order and writable: the program checks it against the hall. */
const rosterMetas = (hall: HallAccount) => hall.seats.map((s) => meta(s.player, AccountRole.WRITABLE));

export async function openHallIx(
  host: Address,
  code: string,
  stakePerCard: bigint,
  maxPlayers: number,
  cards: number,
  commitmentHex: string,
): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['code', fixEncoderSize(getBytesEncoder(), 5)],
    ['stakePerCard', getU64Encoder()],
    ['maxPlayers', getU8Encoder()],
    ['cards', getU8Encoder()],
    ['commitment', fixEncoderSize(getBytesEncoder(), 32)],
  ]).encode({ d: DISC.openHall, code: utf8.encode(code), stakePerCard, maxPlayers, cards, commitment: hexBytes(commitmentHex) });
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(await hallAddress(host, code), AccountRole.WRITABLE),
      meta(host, AccountRole.WRITABLE_SIGNER),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    data,
  };
}

export async function joinHallIx(player: Address, hall: Address, cards: number): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['cards', getU8Encoder()],
  ]).encode({ d: DISC.joinHall, cards });
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(hall, AccountRole.WRITABLE),
      meta(player, AccountRole.WRITABLE_SIGNER),
      meta(SLOT_HASHES, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    data,
  };
}

/** A seated guest closes sales and fixes the entropy (the host may not; see lib.rs `lock_hall`). */
export async function lockHallIx(player: Address, hall: Address): Promise<Instruction> {
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(hall, AccountRole.WRITABLE),
      meta(player, AccountRole.READONLY_SIGNER),
      meta(SLOT_HASHES, AccountRole.READONLY),
    ],
    data: DISC.lockHall,
  };
}

/** The host calls off an open hall: every seat is refunded, the host also gets the rent. */
export function cancelHallIx(hall: HallAccount): Instruction {
  return {
    programAddress: program(),
    accounts: [meta(hall.address, AccountRole.WRITABLE), meta(hall.host, AccountRole.WRITABLE_SIGNER), ...rosterMetas(hall)],
    data: DISC.cancelHall,
  };
}

async function settleHallAccounts(hall: HallAccount, treasury: Address, settler: Address) {
  return [
    meta(await configAddress(), AccountRole.READONLY),
    meta(hall.address, AccountRole.WRITABLE),
    meta(hall.host, AccountRole.WRITABLE),
    meta(treasury, AccountRole.WRITABLE),
    meta(settler, AccountRole.READONLY_SIGNER),
    ...rosterMetas(hall),
  ];
}

/** Anyone reveals the seed; the program replays every card and pays the winning ones. */
export async function settleHallIx(hall: HallAccount, treasury: Address, settler: Address, serverSeedHex: string): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['seed', fixEncoderSize(getBytesEncoder(), 32)],
  ]).encode({ d: DISC.settleHall, seed: hexBytes(serverSeedHex) });
  return { programAddress: program(), accounts: await settleHallAccounts(hall, treasury, settler), data };
}

/** After the timeout, anyone refunds every seat of a hall whose host never revealed. */
export async function claimTimeoutHallIx(hall: HallAccount, treasury: Address, settler: Address): Promise<Instruction> {
  return { programAddress: program(), accounts: await settleHallAccounts(hall, treasury, settler), data: DISC.claimTimeoutHall };
}

/** ComputeBudget `SetComputeUnitLimit`: tag 2 then the limit as u32 LE. */
export function setComputeUnitLimitIx(units: number): Instruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: getStructEncoder([
      ['tag', getU8Encoder()],
      ['units', getU32Encoder()],
    ]).encode({ tag: 2, units }),
  };
}

/** The settlement transaction's instructions: the compute request, then the reveal. */
export async function settleHallIxs(hall: HallAccount, treasury: Address, settler: Address, serverSeedHex: string): Promise<Instruction[]> {
  return [setComputeUnitLimitIx(SETTLE_HALL_COMPUTE_UNITS), await settleHallIx(hall, treasury, settler, serverSeedHex)];
}
