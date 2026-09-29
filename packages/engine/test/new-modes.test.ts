import { describe, expect, it } from 'vitest';
import { LINE_TABLE, blitz, crabDig, fastRng, royale, rooms, tidePool } from '../src/index.ts';

function choose(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return Math.round(r);
}

describe('line table', () => {
  it('each row sums to C(24, k) and matches known small cases', () => {
    LINE_TABLE.forEach((row, k) => expect(row.reduce((s, x) => s + x, 0)).toBe(choose(24, k)));
    // 4 marks complete a line only via the 4 lines through the free centre.
    expect(LINE_TABLE[4]![1]).toBe(4);
    // All 24 marked = all 12 lines.
    expect(LINE_TABLE[24]![12]).toBe(1);
  });
});

describe('Tide Pool', () => {
  it('exact RTPs sit just under 97%', () => {
    expect(tidePool.tideRtp('calm')).toBeCloseTo(0.9707, 3);
    expect(tidePool.tideRtp('choppy')).toBeCloseTo(0.9695, 3);
    expect(tidePool.tideRtp('storm')).toBeCloseTo(0.971, 3);
    expect(tidePool.tideHitRate('calm')).toBeCloseTo(0.272, 2);
  });

  it('simulated line frequencies match the exact distribution', () => {
    const rng = fastRng('tide');
    const exact = tidePool.lineDistribution(30);
    const counts = new Array<number>(13).fill(0);
    const rounds = 60_000;
    for (let i = 0; i < rounds; i++) {
      const cards = tidePool.dealTideCards(1, rng);
      counts[tidePool.playTidePool(cards, 'choppy', 100, rng).cards[0]!.lines]!++;
    }
    expect(counts[0]! / rounds).toBeCloseTo(exact[0]!, 2);
    expect(counts[1]! / rounds).toBeCloseTo(exact[1]!, 2);
  });

  it('pays each card by its lines', () => {
    const rng = fastRng('tide-pay');
    const cards = tidePool.dealTideCards(4, rng);
    const result = tidePool.playTidePool(cards, 'calm', 250, rng);
    expect(result.drawn).toHaveLength(35);
    expect(result.stake).toBe(1000);
    for (const card of result.cards) {
      expect(card.payout).toBe(Math.floor(250 * tidePool.TIDE_SEAS.calm.pays[card.lines]! + 1e-9));
    }
  });
});

describe('Crab Dig', () => {
  it('ladder returns 97% for every stopping point', () => {
    for (const crabs of [1, 3, 5, 8, 12]) {
      for (let n = 1; n <= 24 - crabs; n++) {
        const m = crabDig.digMultiplier(crabs, n);
        const rtp = crabDig.digSurvival(crabs, n) * m;
        expect(rtp).toBeLessThanOrEqual(0.97 + 1e-9);
        if (m < crabDig.DIG_MAX_MULTIPLIER) expect(rtp).toBeGreaterThan(0.955);
      }
    }
    expect(crabDig.digMultiplier(3, 1)).toBe(1.1);
    expect(crabDig.digMultiplier(5, 5)).toBeCloseTo(3.55, 1);
  });

  it('plays a round: dig, bite or cash out', () => {
    const rng = fastRng('dig');
    const round = crabDig.startDig(3, 100, rng);
    expect(round.crabCells).toHaveLength(3);
    expect(() => crabDig.cashOutDig(round)).toThrow();
    const safe = [...Array(25).keys()].find((i) => i !== 12 && !round.crabCells.includes(i))!;
    expect(crabDig.dig(round, safe).crab).toBe(false);
    expect(() => crabDig.dig(round, safe)).toThrow();
    expect(crabDig.cashOutDig(round)).toBe(Math.floor(100 * crabDig.digMultiplier(3, 1) + 1e-9));
    const bite = crabDig.startDig(20, 100, rng);
    expect(crabDig.dig(bite, bite.crabCells[0]!).crab).toBe(true);
    expect(bite.status).toBe('bitten');
  });
});

describe('Beach Ball Blitz', () => {
  it('multipliers are the inverse of the completion probability', () => {
    // 0.97 / (C(28,9)/C(30,9)) = 2.0093…, floored to 2 decimals.
    expect(blitz.blitzMultiplier(28)).toBe(2);
    expect(blitz.blitzMultiplier(20)).toBeCloseTo(82.6, 0);
    for (const t of blitz.BLITZ_TARGETS) {
      expect(blitz.blitzProbability(t) * blitz.blitzMultiplier(t)).toBeLessThanOrEqual(0.97 + 1e-9);
    }
  });

  it('simulated win rate for T=24 matches C(24,9)/C(30,9)', () => {
    const rng = fastRng('blitz');
    let wins = 0;
    const rounds = 40_000;
    for (let i = 0; i < rounds; i++) if (blitz.playBlitz(24, 100, rng, rng).won) wins++;
    expect(wins / rounds).toBeCloseTo(blitz.blitzProbability(24), 2);
  });
});

describe('Last Castle Standing', () => {
  it('halves the field each wave down to one champion and pays places', () => {
    const rng = fastRng('royale');
    const entrants = Array.from({ length: 64 }, (_, i) => ({ id: `p${i}`, name: `P${i}` }));
    const state = royale.createRoyale(entrants, 200, rng, rng);
    const sizes: number[] = [];
    while (!state.finished) sizes.push(royale.playWave(state).survivors.length);
    expect(sizes).toEqual([32, 16, 8, 4, 2, 1]);
    expect(state.drawn).toHaveLength(30);
    const payouts = royale.royalePayouts(state);
    expect(Object.keys(payouts)).toHaveLength(8);
    const total = Object.values(payouts).reduce((s, x) => s + x, 0);
    expect(total).toBeLessThanOrEqual(royale.royalePool(state));
    expect(total).toBeGreaterThan(royale.royalePool(state) - 10);
    const champion = state.players.find((p) => p.place === 1)!;
    expect(payouts[champion.id]).toBe(Math.floor(royale.royalePool(state) * 0.4));
  });

  it('small lobbies redistribute unfilled places', () => {
    const rng = fastRng('royale-small');
    const state = royale.createRoyale([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], 100, rng, rng);
    while (!state.finished) royale.playWave(state);
    const total = Object.values(royale.royalePayouts(state)).reduce((s, x) => s + x, 0);
    expect(total).toBeGreaterThan(royale.royalePool(state) - 3);
  });
});

describe('Sunset Jackpot threshold', () => {
  it('rises daily until won, capped', () => {
    expect(rooms.sunsetJackpotCalls(0)).toBe(40);
    expect(rooms.sunsetJackpotCalls(7)).toBe(47);
    expect(rooms.sunsetJackpotCalls(100)).toBe(70);
  });
});
