import { cellLookup, generateCard, type BingoCard } from '../bingo/cards.ts';
import { LINE_TABLE } from '../bingo/lineTable.ts';
import { countLines5x5, winningCells, LINES_5X5 } from '../bingo/patterns.ts';
import { applyMultiplier } from '../economy/money.ts';
import { range, sample, type Rng } from '../rng/fair.ts';

/**
 * TIDE POOL — instant pattern bingo (single player vs. house).
 *
 * Pick 1–4 standard 75-ball cards and a sea state; that many balls are drawn at once and each
 * card is paid by how many of its 12 lines are complete. Every 24-number card has identical
 * odds, so the RTP is computed *exactly* from {@link LINE_TABLE}.
 */
export type SeaState = 'calm' | 'choppy' | 'storm';

export interface TideConfig {
  balls: number;
  /** Paytable: index = completed lines (0–12) → multiplier of the per-card bet. */
  pays: readonly number[];
}

const ladder = (...pays: number[]) => [0, ...pays, ...new Array<number>(12 - pays.length).fill(pays[pays.length - 1]!)];

export const TIDE_SEAS: Readonly<Record<SeaState, TideConfig>> = {
  calm: { balls: 35, pays: ladder(1.8, 6.5, 32, 150, 750, 2500) },
  choppy: { balls: 30, pays: ladder(3.4, 30, 180, 1000, 5000, 10000) },
  storm: { balls: 25, pays: ladder(8.5, 150, 1750, 10000) },
};

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** P(a card completes exactly L lines) after `balls` balls, L = 0…12. */
export function lineDistribution(balls: number): number[] {
  const total = choose(75, balls);
  const dist = new Array<number>(13).fill(0);
  for (let k = 0; k <= 24; k++) {
    const weight = choose(51, balls - k) / total;
    if (weight === 0) continue;
    LINE_TABLE[k]!.forEach((count, L) => {
      dist[L]! += count * weight;
    });
  }
  return dist;
}

/** Exact return-to-player of a sea state. */
export function tideRtp(sea: SeaState): number {
  const { balls, pays } = TIDE_SEAS[sea];
  return lineDistribution(balls).reduce((sum, p, L) => sum + p * (pays[L] ?? 0), 0);
}

/** Probability that a card pays anything. */
export function tideHitRate(sea: SeaState): number {
  return 1 - lineDistribution(TIDE_SEAS[sea].balls)[0]!;
}

export interface TideCardResult {
  card: BingoCard;
  marked: number;
  lines: number;
  multiplier: number;
  payout: number;
  /** Cells of completed lines (for highlighting). */
  lineCells: number[];
}

export interface TideResult {
  sea: SeaState;
  betPerCard: number;
  drawn: number[];
  cards: TideCardResult[];
  stake: number;
  payout: number;
}

export function dealTideCards(count: number, rng: Rng): BingoCard[] {
  if (count < 1 || count > 4) throw new Error('1–4 cards');
  return range(1, count).map(() => generateCard('75', rng));
}

export function playTidePool(cards: readonly BingoCard[], sea: SeaState, betPerCard: number, drawRng: Rng): TideResult {
  const { balls, pays } = TIDE_SEAS[sea];
  const drawn = sample(range(1, 75), balls, drawRng);
  const results = cards.map((card): TideCardResult => {
    const lookup = cellLookup(card);
    let marked = 1 << 12;
    for (const b of drawn) {
      const cell = lookup[b] ?? -1;
      if (cell >= 0) marked |= 1 << cell;
    }
    const lines = countLines5x5(marked);
    const multiplier = pays[lines] ?? 0;
    const lineCells = lines
      ? winningCells(marked, { id: 'lines', name: 'Lines', variant: '75', masks: LINES_5X5, need: 12 }, (1 << 25) - 1)
      : [];
    return { card, marked, lines, multiplier, payout: applyMultiplier(betPerCard, multiplier), lineCells };
  });
  return {
    sea,
    betPerCard,
    drawn,
    cards: results,
    stake: betPerCard * cards.length,
    payout: results.reduce((s, r) => s + r.payout, 0),
  };
}
