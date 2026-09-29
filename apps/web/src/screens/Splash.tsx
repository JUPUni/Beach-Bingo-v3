import logoUrl from '../assets/brand/beachbingo-logo-sticker.svg';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { useGame } from '../state/store.ts';
import { Stage } from '../ui/Stage.tsx';
import './screens.css';

export function Logo({ small = false }: { small?: boolean }) {
  return <img src={logoUrl} alt="Beach Bingo" className={`logo ${small ? 'logo--small' : ''}`} width={600} height={514} />;
}

export function Splash() {
  const go = useGame((s) => s.go);
  const pendingJoin = useGame((s) => s.pendingJoin);
  const setPendingJoin = useGame((s) => s.setPendingJoin);
  return (
    <Stage bg={art.bgSplash} top="none" bottom="none" className="splash">
      <img src={art.cloud1} alt="" className="splash__cloud splash__cloud--a" />
      <img src={art.cloud2} alt="" className="splash__cloud splash__cloud--b" />
      <div className="splash__logo anim-pop">
        <Logo />
      </div>
      <button
        type="button"
        className="sign splash__play anim-float"
        onClick={() => {
          sfx.unlock();
          sfx.win();
          if (pendingJoin) {
            setPendingJoin(null);
            go({ name: 'live', code: pendingJoin, host: false });
          } else {
            go({ name: 'home' });
          }
        }}
      >
        <span className="sign__label">{pendingJoin ? 'Join' : 'Play'}</span>
      </button>
      {pendingJoin && <p className="splash__join t-outline t-outline--navy">Room {pendingJoin} is waiting for you</p>}
      <img src={art.chestShadow} alt="" className="splash__chest-shadow" />
      <img src={art.chestSplash} alt="" className="splash__chest" />
      <p className="splash__legal">Provably fair · Free to play · beachbingo.xyz</p>
    </Stage>
  );
}
