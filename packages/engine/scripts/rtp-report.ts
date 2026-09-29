/**
 * The return-to-player of every mode, computed from the engine's own tables (exactly where the
 * maths allows, by simulation otherwise) and printed next to what the mode card in the game says.
 *
 *   pnpm rtp            (packages/engine: tsx scripts/rtp-report.ts)
 *
 * Exits 1 when a house game's return falls outside 85–99% or a mode card disagrees with the engine.
 */
import {
  MODES,
  blitz,
  crabDig,
  fastRng,
  keno,
  riptide,
  rooms,
  royale,
  shellSpin,
  tidePool,
  videoBingo,
  type ModeId,
} from '../src/index.ts';

const pct = (x: number, places = 2) => `${(x * 100).toFixed(places)}%`;
const card = (id: ModeId) => MODES.find((m) => m.id === id)!.returnToPlayer;

interface Row {
  mode: ModeId;
  variant: string;
  rtp: number;
  how: string;
  maxWin: string;
}

const rows: Row[] = [];
const problems: string[] = [];

// Tide Pool: exact, from the line table.
for (const sea of ['calm', 'choppy', 'storm'] as const) {
  const { pays, balls } = tidePool.TIDE_SEAS[sea];
  rows.push({ mode: 'tidePool', variant: `${sea} (${balls} balls)`, rtp: tidePool.tideRtp(sea), how: `exact · hit rate ${pct(tidePool.tideHitRate(sea), 1)}`, maxWin: `${Math.max(...pays).toLocaleString('en-US')}×` });
}

// Crab Dig: every stopping point returns DIG_RTP before the 2-dp floor; report the worst one
// below the max-win cap (digging on past the cap is the player's choice, and pays the cap).
for (const crabs of [1, 3, 5, 8, 12, 20]) {
  let worst = 1;
  let best = 0;
  let capped = 0;
  for (let n = 1; n <= crabDig.DIG_CELLS - crabs; n++) {
    const m = crabDig.digMultiplier(crabs, n);
    if (m < crabDig.DIG_MAX_MULTIPLIER) worst = Math.min(worst, crabDig.digSurvival(crabs, n) * m);
    else capped++;
    best = Math.max(best, m);
  }
  rows.push({ mode: 'crabDig', variant: `${crabs} crab${crabs > 1 ? 's' : ''}`, rtp: worst, how: `exact, worst stopping point${capped ? ` (${capped} deepest digs hit the cap)` : ''}`, maxWin: `${best.toLocaleString('en-US')}×` });
}

// Beach Ball Blitz: exact per target.
{
  const targets = blitz.BLITZ_TARGETS;
  const rtps = targets.map((t) => blitz.blitzProbability(t) * blitz.blitzMultiplier(t));
  const lo = blitz.blitzMultiplier(blitz.BLITZ_MAX_TARGET);
  const hi = blitz.blitzMultiplier(blitz.BLITZ_MIN_TARGET);
  rows.push({ mode: 'blitz', variant: `targets ${blitz.BLITZ_MIN_TARGET}–${blitz.BLITZ_MAX_TARGET}`, rtp: Math.min(...rtps), how: `exact, worst target (best ${pct(Math.max(...rtps))})`, maxWin: `${lo.toLocaleString('en-US')}× – ${hi.toLocaleString('en-US')}×` });
  const tagline = MODES.find((m) => m.id === 'blitz')!.tagline;
  const claimed = tagline.match(/from ([\d.,]+)× to ([\d.,]+)×/);
  if (claimed) {
    const [, from, to] = claimed;
    const claimedLo = Number(from!.replace(/,/g, ''));
    const claimedHi = Number(to!.replace(/,/g, ''));
    if (Math.abs(claimedLo - lo) > 0.01 || Math.abs(claimedHi - hi) > 1) {
      problems.push(`Blitz card says "${claimed[0]}" but the engine pays ${lo}× at target ${blitz.BLITZ_MAX_TARGET} and ${hi.toLocaleString('en-US')}× at target ${blitz.BLITZ_MIN_TARGET}`);
    }
  }
}

// Shell Spin: Monte Carlo over the included spins with greedy wilds (the 1,500× top prize makes
// this noisy: ±1–2 points at 200k rounds); extra spins by construction.
let shellError = 0;
{
  const rng = fastRng('rtp-report:shell-spin');
  const rounds = 200_000;
  let paid = 0;
  let squares = 0;
  for (let i = 0; i < rounds; i++) {
    const state = shellSpin.startSpin(shellSpin.SHELL_SPIN, 1000, rng);
    shellSpin.autoPlayBaseGame(state, rng);
    const win = shellSpin.spinWinnings(state) / 1000;
    paid += win;
    squares += win * win;
  }
  const mean = paid / rounds;
  shellError = Math.sqrt(squares / rounds - mean * mean) / Math.sqrt(rounds);
  rows.push({ mode: 'shellSpin', variant: 'base game (11 spins)', rtp: mean, how: `Monte Carlo, ${rounds.toLocaleString('en-US')} rounds, greedy wilds, ±${pct(shellError, 1)}`, maxWin: `${Math.max(...shellSpin.SHELL_SPIN.ladder).toLocaleString('en-US')}× ladder` });
  rows.push({ mode: 'shellSpin', variant: 'extra spins', rtp: shellSpin.EXTRA_SPIN_RTP, how: 'by construction: price = EV ÷ RTP', maxWin: '—' });
}

// Riptide: exact per level, worst cash-out point.
for (const [level, config] of Object.entries(riptide.RIPTIDE_LEVELS)) {
  const ladder = riptide.cashoutLadder(config);
  let worst = 1;
  for (let h = 1; h <= 24; h++) if (ladder[h]! < config.maxMultiplier) worst = Math.min(worst, riptide.riptideStrategyRtp(h, config));
  rows.push({ mode: 'riptide', variant: `${level} (${config.sharks} sharks)`, rtp: worst, how: 'exact, worst cash-out point below the cap', maxWin: `${config.maxMultiplier.toLocaleString('en-US')}× cap` });
}

// Tiki Video Bingo: exact base game; extra balls by construction.
rows.push({ mode: 'videoBingo', variant: 'base game (30 balls)', rtp: videoBingo.videoBaseRtp(), how: 'exact over all 2^15 markings', maxWin: `${videoBingo.VIDEO_PATTERNS[0]!.multiplier.toLocaleString('en-US')}×` });
rows.push({ mode: 'videoBingo', variant: 'extra balls', rtp: videoBingo.EXTRA_BALL_RTP, how: 'by construction: price = EV ÷ RTP', maxWin: '—' });

// Keno: exact per risk, worst and best pick count.
for (const risk of ['low', 'medium', 'high'] as const) {
  const rtps = keno.KENO_PAYTABLES[risk].slice(1).map((table, i) => keno.kenoRtp(table, i + 1));
  const max = Math.max(...keno.KENO_PAYTABLES[risk].flat());
  rows.push({ mode: 'keno', variant: `${risk} risk`, rtp: Math.min(...rtps), how: `exact hypergeometric, worst pick count (best ${pct(Math.max(...rtps))})`, maxWin: `${max.toLocaleString('en-US')}×` });
}

// Rooms: the pool share is the return to the table as a whole.
for (const [id, config] of Object.entries(rooms.ROOM_PRESETS)) {
  rows.push({ mode: id as ModeId, variant: `${config.variant}-ball hall`, rtp: config.payoutRate, how: 'pool share of card sales (before the 2% jackpot contribution in practice rooms)', maxWin: '—' });
}
rows.push({ mode: 'lastCastle', variant: 'battle royale', rtp: royale.ROYALE_PAYOUT_RATE, how: 'pool share of buy-ins', maxWin: `${Math.round(royale.ROYALE_PLACES[0]! * 100)}% of the pool` });

// The mode cards: house games show a percentage that must match the engine's figure.
const cardChecks: [ModeId, number][] = [
  ['tidePool', Math.min(tidePool.tideRtp('calm'), tidePool.tideRtp('choppy'), tidePool.tideRtp('storm'))],
  ['crabDig', crabDig.DIG_RTP],
  ['blitz', blitz.BLITZ_RTP],
  ['riptide', riptide.RIPTIDE_LEVELS.calm.rtp],
  ['videoBingo', videoBingo.videoBaseRtp()],
  ['keno', keno.KENO_RTP],
];
for (const [id, value] of cardChecks) {
  const shown = card(id);
  const first = Number((shown.match(/([\d.]+)%/) || [])[1]);
  if (!Number.isFinite(first) || Math.abs(first - value * 100) > 0.11) problems.push(`${id} card says "${shown}" but the engine gives ${pct(value)}`);
}
{
  const shell = rows.find((r) => r.mode === 'shellSpin')!.rtp;
  const shown = card('shellSpin');
  const first = Number((shown.match(/([\d.]+)%/) || [])[1]);
  if (Math.abs(first - shell * 100) > 100 * 3 * shellError + 1) problems.push(`shellSpin card says "${shown}" but the simulation gives ${pct(shell)} ± ${pct(shellError, 1)}`);
}

// Print.
const w = [14, 26, 9, 62, 20];
const line = (cells: string[]) => cells.map((c, i) => c.padEnd(w[i]!)).join(' ');
console.log(line(['mode', 'variant', 'RTP', 'how', 'max win']));
console.log(line(w.map((n) => '-'.repeat(n))));
for (const r of rows) console.log(line([r.mode, r.variant, pct(r.rtp), r.how, r.maxWin]));
console.log('\nmode cards:');
for (const m of MODES) if (m.kind !== 'adventure') console.log(`  ${m.id.padEnd(12)} ${m.returnToPlayer}`);

const house = rows.filter((r) => MODES.find((m) => m.id === r.mode)?.kind === 'house');
for (const r of house) if (r.rtp < 0.85 || r.rtp > 0.99) problems.push(`${r.mode} (${r.variant}) returns ${pct(r.rtp)}, outside 85–99%`);

if (problems.length) {
  console.log('\nproblems:');
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
console.log('\nevery house game returns 85–99% and every mode card matches the engine.');
