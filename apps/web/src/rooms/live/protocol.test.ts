import { describe, expect, it } from 'vitest';
import { commitSeed, createServerSeed, rooms } from '@beach-bingo/engine';
import {
  ballsCalledAt,
  buildRoom,
  claimValid,
  CODE_ALPHABET,
  inviteLink,
  isCode,
  joinCodeFromHash,
  makeCode,
  normalizeCode,
  parseMessage,
  resolveClaims,
  rosterHash,
  sortRoster,
} from './protocol.ts';

describe('room codes', () => {
  it('makes five-character codes from the spoken-safe alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = makeCode();
      expect(code).toHaveLength(5);
      expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
      expect(isCode(code)).toBe(true);
    }
  });

  it('normalises what people type and rejects look-alikes', () => {
    expect(normalizeCode(' ab-cd3 ')).toBe('ABCD3');
    expect(normalizeCode('abcdefgh')).toBe('ABCDE');
    expect(isCode('ABCDO')).toBe(false);
    expect(isCode('ABCD')).toBe(false);
    expect(isCode('ABCD1')).toBe(false);
  });

  it('reads and writes invite links', () => {
    expect(inviteLink('KRT7W', 'https://beachbingo.xyz', '/app/')).toBe('https://beachbingo.xyz/app/#join=KRT7W');
    expect(joinCodeFromHash('#join=krt7w')).toBe('KRT7W');
    expect(joinCodeFromHash('#join=KRT7O')).toBeNull();
    expect(joinCodeFromHash('#other')).toBeNull();
    expect(joinCodeFromHash('')).toBeNull();
  });
});

describe('messages', () => {
  it('accepts well-formed messages and cleans names', () => {
    expect(parseMessage({ t: 'me', name: '  Ana\u0000 ', cards: 2 })).toEqual({ t: 'me', name: 'Ana', cards: 2 });
    expect(parseMessage({ t: 'me', name: '', cards: 0 })).toEqual({ t: 'me', name: 'Player', cards: 0 });
    const commitment = commitSeed(createServerSeed());
    expect(parseMessage({ t: 'room', preset: 'waveRush', round: 1, commitment, playing: false })).toEqual({
      t: 'room',
      preset: 'waveRush',
      round: 1,
      commitment,
      playing: false,
    });
    expect(parseMessage({ t: 'claim', round: 3, card: 0, ball: 12 })).toEqual({ t: 'claim', round: 3, card: 0, ball: 12 });
  });

  it('reads the room currency when it is one of the two, and rejects anything else', () => {
    const base = { t: 'room', preset: 'waveRush', round: 1, commitment: commitSeed(createServerSeed()), playing: false };
    const currencyOf = (currency: unknown) => {
      const msg = parseMessage({ ...base, currency });
      return msg?.t === 'room' ? (msg.currency ?? 'absent') : null;
    };
    expect(currencyOf(undefined)).toBe('absent'); // older builds: SAND
    expect(currencyOf('sand')).toBe('sand');
    expect(currencyOf('coins')).toBe('coins');
    expect(currencyOf('SOL')).toBeNull();
    expect(currencyOf(1)).toBeNull();
    expect(currencyOf(null)).toBeNull();
  });

  it('reads a stake of either kind and rejects a malformed one', () => {
    const base = { t: 'room', preset: 'waveRush', round: 1, commitment: commitSeed(createServerSeed()), playing: false };
    const stakeOf = (stake: unknown) => {
      const msg = parseMessage({ ...base, stake });
      return msg?.t === 'room' ? msg.stake : null;
    };
    const room = { lamports: '10000000', host: '2'.repeat(32), program: '3'.repeat(32), room: '4'.repeat(32) };
    expect(stakeOf(room)).toEqual({ kind: 'room', ...room }); // the first staked builds sent no kind
    expect(stakeOf({ kind: 'room', ...room })).toEqual({ kind: 'room', ...room });
    const hall = { kind: 'hall', ...room, stakePerCard: '10000000', maxPlayers: 6 };
    expect(stakeOf(hall)).toEqual(hall);
    expect(stakeOf({ kind: 'hall', ...room })).toBeNull();
    expect(stakeOf({ ...hall, maxPlayers: 9 })).toBeNull();
    expect(stakeOf({ ...hall, maxPlayers: 1 })).toBeNull();
    expect(stakeOf({ ...hall, stakePerCard: 12 })).toBeNull();
    expect(stakeOf({ ...room, kind: 'pool' })).toBeNull();
    expect(stakeOf({ ...room, lamports: '1e9' })).toBeNull();
  });

  it('reads a token stake by its mint and keeps a stake without one as SOL', () => {
    const base = { t: 'room', preset: 'waveRush', round: 1, commitment: commitSeed(createServerSeed()), playing: false };
    const stakeOf = (stake: unknown) => {
      const msg = parseMessage({ ...base, stake });
      return msg?.t === 'room' ? msg.stake : null;
    };
    const mint = 'GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz';
    const room = { kind: 'room', lamports: '50000000', host: '2'.repeat(32), program: '3'.repeat(32), room: '4'.repeat(32) };
    expect(stakeOf({ ...room, mint })).toEqual({ ...room, mint });
    expect(stakeOf(room)).not.toHaveProperty('mint'); // older builds: SOL
    const hall = { ...room, kind: 'hall', stakePerCard: '50000000', maxPlayers: 4, mint };
    expect(stakeOf(hall)).toEqual(hall);
    expect(stakeOf({ ...room, mint: 'not-an-address' })).toBeNull();
    expect(stakeOf({ ...room, mint: 0 })).toBeNull();
    expect(stakeOf({ ...room, mint: null })).toBeNull();
    expect(stakeOf({ ...room, mint: '0'.repeat(40) })).toBeNull(); // 0 is not in base58
  });

  it('rejects junk', () => {
    expect(parseMessage(null)).toBeNull();
    expect(parseMessage('me')).toBeNull();
    expect(parseMessage({ t: 'me', name: 'x', cards: 99 })).toBeNull();
    expect(parseMessage({ t: 'room', preset: 'lastCastle', round: 1, commitment: 'ab', playing: false })).toBeNull();
    expect(parseMessage({ t: 'start', round: 1, serverSeed: 'nope', startAt: 1, roster: [] })).toBeNull();
    expect(
      parseMessage({ t: 'start', round: 1, serverSeed: createServerSeed(), startAt: 1, roster: [{ id: 'a', cards: 1 }, { id: 'a', cards: 1 }] }),
    ).toBeNull();
    expect(parseMessage({ t: 'claim', round: 1, card: 9, ball: 1 })).toBeNull();
    expect(parseMessage({ t: 'nope' })).toBeNull();
  });
});

describe('the deterministic build', () => {
  const config = rooms.ROOM_PRESETS.sunsetHall;
  const seed = createServerSeed();
  const commitment = commitSeed(seed);
  const roster = sortRoster(
    [
      { id: 'zed', name: 'Zed', cards: 2 },
      { id: 'amy', name: 'Amy', cards: 1 },
      { id: 'kip', name: 'Kip', cards: 0 },
    ],
    config,
  );

  it('orders the roster by id and drops empty hands', () => {
    expect(roster.map((e) => e.id)).toEqual(['amy', 'zed']);
    expect(sortRoster([{ id: 'a', name: 'A', cards: 99 }], config)[0]!.cards).toBe(config.maxCardsPerPlayer);
  });

  it('gives two clients the same room from the same inputs', () => {
    const a = buildRoom(config, commitment, seed, roster);
    const b = buildRoom(config, commitment, seed, roster);
    expect(a.drum).toEqual(b.drum);
    expect(a.players.map((p) => p.cards.map((c) => c.cells))).toEqual(b.players.map((p) => p.cards.map((c) => c.cells)));
    expect(a.phase).toBe('drawing');
    expect(a.pool).toBe(Math.floor(3 * config.cardPrice * config.payoutRate));
    while (a.phase === 'drawing') rooms.drawNext(a);
    while (b.phase === 'drawing') rooms.drawNext(b);
    expect(a.wins).toEqual(b.wins);
  });

  it('changes the drum when the roster changes, so the host cannot pre-shape it', () => {
    const other = sortRoster([...roster, { id: 'new', name: 'New', cards: 1 }], config);
    expect(rosterHash(other)).not.toBe(rosterHash(roster));
    expect(buildRoom(config, commitment, seed, other).drum).not.toEqual(buildRoom(config, commitment, seed, roster).drum);
  });

  it('refuses rosters the hall cannot seat', () => {
    const duel = rooms.ROOM_PRESETS.riptideDuel;
    expect(() => buildRoom(duel, commitment, seed, [{ id: 'a', name: 'A', cards: 1 }])).toThrow(/need 2 players/);
    expect(() =>
      buildRoom(duel, commitment, seed, [
        { id: 'a', name: 'A', cards: 1 },
        { id: 'b', name: 'B', cards: 1 },
        { id: 'c', name: 'C', cards: 1 },
      ]),
    ).toThrow(/full/);
  });
});

describe('the shared clock', () => {
  it('calls ball n at startAt + (n − 1) × interval and never past the drum', () => {
    expect(ballsCalledAt(999, 1000, 100, 30)).toBe(0);
    expect(ballsCalledAt(1000, 1000, 100, 30)).toBe(1);
    expect(ballsCalledAt(1099, 1000, 100, 30)).toBe(1);
    expect(ballsCalledAt(1250, 1000, 100, 30)).toBe(3);
    expect(ballsCalledAt(1_000_000, 1000, 100, 30)).toBe(30);
  });
});

describe('duel claims', () => {
  const config = rooms.ROOM_PRESETS.riptideDuel;
  const seed = createServerSeed();
  const room = buildRoom(config, commitSeed(seed), seed, [
    { id: 'a', name: 'A', cards: 1 },
    { id: 'b', name: 'B', cards: 1 },
  ]);
  // The first ball count at which A's card has a line.
  let winBall = 0;
  for (let n = 1; n <= room.drum.length && !winBall; n++) if (claimValid(room, 'a', 0, n)) winBall = n;

  it('verifies a claim against the drum, not against the claimant', () => {
    expect(winBall).toBeGreaterThan(3);
    expect(claimValid(room, 'a', 0, winBall)).toBe(true);
    expect(claimValid(room, 'a', 0, winBall - 1)).toBe(false);
    expect(claimValid(room, 'a', 0, winBall + 5)).toBe(true);
    expect(claimValid(room, 'a', 1, winBall)).toBe(false);
    expect(claimValid(room, 'nobody', 0, winBall)).toBe(false);
    expect(claimValid(room, 'a', 0, 0)).toBe(false);
    expect(claimValid(room, 'a', 0, 76)).toBe(false);
  });

  it('awards the earliest shout and shares a tie', () => {
    expect(
      resolveClaims([
        { peerId: 'a', card: 0, ball: 12 },
        { peerId: 'b', card: 0, ball: 11 },
      ]),
    ).toEqual([{ peerId: 'b', card: 0, ball: 11 }]);
    expect(
      resolveClaims([
        { peerId: 'a', card: 0, ball: 11 },
        { peerId: 'b', card: 0, ball: 11 },
        { peerId: 'a', card: 0, ball: 11 },
      ]),
    ).toEqual([
      { peerId: 'a', card: 0, ball: 11 },
      { peerId: 'b', card: 0, ball: 11 },
    ]);
    expect(resolveClaims([])).toEqual([]);
  });
});
