import { cellLookup, generateCard, type BingoCard } from '../bingo/cards.ts';
import { maskFromArt, popcount, rowMask } from '../bingo/patterns.ts';
import { applyMultiplier } from '../economy/money.ts';
import { range, sample, type Rng } from '../rng/fair.ts';

/**
 * TIKI VIDEO BINGO — the video-bingo format popular with gamblers in Latin America & Spain
 * (single player vs. house).
 *
 * Up to 4 cards of 3×5 (numbers 1–60), 30 balls drawn from 60. Each card pays its single
 * highest pattern × its bet. After the 30th ball the player may buy up to 10 extra balls;
 * each is priced at its exact expected value divided by {@link EXTRA_BALL_RTP}, so extra
 * balls return the same RTP no matter when they are bought.
 */
export interface VideoPattern {
  id: string;
  name: string;
  masks: readonly number[];
  multiplier: number;
}

const art = (...rows: string[]) => maskFromArt(rows);

/** Ordered from highest to lowest prize. Base-game RTP is verified by simulation in tests. */
export const VIDEO_PATTERNS: readonly VideoPattern[] = [
  { id: 'bingo', name: 'Tiki Bingo', multiplier: 3000, masks: [art('XXXXX', 'XXXXX', 'XXXXX')] },
  { id: 'frame', name: 'Surfboard Frame', multiplier: 500, masks: [art('XXXXX', 'X...X', 'XXXXX')] },
  {
    id: 'doubleLine',
    name: 'Double Wave',
    multiplier: 100,
    masks: [rowMask(0, 5) | rowMask(1, 5), rowMask(0, 5) | rowMask(2, 5), rowMask(1, 5) | rowMask(2, 5)],
  },
  { id: 'pyramid', name: 'Volcano', multiplier: 60, masks: [art('..X..', '.XXX.', 'XXXXX')] },
  { id: 'cup', name: 'Coconut Cup', multiplier: 60, masks: [art('X...X', 'X...X', 'XXXXX')] },
  { id: 'chess', name: 'Beach Towel', multiplier: 25, masks: [art('X.X.X', '.X.X.', 'X.X.X')] },
  { id: 'w', name: 'Seagull W', multiplier: 25, masks: [art('X.X.X', 'X.X.X', '.X.X.')] },
  { id: 'm', name: 'Mountain M', multiplier: 25, masks: [art('.X.X.', 'X.X.X', 'X.X.X')] },
  { id: 'plus', name: 'Lighthouse', multiplier: 12, masks: [art('..X..', 'XXXXX', '..X..')] },
  { id: 'v', name: 'Palm V', multiplier: 4, masks: [art('X...X', '.X.X.', '..X..')] },
  { id: 'hat', name: 'Sun Hat', multiplier: 4, masks: [art('..X..', '.X.X.', 'X...X')] },
  { id: 'line', name: 'Shoreline', multiplier: 3, masks: [rowMask(0, 5), rowMask(1, 5), rowMask(2, 5)] },
  { id: 'corners', name: 'Four Shells', multiplier: 2.5, masks: [art('X...X', '.....', 'X...X')] },
];

export const VIDEO_BALLS = 60;
export const VIDEO_BASE_DRAW = 30;
export const VIDEO_MAX_EXTRA = 10;
export const VIDEO_MAX_CARDS = 4;
export const EXTRA_BALL_RTP = 0.96;

/** Highest paying pattern completed by a mark mask (or null). */
export function bestVideoPattern(marked: number): VideoPattern | null {
  for (const pattern of VIDEO_PATTERNS) {
    for (const m of pattern.masks) if ((m & ~marked) === 0) return pattern;
  }
  return null;
}

export function videoMultiplier(marked: number): number {
  return bestVideoPattern(marked)?.multiplier ?? 0;
}

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

/**
 * Exact base-game RTP after `drawn` balls. A card's 15 numbers are distinct, so the chance
 * that exactly the cell set S is marked is C(45, drawn−|S|) / C(60, drawn); enumerating all
 * 2^15 cell sets gives the exact expectation of the paid multiplier.
 */
export function videoBaseRtp(drawn = VIDEO_BASE_DRAW): number {
  const total = choose(VIDEO_BALLS, drawn);
  let rtp = 0;
  for (let marked = 0; marked < 1 << 15; marked++) {
    const multiplier = videoMultiplier(marked);
    if (multiplier > 0) rtp += (multiplier * choose(VIDEO_BALLS - 15, drawn - popcount(marked))) / total;
  }
  return rtp;
}

export interface VideoBingoRound {
  bet: number;
  cards: BingoCard[];
  lookups: Int8Array[];
  marks: number[];
  /** Pre-shuffled drum (committed at start). The first `drawnCount` are revealed. */
  drum: number[];
  drawnCount: number;
  extraBalls: number;
  extraSpent: number;
  settled: boolean;
}

export function startVideoBingo(bet: number, cardCount: number, cardRng: Rng, drumRng: Rng): VideoBingoRound {
  if (cardCount < 1 || cardCount > VIDEO_MAX_CARDS) throw new Error('1–4 cards');
  const cards = range(1, cardCount).map(() => generateCard('video', cardRng));
  const round: VideoBingoRound = {
    bet,
    cards,
    lookups: cards.map(cellLookup),
    marks: cards.map(() => 0),
    drum: sample(range(1, VIDEO_BALLS), VIDEO_BALLS, drumRng),
    drawnCount: 0,
    extraBalls: 0,
    extraSpent: 0,
    settled: false,
  };
  for (let i = 0; i < VIDEO_BASE_DRAW; i++) revealNext(round);
  return round;
}

function revealNext(round: VideoBingoRound): number {
  const ball = round.drum[round.drawnCount++]!;
  round.lookups.forEach((lookup, i) => {
    const cell = lookup[ball] ?? -1;
    if (cell >= 0) round.marks[i]! |= 1 << cell;
  });
  return ball;
}

export function drawnBalls(round: VideoBingoRound): number[] {
  return round.drum.slice(0, round.drawnCount);
}

/** Current winnings (before extra-ball costs). */
export function videoWinnings(round: VideoBingoRound): number {
  return round.marks.reduce((sum, m) => sum + applyMultiplier(round.bet, videoMultiplier(m)), 0);
}

/** Exact expected gain of drawing one more ball, averaged over the undrawn balls. */
export function extraBallEv(round: VideoBingoRound): number {
  const remaining = round.drum.slice(round.drawnCount);
  if (remaining.length === 0) return 0;
  const current = round.marks.map(videoMultiplier);
  let gain = 0;
  for (const ball of remaining) {
    round.lookups.forEach((lookup, i) => {
      const cell = lookup[ball] ?? -1;
      if (cell >= 0) gain += videoMultiplier(round.marks[i]! | (1 << cell)) - current[i]!;
    });
  }
  return (gain / remaining.length) * round.bet;
}

export interface ExtraBallOffer {
  price: number;
  ev: number;
  /** Cards that are one ball away from a better prize, with that prize's multiplier. */
  nearMisses: { card: number; multiplier: number }[];
}

export function extraBallOffer(round: VideoBingoRound): ExtraBallOffer | null {
  if (round.settled || round.extraBalls >= VIDEO_MAX_EXTRA) return null;
  const ev = extraBallEv(round);
  if (ev <= 0) return null;
  const nearMisses: ExtraBallOffer['nearMisses'] = [];
  round.marks.forEach((marked, card) => {
    const current = videoMultiplier(marked);
    let best = 0;
    for (const pattern of VIDEO_PATTERNS) {
      if (pattern.multiplier <= current) break;
      for (const m of pattern.masks) {
        if (popcount(m & ~marked) === 1) best = Math.max(best, pattern.multiplier);
      }
    }
    if (best > 0) nearMisses.push({ card, multiplier: best });
  });
  return { price: Math.max(1, Math.ceil(ev / EXTRA_BALL_RTP)), ev, nearMisses };
}

export function buyExtraBall(round: VideoBingoRound): { ball: number; price: number } {
  const offer = extraBallOffer(round);
  if (!offer) throw new Error('no extra ball available');
  round.extraBalls++;
  round.extraSpent += offer.price;
  return { ball: revealNext(round), price: offer.price };
}

export function settleVideoBingo(round: VideoBingoRound): { stake: number; extraSpent: number; payout: number } {
  round.settled = true;
  return { stake: round.bet * round.cards.length, extraSpent: round.extraSpent, payout: videoWinnings(round) };
}
