// Enumerates all 2^24 markings of a 75-ball card (free centre always marked) and counts,
// for each number of marked cells k, how many markings complete exactly L lines.
// Output is baked into src/bingo/lineTable.ts (used for exact Tide Pool RTP).
import { LINES_5X5 } from '../src/bingo/patterns.ts';

const cells = [...Array(25).keys()].filter((i) => i !== 12);
const table = Array.from({ length: 25 }, () => new Array<number>(13).fill(0));
const lines = [...LINES_5X5];
for (let sub = 0; sub < 1 << 24; sub++) {
  let mask = 1 << 12;
  let k = 0;
  for (let b = 0; b < 24; b++) {
    if (sub & (1 << b)) {
      mask |= 1 << cells[b]!;
      k++;
    }
  }
  let L = 0;
  for (const m of lines) if ((m & ~mask) === 0) L++;
  table[k]![L]!++;
}
console.log(JSON.stringify(table));
