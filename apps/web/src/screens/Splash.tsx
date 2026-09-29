import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { useGame } from '../state/store.ts';
import { Stage } from '../ui/Stage.tsx';
import './screens.css';

export function Logo({ small = false }: { small?: boolean }) {
  return (
    <div className={`logo ${small ? 'logo--small' : ''}`} role="img" aria-label="Beach Bingo">
      <img src={art.logoLeaves} alt="" className="logo__leaves" />
      <div className="logo__words">
        {['BEACH', 'BINGO'].map((word) => (
          <span key={word} className="logo__word">
            <span className="logo__stroke" aria-hidden>
              {word}
            </span>
            <span className="logo__fill">{word}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Splash() {
  const go = useGame((s) => s.go);
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
          go({ name: 'home' });
        }}
      >
        <span className="sign__label">Play</span>
      </button>
      <img src={art.chestShadow} alt="" className="splash__chest-shadow" />
      <img src={art.chestSplash} alt="" className="splash__chest" />
      <p className="splash__legal">Provably fair · Free to play · beachbingo.xyz</p>
    </Stage>
  );
}
