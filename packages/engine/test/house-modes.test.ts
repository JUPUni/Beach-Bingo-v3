import { describe, expect, it } from 'vitest';
import { applyMultiplier, fastRng, keno, parseAmount, riptide, shellSpin, videoBingo, CURRENCIES } from '../src/index.ts';

describe('money', () => {
  it('applies multipliers exactly, rounding down', () => {
    expect(applyMultiplier(100, 1.15)).toBe(115);
    expect(applyMultiplier(3, 0.5)).toBe(1);
    expect(applyMultiplier(9_000_000_000_000, 10_000)).toBe(90_000_000_000_000_000);
    expect(parseAmount('1.5', CURRENCIES.SOL)).toBe(1_500_000_000);
    expect(() => parseAmount('0.0000001', CURRENCIES.USDC)).toThrow();
  });
});

describe('Riptide cash-out', () => {
  const { RIPTIDE_LEVELS, cashoutLadder, riptideStrategyRtp, startRiptide, drawRiptide, cashOutRiptide, SHARK } = riptide;

  it('ladder is increasing and every stopping strategy returns ≈ RTP (≤ target)', () => {
    for (const config of Object.values(RIPTIDE_LEVELS)) {
      const ladder = cashoutLadder(config);
      expect(ladder[0]).toBe(0);
      for (let h = 2; h <= 24; h++) expect(ladder[h]!).toBeGreaterThanOrEqual(ladder[h - 1]!);
      for (let h = 1; h <= 24; h++) {
        const rtp = riptideStrategyRtp(h, config);
        expect(rtp).toBeLessThanOrEqual(config.rtp + 1e-9);
        if (ladder[h]! < config.maxMultiplier) expect(rtp).toBeGreaterThan(config.rtp - 0.01);
      }
    }
    expect(cashoutLadder(RIPTIDE_LEVELS.calm)[1]).toBe(1.05);
  });

  it('simulated "cash out at 6 hits" matches the analytic RTP', () => {
    const rng = fastRng('riptide-sim');
    const config = RIPTIDE_LEVELS.choppy;
    let paid = 0;
    const rounds = 40_000;
    for (let i = 0; i < rounds; i++) {
      const round = startRiptide(config, 100, rng, rng, 6);
      while (round.status === 'running') drawRiptide(round);
      paid += round.payout;
    }
    expect(paid / (rounds * 100)).toBeCloseTo(riptideStrategyRtp(6, config), 1);
  });

  it('busts on a shark, blocks empty cash-outs, auto-settles blackout', () => {
    const rng = fastRng('riptide-flow');
    const round = startRiptide(RIPTIDE_LEVELS.storm, 1000, rng, rng);
    expect(() => cashOutRiptide(round)).toThrow();
    expect(round.drum.filter((b) => b === SHARK)).toHaveLength(8);
    let event;
    do event = drawRiptide(round);
    while (event.status === 'running');
    if (event.isShark) expect(round.payout).toBe(0);
    else expect(round.payout).toBeGreaterThan(0);
  });
});

describe('Keno Cove', () => {
  const { kenoProbability, KENO_PAYTABLES, kenoRtp, playKeno, KENO_RTP, KENO_MAX_MULTIPLIER } = keno;

  it('hypergeometric probabilities sum to 1', () => {
    for (let picks = 1; picks <= 10; picks++) {
      let total = 0;
      for (let k = 0; k <= picks; k++) total += kenoProbability(picks, k);
      expect(total).toBeCloseTo(1, 12);
    }
  });

  it('every paytable returns just under the target RTP, monotone, capped', () => {
    for (const risk of ['low', 'medium', 'high'] as const) {
      for (let picks = 1; picks <= 10; picks++) {
        const table = KENO_PAYTABLES[risk][picks]!;
        const rtp = kenoRtp(table, picks);
        expect(rtp).toBeLessThanOrEqual(KENO_RTP + 1e-9);
        expect(rtp).toBeGreaterThan(KENO_RTP - 0.006);
        for (let k = 1; k < table.length; k++) expect(table[k]!).toBeGreaterThanOrEqual(table[k - 1]!);
        expect(Math.max(...table)).toBeLessThanOrEqual(KENO_MAX_MULTIPLIER);
      }
    }
  });

  it('plays a round and validates picks', () => {
    const result = playKeno([1, 2, 3, 4, 5], 'medium', 100, fastRng('keno'));
    expect(result.drawn).toHaveLength(10);
    expect(result.payout).toBe(Math.floor(100 * result.multiplier + 1e-9));
    expect(() => playKeno([1, 1], 'low', 100, fastRng('x'))).toThrow();
    expect(() => playKeno([41], 'low', 100, fastRng('x'))).toThrow();
  });
});

describe('Tiki Video Bingo', () => {
  const { videoBaseRtp, startVideoBingo, videoWinnings, extraBallOffer, buyExtraBall, settleVideoBingo, EXTRA_BALL_RTP } =
    videoBingo;

  it('exact base-game RTP is ≈92.3%', () => {
    expect(videoBaseRtp()).toBeGreaterThan(0.92);
    expect(videoBaseRtp()).toBeLessThan(0.925);
  });

  it('simulation agrees with the exact RTP for the frequent patterns', () => {
    // Everything except the three rarest patterns, whose variance swamps a unit-test sample.
    const rng = fastRng('video-sim');
    let paid = 0;
    const rounds = 60_000;
    for (let i = 0; i < rounds; i++) {
      const round = startVideoBingo(100, 1, rng, rng);
      const win = videoWinnings(round);
      paid += win >= 100 * 60 ? 0 : win;
    }
    let exactFrequent = 0;
    const full = videoBaseRtp();
    // RTP excluding patterns paying ≥60× equals the full exact RTP minus their contribution;
    // computed by zeroing those multipliers.
    const saved = videoBingo.VIDEO_PATTERNS.map((p) => p.multiplier);
    for (const p of videoBingo.VIDEO_PATTERNS) if (p.multiplier >= 60) (p as { multiplier: number }).multiplier = 0;
    exactFrequent = videoBaseRtp();
    videoBingo.VIDEO_PATTERNS.forEach((p, i) => ((p as { multiplier: number }).multiplier = saved[i]!));
    expect(videoBaseRtp()).toBe(full);
    expect(paid / (rounds * 100)).toBeCloseTo(exactFrequent, 1);
  });

  it('prices extra balls at EV ÷ RTP and reveals the committed drum in order', () => {
    const rng = fastRng('extra');
    let checked = 0;
    for (let i = 0; i < 200 && checked < 20; i++) {
      const round = startVideoBingo(1000, 4, rng, rng);
      const offer = extraBallOffer(round);
      if (!offer) continue;
      checked++;
      expect(offer.price).toBeGreaterThanOrEqual(offer.ev / EXTRA_BALL_RTP);
      const expectedBall = round.drum[round.drawnCount];
      expect(buyExtraBall(round).ball).toBe(expectedBall);
      expect(round.extraSpent).toBe(offer.price);
      const settled = settleVideoBingo(round);
      expect(settled.stake).toBe(4000);
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('Shell Spin', () => {
  const { SHELL_SPIN, startSpin, spin, autoPlaceWilds, extraSpinEv, autoPlayBaseGame, spinWinnings, placeWild, wildTargets } =
    shellSpin;

  it('plays 11 spins, daubs numbers and validates wild placement', () => {
    const rng = fastRng('spin-flow');
    const state = startSpin(SHELL_SPIN, 100, rng);
    expect(new Set(state.card.cells).size).toBe(25);
    let spins = 0;
    while (state.spinsLeft > 0) {
      spin(state, rng);
      spins++;
      if (state.pendingWilds.length) {
        const wild = state.pendingWilds[0]!;
        const targets = wildTargets(state.marked, wild);
        expect(() => placeWild(state, 0, -1)).toThrow();
        placeWild(state, 0, targets[0]!);
      }
      autoPlaceWilds(state);
    }
    expect(spins).toBeGreaterThanOrEqual(11);
    expect(spinWinnings(state)).toBeGreaterThanOrEqual(0);
  });

  it('extra-spin EV enumeration matches Monte Carlo', () => {
    const rng = fastRng('spin-ev');
    const state = startSpin(SHELL_SPIN, 100, rng);
    autoPlayBaseGame(state, rng);
    const ev = extraSpinEv(state);
    const base = SHELL_SPIN.ladder;
    let gain = 0;
    const trials = 30_000;
    const coinTotal = SHELL_SPIN.coins.reduce((s, c) => s + c.weight, 0);
    for (let t = 0; t < trials; t++) {
      const copy = { ...state, pendingWilds: [], spinsLeft: 1, coinWinnings: 0 };
      spin(copy, rng);
      autoPlaceWilds(copy);
      gain += (base[shellSpin.slingos(copy)] ?? 0) - (base[shellSpin.slingos(state)] ?? 0) + copy.coinWinnings / 100;
      // A free spin's value is modelled as one more average spin.
      if (copy.spinsLeft > 0) gain += ev * (1 - (5 * SHELL_SPIN.weights.freeSpin) / 1000);
    }
    expect(coinTotal).toBeGreaterThan(0);
    const mc = gain / trials;
    expect(Math.abs(mc - ev)).toBeLessThan(Math.max(0.03, ev * 0.1));
  });

  it('base game RTP lands near 90% (simulation, fixed seed)', () => {
    const rng = fastRng('spin-rtp');
    let paid = 0;
    const rounds = 40_000;
    for (let i = 0; i < rounds; i++) {
      const state = startSpin(SHELL_SPIN, 1000, rng);
      autoPlayBaseGame(state, rng);
      paid += spinWinnings(state);
    }
    const rtp = paid / (rounds * 1000);
    expect(rtp).toBeGreaterThan(0.8);
    expect(rtp).toBeLessThan(1.0);
  });
});
