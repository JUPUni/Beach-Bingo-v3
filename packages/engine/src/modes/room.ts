import { cellLookup, CARD_SPECS, freeMask, generateCard, playableMask, type BingoCard } from '../bingo/cards.ts';
import { isComplete, PATTERNS_30, PATTERNS_75, PATTERNS_90, cellsToGo, type PatternDef } from '../bingo/patterns.ts';
import { mulDiv } from '../economy/money.ts';
import { range, sample, type Rng } from '../rng/fair.ts';

/**
 * Multiplayer bingo rooms (player vs. player; the house takes a rake).
 *
 * Fairness model for money rooms:
 * - Before sales open the server publishes `commitSeed(serverSeed)`.
 * - Card #i is generated from FairRng({serverSeed, clientSeed: 'cards', nonce}, `card:i`).
 * - When sales close, the draw entropy is a *public beacon* nobody knows in advance (e.g. the
 *   blockhash of the first Solana slot after sales close), so the operator cannot steer which
 *   buyer gets a winning card. The drum is FairRng({serverSeed, clientSeed: beacon, nonce}, 'draw').
 * - After the round, `serverSeed` is revealed and every card and ball can be recomputed.
 *
 * This module is pure state-transition logic; timers, networking and balances live elsewhere.
 */
export type RoomVariant = '75' | '90' | '30';

export interface StageDef {
  pattern: PatternDef;
  /** Share of the prize pool for this stage (all shares sum to 1). */
  share: number;
}

export type StartRule = { kind: 'scheduled'; everyMs: number; minPlayers: number } | { kind: 'sitAndGo'; players: number };

export interface RoomConfig {
  id: string;
  name: string;
  variant: RoomVariant;
  cardPrice: number;
  maxCardsPerPlayer: number;
  /** Fraction of ticket sales paid out as prizes (1 − rake). */
  payoutRate: number;
  /** Minimum prize pool the house guarantees (0 = none). */
  guaranteedPool: number;
  stages: readonly StageDef[];
  /** Rooms auto-daub; duels require the player to spot and claim. */
  autoDaub: boolean;
  drawIntervalMs: number;
  startRule: StartRule;
  /** Progressive jackpot: paid if the final stage is won within `withinBalls` balls. */
  jackpot?: { withinBalls: number; contributionRate: number };
  /** Manual rooms: balls a player is locked out for after a false claim. */
  falseClaimPenaltyBalls: number;
  /** Bots are only ever allowed in play-money practice rooms. */
  allowBots: boolean;
}

export const ROOM_PRESETS = {
  sunsetHall: {
    id: 'sunset-hall',
    name: 'Sunset Hall · 75-ball',
    variant: '75',
    cardPrice: 25,
    maxCardsPerPlayer: 6,
    payoutRate: 0.85,
    guaranteedPool: 0,
    stages: [
      { pattern: PATTERNS_75.line, share: 0.2 },
      { pattern: PATTERNS_75.twoLines, share: 0.3 },
      { pattern: PATTERNS_75.blackout, share: 0.5 },
    ],
    autoDaub: true,
    drawIntervalMs: 2500,
    startRule: { kind: 'scheduled', everyMs: 60_000, minPlayers: 2 },
    jackpot: { withinBalls: 48, contributionRate: 0.02 },
    falseClaimPenaltyBalls: 0,
    allowBots: true,
  },
  pierHall: {
    id: 'pier-hall',
    name: 'Pier Hall · 90-ball',
    variant: '90',
    cardPrice: 25,
    maxCardsPerPlayer: 6,
    payoutRate: 0.85,
    guaranteedPool: 0,
    stages: [
      { pattern: PATTERNS_90.oneLine, share: 0.15 },
      { pattern: PATTERNS_90.twoLines, share: 0.25 },
      { pattern: PATTERNS_90.fullHouse, share: 0.6 },
    ],
    autoDaub: true,
    drawIntervalMs: 2200,
    startRule: { kind: 'scheduled', everyMs: 90_000, minPlayers: 2 },
    jackpot: { withinBalls: 42, contributionRate: 0.02 },
    falseClaimPenaltyBalls: 0,
    allowBots: true,
  },
  waveRush: {
    id: 'wave-rush',
    name: 'Wave Rush · 30-ball speed',
    variant: '30',
    cardPrice: 10,
    maxCardsPerPlayer: 4,
    payoutRate: 0.88,
    guaranteedPool: 0,
    stages: [{ pattern: PATTERNS_30.fullHouse, share: 1 }],
    autoDaub: true,
    drawIntervalMs: 1400,
    startRule: { kind: 'scheduled', everyMs: 30_000, minPlayers: 2 },
    falseClaimPenaltyBalls: 0,
    allowBots: true,
  },
  riptideDuel: {
    id: 'riptide-duel',
    name: 'Riptide Duel · 1v1',
    variant: '75',
    cardPrice: 50,
    maxCardsPerPlayer: 1,
    payoutRate: 0.95,
    guaranteedPool: 0,
    stages: [{ pattern: PATTERNS_75.line, share: 1 }],
    autoDaub: false,
    drawIntervalMs: 1800,
    startRule: { kind: 'sitAndGo', players: 2 },
    falseClaimPenaltyBalls: 3,
    allowBots: true,
  },
} as const satisfies Record<string, RoomConfig>;

export type RoomPresetId = keyof typeof ROOM_PRESETS;

export interface RoomPlayer {
  id: string;
  name: string;
  bot: boolean;
  cards: BingoCard[];
  /** Global card numbers (sale order) — needed to recompute cards from the seed. */
  cardNumbers: number[];
  lockedUntilBall: number;
}

export interface Winner {
  playerId: string;
  card: number;
}

export interface StageWin {
  stage: number;
  patternId: string;
  /** Number of balls drawn when the stage was won. */
  ballCount: number;
  winners: Winner[];
  prizeEach: number;
}

export type RoomPhase = 'selling' | 'drawing' | 'finished';

export interface RoomState {
  config: RoomConfig;
  phase: RoomPhase;
  players: RoomPlayer[];
  cardsSold: number;
  drum: number[];
  drawn: number[];
  stage: number;
  wins: StageWin[];
  /** Prize pool fixed when drawing starts. */
  pool: number;
  stagePrizes: number[];
  pendingClaims: Winner[];
  jackpotPool: number;
  jackpotWin?: { winners: Winner[]; prizeEach: number };
  commitment: string;
}

// Per-card derived data kept out of the serialisable state.
const derived = new WeakMap<BingoCard, { lookup: Int8Array; playable: number; free: number }>();

function info(card: BingoCard) {
  let d = derived.get(card);
  if (!d) {
    d = { lookup: cellLookup(card), playable: playableMask(card), free: freeMask(card) };
    derived.set(card, d);
  }
  return d;
}

export function createRoom(config: RoomConfig, commitment: string, jackpotPool = 0): RoomState {
  const shares = config.stages.reduce((s, st) => s + st.share, 0);
  if (Math.abs(shares - 1) > 1e-9) throw new Error('stage shares must sum to 1');
  return {
    config,
    phase: 'selling',
    players: [],
    cardsSold: 0,
    drum: [],
    drawn: [],
    stage: 0,
    wins: [],
    pool: 0,
    stagePrizes: [],
    pendingClaims: [],
    jackpotPool,
    commitment,
  };
}

export function joinRoom(state: RoomState, player: { id: string; name: string; bot?: boolean }): RoomPlayer {
  if (state.phase !== 'selling') throw new Error('room is not selling');
  if (player.bot && !state.config.allowBots) throw new Error('bots are not allowed in this room');
  const existing = state.players.find((p) => p.id === player.id);
  if (existing) return existing;
  if (state.config.startRule.kind === 'sitAndGo' && state.players.length >= state.config.startRule.players) {
    throw new Error('room is full');
  }
  const entry: RoomPlayer = {
    id: player.id,
    name: player.name,
    bot: Boolean(player.bot),
    cards: [],
    cardNumbers: [],
    lockedUntilBall: 0,
  };
  state.players.push(entry);
  return entry;
}

/** Sell `count` cards; `cardRng(i)` must return the RNG for global card number `i`. */
export function buyCards(state: RoomState, playerId: string, count: number, cardRng: (index: number) => Rng): BingoCard[] {
  if (state.phase !== 'selling') throw new Error('sales are closed');
  const player = state.players.find((p) => p.id === playerId);
  if (!player) throw new Error('join the room first');
  if (count < 1 || player.cards.length + count > state.config.maxCardsPerPlayer) {
    throw new Error(`max ${state.config.maxCardsPerPlayer} cards per player`);
  }
  const cards: BingoCard[] = [];
  for (let i = 0; i < count; i++) {
    const index = state.cardsSold++;
    const card = generateCard(state.config.variant, cardRng(index));
    player.cards.push(card);
    player.cardNumbers.push(index);
    cards.push(card);
  }
  return cards;
}

export function roomSales(state: RoomState): number {
  return state.cardsSold * state.config.cardPrice;
}

/** Jackpot contribution taken from this round's sales (reported to the jackpot ledger). */
export function jackpotContribution(state: RoomState): number {
  const rate = state.config.jackpot?.contributionRate ?? 0;
  return mulDiv(roomSales(state), Math.round(rate * 10_000), 10_000);
}

/** Close sales, fix the prize pool and shuffle the drum with the (beacon-derived) draw RNG. */
export function startDrawing(state: RoomState, drawRng: Rng): void {
  if (state.phase !== 'selling') throw new Error('already started');
  const players = state.players.filter((p) => p.cards.length > 0);
  const rule = state.config.startRule;
  const minPlayers = rule.kind === 'sitAndGo' ? rule.players : rule.minPlayers;
  if (players.length < minPlayers) throw new Error(`need ${minPlayers} players with cards`);

  const sales = roomSales(state);
  const pool = Math.max(state.config.guaranteedPool, mulDiv(sales, Math.round(state.config.payoutRate * 10_000), 10_000));
  state.pool = pool;
  state.stagePrizes = state.config.stages.map((s) => mulDiv(pool, Math.round(s.share * 10_000), 10_000));
  state.drum = sample(range(1, CARD_SPECS[state.config.variant].maxBall), CARD_SPECS[state.config.variant].maxBall, drawRng);
  state.phase = 'drawing';
}

function markedFor(card: BingoCard, drawnSet: ReadonlySet<number>): number {
  const d = info(card);
  let mask = d.free;
  for (const n of card.cells) {
    if (n > 0 && drawnSet.has(n)) mask |= 1 << (d.lookup[n] ?? 0);
  }
  return mask;
}

/** Cards that currently satisfy the open stage (optionally for one player). */
export function completedCards(state: RoomState, playerId?: string): Winner[] {
  const stage = state.config.stages[state.stage];
  if (!stage) return [];
  const drawnSet = new Set(state.drawn);
  const out: Winner[] = [];
  for (const p of state.players) {
    if (playerId && p.id !== playerId) continue;
    p.cards.forEach((card, i) => {
      if (isComplete(markedFor(card, drawnSet), stage.pattern, info(card).playable)) out.push({ playerId: p.id, card: i });
    });
  }
  return out;
}

/** Fewest numbers any of the player's cards needs for the open stage. */
export function bestToGo(state: RoomState, playerId: string): number {
  const stage = state.config.stages[state.stage];
  const player = state.players.find((p) => p.id === playerId);
  if (!stage || !player) return Infinity;
  const drawnSet = new Set(state.drawn);
  let best = Infinity;
  for (const card of player.cards) {
    best = Math.min(best, cellsToGo(markedFor(card, drawnSet), stage.pattern, info(card).playable));
  }
  return best;
}

export interface DrawEvent {
  ball: number;
  ballCount: number;
  stageWins: StageWin[];
  finished: boolean;
}

function awardStage(state: RoomState, winners: Winner[]): StageWin {
  const prize = state.stagePrizes[state.stage] ?? 0;
  const win: StageWin = {
    stage: state.stage,
    patternId: state.config.stages[state.stage]!.pattern.id,
    ballCount: state.drawn.length,
    winners,
    prizeEach: Math.floor(prize / winners.length),
  };
  state.wins.push(win);
  state.stage++;
  if (state.stage >= state.config.stages.length) {
    state.phase = 'finished';
    const jackpot = state.config.jackpot;
    if (jackpot && state.drawn.length <= jackpot.withinBalls && state.jackpotPool > 0) {
      state.jackpotWin = { winners, prizeEach: Math.floor(state.jackpotPool / winners.length) };
    }
  }
  return win;
}

/** Award any pending manual claims for the open stage (call when the claim window closes). */
export function closeClaims(state: RoomState): StageWin | null {
  if (!state.pendingClaims.length || state.phase !== 'drawing') return null;
  const winners = state.pendingClaims;
  state.pendingClaims = [];
  return awardStage(state, winners);
}

export function drawNext(state: RoomState): DrawEvent {
  if (state.phase !== 'drawing') throw new Error(`room is ${state.phase}`);
  const stageWins: StageWin[] = [];
  const closed = closeClaims(state);
  if (closed) stageWins.push(closed);
  if (state.phase !== 'drawing') {
    return { ball: 0, ballCount: state.drawn.length, stageWins, finished: true };
  }
  const ball = state.drum[state.drawn.length];
  if (ball === undefined) {
    state.phase = 'finished';
    return { ball: 0, ballCount: state.drawn.length, stageWins, finished: true };
  }
  state.drawn.push(ball);
  if (state.config.autoDaub) {
    // One ball can settle several stages at once (e.g. line and two lines together).
    while (state.phase === 'drawing') {
      const winners = completedCards(state);
      if (!winners.length) break;
      stageWins.push(awardStage(state, winners));
    }
  }
  if (state.drawn.length >= state.drum.length && state.phase === 'drawing' && state.config.autoDaub) {
    state.phase = 'finished';
  }
  return { ball, ballCount: state.drawn.length, stageWins, finished: state.phase === 'finished' };
}

export type ClaimResult = { ok: true; card: number } | { ok: false; reason: 'locked' | 'no-pattern' | 'closed' };

/** Manual rooms: a player shouts BINGO for one of their cards. */
export function claimBingo(state: RoomState, playerId: string, cardIndex: number): ClaimResult {
  if (state.phase !== 'drawing' || state.config.autoDaub) return { ok: false, reason: 'closed' };
  const player = state.players.find((p) => p.id === playerId);
  if (!player || !player.cards[cardIndex]) return { ok: false, reason: 'no-pattern' };
  if (state.drawn.length < player.lockedUntilBall) return { ok: false, reason: 'locked' };
  const valid = completedCards(state, playerId).some((w) => w.card === cardIndex);
  if (!valid) {
    player.lockedUntilBall = state.drawn.length + state.config.falseClaimPenaltyBalls;
    return { ok: false, reason: 'no-pattern' };
  }
  if (!state.pendingClaims.some((c) => c.playerId === playerId && c.card === cardIndex)) {
    state.pendingClaims.push({ playerId, card: cardIndex });
  }
  return { ok: true, card: cardIndex };
}

export interface RoomSettlement {
  sales: number;
  pool: number;
  rake: number;
  payouts: Record<string, number>;
  /** Prize money from stages nobody won (policy: refunded pro-rata or rolled into the jackpot). */
  unawarded: number;
  jackpotPaid: number;
  jackpotContribution: number;
}

export function settleRoom(state: RoomState): RoomSettlement {
  if (state.phase !== 'finished') throw new Error('room not finished');
  const payouts: Record<string, number> = {};
  let awarded = 0;
  for (const win of state.wins) {
    for (const w of win.winners) {
      payouts[w.playerId] = (payouts[w.playerId] ?? 0) + win.prizeEach;
      awarded += win.prizeEach;
    }
  }
  let jackpotPaid = 0;
  if (state.jackpotWin) {
    for (const w of state.jackpotWin.winners) {
      payouts[w.playerId] = (payouts[w.playerId] ?? 0) + state.jackpotWin.prizeEach;
      jackpotPaid += state.jackpotWin.prizeEach;
    }
  }
  const sales = roomSales(state);
  const contribution = jackpotContribution(state);
  return {
    sales,
    pool: state.pool,
    rake: Math.max(0, sales - state.pool - contribution),
    payouts,
    // Unwon stages plus rounding dust from splitting prizes between tied winners.
    unawarded: state.pool - awarded,
    jackpotPaid,
    jackpotContribution: contribution,
  };
}

/** Public, post-reveal view of a finished round for independent verification. */
export function roomAudit(state: RoomState) {
  return {
    room: state.config.id,
    commitment: state.commitment,
    drawn: state.drawn,
    cards: state.players.flatMap((p) => p.cards.map((c, i) => ({ player: p.id, cardNumber: p.cardNumbers[i], cells: c.cells }))),
    wins: state.wins,
  };
}

/**
 * Sunset Jackpot rule: the progressive pays for a full house within N calls, where N starts at
 * `base` and rises by one for every day the jackpot is not won — so it is guaranteed to drop.
 */
export function sunsetJackpotCalls(daysSinceWin: number, base = 40, cap = 70): number {
  return Math.min(cap, base + Math.max(0, Math.floor(daysSinceWin)));
}
