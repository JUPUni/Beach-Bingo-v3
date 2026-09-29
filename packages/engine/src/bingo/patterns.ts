import type { CardVariant } from './cards.ts';

/**
 * Patterns are geometric bit masks over a card grid (bit i = cell i, row-major).
 * A card completes a pattern when `need` of its masks are fully marked, where each mask
 * is first intersected with the card's playable cells (so 90-ball blanks never count).
 */
export interface PatternDef {
  id: string;
  /** Player-facing name. */
  name: string;
  variant: CardVariant;
  masks: readonly number[];
  /** How many distinct masks must be complete (default 1), e.g. 2 for "two lines". */
  need?: number;
}

export function popcount(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Build a mask from ASCII art: `X` = cell in pattern, anything else = not. */
export function maskFromArt(art: readonly string[]): number {
  let mask = 0;
  const cols = art[0]!.length;
  art.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      if (row[c] === 'X') mask |= 1 << (r * cols + c);
    }
  });
  return mask;
}

export function rowMask(r: number, cols: number): number {
  return ((1 << cols) - 1) << (r * cols);
}

export function colMask(c: number, rows: number, cols: number): number {
  let mask = 0;
  for (let r = 0; r < rows; r++) mask |= 1 << (r * cols + c);
  return mask;
}

export function fullMask(rows: number, cols: number): number {
  return rows * cols >= 31 ? -1 : (1 << (rows * cols)) - 1;
}

const ROWS_5 = [0, 1, 2, 3, 4].map((r) => rowMask(r, 5));
const COLS_5 = [0, 1, 2, 3, 4].map((c) => colMask(c, 5, 5));
const DIAG_MAIN = maskFromArt(['X....', '.X...', '..X..', '...X.', '....X']);
const DIAG_ANTI = maskFromArt(['....X', '...X.', '..X..', '.X...', 'X....']);
/** The 12 lines of a 5×5 card: 5 rows, 5 columns, 2 diagonals. */
export const LINES_5X5: readonly number[] = [...ROWS_5, ...COLS_5, DIAG_MAIN, DIAG_ANTI];

const p75 = (id: string, name: string, masks: readonly number[], need?: number): PatternDef => ({
  id,
  name,
  variant: '75',
  masks,
  ...(need ? { need } : {}),
});

export const PATTERNS_75 = {
  line: p75('line', 'Any Line', LINES_5X5),
  twoLines: p75('twoLines', 'Two Lines', LINES_5X5, 2),
  fourCorners: p75('fourCorners', 'Four Corners', [maskFromArt(['X...X', '.....', '.....', '.....', 'X...X'])]),
  x: p75('x', 'Crossed Oars (X)', [DIAG_MAIN | DIAG_ANTI]),
  plus: p75('plus', 'Lighthouse (+)', [ROWS_5[2]! | COLS_5[2]!]),
  frame: p75('frame', 'Sandcastle Wall', [ROWS_5[0]! | ROWS_5[4]! | COLS_5[0]! | COLS_5[4]!]),
  letterT: p75('letterT', 'Palm Tree (T)', [ROWS_5[0]! | COLS_5[2]!]),
  letterL: p75('letterL', 'Anchor (L)', [COLS_5[0]! | ROWS_5[4]!]),
  diamond: p75('diamond', 'Sand Dollar', [maskFromArt(['..X..', '.X.X.', 'X.X.X', '.X.X.', '..X..'])]),
  postageStamp: p75('postageStamp', 'Beach Towel', [
    maskFromArt(['XX...', 'XX...', '.....', '.....', '.....']),
    maskFromArt(['...XX', '...XX', '.....', '.....', '.....']),
    maskFromArt(['.....', '.....', '.....', 'XX...', 'XX...']),
    maskFromArt(['.....', '.....', '.....', '...XX', '...XX']),
  ]),
  blackout: p75('blackout', 'Blackout', [fullMask(5, 5)]),
} as const satisfies Record<string, PatternDef>;

export type Pattern75Id = keyof typeof PATTERNS_75;

const ROWS_9 = [0, 1, 2].map((r) => rowMask(r, 9));
export const PATTERNS_90 = {
  oneLine: { id: 'oneLine', name: 'One Line', variant: '90', masks: ROWS_9 },
  twoLines: { id: 'twoLines', name: 'Two Lines', variant: '90', masks: ROWS_9, need: 2 },
  fullHouse: { id: 'fullHouse', name: 'Full House', variant: '90', masks: [fullMask(3, 9)] },
} as const satisfies Record<string, PatternDef>;

export type Pattern90Id = keyof typeof PATTERNS_90;

export const PATTERNS_30 = {
  fullHouse: { id: 'fullHouse', name: 'Full House', variant: '30', masks: [fullMask(3, 3)] },
} as const satisfies Record<string, PatternDef>;

/** Number of the pattern's masks that are complete. */
export function completedMasks(marked: number, pattern: PatternDef, playable: number): number {
  let done = 0;
  for (const m of pattern.masks) {
    const target = m & playable;
    if ((target & ~marked) === 0) done++;
  }
  return done;
}

export function isComplete(marked: number, pattern: PatternDef, playable: number): boolean {
  return completedMasks(marked, pattern, playable) >= (pattern.need ?? 1);
}

/** Fewest additional cells needed to complete the pattern ("1 to go" indicators, bots, EV). */
export function cellsToGo(marked: number, pattern: PatternDef, playable: number): number {
  const need = pattern.need ?? 1;
  const masks = pattern.masks.map((m) => m & playable);
  if (need === 1) {
    let best = Infinity;
    for (const m of masks) best = Math.min(best, popcount(m & ~marked));
    return best;
  }
  if (need === 2) {
    let best = Infinity;
    for (let i = 0; i < masks.length; i++) {
      for (let j = i + 1; j < masks.length; j++) {
        best = Math.min(best, popcount((masks[i]! | masks[j]!) & ~marked));
      }
    }
    return best;
  }
  throw new Error(`cellsToGo: need=${need} not supported`);
}

/** Cells (indices) of the most-complete mask — used to highlight the winning shape. */
export function winningCells(marked: number, pattern: PatternDef, playable: number): number[] {
  const need = pattern.need ?? 1;
  let union = 0;
  let found = 0;
  for (const m of pattern.masks) {
    const target = m & playable;
    if ((target & ~marked) === 0) {
      union |= target;
      if (++found >= need) break;
    }
  }
  const cells: number[] = [];
  for (let i = 0; i < 32; i++) if (union & (1 << i)) cells.push(i);
  return cells;
}

/** Lines completed on a 5×5 mark mask (Slingo-style counting). */
export function countLines5x5(marked: number): number {
  let n = 0;
  for (const m of LINES_5X5) if ((m & ~marked) === 0) n++;
  return n;
}
