import { useEffect, type ReactNode } from 'react';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { CHEST_KEYS, TABLE_NAME, useGame } from '../state/store.ts';
import { toast } from './toast.ts';
import { Balances, Counter, CurrencyIcon, RoundButton } from './kit.tsx';
import './stage.css';

export function Stage({
  bg,
  top = 'hud',
  bottom = 'nav',
  children,
  className = '',
}: {
  bg: string;
  top?: 'hud' | 'none' | ReactNode;
  bottom?: 'nav' | 'none' | ReactNode;
  children: ReactNode;
  className?: string;
}) {
  useEffect(() => {
    document.documentElement.style.setProperty('--scene', `url(${bg})`);
  }, [bg]);

  return (
    <div className={`stage ${className}`} style={{ backgroundImage: `url(${bg})` }}>
      {top === 'hud' ? <TopBar /> : top === 'none' ? null : top}
      <main className="stage__body">{children}</main>
      {bottom === 'nav' ? <BottomNav /> : bottom === 'none' ? null : bottom}
    </div>
  );
}

export function TopBar() {
  const keys = useGame((s) => s.keys);
  const avatar = useGame((s) => s.profile.avatar);
  const openPopup = useGame((s) => s.openPopup);

  return (
    <header className="topbar wood-bar">
      <button type="button" className="topbar__avatar" aria-label="Edit profile" onClick={() => openPopup('profile')}>
        <span>{avatar}</span>
      </button>
      <Balances className="topbar__balances" />
      <button type="button" className="chip chip--red topbar__keys" aria-label="Golden keys — treasure chest" onClick={() => openPopup('chest')}>
        <img src={art.iconKey} alt="" className="chip__icon" />
        <span className="t-outline t-outline--red">
          {keys}/{CHEST_KEYS}
        </span>
      </button>
    </header>
  );
}

export function BottomNav({ onHome }: { onHome?: () => void }) {
  const go = useGame((s) => s.go);
  const openPopup = useGame((s) => s.openPopup);
  const taskReady = useGame((s) => s.tasks.claimed.length < 4);
  return (
    <nav className="bottomnav">
      <div className="bottomnav__wood" />
      <RoundButton img={art.navBtnSettings} label="Settings" onClick={() => openPopup('settings')} />
      <RoundButton img={art.navBtnList} label="Daily tasks" onClick={() => openPopup('tasks')}>
        {taskReady && <span className="bottomnav__dot" />}
      </RoundButton>
      <RoundButton img={art.navBtnHome} label="Home" onClick={() => (onHome ? onHome() : go({ name: 'home' }))} />
    </nav>
  );
}

/** Compact header for game screens: back button + title + the active table's balance. */
export function GameHeader({ title, onBack, right }: { title: string; onBack: () => void; right?: ReactNode }) {
  const table = useGame((s) => s.table);
  const balance = useGame((s) => s[s.table]);
  const openBalance = () => {
    sfx.click();
    const s = useGame.getState();
    if (s.table === 'sand') return s.openPopup('faucet');
    if (s.requestCoins('shop') === 'blocked') toast(s.coinsBlockedReason() ?? '', 'warn');
  };
  return (
    <header className="gamehead wood-bar">
      <button type="button" className="gamehead__back" aria-label="Back" onClick={onBack}>
        <img src={art.btnArrowLeft} alt="" />
      </button>
      <h1 className={`gamehead__title t-outline t-outline--wood ${title.length > 15 ? 'gamehead__title--long' : ''}`}>{title}</h1>
      {right ?? (
        <button type="button" className={`chip gamehead__coins gamehead__coins--${table}`} aria-label={`${TABLE_NAME[table]} balance`} onClick={openBalance}>
          <CurrencyIcon table={table} className="chip__icon" />
          <span className="t-outline t-outline--wood">
            <Counter value={balance} />
          </span>
        </button>
      )}
    </header>
  );
}
