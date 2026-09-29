import { generateCard, type BingoCard } from '../bingo/cards.ts';
import { applyMultiplier, floorMultiplier } from '../economy/money.ts';
import { sample, type Rng } from '../rng/fair.ts';

/**
 * CRAB DIG — "mines" on a bingo card (single player vs. house).
 *
 * `crabs` crabs hide under the 24 numbered squares of a 75-ball card. Each safe dig raises the
 * multiplier; hitting a crab loses the stake; cash out any time after the first dig.
 * The crab layout is fixed (and committed) before the first dig.
 *
 * m(n) = rtp × C(24, n) / C(24 − crabs, n) — the inverse of surviving n digs, so every
 * stopping strategy returns exactly `rtp` (before the 2-decimal floor and max-win cap).
 */
export const DIG_CELLS = 24;
export const DIG_RTP = 0.97;
export const DIG_MAX_MULTIPLIER = 10_000;

const CELL_INDEXES = [...Array(25).keys()].filter((i) => i !== 12);

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function digSurvival(crabs: number, digs: number): number {
  return choose(DIG_CELLS - crabs, digs) / choose(DIG_CELLS, digs);
}

export function digMultiplier(crabs: number, digs: number, rtp = DIG_RTP): number {
  if (digs <= 0) return 0;
  return Math.min(DIG_MAX_MULTIPLIER, floorMultiplier(rtp / digSurvival(crabs, digs)));
}

export type DigStatus = 'digging' | 'cashed' | 'bitten' | 'cleared';

export interface DigRound {
  crabs: number;
  stake: number;
  card: BingoCard;
  /** Hidden until the round ends (server-side in real-money play). */
  crabCells: number[];
  dug: number[];
  status: DigStatus;
  payout: number;
}

export function startDig(crabs: number, stake: number, rng: Rng): DigRound {
  if (!Number.isInteger(crabs) || crabs < 1 || crabs > 20) throw new Error('1–20 crabs');
  const card = generateCard('75', rng);
  return { crabs, stake, card, crabCells: sample(CELL_INDEXES, crabs, rng), dug: [], status: 'digging', payout: 0 };
}

export function dig(round: DigRound, cell: number): { crab: boolean; multiplier: number; status: DigStatus } {
  if (round.status !== 'digging') throw new Error(`round is ${round.status}`);
  if (!CELL_INDEXES.includes(cell) || round.dug.includes(cell)) throw new Error('invalid square');
  round.dug.push(cell);
  if (round.crabCells.includes(cell)) {
    round.status = 'bitten';
    round.payout = 0;
    return { crab: true, multiplier: 0, status: round.status };
  }
  const multiplier = digMultiplier(round.crabs, round.dug.length);
  if (round.dug.length === DIG_CELLS - round.crabs) {
    round.status = 'cleared';
    round.payout = applyMultiplier(round.stake, multiplier);
  }
  return { crab: false, multiplier, status: round.status };
}

export function cashOutDig(round: DigRound): number {
  if (round.status !== 'digging' || round.dug.length === 0) throw new Error('nothing to cash out');
  round.status = 'cashed';
  round.payout = applyMultiplier(round.stake, digMultiplier(round.crabs, round.dug.length));
  return round.payout;
}

/** Marked mask of safe digs (for line celebrations — cosmetic only). */
export function dugMask(round: DigRound): number {
  return round.dug.filter((c) => !round.crabCells.includes(c)).reduce((m, c) => m | (1 << c), 1 << 12);
}
