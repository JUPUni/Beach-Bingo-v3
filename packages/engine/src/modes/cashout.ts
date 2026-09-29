import { cellLookup, generateCard, type BingoCard } from '../bingo/cards.ts';
import { countLines5x5 } from '../bingo/patterns.ts';
import { applyMultiplier } from '../economy/money.ts';
import { range, sample, type Rng } from '../rng/fair.ts';

/**
 * RIPTIDE — crash-style cash-out bingo (single player vs. house).
 *
 * The drum holds balls 1–75 plus `sharks` shark balls. Balls are drawn one at a time.
 * Every ball that hits the player's 5×5 card raises the multiplier; a shark ends the
 * round and the stake is lost. The player may cash out between draws.
 *
 * Fairness by construction: with h hits so far, the chance of reaching h hits before any
 * shark is P(h) = Π_{i<h} (24−i)/(24+S−i) (misses are irrelevant). The ladder is
 * m(h) = rtp / P(h), which makes m a martingale, so *every* cash-out strategy has the
 * same expected return `rtp` (before rounding down to 2 decimals and the max-win cap,
 * both of which only lower it).
 */
export interface CashoutConfig {
  sharks: number;
  /** Target return to player, e.g. 0.97. */
  rtp: number;
  /** Maximum multiplier paid (house max-win cap). */
  maxMultiplier: number;
}

export const RIPTIDE_LEVELS = {
  calm: { sharks: 2, rtp: 0.97, maxMultiplier: 1000 },
  choppy: { sharks: 4, rtp: 0.97, maxMultiplier: 5000 },
  storm: { sharks: 8, rtp: 0.97, maxMultiplier: 10000 },
} as const satisfies Record<string, CashoutConfig>;

export type RiptideLevel = keyof typeof RIPTIDE_LEVELS;

/** Card numbers on a 75-ball card (24; the centre is free). */
const CARD_NUMBERS = 24;
/** Drum value for a shark ball. */
export const SHARK = 0;

export function reachProbability(hits: number, sharks: number): number {
  let p = 1;
  for (let i = 0; i < hits; i++) p *= (CARD_NUMBERS - i) / (CARD_NUMBERS + sharks - i);
  return p;
}

/** Multiplier paid when cashing out after `hits` hits (2-decimal floor, capped). */
export function cashoutMultiplier(hits: number, config: CashoutConfig): number {
  if (hits <= 0) return 0;
  const raw = config.rtp / reachProbability(hits, config.sharks);
  return Math.min(config.maxMultiplier, Math.floor(raw * 100 + 1e-9) / 100);
}

/** The whole ladder, index = hits (0…24). */
export function cashoutLadder(config: CashoutConfig): number[] {
  return range(0, CARD_NUMBERS).map((h) => cashoutMultiplier(h, config));
}

export type RiptideStatus = 'running' | 'cashed' | 'busted' | 'blackout';

export interface RiptideRound {
  config: CashoutConfig;
  stake: number;
  card: BingoCard;
  /** Full hidden draw order: numbers 1–75 and {@link SHARK}s. Server-side only in real-money play. */
  drum: number[];
  drawn: number[];
  hits: number;
  marked: number;
  status: RiptideStatus;
  /** Settled payout in stake units (0 until the round ends). */
  payout: number;
  /** Optional auto cash-out once this many hits are reached. */
  autoCashoutHits?: number;
}

export interface RiptideDraw {
  ball: number;
  isShark: boolean;
  isHit: boolean;
  cell: number;
  hits: number;
  multiplier: number;
  newLines: number;
  status: RiptideStatus;
}

export function startRiptide(
  config: CashoutConfig,
  stake: number,
  cardRng: Rng,
  drumRng: Rng,
  autoCashoutHits?: number,
): RiptideRound {
  const card = generateCard('75', cardRng);
  const drum = sample([...range(1, 75), ...new Array<number>(config.sharks).fill(SHARK)], 75 + config.sharks, drumRng);
  return {
    config,
    stake,
    card,
    drum,
    drawn: [],
    hits: 0,
    marked: 1 << 12,
    status: 'running',
    payout: 0,
    ...(autoCashoutHits ? { autoCashoutHits } : {}),
  };
}

/** Draw the next ball. Mutates and returns the round's draw event. */
export function drawRiptide(round: RiptideRound): RiptideDraw {
  if (round.status !== 'running') throw new Error(`round is ${round.status}`);
  const ball = round.drum[round.drawn.length];
  if (ball === undefined) throw new Error('drum exhausted');
  round.drawn.push(ball);

  const linesBefore = countLines5x5(round.marked);
  let cell = -1;
  if (ball === SHARK) {
    round.status = 'busted';
    round.payout = 0;
  } else {
    cell = cellLookup(round.card)[ball] ?? -1;
    if (cell >= 0) {
      round.hits++;
      round.marked |= 1 << cell;
      if (round.hits === CARD_NUMBERS) {
        round.status = 'blackout';
        round.payout = settle(round);
      } else if (round.autoCashoutHits && round.hits >= round.autoCashoutHits) {
        round.status = 'cashed';
        round.payout = settle(round);
      }
    }
  }
  return {
    ball,
    isShark: ball === SHARK,
    isHit: cell >= 0,
    cell,
    hits: round.hits,
    multiplier: cashoutMultiplier(round.hits, round.config),
    newLines: countLines5x5(round.marked) - linesBefore,
    status: round.status,
  };
}

export function cashOutRiptide(round: RiptideRound): number {
  if (round.status !== 'running') throw new Error(`round is ${round.status}`);
  if (round.hits === 0) throw new Error('need at least one hit to cash out');
  round.status = 'cashed';
  round.payout = settle(round);
  return round.payout;
}

function settle(round: RiptideRound): number {
  return applyMultiplier(round.stake, cashoutMultiplier(round.hits, round.config));
}

/** Exact expected return of the "cash out at h hits" strategy (for docs/tests). */
export function riptideStrategyRtp(targetHits: number, config: CashoutConfig): number {
  return reachProbability(targetHits, config.sharks) * cashoutMultiplier(targetHits, config);
}
