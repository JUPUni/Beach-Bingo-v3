import { PATTERNS_75, type Pattern75Id } from '@beach-bingo/engine';

/** Tiny 5×5 illustration of a 75-ball pattern (first mask, or two for "two lines"). */
export function PatternPreview({ pattern, size = 1.1 }: { pattern: Pattern75Id; size?: number }) {
  const def = PATTERNS_75[pattern];
  const masks = def.masks.slice(0, def.need ?? 1);
  const show = pattern === 'twoLines' ? [def.masks[0]!, def.masks[4]!] : masks;
  const mask = show.reduce((m, x) => m | x, 0);
  return (
    <span
      className="pattern-preview"
      style={{ gridTemplateColumns: `repeat(5, ${size}rem)`, gridAutoRows: `${size}rem`, gap: `${size * 0.18}rem` }}
      aria-label={def.name}
      title={def.name}
    >
      {Array.from({ length: 25 }, (_, i) => (
        <i key={i} className={mask & (1 << i) ? 'on' : i === 12 ? 'free' : ''} />
      ))}
    </span>
  );
}
