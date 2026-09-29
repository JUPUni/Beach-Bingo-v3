import { MODES, type ModeKind } from '@beach-bingo/engine';
import { MODE_ICONS } from './modeIcons.ts';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { useGame } from '../state/store.ts';
import { GameHeader, Stage } from '../ui/Stage.tsx';
import './screens.css';


export default function ModeList({ kind }: { kind: Extract<ModeKind, 'house' | 'pvp'> }) {
  const go = useGame((s) => s.go);
  const modes = MODES.filter((m) => m.kind === kind);
  return (
    <Stage
      bg={kind === 'house' ? art.bgLevelMap : art.bgGame}
      top={<GameHeader title={kind === 'house' ? 'Casino Cove' : 'Beach Rooms'} onBack={() => go({ name: 'home' })} />}
    >
      <div className="modes scroll">
        <p className="modes__intro">
          {kind === 'house'
            ? 'Instant games against the island bank. Every result is provably fair.'
            : 'Play the same balls as everyone else. Prize pools come from ticket sales.'}
        </p>
        {modes.map((mode, i) => (
          <button
            key={mode.id}
            type="button"
            className="panel mode-card anim-pop"
            style={{ animationDelay: `${i * 0.05}s` }}
            onClick={() => {
              sfx.click();
              go({ name: 'game', mode: mode.id });
            }}
          >
            <span className="mode-card__icon">{MODE_ICONS[mode.id]}</span>
            <span>
              <h2>{mode.name}</h2>
              <p>{mode.tagline}</p>
              <span className="mode-card__meta">
                <span>👥 {mode.players}</span>
                <span>⏱ {mode.roundTime}</span>
                <span>{kind === 'house' ? 'RTP' : 'Pays'} {mode.returnToPlayer}</span>
              </span>
            </span>
            <span className="mode-card__go">›</span>
          </button>
        ))}
        <p className="fair-note">
          <b>Play money only.</b> Coins are free and have no cash value. House games use HMAC-SHA256 commit–reveal seeds you can
          verify in Settings → Provably fair{kind === 'pvp' ? '. Practice rooms are filled with labelled bots until live rooms open.' : '.'}
        </p>
      </div>
    </Stage>
  );
}
