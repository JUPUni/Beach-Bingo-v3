import { useCallback, useState } from 'react';
import { keno, mathRng, range, type KenoResult, type KenoRisk } from '@beach-bingo/engine';
import { sfx } from '../lib/audio.ts';
import { newRound } from '../lib/fair.ts';
import { useGame } from '../state/store.ts';
import { GreenButton, StakePicker } from '../ui/kit.tsx';
import { toast } from '../ui/toast.ts';
import { CasinoShell, FairChip, Segmented, WinBanner } from './common.tsx';
import { COIN_STAKES, sleep, useWager } from './wager.ts';

const RISKS: readonly KenoRisk[] = ['low', 'medium', 'high'];

export default function Keno() {
  const { stake, setStake, placeBet, settle } = useWager('keno', 25);
  const commitment = useGame((s) => s.fairness.commitment);
  const [risk, setRisk] = useState<KenoRisk>('medium');
  const [picks, setPicks] = useState<number[]>([]);
  const [result, setResult] = useState<KenoResult | null>(null);
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState<number | null>(null);
  const [win, setWin] = useState<{ amount: number; mult: number } | null>(null);

  const toggle = (n: number) => {
    if (busy) return;
    setResult(null);
    setPicks((p) => {
      if (p.includes(n)) return p.filter((x) => x !== n);
      if (p.length >= keno.KENO_MAX_PICKS) {
        toast('Pick up to 10 shells');
        return p;
      }
      sfx.click();
      return [...p, n];
    });
  };

  const play = async () => {
    if (busy) return;
    if (!picks.length) return toast('Pick at least one shell (or tap Quick pick)');
    if (!placeBet(stake)) return;
    setBusy(true);
    setWin(null);
    const round = newRound('keno');
    setNonce(round.seed.nonce);
    const res = keno.playKeno(picks, risk, stake, round.rng('draw'));
    setResult(res);
    for (let i = 1; i <= res.drawn.length; i++) {
      setShown(i);
      if (picks.includes(res.drawn[i - 1]!)) sfx.daub();
      else sfx.ball();
      await sleep(170);
    }
    settle(res.payout);
    round.log(`${res.catches}/${picks.length} caught → ${res.payout}`);
    if (res.payout > 0) setWin({ amount: res.payout, mult: res.multiplier });
    else sfx.miss();
    setBusy(false);
  };

  const onDone = useCallback(() => setWin(null), []);
  const drawn = new Set(result ? result.drawn.slice(0, shown) : []);
  const table = picks.length ? keno.KENO_PAYTABLES[risk][picks.length]! : [];
  const caught = result && shown === result.drawn.length ? result.catches : -1;

  return (
    <CasinoShell
      mode="keno"
      controls={
        <>
          <StakePicker value={stake} options={COIN_STAKES} onChange={setStake} disabled={busy} />
          <GreenButton onClick={play} disabled={busy} className="casino__go">
            {busy ? '…' : 'Draw 10'}
          </GreenButton>
        </>
      }
    >
      <div className="casino__row">
        <Segmented options={RISKS} value={risk} onChange={(r) => (setRisk(r), setResult(null))} disabled={busy} render={(r) => r[0]!.toUpperCase() + r.slice(1)} />
        <FairChip nonce={nonce} commitment={commitment} />
      </div>
      <div className="casino__row">
        <button type="button" className="fair-chip" disabled={busy} onClick={() => (setResult(null), setPicks(keno.kenoQuickPick(5 + mathRng.int(6), mathRng)))}>
          🎲 Quick pick
        </button>
        <span className="pill">
          {picks.length}/10 picked
        </span>
        <button type="button" className="fair-chip" disabled={busy} onClick={() => (setResult(null), setPicks([]))}>
          ✖ Clear
        </button>
      </div>
      <div className="keno-grid">
        {range(1, keno.KENO_SPOTS).map((n) => {
          const picked = picks.includes(n);
          const isDrawn = drawn.has(n);
          return (
            <button
              key={n}
              type="button"
              className={`keno-cell ${picked ? 'is-picked' : ''} ${isDrawn ? (picked ? 'is-hit' : 'is-drawn') : ''}`}
              onClick={() => toggle(n)}
              aria-pressed={picked}
            >
              {n}
            </button>
          );
        })}
      </div>
      {picks.length > 0 && (
        <div className="keno-pays" aria-label="Payouts by catches">
          {table.map((m, k) => (
            <span key={k} className={k === caught ? 'is-hit' : ''}>
              {k}🐚
              <b>{m ? `${m}×` : '—'}</b>
            </span>
          ))}
        </div>
      )}
      <p className="casino__foot small-note">
        RTP {(keno.kenoRtp(table.length ? table : [0], Math.max(1, picks.length)) * 100 || 96).toFixed(1)}% · exact hypergeometric odds
      </p>
      {win && <WinBanner amount={win.amount} multiplier={win.mult} onDone={onDone} />}
    </CasinoShell>
  );
}
