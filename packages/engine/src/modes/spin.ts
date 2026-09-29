import { generateCard, type BingoCard } from '../bingo/cards.ts';
import { LINES_5X5, countLines5x5, popcount } from '../bingo/patterns.ts';
import { applyMultiplier } from '../economy/money.ts';
import { weightedIndex, type Rng } from '../rng/fair.ts';

/**
 * SHELL SPIN — Slingo-style slots × bingo (single player vs. house).
 *
 * A 5×5 card of 25 numbers (column c holds five of 15c+1 … 15c+15). Each spin shows one
 * symbol per column: a number (daubed if it is in that column), a Palm Joker (daub any cell
 * in that column), a Golden Sun (daub any cell), a Coin (instant prize), a Free Spin, or a
 * Shark (blocks the column). Completed lines are "slingos"; the ladder pays on the slingo
 * count when the game is collected. 11 spins are included in the stake; afterwards extra
 * spins can be bought at their expected value ÷ {@link EXTRA_SPIN_RTP}.
 */
export type ReelSymbol =
  | { kind: 'number'; value: number }
  | { kind: 'joker' }
  | { kind: 'super' }
  | { kind: 'coin'; multiplier: number }
  | { kind: 'freeSpin' }
  | { kind: 'shark' };

export interface SpinConfig {
  spins: number;
  maxExtraSpins: number;
  /** Per-reel symbol weights (integers). */
  weights: { number: number; joker: number; super: number; coin: number; freeSpin: number; shark: number };
  /** Coin prizes (× stake) and their weights. */
  coins: readonly { multiplier: number; weight: number }[];
  /** Ladder: index = slingos (0–12) → multiplier of stake. 11 slingos is impossible (an open cell always breaks a row and a column). */
  ladder: readonly number[];
}

export const EXTRA_SPIN_RTP = 0.96;

export const SHELL_SPIN: SpinConfig = {
  spins: 11,
  maxExtraSpins: 10,
  weights: { number: 894, joker: 55, super: 10, coin: 6, freeSpin: 10, shark: 25 },
  coins: [
    { multiplier: 0.1, weight: 60 },
    { multiplier: 0.25, weight: 30 },
    { multiplier: 1, weight: 9 },
    { multiplier: 5, weight: 1 },
  ],
  ladder: [0, 0, 0, 1.5, 3, 5, 10, 20, 40, 80, 150, 150, 1500],
};

export interface PendingWild {
  kind: 'joker' | 'super';
  /** Column for jokers. */
  column?: number;
}

export interface SpinState {
  config: SpinConfig;
  stake: number;
  card: BingoCard;
  marked: number;
  spinsLeft: number;
  spinsPlayed: number;
  extraSpins: number;
  extraSpent: number;
  coinWinnings: number;
  pendingWilds: PendingWild[];
  lastReels: ReelSymbol[];
  collected: boolean;
}

export function startSpin(config: SpinConfig, stake: number, cardRng: Rng): SpinState {
  const card = generateCard('75', cardRng);
  // Slingo cards have no free space: fill the centre with a fifth N-column number.
  const used = new Set(card.cells.filter((n) => n > 0 && n >= 31 && n <= 45));
  let centre = 31 + cardRng.int(15);
  while (used.has(centre)) centre = 31 + ((centre - 31 + 1) % 15);
  card.cells[12] = centre;
  return {
    config,
    stake,
    card,
    marked: 0,
    spinsLeft: config.spins,
    spinsPlayed: 0,
    extraSpins: 0,
    extraSpent: 0,
    coinWinnings: 0,
    pendingWilds: [],
    lastReels: [],
    collected: false,
  };
}

const SYMBOL_ORDER = ['number', 'joker', 'super', 'coin', 'freeSpin', 'shark'] as const;

export function rollReel(column: number, config: SpinConfig, rng: Rng): ReelSymbol {
  const w = config.weights;
  const kind = SYMBOL_ORDER[weightedIndex([w.number, w.joker, w.super, w.coin, w.freeSpin, w.shark], rng)]!;
  switch (kind) {
    case 'number':
      return { kind, value: column * 15 + 1 + rng.int(15) };
    case 'coin':
      return { kind, multiplier: config.coins[weightedIndex(config.coins.map((c) => c.weight), rng)]!.multiplier };
    default:
      return { kind };
  }
}

/** Play one spin. Numbers are daubed automatically; wilds are queued in `pendingWilds`. */
export function spin(state: SpinState, rng: Rng): ReelSymbol[] {
  if (state.collected) throw new Error('game collected');
  if (state.pendingWilds.length) throw new Error('place pending wilds first');
  if (state.spinsLeft <= 0) throw new Error('no spins left');
  state.spinsLeft--;
  state.spinsPlayed++;
  const reels = [0, 1, 2, 3, 4].map((c) => rollReel(c, state.config, rng));
  reels.forEach((symbol, c) => {
    if (symbol.kind === 'number') {
      for (let r = 0; r < 5; r++) {
        if (state.card.cells[r * 5 + c] === symbol.value) state.marked |= 1 << (r * 5 + c);
      }
    } else if (symbol.kind === 'joker') {
      state.pendingWilds.push({ kind: 'joker', column: c });
    } else if (symbol.kind === 'super') {
      state.pendingWilds.push({ kind: 'super' });
    } else if (symbol.kind === 'coin') {
      state.coinWinnings += applyMultiplier(state.stake, symbol.multiplier);
    } else if (symbol.kind === 'freeSpin') {
      state.spinsLeft++;
    }
  });
  // Wilds with nothing left to daub are discarded.
  state.pendingWilds = state.pendingWilds.filter((w) => wildTargets(state.marked, w).length > 0);
  state.lastReels = reels;
  return reels;
}

export function wildTargets(marked: number, wild: PendingWild): number[] {
  const cells: number[] = [];
  for (let i = 0; i < 25; i++) {
    if (marked & (1 << i)) continue;
    if (wild.kind === 'joker' && i % 5 !== wild.column) continue;
    cells.push(i);
  }
  return cells;
}

/** Place a pending wild on a cell. */
export function placeWild(state: SpinState, wildIndex: number, cell: number): void {
  const wild = state.pendingWilds[wildIndex];
  if (!wild) throw new Error('no such wild');
  if (!wildTargets(state.marked, wild).includes(cell)) throw new Error('invalid wild target');
  state.marked |= 1 << cell;
  state.pendingWilds.splice(wildIndex, 1);
  state.pendingWilds = state.pendingWilds.filter((w) => wildTargets(state.marked, w).length > 0);
}

/** Heuristic value of a mark mask: completed lines dominate, then near-complete lines. */
function markScore(marked: number): number {
  let score = 0;
  for (const line of LINES_5X5) {
    const have = popcount(line & marked);
    score += have === 5 ? 1000 : have * have;
  }
  return score;
}

/** Greedy best cell for a wild (also used by auto-play and EV pricing). */
export function bestWildCell(marked: number, wild: PendingWild): number {
  let best = -1;
  let bestScore = -1;
  for (const cell of wildTargets(marked, wild)) {
    const s = markScore(marked | (1 << cell));
    if (s > bestScore) {
      bestScore = s;
      best = cell;
    }
  }
  return best;
}

/** Resolve all pending wilds greedily (jokers first — they are the most constrained). */
export function autoPlaceWilds(state: SpinState): void {
  state.pendingWilds.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'joker' ? -1 : 1));
  while (state.pendingWilds.length) {
    const cell = bestWildCell(state.marked, state.pendingWilds[0]!);
    if (cell < 0) state.pendingWilds.shift();
    else placeWild(state, 0, cell);
  }
}

export function slingos(state: SpinState): number {
  return countLines5x5(state.marked);
}

export function ladderMultiplier(state: SpinState): number {
  return state.config.ladder[countLines5x5(state.marked)] ?? 0;
}

export function spinWinnings(state: SpinState): number {
  return applyMultiplier(state.stake, ladderMultiplier(state)) + state.coinWinnings;
}

/**
 * Expected gain of one more spin from the current state, in stake units: exact over all
 * per-reel daub outcomes (wilds placed greedily), plus coin and free-spin value.
 */
export function extraSpinEv(state: SpinState): number {
  const { config, marked, card } = state;
  const w = config.weights;
  const total = w.number + w.joker + w.super + w.coin + w.freeSpin + w.shark;
  const pNumberEach = w.number / total / 15;

  type Outcome = { p: number; cell: number; wild: 0 | 1 | 2 };
  const perReel: Outcome[][] = [];
  for (let c = 0; c < 5; c++) {
    const outcomes: Outcome[] = [];
    let pNone = 1;
    for (let r = 0; r < 5; r++) {
      const i = r * 5 + c;
      if (!(marked & (1 << i)) && card.cells[i]! > 0) {
        outcomes.push({ p: pNumberEach, cell: i, wild: 0 });
        pNone -= pNumberEach;
      }
    }
    const pJoker = w.joker / total;
    const pSuper = w.super / total;
    if (wildTargets(marked, { kind: 'joker', column: c }).length) {
      outcomes.push({ p: pJoker, cell: -1, wild: 1 });
      pNone -= pJoker;
    }
    outcomes.push({ p: pSuper, cell: -1, wild: 2 });
    pNone -= pSuper;
    outcomes.push({ p: Math.max(0, pNone), cell: -1, wild: 0 });
    perReel.push(outcomes);
  }

  const base = config.ladder[countLines5x5(marked)] ?? 0;
  let expected = 0;
  const walk = (c: number, p: number, mask: number, jokers: number[], supers: number) => {
    if (c === 5) {
      let m = mask;
      for (const col of jokers) {
        const cell = bestWildCell(m, { kind: 'joker', column: col });
        if (cell >= 0) m |= 1 << cell;
      }
      for (let s = 0; s < supers; s++) {
        const cell = bestWildCell(m, { kind: 'super' });
        if (cell >= 0) m |= 1 << cell;
      }
      expected += p * (config.ladder[countLines5x5(m)] ?? 0);
      return;
    }
    for (const o of perReel[c]!) {
      if (o.p <= 0) continue;
      if (o.cell >= 0) walk(c + 1, p * o.p, mask | (1 << o.cell), jokers, supers);
      else if (o.wild === 1) walk(c + 1, p * o.p, mask, [...jokers, c], supers);
      else if (o.wild === 2) walk(c + 1, p * o.p, mask, jokers, supers + 1);
      else walk(c + 1, p * o.p, mask, jokers, supers);
    }
  };
  walk(0, 1, marked, [], 0);

  const coinTotal = config.coins.reduce((s, c) => s + c.weight, 0);
  const coinEv = (5 * (w.coin / total) * config.coins.reduce((s, c) => s + c.multiplier * c.weight, 0)) / coinTotal;
  const markEv = expected - base;
  // A free spin is worth roughly another spin: V = (mark + coin) / (1 − 5·pFree).
  return (markEv + coinEv) / (1 - (5 * w.freeSpin) / total);
}

export interface ExtraSpinOffer {
  price: number;
  ev: number;
}

export function extraSpinOffer(state: SpinState): ExtraSpinOffer | null {
  if (state.collected || state.spinsLeft > 0 || state.pendingWilds.length) return null;
  if (state.extraSpins >= state.config.maxExtraSpins) return null;
  const ev = extraSpinEv(state) * state.stake;
  if (ev <= 0) return null;
  return { price: Math.max(1, Math.ceil(ev / EXTRA_SPIN_RTP)), ev };
}

export function buyExtraSpin(state: SpinState): number {
  const offer = extraSpinOffer(state);
  if (!offer) throw new Error('no extra spin available');
  state.extraSpins++;
  state.extraSpent += offer.price;
  state.spinsLeft++;
  return offer.price;
}

export function collectSpin(state: SpinState): { stake: number; extraSpent: number; payout: number } {
  if (state.pendingWilds.length) autoPlaceWilds(state);
  state.collected = true;
  return { stake: state.stake, extraSpent: state.extraSpent, payout: spinWinnings(state) };
}

/** Auto-play the included spins with greedy wilds (simulations, "auto" button). */
export function autoPlayBaseGame(state: SpinState, rng: Rng): void {
  while (state.spinsLeft > 0) {
    spin(state, rng);
    autoPlaceWilds(state);
  }
}
