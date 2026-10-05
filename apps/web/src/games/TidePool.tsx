import { useCallback, useState } from 'react';
import { markedMask, mathRng, tidePool, type BingoCard, type SeaState, type TideResult } from '@beach-bingo/engine';
import { sfx } from '../lib/audio.ts';
import { newRound } from '../lib/fair.ts';
import { useGame } from '../state/store.ts';
import { BingoGrid } from '../ui/BingoGrid.tsx';
import { Ball, GreenButton, StakePicker } from '../ui/kit.tsx';
import { toast } from '../ui/toast.ts';
import { CasinoShell, FairChip, Segmented, WinBanner } from './common.tsx';
import { COIN_STAKES, sleep, useWager } from './wager.ts';

const SEAS: readonly SeaState[] = ['calm', 'choppy', 'storm'];
const SEA_LABEL: Record<SeaState, string> = { calm: '🌤️ Calm', choppy: '🌊 Choppy', storm: '⛈️ Storm' };

export default function TidePool() {
  const { stake, setStake, placeBet, settle, covers } = useWager('tidePool', 25);
  const commitment = useGame((s) => s.fairness.commitment);
  const [sea, setSea] = useState<SeaState>('calm');
  const [count, setCount] = useState(2);
  const [cards, setCards] = useState<BingoCard[]>(() => tidePool.dealTideCards(2, mathRng));
  const [result, setResult] = useState<TideResult | null>(null);
  const [revealed, setRevealed] = useState(0);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState<number | null>(null);
  const [win, setWin] = useState<{ amount: number; mult: number } | null>(null);
  const config = tidePool.TIDE_SEAS[sea];

  const changeCount = (n: number) => {
    setCount(n);
    setCards(tidePool.dealTideCards(n, mathRng));
    setResult(null);
  };

  const play = async () => {
    if (busy || !placeBet(stake * count)) return;
    setBusy(true);
    setWin(null);
    const round = newRound('tidePool');
    setNonce(round.seed.nonce);
    const res = tidePool.playTidePool(cards, sea, stake, round.rng('draw'));
    setResult(res);
    for (let i = 1; i <= res.drawn.length; i++) {
      setRevealed(i);
      if (i % 3 === 0) sfx.reel();
      await sleep(i > res.drawn.length - 5 ? 180 : 55);
    }
    settle(res.payout);
    round.log(`${res.cards.map((c) => `${c.lines}L`).join(' ')} → ${res.payout}`);
    if (res.payout > 0) {
      setWin({ amount: res.payout, mult: res.payout / res.stake });
    } else {
      sfx.miss();
      toast('No lines this tide — try again!');
    }
    setBusy(false);
  };

  const onDone = useCallback(() => setWin(null), []);
  const drawn = result ? result.drawn.slice(0, revealed) : [];
  const size = cards.length === 1 ? 'lg' : 'sm';

  return (
    <CasinoShell
      mode="tidePool"
      controls={
        <>
          <Segmented options={[1, 2, 3, 4]} value={count} onChange={changeCount} disabled={busy} render={(n) => `${n}🃏`} />
          <StakePicker value={stake} options={COIN_STAKES} onChange={setStake} disabled={busy} label="Per card" />
          <GreenButton onClick={play} disabled={busy} className="casino__go">
            {busy ? '…' : covers(stake * count) ? 'Splash · Free game' : `Splash ${stake * count}`}
          </GreenButton>
        </>
      }
    >
      <div className="casino__row">
        <Segmented options={SEAS} value={sea} onChange={(s) => (setSea(s), setResult(null))} disabled={busy} render={(s) => SEA_LABEL[s]} />
        <FairChip nonce={nonce} commitment={commitment} />
      </div>
      <div className="paytable">
        <span>{config.balls} balls</span>
        {[1, 2, 3, 4, 5, 6].map((l) =>
          config.pays[l] !== config.pays[l - 1] || l === 1 ? (
            <span key={l}>
              <b>{l === 6 || (l === 4 && sea === 'storm') ? `${l}+` : l}</b> {config.pays[l]}×
            </span>
          ) : null,
        )}
        <span className="paytable__rtp">RTP {(tidePool.tideRtp(sea) * 100).toFixed(2)}%</span>
      </div>
      <div className={`card-set card-set--${cards.length} casino__cards`}>
        {cards.map((card, i) => {
          const r = result?.cards[i];
          const finished = r && revealed === result.drawn.length;
          return (
            <div key={i} className="tide-card">
              <BingoGrid
                card={card}
                marked={result ? markedMask(card, drawn) : 1 << 12}
                highlight={finished ? r.lineCells : undefined}
                size={size}
                label={`Card ${i + 1}`}
              />
              {finished && (
                <span className={`tide-card__result ${r.payout ? 'is-win' : ''}`}>
                  {r.lines} line{r.lines === 1 ? '' : 's'}
                  {r.payout ? ` · +${r.payout}` : ''}
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="ball-tray" aria-label="Drawn balls">
        {drawn.map((b, i) => (
          <Ball key={b} n={b} size={2.5} className={i === drawn.length - 1 && busy ? 'ball--enter' : ''} />
        ))}
      </div>
      {win && <WinBanner amount={win.amount} multiplier={win.mult} onDone={onDone} />}
    </CasinoShell>
  );
}
