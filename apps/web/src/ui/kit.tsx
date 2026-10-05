import { useEffect, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { letterFor } from '@beach-bingo/engine';
import { TABLE_NAME, useGame, type Table } from '../state/store.ts';
import { ballColor, formatCoins, formatCompact } from './format.ts';
import { toast, useToasts } from './toast.ts';
import './kit.css';

type Tone = 'green' | 'red' | 'gold' | 'blue';

export function GreenButton({
  tone = 'green',
  className = '',
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone }) {
  return (
    <button
      type="button"
      className={`btn-green ${tone === 'green' ? '' : `btn-green--${tone}`} ${className}`}
      onClick={(e) => {
        sfx.click();
        onClick?.(e);
      }}
      {...rest}
    >
      <span className="btn-label">{children}</span>
    </button>
  );
}

export function RoundButton({
  img,
  label,
  size = 6,
  className = '',
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { img: string; label: string; size?: number }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`round-btn ${className}`}
      style={{ backgroundImage: `url(${img})`, width: `${size}rem`, height: `${size}rem` }}
      onClick={(e) => {
        sfx.click();
        onClick?.(e);
      }}
      {...rest}
    >
      {children}
    </button>
  );
}

/** `size` in rem; leave it out where a stylesheet sizes the icon (a chip, a pill). */
const iconSize = (size?: number) => (size === undefined ? undefined : { width: `${size}rem`, height: `${size}rem` });

export function CoinIcon({ size, className = '' }: { size?: number; className?: string }) {
  return <img src={art.iconCoin} alt="" className={`coin-icon ${className}`} style={iconSize(size)} />;
}

/** Shells, the free currency: the brand's shell (packages/brand/src/draw.mjs) at icon scale, in the game's warmer pink. */
export function ShellIcon({ size, className = '' }: { size?: number; className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={`coin-icon shell-icon ${className}`} style={iconSize(size)} aria-hidden="true">
      <path d="M16.86 31.76L20.94 35.5L22.98 39.24H25.02L27.06 35.5L31.14 31.76Z" fill="#ff4d97" stroke="#4a0d2a" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M20.94 35.5L7 27.85Q4.3 21.72 9.28 18.5Q9.58 12.58 15.5 12.28Q18.72 7.3 24 10Q29.28 7.3 32.5 12.28Q38.42 12.58 38.72 18.5Q43.7 21.72 41 27.85L27.06 35.5Z" fill="#ff4d97" stroke="#4a0d2a" strokeWidth="2.4" strokeLinejoin="round" />
      <path d="M12.6 18.4Q14.2 13.6 19.4 12.3" fill="none" stroke="#ffc1dc" strokeWidth="2.2" strokeLinecap="round" />
      <path d="M24 34.65L12.52 20.37M24 34.65L17.37 15.52M24 34.65L24 13.74M24 34.65L30.63 15.52M24 34.65L35.48 20.37" fill="none" stroke="#4a0d2a" strokeWidth="1.68" strokeLinecap="round" />
    </svg>
  );
}

export function CurrencyIcon({ table, size, className = '' }: { table: Table; size?: number; className?: string }) {
  return table === 'shells' ? <ShellIcon size={size} className={className} /> : <CoinIcon size={size} className={className} />;
}

/** The one place the table changes: shells or coins. Coins go through the age gate and the region check first. */
export function TableSwitch({ className = '' }: { className?: string }) {
  const table = useGame((s) => s.table);
  const coins = table === 'coins';
  const flip = () => {
    sfx.click();
    const s = useGame.getState();
    if (coins) return s.setTable('shells');
    if (s.requestCoins('table') === 'blocked') toast(s.coinsBlockedReason() ?? '', 'warn');
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={coins}
      aria-label={coins ? 'Playing with coins. Switch to shells' : 'Playing with shells. Switch to coins'}
      className={`table-switch table-switch--${table} ${className}`}
      onClick={flip}
    >
      <span className="table-switch__knob">
        <CurrencyIcon table={table} size={1.9} />
      </span>
    </button>
  );
}

/** Both balances with the switch between them; the active table's chip is lit. */
export function Balances({ className = '' }: { className?: string }) {
  const shells = useGame((s) => s.shells);
  const coins = useGame((s) => s.coins);
  const table = useGame((s) => s.table);
  const freeGames = useGame((s) => s.freeGames);
  const openPopup = useGame((s) => s.openPopup);
  const openShop = () => {
    const s = useGame.getState();
    if (s.requestCoins('shop') === 'blocked') toast(s.coinsBlockedReason() ?? '', 'warn');
  };
  return (
    <div className={`balances ${className}`}>
      <button
        type="button"
        className={`chip chip--plus balance balance--shells ${table === 'shells' ? 'is-on' : ''}`}
        aria-label="Shells — free from the tide"
        onClick={() => (sfx.click(), openPopup('faucet'))}
      >
        <ShellIcon className="chip__icon" />
        <span className="t-outline t-outline--wood">
          <Counter value={shells} format={formatCompact} />
        </span>
      </button>
      <TableSwitch />
      <button type="button" className={`chip balance balance--coins ${table === 'coins' ? 'is-on' : ''}`} aria-label="Coins — Coin Shop" onClick={() => (sfx.click(), openShop())}>
        <img src={art.iconCoin} alt="" className="chip__icon" />
        <span className="t-outline t-outline--wood">
          <Counter value={coins} format={formatCompact} />
        </span>
        {freeGames > 0 && (
          <small className="balance__free">
            {freeGames} free game{freeGames > 1 ? 's' : ''}
          </small>
        )}
      </button>
    </div>
  );
}

/** A prize, with the currency it was paid in. */
export function RewardPill({ amount, table }: { amount: number; table: Table }) {
  return (
    <div className={`reward-pill reward-pill--${table}`}>
      {table === 'shells' && <ShellIcon size={3} className="reward-pill__icon" />}
      +{formatCoins(amount)} <small>{TABLE_NAME[table]}</small>
    </div>
  );
}


/* ---------- Stars (the kit's gold / empty star art) ---------- */
export function Star({ filled, size = 3 }: { filled: boolean; size?: number }) {
  return (
    <img
      src={filled ? art.starGold : art.starEmpty}
      alt=""
      className={`star ${filled ? 'star--on' : ''}`}
      style={{ width: `${size}rem`, height: `${size * 0.94}rem` }}
    />
  );
}

export function Stars({ count, size = 3, arc = false }: { count: number; size?: number; arc?: boolean }) {
  return (
    <div className={`stars ${arc ? 'stars--arc' : ''}`}>
      {[0, 1, 2].map((i) => (
        <Star key={i} filled={i < count} size={arc && i === 1 ? size * 1.25 : size} />
      ))}
    </div>
  );
}

/* ---------- Bingo ball ---------- */
export function Ball({
  n,
  variant = '75',
  size = 4.4,
  className = '',
  style,
}: {
  n: number;
  variant?: string;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`ball ${className}`}
      style={{ '--ball': ballColor(n, variant), width: `${size}rem`, height: `${size}rem`, fontSize: `${size / 2.6}rem`, ...style } as CSSProperties}
    >
      <div className="ball__face">
        {variant === '75' && <small>{letterFor(n)}</small>}
        <b>{n}</b>
      </div>
    </div>
  );
}

/* ---------- Ribbon title ---------- */
export function Ribbon({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="ribbon">
      <img src={art.ribbonHeader} alt="" className="ribbon__img" />
      <h2 className="ribbon__title t-outline t-outline--green">{children}</h2>
      {onClose && (
        <button type="button" className="ribbon__close" aria-label="Close" onClick={onClose}>
          <img src={art.btnClose} alt="" />
        </button>
      )}
    </div>
  );
}

/* ---------- Toasts ---------- */
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.tone} anim-pop`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/* ---------- Celebration ---------- */
export function Confetti({ pieces = 60 }: { pieces?: number }) {
  const [items] = useState(() =>
    Array.from({ length: pieces }, (_, i) => ({
      left: Math.random() * 100,
      delay: Math.random() * 0.6,
      dur: 1.6 + Math.random() * 1.4,
      rot: Math.random() * 360,
      color: ['#ffc21a', '#ff3d8b', '#2fb34a', '#2f7de1', '#fff', '#ff8a00'][i % 6],
      w: 0.6 + Math.random() * 0.6,
    })),
  );
  return (
    <div className="confetti" aria-hidden>
      {items.map((p, i) => (
        <i
          key={i}
          style={{
            left: `${p.left}%`,
            animationDelay: `${p.delay}s`,
            animationDuration: `${p.dur}s`,
            background: p.color,
            width: `${p.w}rem`,
            transform: `rotate(${p.rot}deg)`,
          }}
        />
      ))}
    </div>
  );
}

/** Animated number that counts toward `value`. */
export function Counter({ value, duration = 600, format = (n: number) => n.toLocaleString('en-US') }: { value: number; duration?: number; format?: (n: number) => string }) {
  const [shown, setShown] = useState(value);
  useEffect(() => {
    const from = shown;
    if (from === value) return;
    const start = performance.now();
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      setShown(Math.round(from + (value - from) * (1 - (1 - k) ** 3)));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, duration]);
  return <>{format(shown)}</>;
}

/* ---------- Stake picker ---------- */
export function StakePicker({
  value,
  options,
  onChange,
  disabled,
  label = 'Bet',
}: {
  value: number;
  options: readonly number[];
  onChange(v: number): void;
  disabled?: boolean;
  label?: string;
}) {
  const i = Math.max(0, options.indexOf(value));
  const table = useGame((s) => s.table);
  return (
    <div className="stake-picker">
      <button
        type="button"
        className="stake-picker__btn"
        disabled={disabled || i === 0}
        aria-label="Lower bet"
        onClick={() => {
          sfx.click();
          onChange(options[i - 1]!);
        }}
      >
        −
      </button>
      <div className="stake-picker__value">
        <small>{label}</small>
        <span className="display">
          <CurrencyIcon table={table} size={1.8} /> {formatCoins(value)}
        </span>
      </div>
      <button
        type="button"
        className="stake-picker__btn"
        disabled={disabled || i === options.length - 1}
        aria-label="Raise bet"
        onClick={() => {
          sfx.click();
          onChange(options[i + 1]!);
        }}
      >
        +
      </button>
    </div>
  );
}
