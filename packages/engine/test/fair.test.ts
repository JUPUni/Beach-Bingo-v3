import { createHmac, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FairRng,
  commitSeed,
  createServerSeed,
  fastRng,
  range,
  sample,
  sha256Hex,
  shuffle,
  verifyCommitment,
  weightedIndex,
} from '../src/index.ts';

const SEED = { serverSeed: 'a1'.repeat(32), clientSeed: 'beach:player-7', nonce: 3 };

describe('provably fair RNG', () => {
  it('commits to the server seed with SHA-256 of its bytes', () => {
    const expected = createHash('sha256').update(Buffer.from(SEED.serverSeed, 'hex')).digest('hex');
    expect(commitSeed(SEED.serverSeed)).toBe(expected);
    expect(verifyCommitment(SEED.serverSeed, expected)).toBe(true);
    expect(verifyCommitment('b2'.repeat(32), expected)).toBe(false);
  });

  it('hashes text with SHA-256 for public inputs such as a live room roster', () => {
    const text = 'peer-a:2\npeer-b:1';
    expect(sha256Hex(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'));
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('rejects malformed server seeds', () => {
    expect(() => commitSeed('xyz')).toThrow();
    expect(() => new FairRng({ ...SEED, serverSeed: 'AB'.repeat(32) }, 'draw')).toThrow();
    expect(() => new FairRng({ ...SEED, nonce: -1 }, 'draw')).toThrow();
  });

  it('derives blocks exactly as documented (independent HMAC implementation)', () => {
    for (const counter of [0, 1, 7]) {
      const message = JSON.stringify([SEED.clientSeed, SEED.nonce, 'draw', counter]);
      const expected = createHmac('sha256', Buffer.from(SEED.serverSeed, 'hex')).update(message, 'utf8').digest();
      expect(Buffer.from(FairRng.block(SEED, 'draw', counter))).toEqual(expected);
    }
    // First uint32 of the stream = first 4 bytes of block 0, big-endian.
    const block0 = FairRng.block(SEED, 'draw', 0);
    expect(new FairRng(SEED, 'draw').uint32()).toBe(Buffer.from(block0).readUInt32BE(0));
  });

  it('is deterministic per (seed, domain) and independent across domains', () => {
    const a = shuffle(range(1, 75), new FairRng(SEED, 'draw'));
    const b = shuffle(range(1, 75), new FairRng(SEED, 'draw'));
    const c = shuffle(range(1, 75), new FairRng(SEED, 'card:0'));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect([...a].sort((x, y) => x - y)).toEqual(range(1, 75));
  });

  it('produces unbiased integers', () => {
    const rng = new FairRng({ ...SEED, serverSeed: createServerSeed() }, 'bias');
    const buckets = new Array<number>(6).fill(0);
    const n = 60_000;
    for (let i = 0; i < n; i++) buckets[rng.int(6)]!++;
    // Chi-square with 5 d.o.f.; 20.5 is the 99.9th percentile.
    const chi = buckets.reduce((s, x) => s + (x - n / 6) ** 2 / (n / 6), 0);
    expect(chi).toBeLessThan(20.5);
  });

  it('floats are in [0, 1)', () => {
    const rng = new FairRng(SEED, 'floats');
    for (let i = 0; i < 1000; i++) {
      const f = rng.float();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
    }
  });

  it('sample returns distinct items and weightedIndex respects weights', () => {
    const rng = fastRng('sample');
    const s = sample(range(1, 40), 10, rng);
    expect(new Set(s).size).toBe(10);
    const counts = [0, 0, 0];
    for (let i = 0; i < 30_000; i++) counts[weightedIndex([1, 2, 7], rng)]!++;
    expect(counts[2]! / 30_000).toBeCloseTo(0.7, 1);
    expect(counts[0]! / 30_000).toBeCloseTo(0.1, 1);
  });
});
