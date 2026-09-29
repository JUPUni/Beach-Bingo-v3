import { applyMultiplier, floorMultiplier } from '../economy/money.ts';
import { range, sample, type Rng } from '../rng/fair.ts';

/**
 * KENO COVE — bingo's fast cousin (single player vs. house).
 * 40 shells on the beach; pick 1–10; 10 are drawn. Payout depends on catches.
 *
 * Paytables are generated from a risk profile and scaled so the exact
 * (hypergeometric) RTP lands just under the target, then rounded down per entry.
 */
export const KENO_SPOTS = 40;
export const KENO_DRAWN = 10;
export const KENO_MAX_PICKS = 10;

export type KenoRisk = 'low' | 'medium' | 'high';

interface RiskProfile {
  /** Fraction of picks that must be caught before anything pays. */
  threshold: number;
  /** Growth of the prize per extra catch. */
  growth: number;
}

const RISK_PROFILES: Readonly<Record<KenoRisk, RiskProfile>> = {
  low: { threshold: 0.3, growth: 1.9 },
  medium: { threshold: 0.45, growth: 2.8 },
  high: { threshold: 0.6, growth: 4.5 },
};

export const KENO_RTP = 0.96;
export const KENO_MAX_MULTIPLIER = 10_000;

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return Math.round(result);
}

/** P(exactly `catches` of `picks` are among the 10 drawn). */
export function kenoProbability(picks: number, catches: number): number {
  return (
    (choose(picks, catches) * choose(KENO_SPOTS - picks, KENO_DRAWN - catches)) / choose(KENO_SPOTS, KENO_DRAWN)
  );
}

export function kenoRtp(paytable: readonly number[], picks: number): number {
  let rtp = 0;
  for (let k = 0; k <= picks; k++) rtp += kenoProbability(picks, k) * (paytable[k] ?? 0);
  return rtp;
}

export function buildKenoPaytable(picks: number, risk: KenoRisk, targetRtp = KENO_RTP): number[] {
  const { threshold, growth } = RISK_PROFILES[risk];
  const first = Math.max(1, Math.ceil(threshold * picks));
  const shape = range(0, picks).map((k) => (k >= first ? growth ** (k - first) : 0));
  const base = kenoRtp(shape, picks);
  let table = shape.map((s) => Math.min(KENO_MAX_MULTIPLIER, floorMultiplier((s * targetRtp) / base)));
  // The cap can only lower the RTP; top the lower tiers back up proportionally, then floor again.
  const capped = kenoRtp(table, picks);
  if (capped < targetRtp - 1e-6) {
    const uncappedShare = kenoRtp(
      table.map((m) => (m < KENO_MAX_MULTIPLIER ? m : 0)),
      picks,
    );
    const boost = (targetRtp - (capped - uncappedShare)) / uncappedShare;
    table = table.map((m) => (m < KENO_MAX_MULTIPLIER ? Math.min(KENO_MAX_MULTIPLIER, floorMultiplier(m * boost)) : m));
  }
  return table;
}

/** `KENO_PAYTABLES[risk][picks][catches]` → multiplier. Index 0 of the outer array is unused. */
export const KENO_PAYTABLES: Readonly<Record<KenoRisk, readonly number[][]>> = {
  low: [[], ...range(1, KENO_MAX_PICKS).map((n) => buildKenoPaytable(n, 'low'))],
  medium: [[], ...range(1, KENO_MAX_PICKS).map((n) => buildKenoPaytable(n, 'medium'))],
  high: [[], ...range(1, KENO_MAX_PICKS).map((n) => buildKenoPaytable(n, 'high'))],
};

export interface KenoResult {
  picks: number[];
  drawn: number[];
  hits: number[];
  catches: number;
  multiplier: number;
  payout: number;
}

export function validateKenoPicks(picks: readonly number[]): void {
  if (picks.length < 1 || picks.length > KENO_MAX_PICKS) throw new Error('pick 1–10 numbers');
  const seen = new Set<number>();
  for (const p of picks) {
    if (!Number.isInteger(p) || p < 1 || p > KENO_SPOTS) throw new Error(`invalid pick ${p}`);
    if (seen.has(p)) throw new Error(`duplicate pick ${p}`);
    seen.add(p);
  }
}

export function playKeno(picks: readonly number[], risk: KenoRisk, stake: number, rng: Rng): KenoResult {
  validateKenoPicks(picks);
  const drawn = sample(range(1, KENO_SPOTS), KENO_DRAWN, rng);
  const drawnSet = new Set(drawn);
  const hits = picks.filter((p) => drawnSet.has(p));
  const multiplier = KENO_PAYTABLES[risk][picks.length]![hits.length] ?? 0;
  return {
    picks: [...picks],
    drawn,
    hits,
    catches: hits.length,
    multiplier,
    payout: applyMultiplier(stake, multiplier),
  };
}

/** Quick-pick helper. */
export function kenoQuickPick(count: number, rng: Rng): number[] {
  return sample(range(1, KENO_SPOTS), count, rng).sort((a, b) => a - b);
}
