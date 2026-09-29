import { cellLookup, generateCard, type BingoCard } from '../bingo/cards.ts';
import { applyMultiplier, floorMultiplier } from '../economy/money.ts';
import { range, sample, type Rng } from '../rng/fair.ts';

/**
 * BEACH BALL BLITZ — 30-ball speed "limbo" (single player vs. house).
 *
 * A 3×3 speed card (9 of 30 numbers). The player picks a target T: "full house by ball T".
 * The 30 balls are drawn; the round wins if the 9th number arrives on or before ball T.
 * Payout = rtp / P(full house by T) with P = C(T, 9) / C(30, 9) — exact and strategy-proof.
 */
export const BLITZ_RTP = 0.97;
export const BLITZ_MIN_TARGET = 12;
export const BLITZ_MAX_TARGET = 29;

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function blitzProbability(target: number): number {
  return choose(target, 9) / choose(30, 9);
}

export function blitzMultiplier(target: number, rtp = BLITZ_RTP): number {
  if (target < BLITZ_MIN_TARGET || target > BLITZ_MAX_TARGET) throw new Error('target out of range');
  return floorMultiplier(rtp / blitzProbability(target));
}

export const BLITZ_TARGETS: readonly number[] = range(BLITZ_MIN_TARGET, BLITZ_MAX_TARGET);

export interface BlitzResult {
  card: BingoCard;
  target: number;
  multiplier: number;
  drawn: number[];
  /** Ball count at which the card completed (always ≤ 30). */
  completedAt: number;
  won: boolean;
  payout: number;
}

export function playBlitz(target: number, stake: number, cardRng: Rng, drawRng: Rng): BlitzResult {
  const multiplier = blitzMultiplier(target);
  const card = generateCard('30', cardRng);
  const drawn = sample(range(1, 30), 30, drawRng);
  const lookup = cellLookup(card);
  let hits = 0;
  let completedAt = 30;
  for (let i = 0; i < drawn.length; i++) {
    if ((lookup[drawn[i]!] ?? -1) >= 0 && ++hits === 9) {
      completedAt = i + 1;
      break;
    }
  }
  const won = completedAt <= target;
  return { card, target, multiplier, drawn, completedAt, won, payout: won ? applyMultiplier(stake, multiplier) : 0 };
}
