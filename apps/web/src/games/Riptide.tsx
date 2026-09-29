import { useCallback, useEffect, useRef, useState } from 'react';
import { applyMultiplier, riptide, type RiptideLevel, type RiptideRound } from '@beach-bingo/engine';
import { callBall, sfx } from '../lib/audio.ts';
import { newRound } from '../lib/fair.ts';
import { useModel } from '../lib/hooks.ts';
import { useGame } from '../state/store.ts';
import { BingoGrid } from '../ui/BingoGrid.tsx';
import { Ball, GreenButton, StakePicker } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { CasinoShell, FairChip, Segmented, WinBanner } from './common.tsx';
import { COIN_STAKES, useWager } from './wager.ts';

const LEVELS: readonly RiptideLevel[] = ['calm', 'choppy', 'storm'];
const LABEL: Record<RiptideLevel, string> = { calm: '🦈×2', choppy: '🦈×4', storm: '🦈×8' };
const AUTO = [0, 3, 5, 8, 12] as const;
const DRAW_MS = 1100;

export default function Riptide() {
  const { stake, setStake, placeBet, settle } = useWager('riptide', 50);
  const commitment = useGame((s) => s.fairness.commitment);
  const [level, setLevel] = useState<RiptideLevel>('choppy');
  const [auto, setAuto] = useState<number>(0);
  const [nonce, setNonce] = useState<number | null>(null);
  const [win, setWin] = useState<{ amount: number; mult: number } | null>(null);
  const [bitten, setBitten] = useState(false);
  const { model: round, commit: render, replace } = useModel<RiptideRound | null>(() => null);
  const logRef = useRef<((s: string) => void) | null>(null);
  const running = round?.status === 'running';
  const config = riptide.RIPTIDE_LEVELS[level];

  const finish = useCallback(
    (r: RiptideRound) => {
      settle(r.payout);
      logRef.current?.(`${r.status === 'cashed' ? 'banked' : r.status} at ${r.hits} hits → ${r.payout}`);
      if (r.payout > 0) setWin({ amount: r.payout, mult: riptide.cashoutMultiplier(r.hits, r.config) });
    },
    [settle],
  );

  // The tide draws automatically; the player only decides when to bank.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      const r = round;
      if (!r || r.status !== 'running') return;
      const ev = riptide.drawRiptide(r);
      if (ev.isShark) {
        sfx.shark();
        setBitten(true);
        finish(r);
      } else if (ev.isHit) {
        sfx.daub();
        callBall(ev.ball);
        if (ev.newLines) sfx.coin();
        if (r.status !== 'running') {
          sfx.cashout();
          finish(r);
        }
      } else {
        sfx.ball();
      }
      render();
    }, DRAW_MS);
    return () => window.clearInterval(id);
  }, [running, round, finish, render]);

  const start = () => {
    if (running || !placeBet(stake)) return;
    const fair = newRound('riptide');
    logRef.current = fair.log;
    setNonce(fair.seed.nonce);
    setBitten(false);
    setWin(null);
    replace(riptide.startRiptide(config, stake, fair.rng('card'), fair.rng('drum'), auto || undefined));
    sfx.click();
  };

  const cashOut = () => {
    const r = round;
    if (!r || r.status !== 'running') return;
    if (r.hits === 0) return toast('Catch at least one number first!');
    riptide.cashOutRiptide(r);
    sfx.cashout();
    finish(r);
    render();
  };

  const onDone = useCallback(() => setWin(null), []);
  const ladder = riptide.cashoutLadder(config);
  const hits = round?.hits ?? 0;
  const current = riptide.cashoutMultiplier(hits, config);
  const next = ladder[Math.min(24, hits + 1)]!;
  const lastBall = round?.drawn.at(-1);

  return (
    <CasinoShell
      mode="riptide"
      controls={
        <>
          <StakePicker value={stake} options={COIN_STAKES} onChange={setStake} disabled={running} />
          {running ? (
            <GreenButton tone="gold" onClick={cashOut} className="casino__go" disabled={hits === 0}>
              Bank {formatCoins(applyMultiplier(stake, current))}
            </GreenButton>
          ) : (
            <GreenButton onClick={start} className="casino__go">
              Ride the tide
            </GreenButton>
          )}
        </>
      }
    >
      <div className="casino__row">
        <Segmented options={LEVELS} value={level} onChange={setLevel} disabled={running} render={(l) => LABEL[l]} />
        <FairChip nonce={nonce} commitment={commitment} />
      </div>
      <div className="casino__row">
        <span className="pill">Auto bank</span>
        <Segmented options={AUTO} value={auto} onChange={setAuto} disabled={running} render={(a) => (a ? `${a} hits` : 'Off')} />
      </div>

      <div className={`riptide-meter ${bitten ? 'is-bitten anim-shake' : ''}`}>
        <div className="riptide-meter__ball">
          {lastBall === undefined ? (
            <span className="riptide-meter__idle">🌊</span>
          ) : lastBall === riptide.SHARK ? (
            <span className="riptide-meter__shark">🦈</span>
          ) : (
            <Ball key={round!.drawn.length} n={lastBall} size={5.6} className="ball--enter" />
          )}
        </div>
        <div className="riptide-meter__mult">
          <b className={`t-outline ${bitten ? 't-outline--red' : 't-outline--green'}`}>{bitten ? 'CHOMP!' : `${current.toFixed(2)}×`}</b>
          <small>
            {hits}/24 hits · next {next.toLocaleString('en-US')}× · {config.sharks} sharks in the drum
          </small>
        </div>
      </div>

      <div className="casino__cards">
        {round ? (
          <BingoGrid card={round.card} marked={round.marked} size="lg" />
        ) : (
          <div className="casino__hint panel">
            <p>
              Balls splash in every second. Each number on your card pumps the multiplier — but <b>{config.sharks} sharks</b> hide
              in the drum. Bank before one bites!
            </p>
            <p className="small-note">
              Banking at any point returns {(config.rtp * 100).toFixed(0)}% on average (max {config.maxMultiplier.toLocaleString()}×).
            </p>
          </div>
        )}
      </div>

      <div className="ladder" aria-label="Multiplier ladder">
        {ladder.slice(1).map((m, i) => (
          <span key={i} className={i + 1 <= hits ? 'is-hit' : i + 1 === hits + 1 && running ? 'is-next' : ''}>
            {m >= 1000 ? `${Math.round(m / 1000)}k` : m.toFixed(m < 10 ? 2 : 0)}
          </span>
        ))}
      </div>
      {win && <WinBanner amount={win.amount} multiplier={win.mult} onDone={onDone} />}
    </CasinoShell>
  );
}
