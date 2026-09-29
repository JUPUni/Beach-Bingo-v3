/* The Beach Bingo palette. Six colours are Fete Labs' own, from its logo kit
   (Ink, Cream, Teal, Soca Pink, Gold, Lime). Surf, Deep and Coconut come from
   the Fete Labs site palette (Deck Cyan, blue, and the seed-tier orange), and
   Sand is the Fete Labs kit's neutral ground. Nothing here is new to the family. */

export const C = {
  ink: '#0E0818',
  cream: '#FFF6E6',
  teal: '#1FB5A8',
  pink: '#FF2E88',
  gold: '#F4B400',
  lime: '#9BE22D',
  surf: '#22E0F2',
  deep: '#0F9BD6',
  coconut: '#FF8A1F',
  sand: '#E8DCC8',
};

/** Name, hex, role: the order the kit, the tokens and the brand page list them in. */
export const PALETTE = [
  ['Ink', C.ink, 'Outlines, block shadows and the dark ground.'],
  ['Cream', C.cream, 'BINGO, and the light ground. As text, only on Ink.'],
  ['Teal', C.teal, 'The app tile. The lagoon everything sits in.'],
  ['Soca Pink', C.pink, 'BEACH. The loudest thing on the page.'],
  ['Gold', C.gold, 'The ball. One per layout.'],
  ['Lime', C.lime, 'The palm. Tags and highlights.'],
  ['Surf', C.surf, 'The top wave. Links and focus on dark.'],
  ['Deep', C.deep, 'The lower wave.'],
  ['Coconut', C.coconut, 'Trunk, coconuts. Small accents only.'],
  ['Sand', C.sand, 'Neutral ground for sheets and stickers.'],
];

export const slug = (name) => name.toLowerCase().replace(/\s+/g, '-');
