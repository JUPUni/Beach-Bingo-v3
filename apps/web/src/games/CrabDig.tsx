import { useCallback, useRef, useState } from 'react';
import { crabDig, type DigRound } from '@beach-bingo/engine';
import { sfx } from '../lib/audio.ts';
import { newRound } from '../lib/fair.ts';
import { useModel } from '../lib/hooks.ts';
import { useGame } from '../state/store.ts';
import { GreenButton, StakePicker } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { CasinoShell, FairChip, Segmented, WinBanner } from './common.tsx';
import { COIN_STAKES, useWager } from './wager.ts';

const CRABS = [1, 3, 5, 8, 12, 20] as const;

export default function CrabDig() {
  const { stake, setStake, placeBet, settle } = useWager('crabDig', 50);
  const commitment = useGame((s) => s.fairness.commitment);
  const [crabs, setCrabs] = useState<number>(3);
  const [nonce, setNonce] = useState<number | null>(null);
  const [win, setWin] = useState<{ amount: number; mult: number } | null>(null);
  const { model: round, commit: render, replace } = useModel<DigRound | null>(() => null);
  const logRef = useRef<((s: string) => void) | null>(null);
  const digging = round?.status === 'digging';

  const start = () => {
    if (digging || !placeBet(stake)) return;
    const fair = newRound('crabDig');
    logRef.current = fair.log;
    setNonce(fair.seed.nonce);
    setWin(null);
    replace(crabDig.startDig(crabs, stake, fair.rng('layout')));
    sfx.click();
  };

  const finish = (r: DigRound) => {
    settle(r.payout);
    logRef.current?.(`${r.status} after ${r.dug.length} digs → ${r.payout}`);
    if (r.payout > 0) setWin({ amount: r.payout, mult: crabDig.digMultiplier(r.crabs, r.dug.length) });
  };

  const onCell = (cell: number) => {
    const r = round;
    if (!r || r.status !== 'digging' || cell === 12 || r.dug.includes(cell)) return;
    const res = crabDig.dig(r, cell);
    if (res.crab) {
      sfx.shark();
      finish(r);
    } else {
      sfx.daub();
      if (res.status === 'cleared') {
        sfx.bingo();
        finish(r);
      }
    }
    render();
  };

  const cashOut = () => {
    const r = round;
    if (!r || r.status !== 'digging') return;
    if (r.dug.length === 0) return toast('Dig at least one square first!');
    crabDig.cashOutDig(r);
    sfx.cashout();
    finish(r);
    render();
  };

  const onDone = useCallback(() => setWin(null), []);
  const dugSafe = round ? round.dug.filter((c) => !round.crabCells.includes(c)).length : 0;
  const current = round ? crabDig.digMultiplier(round.crabs, dugSafe) : 0;
  const next = crabDig.digMultiplier(round?.crabs ?? crabs, dugSafe + 1);
  const over = round && round.status !== 'digging';

  return (
    <CasinoShell
      mode="crabDig"
      controls={
        <>
          <StakePicker value={stake} options={COIN_STAKES} onChange={setStake} disabled={digging} />
          {digging ? (
            <GreenButton tone="gold" onClick={cashOut} className="casino__go" disabled={dugSafe === 0}>
              Cash out {formatCoins(Math.floor(stake * current))}
            </GreenButton>
          ) : (
            <GreenButton onClick={start} className="casino__go">
              Start digging
            </GreenButton>
          )}
        </>
      }
    >
      <div className="casino__row">
        <span className="pill">🦀 Crabs</span>
        <Segmented options={CRABS} value={crabs} onChange={setCrabs} disabled={digging} />
        <FairChip nonce={nonce} commitment={commitment} />
      </div>
      <div className="riptide-meter">
        <div className="riptide-meter__mult">
          <b className={`t-outline ${round?.status === 'bitten' ? 't-outline--red' : 't-outline--green'}`}>
            {round?.status === 'bitten' ? 'PINCHED!' : `${(current || 1).toFixed(2)}×`}
          </b>
          <small>
            {dugSafe} safe digs · next {next.toLocaleString('en-US')}× · {round?.crabs ?? crabs} crabs hidden
          </small>
        </div>
      </div>
      <div className="casino__cards">
        <div className="dig-board">
          {Array.from({ length: 25 }, (_, i) => {
            const isCentre = i === 12;
            const dug = round?.dug.includes(i);
            const crab = round?.crabCells.includes(i);
            const reveal = over && crab;
            const value = round?.card.cells[i];
            return (
              <button
                key={i}
                type="button"
                className={`dig-cell ${dug ? 'is-dug' : ''} ${dug && crab ? 'is-crab' : ''} ${reveal && !dug ? 'is-reveal' : ''}`}
                disabled={!digging || isCentre || dug}
                onPointerDown={() => onCell(i)}
                aria-label={isCentre ? 'Free space' : `Square ${i + 1}`}
              >
                {isCentre ? '🌴' : dug ? (crab ? '🦀' : <span className="dig-cell__num">{value}</span>) : reveal ? '🦀' : ''}
              </button>
            );
          })}
        </div>
      </div>
      <p className="casino__foot small-note">Every stopping point returns {(crabDig.DIG_RTP * 100).toFixed(0)}% on average. Lines are just for show — only digs count.</p>
      {win && <WinBanner amount={win.amount} multiplier={win.mult} onDone={onDone} />}
    </CasinoShell>
  );
}
