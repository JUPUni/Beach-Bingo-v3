import { useCallback, useRef, useState } from 'react';
import { videoBingo, type VideoBingoRound } from '@beach-bingo/engine';
import { sfx } from '../lib/audio.ts';
import { newRound, type FairRound } from '../lib/fair.ts';
import { useModel } from '../lib/hooks.ts';
import { useGame } from '../state/store.ts';
import { BingoGrid } from '../ui/BingoGrid.tsx';
import { Ball, GreenButton, StakePicker } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { CasinoShell, FairChip, Segmented, WinBanner } from './common.tsx';
import { COIN_STAKES, sleep, useWager } from './wager.ts';

function MiniPattern({ mask }: { mask: number }) {
  return (
    <span className="mini-pattern" aria-hidden>
      {Array.from({ length: 15 }, (_, i) => (
        <i key={i} className={mask & (1 << i) ? 'on' : ''} />
      ))}
    </span>
  );
}

export default function VideoBingo() {
  const { stake, setStake, placeBet, settle, covers, buyExtra } = useWager('videoBingo', 10);
  const commitment = useGame((s) => s.fairness.commitment);
  const [cards, setCards] = useState(4);
  const [shown, setShown] = useState(0);
  const [busy, setBusy] = useState(false);
  const [nonce, setNonce] = useState<number | null>(null);
  const [win, setWin] = useState<{ amount: number; mult: number } | null>(null);
  const { model: round, commit: render, replace } = useModel<VideoBingoRound | null>(() => null);
  const fairRef = useRef<FairRound | null>(null);
  const open = round !== null && !round.settled && !busy;

  const play = async () => {
    if (busy || (round && !round.settled) || !placeBet(stake * cards)) return;
    setBusy(true);
    setWin(null);
    const fair = newRound('videoBingo');
    fairRef.current = fair;
    setNonce(fair.seed.nonce);
    const r = videoBingo.startVideoBingo(stake, cards, fair.rng('cards'), fair.rng('drum'));
    replace(r);
    for (let i = 1; i <= videoBingo.VIDEO_BASE_DRAW; i++) {
      setShown(i);
      if (i % 2 === 0) sfx.reel();
      await sleep(45);
    }
    setBusy(false);
    if (!videoBingo.extraBallOffer(r)) finish(r);
    render();
  };

  const finish = (r: VideoBingoRound) => {
    const res = videoBingo.settleVideoBingo(r);
    settle(res.payout);
    fairRef.current?.log(`${r.extraBalls} extra balls → ${res.payout}`);
    if (res.payout > 0) setWin({ amount: res.payout, mult: res.payout / res.stake });
    else sfx.miss();
    render();
  };

  const buyBall = async () => {
    const r = round;
    const offer = r && videoBingo.extraBallOffer(r);
    if (!r || !offer) return;
    if (!buyExtra(offer.price, 'an extra ball')) return;
    const { ball } = videoBingo.buyExtraBall(r);
    setShown(r.drawnCount);
    sfx.ball();
    void ball;
    render();
    await sleep(300);
    if (!videoBingo.extraBallOffer(r)) finish(r);
  };

  const onDone = useCallback(() => setWin(null), []);
  const offer = open ? videoBingo.extraBallOffer(round) : null;
  const drawn = round ? round.drum.slice(0, round.settled ? round.drawnCount : Math.max(shown, 0)) : [];
  const hitPatterns = new Set(round?.marks.map((m) => videoBingo.bestVideoPattern(m)?.id).filter(Boolean) as string[]);

  return (
    <CasinoShell
      mode="videoBingo"
      controls={
        <>
          <StakePicker value={stake} options={COIN_STAKES} onChange={setStake} disabled={busy || open} label="Per card" />
          {offer ? (
            <>
              <GreenButton tone="blue" onClick={buyBall}>
                Extra ball {formatCoins(offer.price)}
              </GreenButton>
              <GreenButton tone="gold" onClick={() => finish(round!)}>
                Collect
              </GreenButton>
            </>
          ) : (
            <GreenButton onClick={play} disabled={busy} className="casino__go">
              {busy ? '…' : covers(stake * cards) ? 'Play · Free game' : `Play ${stake * cards}`}
            </GreenButton>
          )}
        </>
      }
    >
      <div className="casino__row">
        <Segmented options={[1, 2, 3, 4]} value={cards} onChange={setCards} disabled={busy || open} render={(n) => `${n}🃏`} />
        <FairChip nonce={nonce} commitment={commitment} />
      </div>
      <div className="video-cards">
        {Array.from({ length: cards }, (_, i) => {
          const card = round?.cards[i];
          const marks = round?.marks[i] ?? 0;
          const best = round && !busy ? videoBingo.bestVideoPattern(marks) : null;
          const near = offer?.nearMisses.find((n) => n.card === i);
          return (
            <div key={i} className="video-card">
              {card ? (
                <BingoGrid card={card} marked={busy ? 0 : marks} size="sm" header={false} label={`Card ${i + 1}`} />
              ) : (
                <div className="grid grid--sm" style={{ width: '17rem', height: '11rem' }} />
              )}
              {best && <span className="video-card__win">{best.name} · {best.multiplier}×</span>}
              {!best && near && <span className="video-card__near">1 away from {near.multiplier}×!</span>}
            </div>
          );
        })}
      </div>
      {offer && (
        <div className="extra-offer anim-pop">
          <b>🗿 Extra ball {round!.extraBalls + 1}/{videoBingo.VIDEO_MAX_EXTRA}</b>
          <span>
            Expected value {formatCoins(Math.round(offer.ev))} · price {formatCoins(offer.price)} (EV ÷ {videoBingo.EXTRA_BALL_RTP * 100}%)
          </span>
        </div>
      )}
      <div className="ball-tray">
        {drawn.map((b, i) => (
          <Ball key={b} n={b} variant="video" size={2.3} className={i >= videoBingo.VIDEO_BASE_DRAW ? 'ball--enter' : ''} />
        ))}
      </div>
      <div className="video-paytable">
        {videoBingo.VIDEO_PATTERNS.map((p) => (
          <div key={p.id} className={hitPatterns.has(p.id) && !busy ? 'is-hit' : ''}>
            <MiniPattern mask={p.masks[0]!} />
            <span>{p.name}</span>
            <b>{p.multiplier}×</b>
          </div>
        ))}
      </div>
      {win && <WinBanner amount={win.amount} multiplier={win.mult} onDone={onDone} />}
    </CasinoShell>
  );
}
