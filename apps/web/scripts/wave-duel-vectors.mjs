#!/usr/bin/env node
// Test vectors for the wave_duel program: the engine's own answer for a staked 1v1 Wave Rush
// round (host card 0, guest card 1, one card each, client seed = the escrow's entropy as hex).
// The Rust program must reproduce every field bit for bit. Run with the engine's tsx:
//
//   pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-vectors.mjs > programs/wave_duel/tests/vectors/rounds.json
import { createHash, randomBytes } from 'node:crypto';
import { commitSeed, rooms } from '../../../packages/engine/src/index.ts';
import { buildRoom } from '../src/rooms/live/protocol.ts';

const N = Number(process.argv[2] || 32);
const out = [];
for (let i = 0; i < N; i++) {
  const serverSeed = randomBytes(32).toString('hex');
  const entropy = randomBytes(32).toString('hex');
  const host = `host-${i}`;
  const guest = `guest-${i}`;
  const room = buildRoom(
    rooms.ROOM_PRESETS.waveRush,
    commitSeed(serverSeed),
    serverSeed,
    [
      { id: host, name: 'Host', cards: 1 },
      { id: guest, name: 'Guest', cards: 1 },
    ],
    entropy,
  );
  while (room.phase === 'drawing') rooms.drawNext(room);
  const win = room.wins[0];
  out.push({
    serverSeed,
    commitment: createHash('sha256').update(Buffer.from(serverSeed, 'hex')).digest('hex'),
    clientSeed: entropy,
    hostCard: room.players[0].cards[0].cells,
    guestCard: room.players[1].cards[0].cells,
    drum: room.drum,
    winBall: win.ballCount,
    winners: win.winners.map((w) => (w.playerId === host ? 0 : 1)),
  });
}
process.stdout.write(JSON.stringify(out, null, 1) + '\n');
