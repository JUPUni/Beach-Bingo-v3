import { useEffect, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { letterFor } from '@beach-bingo/engine';
import { ballColor, formatCoins } from './format.ts';
import { useToasts } from './toast.ts';
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

export function CoinIcon({ size = 2.4 }: { size?: number }) {
  return <img src={art.iconCoin} alt="" className="coin-icon" style={{ width: `${size}rem`, height: `${size}rem` }} />;
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
export function Counter({ value, duration = 600 }: { value: number; duration?: number }) {
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
  return <>{shown.toLocaleString('en-US')}</>;
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
          <CoinIcon size={1.8} /> {formatCoins(value)}
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
