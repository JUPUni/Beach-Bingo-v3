import { useEffect, type ReactNode } from 'react';
import { art } from '../assets/art.ts';
import { CHEST_KEYS, useGame } from '../state/store.ts';
import { Counter, RoundButton } from './kit.tsx';
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
  const coins = useGame((s) => s.coins);
  const keys = useGame((s) => s.keys);
  const avatar = useGame((s) => s.profile.avatar);
  const openPopup = useGame((s) => s.openPopup);

  return (
    <header className="topbar wood-bar">
      <button type="button" className="topbar__avatar" aria-label="Edit profile" onClick={() => openPopup('profile')}>
        <span>{avatar}</span>
      </button>
      <button type="button" className="chip chip--plus topbar__coins" aria-label="Coins — get more" onClick={() => openPopup('faucet')}>
        <img src={art.iconCoin} alt="" className="chip__icon" />
        <span className="t-outline t-outline--wood">
          <Counter value={coins} />
        </span>
      </button>
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

/** Compact header for game screens: back button + title + coins. */
export function GameHeader({ title, onBack, right }: { title: string; onBack: () => void; right?: ReactNode }) {
  const coins = useGame((s) => s.coins);
  return (
    <header className="gamehead wood-bar">
      <button type="button" className="gamehead__back" aria-label="Back" onClick={onBack}>
        <img src={art.btnArrowLeft} alt="" />
      </button>
      <h1 className={`gamehead__title t-outline t-outline--wood ${title.length > 15 ? 'gamehead__title--long' : ''}`}>{title}</h1>
      {right ?? (
        <div className="chip gamehead__coins">
          <img src={art.iconCoin} alt="" className="chip__icon" />
          <span className="t-outline t-outline--wood">
            <Counter value={coins} />
          </span>
        </div>
      )}
    </header>
  );
}
