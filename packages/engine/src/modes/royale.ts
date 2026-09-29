import { cellLookup, generateCard, type BingoCard } from '../bingo/cards.ts';
import { cellsToGo, popcount, PATTERNS_75 } from '../bingo/patterns.ts';
import { mulDiv } from '../economy/money.ts';
import { range, sample, shuffle, type Rng } from '../rng/fair.ts';

/**
 * LAST CASTLE STANDING — battle-royale bingo (player vs. player, rake).
 *
 * Everyone gets one 75-ball card. Balls come in waves of 5; after each wave the bottom half of
 * the surviving players (by squares marked, then by fewest squares to a line, then by a
 * seed-derived tiebreak) is washed away. 64 players → 1 champion in 6 waves / 30 balls.
 * Auto-daub only, so there is no speed advantage for bots.
 */
export const ROYALE_WAVE = 5;
export const ROYALE_PAYOUT_RATE = 0.9;
/** Share of the prize pool by finishing place (1st, 2nd, 3rd–4th, 5th–8th). */
export const ROYALE_PLACES: readonly number[] = [0.4, 0.2, 0.1, 0.1, 0.05, 0.05, 0.05, 0.05];

export interface RoyalePlayer {
  id: string;
  name: string;
  card: BingoCard;
  marked: number;
  /** Finishing place once eliminated or crowned (1 = champion). */
  place: number | null;
}

export interface RoyaleState {
  buyIn: number;
  players: RoyalePlayer[];
  drum: number[];
  drawn: number[];
  /** Seed-derived tiebreak order (lower index wins ties). */
  tiebreak: string[];
  wave: number;
  finished: boolean;
}

export function createRoyale(entrants: { id: string; name: string }[], buyIn: number, cardRng: Rng, drawRng: Rng): RoyaleState {
  if (entrants.length < 2) throw new Error('need at least 2 players');
  const players = entrants.map((e) => ({ ...e, card: generateCard('75', cardRng), marked: 1 << 12, place: null }));
  return {
    buyIn,
    players,
    drum: sample(range(1, 75), 75, drawRng),
    drawn: [],
    tiebreak: shuffle(
      entrants.map((e) => e.id),
      drawRng,
    ),
    wave: 0,
    finished: false,
  };
}

export function alive(state: RoyaleState): RoyalePlayer[] {
  return state.players.filter((p) => p.place === null);
}

/** Ranking key for survivors: more marks, then fewer squares to a line, then tiebreak. */
function rank(state: RoyaleState, players: RoyalePlayer[]): RoyalePlayer[] {
  const order = new Map(state.tiebreak.map((id, i) => [id, i]));
  const playable = (1 << 25) - 1;
  return [...players].sort(
    (a, b) =>
      popcount(b.marked) - popcount(a.marked) ||
      cellsToGo(a.marked, PATTERNS_75.line, playable) - cellsToGo(b.marked, PATTERNS_75.line, playable) ||
      order.get(a.id)! - order.get(b.id)!,
  );
}

export interface WaveResult {
  wave: number;
  balls: number[];
  eliminated: RoyalePlayer[];
  survivors: RoyalePlayer[];
}

export function playWave(state: RoyaleState): WaveResult {
  if (state.finished) throw new Error('royale finished');
  const balls = state.drum.slice(state.drawn.length, state.drawn.length + ROYALE_WAVE);
  state.drawn.push(...balls);
  const survivorsBefore = alive(state);
  for (const p of survivorsBefore) {
    const lookup = cellLookup(p.card);
    for (const b of balls) {
      const cell = lookup[b] ?? -1;
      if (cell >= 0) p.marked |= 1 << cell;
    }
  }
  const ranked = rank(state, survivorsBefore);
  const keep = Math.ceil(ranked.length / 2);
  const eliminated = ranked.slice(keep);
  eliminated.forEach((p, i) => {
    p.place = keep + i + 1;
  });
  state.wave++;
  const survivors = ranked.slice(0, keep);
  if (survivors.length === 1) {
    survivors[0]!.place = 1;
    state.finished = true;
  }
  return { wave: state.wave, balls, eliminated, survivors };
}

export function royalePool(state: RoyaleState): number {
  return mulDiv(state.buyIn * state.players.length, Math.round(ROYALE_PAYOUT_RATE * 10_000), 10_000);
}

export function royalePayouts(state: RoyaleState): Record<string, number> {
  if (!state.finished) throw new Error('royale not finished');
  const pool = royalePool(state);
  const out: Record<string, number> = {};
  // Unfilled places (small lobbies) roll down to the places that exist.
  const places = ROYALE_PLACES.slice(0, state.players.length);
  const scale = places.reduce((s, x) => s + x, 0);
  for (const p of state.players) {
    const share = p.place && p.place <= places.length ? places[p.place - 1]! / scale : 0;
    if (share > 0) out[p.id] = mulDiv(pool, Math.round(share * 1_000_000), 1_000_000);
  }
  return out;
}
