import { lazy, Suspense, useEffect } from 'react';
import { art } from './assets/art.ts';
import { setMusic, sfx } from './lib/audio.ts';
import { lookupRegion } from './lib/geo.ts';
import { joinCodeFromHash } from './rooms/live/protocol.ts';
import { CHAIN_SHOP_ENABLED } from './solana/config.ts';
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
const LiveRoom = lazy(() => import('./rooms/LiveRoom.tsx'));
const Royale = lazy(() => import('./rooms/Royale.tsx'));
/** The devnet build only: binds the chain Coin Shop and the wallet badges to the connected wallet. Production never loads it. */
const ChainBridge = CHAIN_SHOP_ENABLED ? lazy(() => import('./solana/ChainBridge.tsx')) : null;

/** `visit` is in the keys of the screens a player can open again from themselves (Replay, Play again), so each visit is a fresh round. */
function ScreenView({ screen, visit }: { screen: Screen; visit: number }) {
  switch (screen.name) {
    case 'splash':
      return <Splash />;
    case 'home':
      return <Home />;
    case 'map':
      return <AdventureMap page={screen.page} />;
    case 'adventure':
      return <AdventureGame key={`${visit}-${screen.level}`} levelId={screen.level} seagull={screen.seagull} sun={screen.sun} />;
    case 'casino':
      return <ModeList kind="house" />;
    case 'rooms':
      return <ModeList kind="pvp" />;
    case 'live':
      return <LiveRoom key={screen.code} code={screen.code} host={screen.host} preset={screen.preset} />;
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
          return <RoomGame key={`${visit}-${screen.mode}`} preset={screen.mode} />;
        default:
          return <Home />;
      }
  }
}

export function App() {
  const screen = useGame((s) => s.screen);
  const visit = useGame((s) => s.visit);
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

  // An invite link (…/app/#join=CODE) opens that room: after the splash on a cold start, at once otherwise.
  useEffect(() => {
    const check = () => {
      const code = joinCodeFromHash(location.hash);
      if (!code) return;
      history.replaceState(null, '', location.pathname + location.search);
      const s = useGame.getState();
      if (s.screen.name === 'splash') s.setPendingJoin(code);
      else s.go({ name: 'live', code, host: false });
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);

  // The region behind the coin gate, asked once per session; unknown fails open (lib/geo.ts).
  useEffect(() => {
    let on = true;
    void lookupRegion().then((region) => on && useGame.getState().setRegion(region));
    return () => {
      on = false;
    };
  }, []);

  // Back from the follow link: the claim in the tasks popup unlocks.
  useEffect(() => {
    const back = () => {
      const s = useGame.getState();
      if (document.visibilityState === 'visible' && s.follow === 'opened') s.setFollow('returned');
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
    };
  }, []);

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
        <ScreenView screen={screen} visit={visit} />
        <PopupHost />
        <Toasts />
        {ChainBridge && <ChainBridge />}
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
