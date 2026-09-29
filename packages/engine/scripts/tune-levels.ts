// Re-tunes the Beach Adventure level table: prints ball budgets and star thresholds per level.
// Usage: pnpm --filter @beach-bingo/engine exec tsx scripts/tune-levels.ts
import { fastRng, range, sample } from '../src/rng/fair.ts';
import { generateCard, cellLookup, freeMask, playableMask } from '../src/bingo/cards.ts';
import { PATTERNS_75, isComplete, type Pattern75Id } from '../src/bingo/patterns.ts';
const rows: [number, Pattern75Id][] = [
  [1,'line'],[1,'postageStamp'],[2,'line'],[1,'fourCorners'],[2,'postageStamp'],[2,'twoLines'],[3,'line'],[2,'fourCorners'],[3,'postageStamp'],[2,'x'],
  [3,'twoLines'],[3,'fourCorners'],[3,'diamond'],[4,'line'],[3,'letterT'],[4,'postageStamp'],[3,'plus'],[4,'twoLines'],[3,'letterL'],[4,'x'],
  [4,'fourCorners'],[4,'diamond'],[4,'letterT'],[4,'plus'],[4,'letterL'],[4,'twoLines'],[4,'frame'],[4,'postageStamp'],[4,'x'],[4,'diamond'],
  [4,'line'],[4,'twoLines'],[4,'fourCorners'],[4,'x'],[4,'plus'],[4,'frame'],[4,'letterT'],[4,'diamond'],[4,'frame'],[4,'blackout'],
];
const rng = fastRng('levels2');
const T = 30000;
const lines: string[] = []; const summary: string[] = [];
rows.forEach(([cards, pid], i) => {
  const pattern = PATTERNS_75[pid];
  const firstAt: number[] = [];
  for (let t = 0; t < T; t++) {
    const cs = range(1, cards).map(() => generateCard('75', rng));
    const lookups = cs.map(cellLookup); const marks = cs.map(freeMask); const play = cs.map(playableMask);
    const drum = sample(range(1, 75), 75, rng);
    let at = 75;
    for (let b = 0; b < 75; b++) {
      const ball = drum[b]!; let done = false;
      for (let c = 0; c < cs.length; c++) { const cell = lookups[c]![ball]!; if (cell >= 0) { marks[c]! |= 1 << cell; if (isComplete(marks[c]!, pattern, play[c]!)) done = true; } }
      if (done) { at = b + 1; break; }
    }
    firstAt.push(at);
  }
  firstAt.sort((a, b) => a - b);
  const target = i === 39 ? 0.6 : 0.95 - (0.3 * i) / 38;
  const q = firstAt[Math.min(T - 1, Math.ceil(target * T) - 1)]!;
  const win = firstAt.filter((x) => x <= q).length / T;
  const p30 = firstAt[Math.floor(0.3 * T)]!; const p65 = firstAt[Math.floor(0.65 * T)]!;
  lines.push(`  [${cards}, '${pid}', ${q}, ${p30}, ${p65}],`);
  summary.push(`${i + 1} ${cards}x ${pid.padEnd(13)} budget=${q} win=${win.toFixed(3)} p30=${p30} p65=${p65} median=${firstAt[T >> 1]}`);
});
console.log(summary.join('\n')); console.log(lines.join('\n'));
