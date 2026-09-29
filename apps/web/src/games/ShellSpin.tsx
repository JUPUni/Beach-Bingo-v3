import { useCallback, useRef, useState } from 'react';
import { shellSpin, type ReelSymbol, type SpinState } from '@beach-bingo/engine';
import { sfx } from '../lib/audio.ts';
import { newRound, type FairRound } from '../lib/fair.ts';
import { useModel } from '../lib/hooks.ts';
import { useGame } from '../state/store.ts';
import { BingoGrid } from '../ui/BingoGrid.tsx';
import { GreenButton, StakePicker } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { CasinoShell, FairChip, WinBanner } from './common.tsx';
import { COIN_STAKES, sleep, useWager } from './wager.ts';

const SYMBOL: Record<ReelSymbol['kind'], string> = {
  number: '',
  joker: '🌴',
  super: '☀️',
  coin: '🪙',
  freeSpin: '🔁',
  shark: '🦈',
};

export default function ShellSpin() {
  const { stake, setStake, placeBet, settle } = useWager('shellSpin', 50);
  const commitment = useGame((s) => s.fairness.commitment);
  const spend = useGame((s) => s.spend);
  const { model: state, commit: render, replace } = useModel<SpinState | null>(() => null);
  const fairRef = useRef<FairRound | null>(null);
  const reelRng = useRef<ReturnType<FairRound['rng']> | null>(null);
  const [spinning, setSpinning] = useState(false);
  const [nonce, setNonce] = useState<number | null>(null);
  const [win, setWin] = useState<{ amount: number; mult: number } | null>(null);
  const active = state !== null && !state.collected;

  const startGame = (): SpinState | null => {
    if (!placeBet(stake)) return null;
    const fair = newRound('shellSpin');
    fairRef.current = fair;
    reelRng.current = fair.rng('reels');
    setNonce(fair.seed.nonce);
    const fresh = shellSpin.startSpin(shellSpin.SHELL_SPIN, stake, fair.rng('card'));
    replace(fresh);
    setWin(null);
    return fresh;
  };

  const doSpin = async (current: SpinState | null = state) => {
    if (spinning) return;
    const s = current && !current.collected ? current : startGame();
    if (!s) return;
    if (s.pendingWilds.length) return toast('Place your wilds first — tap a glowing square');
    if (s.spinsLeft <= 0) return;
    setSpinning(true);
    for (let i = 0; i < 6; i++) {
      sfx.reel();
      await sleep(60);
    }
    shellSpin.spin(s, reelRng.current!);
    if (s.lastReels.some((r) => r.kind === 'number')) sfx.daub();
    if (s.lastReels.some((r) => r.kind === 'coin')) sfx.coin();
    if (s.pendingWilds.length) sfx.win();
    setSpinning(false);
    render();
  };

  const onCell = (cell: number) => {
    const s = state;
    if (!s || !s.pendingWilds.length) return;
    const index = s.pendingWilds.findIndex((w) => shellSpin.wildTargets(s.marked, w).includes(cell));
    if (index < 0) return;
    shellSpin.placeWild(s, index, cell);
    sfx.daub();
    render();
  };

  const autoWilds = () => {
    const s = state;
    if (!s) return;
    shellSpin.autoPlaceWilds(s);
    sfx.daub();
    render();
  };

  const buySpin = () => {
    const s = state;
    const offer = s && shellSpin.extraSpinOffer(s);
    if (!s || !offer) return;
    if (!spend(offer.price, { wager: true })) return toast('Not enough coins for an extra spin', 'warn');
    shellSpin.buyExtraSpin(s);
    render();
    void doSpin(s);
  };

  const collect = () => {
    const s = state;
    if (!s) return;
    const res = shellSpin.collectSpin(s);
    settle(res.payout);
    fairRef.current?.log(`${shellSpin.slingos(s)} slingos, ${s.extraSpins} extra → ${res.payout}`);
    if (res.payout > 0) setWin({ amount: res.payout, mult: res.payout / res.stake });
    else sfx.miss();
    render();
  };

  const onDone = useCallback(() => setWin(null), []);
  const offer = state && !state.collected ? shellSpin.extraSpinOffer(state) : null;
  const targets = state?.pendingWilds.reduce(
    (m, w) => shellSpin.wildTargets(state.marked, w).reduce((mm, c) => mm | (1 << c), m),
    0,
  );
  const lines = state ? shellSpin.slingos(state) : 0;
  const ladder = shellSpin.SHELL_SPIN.ladder;

  return (
    <CasinoShell
      mode="shellSpin"
      controls={
        <>
          <StakePicker value={stake} options={COIN_STAKES} onChange={setStake} disabled={active} />
          {!active || state!.spinsLeft > 0 || state!.pendingWilds.length ? (
            <GreenButton onClick={() => void doSpin()} disabled={spinning || Boolean(state?.pendingWilds.length && active)} className="casino__go">
              {active ? `Spin (${state!.spinsLeft} left)` : 'Spin'}
            </GreenButton>
          ) : (
            <>
              {offer && (
                <GreenButton tone="blue" onClick={buySpin} disabled={spinning}>
                  +1 spin {formatCoins(offer.price)}
                </GreenButton>
              )}
              <GreenButton tone="gold" onClick={collect} className="casino__go">
                Collect {formatCoins(shellSpin.spinWinnings(state!))}
              </GreenButton>
            </>
          )}
        </>
      }
    >
      <div className="casino__row">
        <span className="pill">
          🐚 {lines} slingo{lines === 1 ? '' : 's'} · pays {ladder[lines]}×
        </span>
        <FairChip nonce={nonce} commitment={commitment} />
      </div>
      <div className="slingo-ladder">
        {ladder.map((m, k) =>
          m > 0 && k !== 11 ? (
            <span key={k} className={k === lines ? 'is-on' : ''}>
              {k === 12 ? 'Full' : k} <b>{m}×</b>
            </span>
          ) : null,
        )}
      </div>
      <div className="reels" aria-label="Reels">
        {[0, 1, 2, 3, 4].map((c) => {
          const sym = state?.lastReels[c];
          const special = sym && sym.kind !== 'number';
          return (
            <div key={c} className={`reel ${spinning ? 'is-spinning' : ''} ${special ? 'is-special' : ''}`}>
              <span>{spinning ? '🐚' : sym ? (sym.kind === 'number' ? sym.value : SYMBOL[sym.kind]) : '•'}</span>
            </div>
          );
        })}
      </div>
      {state?.pendingWilds.length ? (
        <div className="spin-status">
          <span className="pill">
            {state.pendingWilds.map((w) => (w.kind === 'joker' ? '🌴 column wild' : '☀️ any square')).join(' · ')} — tap a glowing square
          </span>
          <button type="button" className="fair-chip" onClick={autoWilds}>
            ✨ Best spot
          </button>
        </div>
      ) : null}
      <div className="casino__cards">
        {state ? (
          <BingoGrid card={state.card} marked={state.marked} targets={targets} onCell={onCell} size="lg" header />
        ) : (
          <div className="casino__hint panel">
            <p>
              11 spins, 5 reels, one card. Numbers daub automatically; 🌴 lets you daub any square in its column, ☀️ any square at
              all. Complete lines (slingos) to climb the ladder — 12 slingos pays 1,500×.
            </p>
            <p className="small-note">After your spins you can buy extras, priced at their exact expected value ÷ 96%.</p>
          </div>
        )}
      </div>
      {state && state.coinWinnings > 0 && <p className="casino__foot small-note">Coins collected: {state.coinWinnings}</p>}
      {win && <WinBanner amount={win.amount} multiplier={win.mult} onDone={onDone} />}
    </CasinoShell>
  );
}
