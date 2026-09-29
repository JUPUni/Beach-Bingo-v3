import { useCallback, useState } from 'react';
import { blitz, markedMask, type BlitzResult } from '@beach-bingo/engine';
import { sfx } from '../lib/audio.ts';
import { newRound } from '../lib/fair.ts';
import { useGame } from '../state/store.ts';
import { BingoGrid } from '../ui/BingoGrid.tsx';
import { Ball, GreenButton, StakePicker } from '../ui/kit.tsx';
import { toast } from '../ui/toast.ts';
import { CasinoShell, FairChip, WinBanner } from './common.tsx';
import { COIN_STAKES, sleep, useWager } from './wager.ts';

export default function Blitz() {
  const { stake, setStake, placeBet, settle } = useWager('blitz', 25);
  const commitment = useGame((s) => s.fairness.commitment);
  const [target, setTarget] = useState(22);
  const [result, setResult] = useState<BlitzResult | null>(null);
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState<number | null>(null);
  const [win, setWin] = useState<{ amount: number; mult: number } | null>(null);
  const multiplier = blitz.blitzMultiplier(target);
  const chance = blitz.blitzProbability(target);

  const play = async () => {
    if (busy || !placeBet(stake)) return;
    setBusy(true);
    setWin(null);
    const round = newRound('blitz');
    setNonce(round.seed.nonce);
    const res = blitz.playBlitz(target, stake, round.rng('card'), round.rng('draw'));
    setResult(res);
    for (let i = 1; i <= res.completedAt; i++) {
      setShown(i);
      sfx.ball();
      await sleep(i === target ? 350 : 110);
    }
    settle(res.payout);
    round.log(`full house on ball ${res.completedAt} vs target ${target} → ${res.payout}`);
    if (res.won) {
      sfx.bingo();
      setWin({ amount: res.payout, mult: res.multiplier });
    } else {
      sfx.lose();
      toast(`Full house on ball ${res.completedAt} — needed ${target}`, 'warn');
    }
    setBusy(false);
  };

  const onDone = useCallback(() => setWin(null), []);
  const drawn = result ? result.drawn.slice(0, shown) : [];

  return (
    <CasinoShell
      mode="blitz"
      controls={
        <>
          <StakePicker value={stake} options={COIN_STAKES} onChange={setStake} disabled={busy} />
          <GreenButton onClick={play} disabled={busy} className="casino__go">
            {busy ? '…' : `Blitz ${multiplier}×`}
          </GreenButton>
        </>
      }
    >
      <div className="casino__row">
        <span className="pill">🏐 30 balls · 9 on your card</span>
        <FairChip nonce={nonce} commitment={commitment} />
      </div>
      <div className="blitz-target">
        <div className="blitz-target__row">
          <span>
            Full house by ball
            <br />
            <b>{target}</b>
          </span>
          <span style={{ textAlign: 'right' }}>
            Pays
            <br />
            <b>{multiplier.toLocaleString('en-US')}×</b>
          </span>
        </div>
        <input
          type="range"
          min={blitz.BLITZ_MIN_TARGET}
          max={blitz.BLITZ_MAX_TARGET}
          value={target}
          disabled={busy}
          onChange={(e) => (setTarget(Number(e.target.value)), setResult(null))}
          aria-label="Target ball"
        />
        <small>Win chance {(chance * 100).toFixed(chance < 0.01 ? 3 : 1)}% · RTP {(blitz.BLITZ_RTP * 100).toFixed(0)}%</small>
      </div>
      <div className="casino__cards">
        {result ? (
          <BingoGrid card={result.card} marked={markedMask(result.card, drawn)} size="lg" />
        ) : (
          <div className="casino__hint panel">
            <p>Pick how fast your 9 numbers must all be called. The faster the target, the bigger the prize.</p>
          </div>
        )}
      </div>
      <div className="ball-tray">
        {drawn.map((b, i) => (
          <Ball key={b} n={b} variant="30" size={2.6} className={i === drawn.length - 1 && busy ? 'ball--enter' : ''} />
        ))}
      </div>
      {win && <WinBanner amount={win.amount} multiplier={win.mult} onDone={onDone} />}
    </CasinoShell>
  );
}
