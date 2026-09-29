import { mathRng } from '@beach-bingo/engine';

/**
 * Practice-room bots. They only ever appear in play-money rooms and are always labelled 🤖 —
 * money rooms must never contain house-run players (see docs/GAME_MODES.md).
 */
const NAMES = [
  'Coral Kate',
  'Surfer Sam',
  'Pelican Pete',
  'Sandy Shores',
  'Captain Barnacle',
  'Tiki Tom',
  'Marina',
  'Reef Rider',
  'Sunny Sal',
  'Pearl',
  'Driftwood Dan',
  'Lagoon Lou',
  'Shelly',
  'Wave Walker',
  'Kelp Kid',
  'Salty Sue',
  'Breezy Bea',
  'Palm Pat',
  'Nautilus Ned',
  'Gull Gwen',
];

export function botName(i: number): string {
  const base = NAMES[i % NAMES.length]!;
  return i < NAMES.length ? `${base} 🤖` : `${base} ${Math.floor(i / NAMES.length) + 1} 🤖`;
}

export function botRoster(count: number): { id: string; name: string; bot: true }[] {
  const offset = mathRng.int(NAMES.length);
  return Array.from({ length: count }, (_, i) => ({ id: `bot-${i}`, name: botName(i + offset), bot: true as const }));
}

/** How long a duel bot takes to notice its bingo (ms). */
export function botReactionMs(): number {
  return 900 + mathRng.int(2200);
}
