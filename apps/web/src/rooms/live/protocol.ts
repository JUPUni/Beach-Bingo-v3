import {
  FairRng,
  isComplete,
  markedMask,
  mathRng,
  playableMask,
  rooms,
  sha256Hex,
  type RoomConfig,
  type RoomPresetId,
  type RoomState,
} from '@beach-bingo/engine';

/**
 * Live rooms: the bingo halls played with friends, browser to browser.
 *
 * There is no server. The host commits to a seed, players announce how many cards they hold,
 * and the host's `start` message (seed, roster, start time) lets every client build the same
 * `RoomState` with the engine and call the same balls on the same clock. This module is the
 * pure part: codes, messages, the deterministic build and the duel claim rule. The transport
 * is `net.ts`; the state machine is `machine.ts`.
 *
 * Fairness (see docs/FAIRNESS.md):
 * - the host publishes `commitSeed(serverSeed)` before anyone buys a card;
 * - `clientSeed` is the SHA-256 of the roster (peer ids and card counts), which the host
 *   cannot know when it commits, so it cannot shape the draw for anyone;
 * - card `i` comes from `FairRng({ serverSeed, clientSeed, nonce: 0 }, "live:card:i")` and the
 *   drum from the stream `live:draw`; anyone can recompute both after the reveal.
 */

/** trystero app id; old `/play` rooms use another one, so the two never meet. */
export const APP_ID = 'beachbingo-season3';
/** No 0/O, 1/I/L: a code survives being read out loud. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 5;
/** Delay between the host's `start` and the first ball, so everyone sees the countdown. */
export const START_LEAD_MS = 4000;
/** A duel claim made at ball b is settled when ball b + CLAIM_WINDOW_BALLS is due. */
export const CLAIM_WINDOW_BALLS = 2;
/** Claims from a peer more than this many balls ahead of our own count are dropped. */
export const CLAIM_LEAD_BALLS = 2;
/** Cards shown per player in the UI (the engine allows more, the screen does not). */
export const UI_MAX_CARDS: Record<string, number> = { '75': 4, '90': 3, '30': 4 };
export const MAX_NAME = 18;
const HEX_64 = /^[0-9a-f]{64}$/;

export function makeCode(rng = mathRng): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[rng.int(CODE_ALPHABET.length)];
  return code;
}

/** What a person typed, reduced to the characters a code can contain. */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .split('')
    .filter((c) => CODE_ALPHABET.includes(c))
    .join('')
    .slice(0, CODE_LENGTH);
}

export function isCode(value: string): boolean {
  return value.length === CODE_LENGTH && normalizeCode(value) === value;
}

/** `#join=CODE` on the game's URL: the invite link a host shares. */
export function inviteLink(code: string, origin: string, base: string): string {
  return `${origin}${base}#join=${code}`;
}

export function joinCodeFromHash(hash: string): string | null {
  const m = /^#join=([A-Za-z0-9]{5})$/.exec(hash.trim());
  if (!m) return null;
  const code = normalizeCode(m[1]!);
  return isCode(code) ? code : null;
}

export function cleanName(name: unknown): string {
  return (
    String(name ?? '')
      .replace(/[\p{C}]/gu, '')
      .trim()
      .slice(0, MAX_NAME) || 'Player'
  );
}

export function maxCardsFor(config: RoomConfig): number {
  return Math.min(UI_MAX_CARDS[config.variant] ?? config.maxCardsPerPlayer, config.maxCardsPerPlayer);
}

/* ---------- Messages ---------- */

/** A type alias, not an interface: trystero's payload type needs the JSON index signature. */
export type RosterEntry = {
  id: string;
  name: string;
  cards: number;
};

/**
 * A staked room: the escrow program's account for this code (programs/wave_duel), as the host
 * announces it. Amounts travel as a decimal string of base units (lamports for SOL, the mint's
 * base units for a token stake); addresses as base58. `room` is the escrow's address: the `Room`
 * PDA of a 1v1 room, the `Hall` PDA of a hall (2 to 8 players, 1 to 4 cards each). `lamports` is
 * the stake of a room and the stake per card of a hall, so the screen reads one field either way.
 * `mint` names the token the escrow is staked in; absent, the stake is SOL (what older builds send).
 */
export type StakeInfo =
  | { kind: 'room'; lamports: string; host: string; program: string; room: string; mint?: string }
  | { kind: 'hall'; lamports: string; host: string; program: string; room: string; stakePerCard: string; maxPlayers: number; mint?: string };
/** What cards are bought with: the host's table when the room opened. Guests pay in the same. */
export type Currency = 'sand' | 'coins';
const isCurrency = (x: unknown): x is Currency => x === 'sand' || x === 'coins';
/** A hall's shape (lib.rs MIN_HALL_PLAYERS..MAX_HALL_PLAYERS, MAX_HALL_CARDS). */
export const HALL_PLAYERS = { min: 2, max: 8 } as const;
export const HALL_CARDS = { min: 1, max: 4 } as const;

export type LiveMessage =
  /** Any peer: my name, how many cards I hold for the next round, and my wallet in a staked room. */
  | { t: 'me'; name: string; cards: number; wallet?: string }
  /** Host: which hall this is, the commitment for the coming round, the stake if there is one, and the currency (SAND when absent: older builds). */
  | { t: 'room'; preset: RoomPresetId; round: number; commitment: string; playing: boolean; stake?: StakeInfo; currency?: Currency }
  /** Host: the reveal that starts a round. Staked rooms carry the escrow's entropy as the client seed. */
  | { t: 'start'; round: number; serverSeed: string; startAt: number; roster: RosterEntry[]; entropy?: string }
  /** Any player in a duel: BINGO on my card `card` with `ball` balls on the table. */
  | { t: 'claim'; round: number; card: number; ball: number };

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null;
const isInt = (x: unknown, min: number, max: number): x is number => Number.isInteger(x) && (x as number) >= min && (x as number) <= max;
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64;
const isAddress = (x: unknown): x is string => typeof x === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x);
const isHex64 = (x: unknown): x is string => typeof x === 'string' && HEX_64.test(x);

const isLamports = (x: unknown): x is string => typeof x === 'string' && /^\d{1,20}$/.test(x);

function parseStake(raw: unknown): StakeInfo | null {
  if (!isObject(raw)) return null;
  if (!isLamports(raw.lamports)) return null;
  if (!isAddress(raw.host) || !isAddress(raw.program) || !isAddress(raw.room)) return null;
  // A token stake names its mint; a stake without one is SOL (the shape the SOL-only builds send).
  if (raw.mint !== undefined && !isAddress(raw.mint)) return null;
  const base = { lamports: raw.lamports, host: raw.host, program: raw.program, room: raw.room, ...(raw.mint !== undefined ? { mint: raw.mint } : {}) };
  // A stake without a kind is a 1v1 room: the shape the first staked builds announced.
  const kind = raw.kind ?? 'room';
  if (kind === 'room') return { kind, ...base };
  if (kind !== 'hall') return null;
  if (!isLamports(raw.stakePerCard) || !isInt(raw.maxPlayers, HALL_PLAYERS.min, HALL_PLAYERS.max)) return null;
  return { kind, ...base, stakePerCard: raw.stakePerCard, maxPlayers: raw.maxPlayers };
}

/** Anything a peer sends is untrusted: keep only well-formed messages, with clean values. */
export function parseMessage(raw: unknown): LiveMessage | null {
  if (!isObject(raw)) return null;
  switch (raw.t) {
    case 'me': {
      if (!isInt(raw.cards, 0, 6)) return null;
      if (raw.wallet !== undefined && !isAddress(raw.wallet)) return null;
      return { t: 'me', name: cleanName(raw.name), cards: raw.cards, ...(raw.wallet !== undefined ? { wallet: raw.wallet } : {}) };
    }
    case 'room': {
      if (
        typeof raw.preset !== 'string' ||
        !(raw.preset in rooms.ROOM_PRESETS) ||
        !isInt(raw.round, 1, 1_000_000) ||
        !isHex64(raw.commitment) ||
        typeof raw.playing !== 'boolean'
      ) {
        return null;
      }
      const msg: LiveMessage = { t: 'room', preset: raw.preset as RoomPresetId, round: raw.round, commitment: raw.commitment, playing: raw.playing };
      if (raw.stake !== undefined) {
        const stake = parseStake(raw.stake);
        if (!stake) return null;
        msg.stake = stake;
      }
      if (raw.currency !== undefined) {
        if (!isCurrency(raw.currency)) return null;
        msg.currency = raw.currency;
      }
      return msg;
    }
    case 'start': {
      if (!isInt(raw.round, 1, 1_000_000) || !isHex64(raw.serverSeed)) return null;
      if (typeof raw.startAt !== 'number' || !Number.isFinite(raw.startAt)) return null;
      if (raw.entropy !== undefined && !isHex64(raw.entropy)) return null;
      if (!Array.isArray(raw.roster) || raw.roster.length < 1 || raw.roster.length > 500) return null;
      const roster: RosterEntry[] = [];
      const seen = new Set<string>();
      for (const e of raw.roster) {
        if (!isObject(e) || !isId(e.id) || !isInt(e.cards, 1, 6) || seen.has(e.id)) return null;
        seen.add(e.id);
        roster.push({ id: e.id, name: cleanName(e.name), cards: e.cards });
      }
      return { t: 'start', round: raw.round, serverSeed: raw.serverSeed, startAt: raw.startAt, roster, ...(raw.entropy !== undefined ? { entropy: raw.entropy } : {}) };
    }
    case 'claim':
      return isInt(raw.round, 1, 1_000_000) && isInt(raw.card, 0, 5) && isInt(raw.ball, 1, 90)
        ? { t: 'claim', round: raw.round, card: raw.card, ball: raw.ball }
        : null;
    default:
      return null;
  }
}

/* ---------- The deterministic build ---------- */

/** Players with cards, in a canonical order, each capped to what the hall allows. */
export function sortRoster(entries: readonly RosterEntry[], config: RoomConfig): RosterEntry[] {
  return entries
    .filter((e) => e.cards > 0)
    .map((e) => ({ id: e.id, name: e.name, cards: Math.min(e.cards, config.maxCardsPerPlayer) }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The round's client seed: nobody, host included, knows it before the roster is final. */
export function rosterHash(roster: readonly RosterEntry[]): string {
  return sha256Hex(roster.map((e) => `${e.id}:${e.cards}`).join('\n'));
}

/**
 * The same `RoomState` on every client: players joined in roster order, cards bought in roster
 * order from the committed seed, the drum shuffled and sales closed. Throws on a roster the hall
 * cannot seat (too few players, a duel with more than two, over the card limit).
 */
export function buildRoom(
  config: RoomConfig,
  commitment: string,
  serverSeed: string,
  roster: readonly RosterEntry[],
  /** Friends rooms hash the roster; staked rooms use the entropy the escrow program fixed at join. */
  clientSeed: string = rosterHash(roster),
): RoomState {
  const seed = { serverSeed, clientSeed, nonce: 0 };
  const state = rooms.createRoom(config, commitment, 0);
  for (const e of roster) rooms.joinRoom(state, { id: e.id, name: e.name });
  for (const e of roster) rooms.buyCards(state, e.id, e.cards, (i) => new FairRng(seed, `live:card:${i}`));
  rooms.startDrawing(state, new FairRng(seed, 'live:draw'));
  return state;
}

/** How many balls are on the table at `now`: ball n is called at startAt + (n − 1) × interval. */
export function ballsCalledAt(now: number, startAt: number, intervalMs: number, maxBalls: number): number {
  if (now < startAt) return 0;
  return Math.min(maxBalls, Math.floor((now - startAt) / intervalMs) + 1);
}

/** The moment ball `n` is called. */
export function ballTime(n: number, startAt: number, intervalMs: number): number {
  return startAt + (n - 1) * intervalMs;
}

/* ---------- Duel claims ---------- */

export interface Claim {
  peerId: string;
  card: number;
  /** Balls on the claimant's table when they shouted. */
  ball: number;
}

/** True when the player's card completes the open stage within the first `ball` balls of the drum. */
export function claimValid(room: RoomState, playerId: string, card: number, ball: number): boolean {
  const stage = room.config.stages[room.stage];
  const player = room.players.find((p) => p.id === playerId);
  const c = player?.cards[card];
  if (!stage || !c || ball < 1 || ball > room.drum.length) return false;
  return isComplete(markedMask(c, room.drum.slice(0, ball)), stage.pattern, playableMask(c));
}

/** The earliest shout wins; shouts on the same ball share the stage. */
export function resolveClaims(claims: readonly Claim[]): Claim[] {
  if (!claims.length) return [];
  const best = Math.min(...claims.map((c) => c.ball));
  const seen = new Set<string>();
  return claims.filter((c) => c.ball === best && !seen.has(`${c.peerId}:${c.card}`) && seen.add(`${c.peerId}:${c.card}`) !== undefined);
}

/* ---------- Transport contract (implemented by net.ts, faked in tests) ---------- */

export interface NetHandlers {
  peerJoin(id: string): void;
  peerLeave(id: string): void;
  message(data: unknown, from: string): void;
}

export interface Net {
  readonly selfId: string;
  send(msg: LiveMessage, to?: string): void;
  leave(): void;
  /** Relays we currently hold a socket to (0 = nobody can find this room). */
  relayCount(): number;
}

export type Connect = (code: string, on: NetHandlers) => Promise<Net>;
