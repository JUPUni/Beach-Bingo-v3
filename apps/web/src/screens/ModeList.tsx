import { useState } from 'react';
import { MODES, type ModeKind } from '@beach-bingo/engine';
import { MODE_ICONS } from './modeIcons.ts';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { isCode, normalizeCode } from '../rooms/live/protocol.ts';
import { useGame } from '../state/store.ts';
import { Balances, GreenButton } from '../ui/kit.tsx';
import { GameHeader, Stage } from '../ui/Stage.tsx';
import './screens.css';
import '../rooms/rooms.css';

/** Type a friend's room code to join their hall. */
function JoinBox() {
  const go = useGame((s) => s.go);
  const [code, setCode] = useState('');
  return (
    <form
      className="panel join-box"
      onSubmit={(e) => {
        e.preventDefault();
        if (isCode(code)) go({ name: 'live', code, host: false });
      }}
    >
      <label htmlFor="join-code">Have a room code?</label>
      <input
        id="join-code"
        className="field"
        value={code}
        onChange={(e) => setCode(normalizeCode(e.target.value))}
        placeholder="ABC23"
        maxLength={5}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        aria-label="Room code"
      />
      <GreenButton type="submit" disabled={!isCode(code)}>
        Join
      </GreenButton>
    </form>
  );
}

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
            : 'Play the same balls as your friends. Open a hall, share the code, or practise with bots.'}
        </p>
        <div className="panel table-row">
          <span>Playing with</span>
          <Balances />
        </div>
        {kind === 'pvp' && <JoinBox />}
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
          <b>SAND is free</b> and never bought or sold. Coins come from the Coin Shop, have no cash value and never leave the game.
          Prices and prizes are the same on either table. House games use HMAC-SHA256 commit–reveal seeds you can verify in
          Settings → Provably fair
          {kind === 'pvp'
            ? '. Each hall opens as a practice room with labelled bots; "Play with friends" turns it into a live room where every phone checks every ball and every win.'
            : '.'}
        </p>
      </div>
    </Stage>
  );
}
