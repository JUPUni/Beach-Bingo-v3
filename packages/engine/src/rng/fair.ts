import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Source of uniform randomness used by every game mode.
 *
 * Money-bearing rounds must use {@link FairRng}; cosmetic effects and bot
 * behaviour may use {@link mathRng}; Monte-Carlo simulations use {@link fastRng}.
 */
export interface Rng {
  /** Uniform integer in `[0, n)`. `n` must be a positive safe integer ≤ 2^32. */
  int(n: number): number;
  /** Uniform float in `[0, 1)` with 53 bits of precision. */
  float(): number;
}

/**
 * Inputs of a provably-fair round.
 *
 * Protocol (commit → play → reveal):
 * 1. The server generates `serverSeed` and publishes `commitSeed(serverSeed)` *before* the round.
 * 2. The player (or, for rooms, a public beacon such as a future Solana blockhash) supplies `clientSeed`.
 * 3. Every random decision is derived from HMAC-SHA256(serverSeed, JSON([clientSeed, nonce, domain, counter])).
 * 4. After the round the server reveals `serverSeed`; anyone can recompute the round with {@link FairRng}.
 */
export interface FairSeed {
  /** 32-byte secret, lowercase hex (64 chars). */
  serverSeed: string;
  /** Player- or beacon-supplied entropy. Any string. */
  clientSeed: string;
  /** Round counter for this server seed (0, 1, 2, …). */
  nonce: number;
}

const HEX_64 = /^[0-9a-f]{64}$/;

export function createServerSeed(): string {
  return bytesToHex(randomBytes(32));
}

export function createClientSeed(): string {
  return bytesToHex(randomBytes(16));
}

/** Public commitment to a server seed: SHA-256 of the seed bytes, hex. */
export function commitSeed(serverSeed: string): string {
  assertServerSeed(serverSeed);
  return bytesToHex(sha256(hexToBytes(serverSeed)));
}

export function verifyCommitment(serverSeed: string, commitment: string): boolean {
  return HEX_64.test(serverSeed) && commitSeed(serverSeed) === commitment.toLowerCase();
}

function assertServerSeed(serverSeed: string): void {
  if (!HEX_64.test(serverSeed)) {
    throw new Error('serverSeed must be 32 bytes of lowercase hex');
  }
}

const TWO_32 = 0x1_0000_0000;

/**
 * Deterministic, verifiable random stream. Each `domain` ("draw", "card:0", "reel", …)
 * is an independent stream, so adding a new kind of decision never shifts existing ones.
 */
export class FairRng implements Rng {
  private readonly key: Uint8Array;
  private readonly prefix: [string, number, string];
  private block: Uint8Array = new Uint8Array(0);
  private offset = 32;
  private counter = 0;

  constructor(seed: FairSeed, domain: string) {
    assertServerSeed(seed.serverSeed);
    if (!Number.isSafeInteger(seed.nonce) || seed.nonce < 0) {
      throw new Error('nonce must be a non-negative safe integer');
    }
    this.key = hexToBytes(seed.serverSeed);
    this.prefix = [seed.clientSeed, seed.nonce, domain];
  }

  /** Raw 32-byte block `counter` of this stream (exposed for independent verifiers). */
  static block(seed: FairSeed, domain: string, counter: number): Uint8Array {
    const message = JSON.stringify([seed.clientSeed, seed.nonce, domain, counter]);
    return hmac(sha256, hexToBytes(seed.serverSeed), utf8ToBytes(message));
  }

  uint32(): number {
    if (this.offset + 4 > 32) {
      const message = JSON.stringify([...this.prefix, this.counter++]);
      this.block = hmac(sha256, this.key, utf8ToBytes(message));
      this.offset = 0;
    }
    const b = this.block;
    const o = this.offset;
    this.offset += 4;
    return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
  }

  int(n: number): number {
    return uniformInt(() => this.uint32(), n);
  }

  float(): number {
    return toFloat53(this.uint32(), this.uint32());
  }
}

/** Rejection sampling: unbiased integer in [0, n) from a uint32 source. */
function uniformInt(next: () => number, n: number): number {
  if (!Number.isInteger(n) || n <= 0 || n > TWO_32) {
    throw new Error(`int(n) requires 0 < n ≤ 2^32, got ${n}`);
  }
  if (n === 1) return 0;
  const limit = TWO_32 - (TWO_32 % n);
  for (;;) {
    const x = next();
    if (x < limit) return x % n;
  }
}

function toFloat53(hi: number, lo: number): number {
  return ((hi >>> 5) * 67108864 + (lo >>> 6)) / 9007199254740992;
}

/** Non-verifiable RNG for cosmetics and bots. Never use for money-bearing outcomes. */
export const mathRng: Rng = {
  int: (n) => uniformInt(() => Math.floor(Math.random() * TWO_32), n),
  float: () => Math.random(),
};

/**
 * Fast seeded PRNG (sfc32) for Monte-Carlo RTP simulations and tests.
 * Statistically solid, not cryptographic.
 */
export function fastRng(seed: number | string): Rng & { uint32(): number } {
  let h = 1779033703 ^ 0;
  const text = String(seed);
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  const mix = () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return (h ^= h >>> 16) >>> 0;
  };
  let a = mix();
  let b = mix();
  let c = mix();
  let d = mix();
  const uint32 = () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) uint32();
  return {
    uint32,
    int: (n) => uniformInt(uint32, n),
    float: () => toFloat53(uint32(), uint32()),
  };
}

/** Unbiased Fisher–Yates shuffle (returns a new array). */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** `k` distinct items chosen uniformly at random (partial Fisher–Yates), in draw order. */
export function sample<T>(items: readonly T[], k: number, rng: Rng): T[] {
  if (k > items.length) throw new Error(`cannot sample ${k} of ${items.length}`);
  const pool = items.slice();
  for (let i = 0; i < k; i++) {
    const j = i + rng.int(pool.length - i);
    const tmp = pool[i]!;
    pool[i] = pool[j]!;
    pool[j] = tmp;
  }
  return pool.slice(0, k);
}

export function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/** Weighted pick: returns the index of the chosen weight. Weights must be non-negative integers. */
export function weightedIndex(weights: readonly number[], rng: Rng): number {
  let total = 0;
  for (const w of weights) total += w;
  let roll = rng.int(total);
  for (let i = 0; i < weights.length; i++) {
    roll -= weights[i]!;
    if (roll < 0) return i;
  }
  return weights.length - 1;
}
