import { lazy, Suspense, useEffect } from 'react';
import { art } from './assets/art.ts';
import { setMusic, sfx } from './lib/audio.ts';
import { useGame, type Screen } from './state/store.ts';
import { Toasts } from './ui/kit.tsx';
import { toast } from './ui/toast.ts';
import { Splash } from './screens/Splash.tsx';
import { Home } from './screens/Home.tsx';
import { PopupHost } from './popups/PopupHost.tsx';

const AdventureMap = lazy(() => import('./screens/AdventureMap.tsx'));
const AdventureGame = lazy(() => import('./screens/AdventureGame.tsx'));
const ModeList = lazy(() => import('./screens/ModeList.tsx'));
const TidePool = lazy(() => import('./games/TidePool.tsx'));
const Riptide = lazy(() => import('./games/Riptide.tsx'));
const CrabDig = lazy(() => import('./games/CrabDig.tsx'));
const ShellSpin = lazy(() => import('./games/ShellSpin.tsx'));
const VideoBingo = lazy(() => import('./games/VideoBingo.tsx'));
const Keno = lazy(() => import('./games/Keno.tsx'));
const Blitz = lazy(() => import('./games/Blitz.tsx'));
const RoomGame = lazy(() => import('./rooms/RoomGame.tsx'));
const Royale = lazy(() => import('./rooms/Royale.tsx'));

function ScreenView({ screen }: { screen: Screen }) {
  switch (screen.name) {
    case 'splash':
      return <Splash />;
    case 'home':
      return <Home />;
    case 'map':
      return <AdventureMap page={screen.page} />;
    case 'adventure':
      return (
        <AdventureGame key={`${screen.level}-${String(screen.seagull)}-${String(screen.sun)}`} levelId={screen.level} seagull={screen.seagull} sun={screen.sun} />
      );
    case 'casino':
      return <ModeList kind="house" />;
    case 'rooms':
      return <ModeList kind="pvp" />;
    case 'game':
      switch (screen.mode) {
        case 'tidePool':
          return <TidePool />;
        case 'riptide':
          return <Riptide />;
        case 'crabDig':
          return <CrabDig />;
        case 'shellSpin':
          return <ShellSpin />;
        case 'videoBingo':
          return <VideoBingo />;
        case 'keno':
          return <Keno />;
        case 'blitz':
          return <Blitz />;
        case 'lastCastle':
          return <Royale />;
        case 'sunsetHall':
        case 'pierHall':
        case 'waveRush':
        case 'riptideDuel':
          return <RoomGame key={screen.mode} preset={screen.mode} />;
        default:
          return <Home />;
      }
  }
}

export function App() {
  const screen = useGame((s) => s.screen);
  const music = useGame((s) => s.settings.music);
  const reduceMotion = useGame((s) => s.settings.reduceMotion);
  const reminder = useGame((s) => s.limits.reminderMinutes);

  // Browsers only allow audio after a gesture: start music on the first tap.
  useEffect(() => {
    const start = () => {
      sfx.unlock();
      setMusic(useGame.getState().settings.music);
    };
    window.addEventListener('pointerdown', start, { once: true });
    return () => window.removeEventListener('pointerdown', start);
  }, []);

  useEffect(() => {
    if (screen.name !== 'splash') setMusic(music);
  }, [music, screen.name]);

  // Responsible-play reality check.
  useEffect(() => {
    if (!reminder) return;
    const id = window.setInterval(() => {
      const minutes = Math.round((Date.now() - useGame.getState().sessionStart) / 60000);
      if (minutes > 0 && minutes % reminder === 0) toast(`You've been playing for ${minutes} minutes. Time for a stretch? 🌴`, 'warn');
    }, 60_000);
    return () => window.clearInterval(id);
  }, [reminder]);

  const backdrop = screen.name === 'splash' ? art.bgSplash : screen.name === 'home' ? art.bgHomeIsland : art.bgGame;
  return (
    <div className={`app ${reduceMotion ? 'reduce-motion' : ''}`}>
      <div className="app__backdrop" style={{ backgroundImage: `url(${backdrop})` }} />
      <Suspense fallback={<div className="stage" style={{ backgroundImage: `url(${backdrop})` }} />}>
        <ScreenView screen={screen} />
        <PopupHost />
        <Toasts />
      </Suspense>
      <div className="rotate-hint">
        <span className="rotate-hint__icon" aria-hidden="true">
          📱
        </span>
        <p>Turn your phone upright to play Beach Bingo.</p>
      </div>
    </div>
  );
}
