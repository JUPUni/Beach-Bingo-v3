import { range, sample, shuffle, type Rng } from '../rng/fair.ts';

/**
 * Card formats:
 * - `75`: US 5×5 card, columns B(1–15) I(16–30) N(31–45) G(46–60) O(61–75), free centre.
 * - `90`: UK 3×9 ticket, 15 numbers, 5 per row, column c holds 1–9 / 10–19 / … / 80–90.
 * - `30`: speed-bingo 3×3 card, column c holds 1–10 / 11–20 / 21–30.
 * - `video`: video-bingo 3×5 card, numbers 1–60, column c holds 12c+1 … 12c+12.
 */
export type CardVariant = '75' | '90' | '30' | 'video';

/** Free space: counts as marked from the start. */
export const FREE = 0;
/** Empty square on a 90-ball ticket: never marked, never part of a pattern. */
export const BLANK = -1;

export interface CardSpec {
  rows: number;
  cols: number;
  /** Highest ball number in the drum. */
  maxBall: number;
}

export const CARD_SPECS: Readonly<Record<CardVariant, CardSpec>> = {
  '75': { rows: 5, cols: 5, maxBall: 75 },
  '90': { rows: 3, cols: 9, maxBall: 90 },
  '30': { rows: 3, cols: 3, maxBall: 30 },
  video: { rows: 3, cols: 5, maxBall: 60 },
};

export interface BingoCard {
  variant: CardVariant;
  rows: number;
  cols: number;
  /** Row-major cell values: a ball number, {@link FREE} or {@link BLANK}. */
  cells: number[];
}

export const BINGO_LETTERS = ['B', 'I', 'N', 'G', 'O'] as const;

/** Letter of a 75-ball number (B/I/N/G/O). */
export function letterFor(ball: number): string {
  return BINGO_LETTERS[Math.min(4, Math.floor((ball - 1) / 15))] ?? '';
}

export function generateCard(variant: CardVariant, rng: Rng): BingoCard {
  switch (variant) {
    case '75':
      return generate75(rng);
    case '90':
      return generate90(rng);
    case '30':
      return generateColumns('30', 3, 10, rng);
    case 'video':
      return generateColumns('video', 3, 12, rng);
  }
}

function generate75(rng: Rng): BingoCard {
  const cells = new Array<number>(25).fill(FREE);
  for (let c = 0; c < 5; c++) {
    const picks = sample(range(c * 15 + 1, c * 15 + 15), 5, rng);
    for (let r = 0; r < 5; r++) {
      if (!(r === 2 && c === 2)) cells[r * 5 + c] = picks[r]!;
    }
  }
  return { variant: '75', rows: 5, cols: 5, cells };
}

/** Column-banded card where every column holds `rows` sorted numbers from a band of `band` numbers. */
function generateColumns(variant: CardVariant, rows: number, band: number, rng: Rng): BingoCard {
  const { cols } = CARD_SPECS[variant];
  const cells = new Array<number>(rows * cols).fill(BLANK);
  for (let c = 0; c < cols; c++) {
    const picks = sample(range(c * band + 1, c * band + band), rows, rng).sort((a, b) => a - b);
    for (let r = 0; r < rows; r++) cells[r * cols + c] = picks[r]!;
  }
  return { variant, rows, cols, cells };
}

/** Numbers available to column `c` of a 90-ball ticket. */
function column90(c: number): number[] {
  if (c === 0) return range(1, 9);
  if (c === 8) return range(80, 90);
  return range(c * 10, c * 10 + 9);
}

/**
 * 90-ball ticket: 15 numbers, exactly 5 per row, 1–3 per column, ascending down each column.
 * Rows are assigned greedily to the rows with the most remaining capacity (Gale–Ryser style),
 * which always succeeds for these degree sequences.
 */
function generate90(rng: Rng): BingoCard {
  const counts = new Array<number>(9).fill(1);
  for (let extra = 6; extra > 0; ) {
    const c = rng.int(9);
    if (counts[c]! < 3) {
      counts[c]!++;
      extra--;
    }
  }

  // Random tie-breaks are drawn up front (fixed RNG consumption) so the result never depends
  // on how a JS engine's sort calls its comparator — tickets must verify identically everywhere.
  const columnTie = shuffle(range(0, 8), rng);
  const rowLoad = [0, 0, 0];
  const occupancy: number[][] = Array.from({ length: 9 }, () => []);
  const order = range(0, 8).sort(
    (a, b) => counts[b]! - counts[a]! || columnTie.indexOf(a) - columnTie.indexOf(b),
  );
  for (const c of order) {
    const rowTie = shuffle([0, 1, 2], rng);
    const rowsByCapacity = [0, 1, 2]
      .map((r) => ({ r, cap: 5 - rowLoad[r]!, tie: rowTie.indexOf(r) }))
      .sort((a, b) => b.cap - a.cap || a.tie - b.tie);
    const chosen = rowsByCapacity.slice(0, counts[c]!).map((x) => x.r);
    for (const r of chosen) rowLoad[r]!++;
    occupancy[c] = chosen.sort((a, b) => a - b);
  }
  if (rowLoad.some((load) => load !== 5)) {
    // Unreachable for valid count vectors; kept as a hard guard for money-bearing rooms.
    throw new Error('90-ball ticket generation failed');
  }

  const cells = new Array<number>(27).fill(BLANK);
  for (let c = 0; c < 9; c++) {
    const picks = sample(column90(c), counts[c]!, rng).sort((a, b) => a - b);
    occupancy[c]!.forEach((r, i) => {
      cells[r * 9 + c] = picks[i]!;
    });
  }
  return { variant: '90', rows: 3, cols: 9, cells };
}

/** Bit mask of cells that can ever be marked (numbers + free space). */
export function playableMask(card: BingoCard): number {
  let mask = 0;
  card.cells.forEach((value, i) => {
    if (value !== BLANK) mask |= 1 << i;
  });
  return mask;
}

/** Bit mask of free spaces (pre-marked). */
export function freeMask(card: BingoCard): number {
  let mask = 0;
  card.cells.forEach((value, i) => {
    if (value === FREE) mask |= 1 << i;
  });
  return mask;
}

/** Lookup table ball → cell index (or -1). */
export function cellLookup(card: BingoCard): Int8Array {
  const table = new Int8Array(CARD_SPECS[card.variant].maxBall + 1).fill(-1);
  card.cells.forEach((value, i) => {
    if (value > 0) table[value] = i;
  });
  return table;
}

/** Mask of cells covered by the given drawn balls (free spaces included). */
export function markedMask(card: BingoCard, drawn: Iterable<number>): number {
  const lookup = cellLookup(card);
  let mask = freeMask(card);
  for (const ball of drawn) {
    const i = lookup[ball] ?? -1;
    if (i >= 0) mask |= 1 << i;
  }
  return mask;
}

/** Numbers on the card (excluding free/blank). */
export function cardNumbers(card: BingoCard): number[] {
  return card.cells.filter((v) => v > 0);
}

/** The full drum `1..maxBall`, shuffled. */
export function drumOrder(maxBall: number, rng: Rng): number[] {
  return sample(range(1, maxBall), maxBall, rng);
}
