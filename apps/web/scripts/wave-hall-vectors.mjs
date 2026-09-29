#!/usr/bin/env node
// Test vectors for the wave_duel program's halls: the engine's own answer for a staked Wave Rush
// hall of 2..8 players holding 1..4 cards each. The roster is in join order (host first) and the
// engine numbers the cards in that order (buyCards, one roster entry after another), which is the
// numbering the program uses when it rebuilds every card. The client seed is the escrow's
// entropy as hex. The Rust program must reproduce every field bit for bit. Run with the engine's
// tsx:
//
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-hall-vectors.mjs > programs/wave_duel/tests/vectors/halls.json
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { commitSeed, rooms } from '../../../packages/engine/src/index.ts';
import { buildRoom } from '../src/rooms/live/protocol.ts';

const N = Number(process.argv[2] || 32);
const MAX_PLAYERS = 8;
const MAX_CARDS = rooms.ROOM_PRESETS.waveRush.maxCardsPerPlayer; // 4

/** Cards per player for vector `i`: the two extremes first, then every table size, filled at random. */
function rosterFor(i) {
  if (i === 0) return Array(MAX_PLAYERS).fill(MAX_CARDS); // the program's worst case: 32 cards
  if (i === 1) return [1, 1]; // the 1v1 room, seen as a hall
  const players = 2 + ((i - 2) % (MAX_PLAYERS - 1));
  return Array.from({ length: players }, () => randomInt(1, MAX_CARDS + 1));
}

const out = [];
for (let i = 0; i < N; i++) {
  const serverSeed = randomBytes(32).toString('hex');
  const entropy = randomBytes(32).toString('hex');
  const counts = rosterFor(i);
  const roster = counts.map((cards, p) => ({ id: `p${p}`, name: p === 0 ? 'Host' : `Guest ${p}`, cards }));
  const room = buildRoom(rooms.ROOM_PRESETS.waveRush, commitSeed(serverSeed), serverSeed, roster, entropy);
  while (room.phase === 'drawing') rooms.drawNext(room);
  const win = room.wins[0];
  // Cards in card order: each player's block follows the previous player's, as the program assumes.
  const cards = [];
  for (const player of room.players) {
    player.cards.forEach((card, k) => {
      if (player.cardNumbers[k] !== cards.length) throw new Error('card numbering is not roster order');
      cards.push(card.cells);
    });
  }
  const index = new Map(room.players.map((p, at) => [p.id, at]));
  const winners = win.winners.map((w) => room.players[index.get(w.playerId)].cardNumbers[w.card]).sort((a, b) => a - b);
  const shares = counts.map(() => 0);
  for (const w of win.winners) shares[index.get(w.playerId)] += 1;
  out.push({
    serverSeed,
    commitment: createHash('sha256').update(Buffer.from(serverSeed, 'hex')).digest('hex'),
    clientSeed: entropy,
    roster: counts,
    cards,
    drum: room.drum,
    winBall: win.ballCount,
    winners,
    shares,
  });
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
