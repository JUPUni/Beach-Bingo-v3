import { describe, expect, it } from 'vitest';
import { FairRng, adventure, commitSeed, createServerSeed, fastRng, generateCard, rooms, type Rng } from '../src/index.ts';

const { ROOM_PRESETS, createRoom, joinRoom, buyCards, startDrawing, drawNext, settleRoom, claimBingo, completedCards, closeClaims } =
  rooms;

function fairCards(serverSeed: string, nonce: number): (i: number) => Rng {
  return (i) => new FairRng({ serverSeed, clientSeed: 'cards', nonce }, `card:${i}`);
}

describe('multiplayer rooms', () => {
  it('runs a 75-ball auto-daub room to settlement with a consistent ledger', () => {
    const serverSeed = createServerSeed();
    const room = createRoom(ROOM_PRESETS.sunsetHall, commitSeed(serverSeed), 5_000);
    for (let p = 0; p < 12; p++) {
      joinRoom(room, { id: `p${p}`, name: `Player ${p}`, bot: p > 0 });
      buyCards(room, `p${p}`, 1 + (p % 6), fairCards(serverSeed, 1));
    }
    startDrawing(room, new FairRng({ serverSeed, clientSeed: 'beacon:slot-123', nonce: 1 }, 'draw'));
    expect(room.pool).toBe(Math.floor(room.cardsSold * 25 * 0.85));

    const stagesSeen: string[] = [];
    while (room.phase === 'drawing') {
      const event = drawNext(room);
      for (const win of event.stageWins) stagesSeen.push(win.patternId);
    }
    expect(stagesSeen).toEqual(['line', 'twoLines', 'blackout']);

    const settlement = settleRoom(room);
    const paid = Object.values(settlement.payouts).reduce((s, x) => s + x, 0);
    expect(paid - settlement.jackpotPaid).toBeLessThanOrEqual(room.pool);
    expect(settlement.unawarded).toBeGreaterThanOrEqual(0);
    expect(settlement.sales).toBe(settlement.pool + settlement.rake + settlement.jackpotContribution);
    if (room.wins.at(-1)!.ballCount <= 48) expect(settlement.jackpotPaid).toBeGreaterThan(0);
    else expect(settlement.jackpotPaid).toBe(0);

    // Anyone can recompute every card from the revealed seed.
    for (const player of room.players) {
      player.cards.forEach((card, i) => {
        expect(generateCard('75', fairCards(serverSeed, 1)(player.cardNumbers[i]!)).cells).toEqual(card.cells);
      });
    }
  });

  it('runs a 90-ball room: one line, two lines, full house', () => {
    const rng = fastRng('pier');
    const room = createRoom(ROOM_PRESETS.pierHall, 'commit');
    for (let p = 0; p < 5; p++) {
      joinRoom(room, { id: `p${p}`, name: `P${p}` });
      buyCards(room, `p${p}`, 6, () => rng);
    }
    startDrawing(room, rng);
    while (room.phase === 'drawing') drawNext(room);
    expect(room.wins.map((w) => w.patternId)).toEqual(['oneLine', 'twoLines', 'fullHouse']);
    const lastBall = room.wins.map((w) => w.ballCount);
    expect([...lastBall].sort((a, b) => a - b)).toEqual(lastBall);
  });

  it('enforces card limits, bot policy and minimum players', () => {
    const rng = fastRng('limits');
    const room = createRoom({ ...ROOM_PRESETS.waveRush, allowBots: false }, 'c');
    expect(() => joinRoom(room, { id: 'b', name: 'Bot', bot: true })).toThrow();
    joinRoom(room, { id: 'a', name: 'A' });
    expect(() => buyCards(room, 'a', 5, () => rng)).toThrow();
    buyCards(room, 'a', 4, () => rng);
    expect(() => startDrawing(room, rng)).toThrow();
  });

  it('duels require claims, lock out false claims and split same-ball ties', () => {
    const rng = fastRng('duel');
    const room = createRoom(ROOM_PRESETS.riptideDuel, 'c');
    joinRoom(room, { id: 'a', name: 'A' });
    joinRoom(room, { id: 'b', name: 'B' });
    expect(() => joinRoom(room, { id: 'c', name: 'C' })).toThrow();
    buyCards(room, 'a', 1, () => rng);
    buyCards(room, 'b', 1, () => rng);
    startDrawing(room, rng);

    drawNext(room);
    const early = claimBingo(room, 'a', 0);
    expect(early).toEqual({ ok: false, reason: 'no-pattern' });
    expect(claimBingo(room, 'a', 0)).toEqual({ ok: false, reason: 'locked' });

    // Nobody auto-wins: keep drawing until someone's card completes a line.
    while (room.phase === 'drawing' && completedCards(room).length === 0) drawNext(room);
    const completed = completedCards(room);
    for (const w of completed) {
      if (w.playerId === 'a' && room.drawn.length < room.players[0]!.lockedUntilBall) continue;
      expect(claimBingo(room, w.playerId, w.card).ok).toBe(true);
    }
    const win = closeClaims(room);
    if (win) {
      expect(room.phase).toBe('finished');
      const settlement = settleRoom(room);
      expect(Object.values(settlement.payouts).reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(95);
    }
  });
});

describe('Beach Adventure levels', () => {
  const { LEVELS, ZONES, startLevel, callBall, daub, claimBingo: claim, starsFor, coinsFor, levelWinRate, bingoCards, crabPinch } =
    adventure;

  it('defines 40 levels over 4 zones with sane star thresholds', () => {
    expect(LEVELS).toHaveLength(40);
    expect(ZONES).toHaveLength(4);
    for (const level of LEVELS) {
      expect(level.stars[0]).toBeLessThanOrEqual(level.stars[1]);
      expect(level.stars[1]).toBeLessThanOrEqual(75);
      expect(level.maxBalls).toBeLessThanOrEqual(75);
      expect(level.callMs).toBeGreaterThanOrEqual(1600);
    }
  });

  it('difficulty curve: early levels are easy, the finale is hard', () => {
    const rng = fastRng('curve');
    expect(levelWinRate(LEVELS[0]!, rng, 1500)).toBeGreaterThan(0.9);
    const mid = levelWinRate(LEVELS[19]!, rng, 1500);
    expect(mid).toBeGreaterThan(0.72);
    expect(mid).toBeLessThan(0.9);
    const finale = levelWinRate(LEVELS[39]!, rng, 1500);
    expect(finale).toBeGreaterThan(0.5);
    expect(finale).toBeLessThan(0.7);
  });

  it('only called numbers can be daubed; false claims cost points', () => {
    const run = startLevel(LEVELS[0]!, fastRng('manual'));
    const card = run.cards[0]!;
    const uncalledCell = card.cells.findIndex((n) => n > 0);
    expect(daub(run, 0, uncalledCell)).toBe(false);
    expect(claim(run)).toBe(false);
    expect(run.falseClaims).toBe(1);

    while (run.status === 'playing') {
      const ball = callBall(run);
      if (ball === null) break;
      const cell = card.cells.indexOf(ball);
      if (cell >= 0) expect(daub(run, 0, cell, 500)).toBe(true);
      if (bingoCards(run).length) expect(claim(run)).toBe(true);
    }
    if (run.status === 'won') {
      expect(starsFor(run)).toBeGreaterThanOrEqual(1);
      expect(coinsFor(run)).toBe(LEVELS[0]!.reward * starsFor(run));
      expect(run.score).toBeGreaterThan(1000);
    }
  });

  it('crab pinch daubs any numbered square', () => {
    const run = startLevel(LEVELS[3]!, fastRng('crab'));
    expect(crabPinch(run, 0, 0)).toBe(true);
    expect(crabPinch(run, 0, 0)).toBe(false);
    expect(crabPinch(run, 0, 12)).toBe(false);
  });
});
