import { useEffect, type ReactNode } from 'react';
import { modeInfo, type ModeId } from '@beach-bingo/engine';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { useGame, type Table } from '../state/store.ts';
import { Confetti, CurrencyIcon } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { GameHeader, Stage } from '../ui/Stage.tsx';
import './games.css';


export function FairChip({ nonce, commitment }: { nonce: number | null; commitment: string }) {
  const openPopup = useGame((s) => s.openPopup);
  return (
    <button type="button" className="fair-chip" onClick={() => openPopup('fairness')} title="Provably fair — tap to verify">
      🔐 {nonce === null ? 'fair' : `#${nonce}`} · {commitment.slice(0, 8)}…
    </button>
  );
}

export function CasinoShell({ mode, children, controls }: { mode: ModeId; children: ReactNode; controls: ReactNode }) {
  const go = useGame((s) => s.go);
  const info = modeInfo(mode);
  return (
    <Stage bg={art.bgGame} top={<GameHeader title={info.name} onBack={() => go({ name: 'casino' })} />} bottom="none" className="casino">
      <div className="casino__body">{children}</div>
      <footer className="casino__controls wood-bar">{controls}</footer>
    </Stage>
  );
}

export function WinBanner({ amount, multiplier, table, onDone }: { amount: number; multiplier?: number; table?: Table; onDone(): void }) {
  const active = useGame((s) => s.table);
  const paid = table ?? active;
  useEffect(() => {
    sfx.win();
    const id = window.setTimeout(onDone, 2200);
    return () => window.clearTimeout(id);
  }, [onDone]);
  const big = multiplier !== undefined && multiplier >= 10;
  return (
    <>
      {big && <Confetti />}
      <div className="win-banner anim-pop" onClick={onDone}>
        <span className="t-outline t-outline--wood">{big ? 'BIG WIN!' : 'WIN!'}</span>
        <b className="t-outline t-outline--green">
          <CurrencyIcon table={paid} size={2.6} /> +{formatCoins(amount)}
        </b>
        {multiplier !== undefined && <small>{multiplier.toLocaleString('en-US', { maximumFractionDigits: 2 })}×</small>}
      </div>
    </>
  );
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  render,
}: {
  options: readonly T[];
  value: T;
  onChange(v: NoInfer<T>): void;
  disabled?: boolean;
  render?: (v: NoInfer<T>) => ReactNode;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={String(o)}
          type="button"
          role="radio"
          aria-checked={o === value}
          className={o === value ? 'is-on' : ''}
          disabled={disabled}
          onClick={() => {
            sfx.click();
            onChange(o);
          }}
        >
          {render ? render(o) : String(o)}
        </button>
      ))}
    </div>
  );
}

