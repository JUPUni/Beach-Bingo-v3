import { useState } from 'react';
import { adventure, PATTERNS_75, type LevelDef } from '@beach-bingo/engine';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { unlockedLevel, useGame } from '../state/store.ts';
import { GreenButton, Stars } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { PatternPreview } from '../ui/PatternPreview.tsx';
import { Popup } from '../ui/Popup.tsx';
import { Stage } from '../ui/Stage.tsx';
import './adventure.css';

const PER_PAGE = 20;
const STAR_ROWS = [art.stars0, art.stars1, art.stars2, art.stars3];

export default function AdventureMap({ page: initialPage }: { page?: number }) {
  const stars = useGame((s) => s.stars);
  const go = useGame((s) => s.go);
  const unlocked = unlockedLevel(stars);
  const [page, setPage] = useState(initialPage ?? Math.floor((Math.min(unlocked, adventure.LEVELS.length) - 1) / PER_PAGE));
  const [picked, setPicked] = useState<LevelDef | null>(null);
  const pages = Math.ceil(adventure.LEVELS.length / PER_PAGE);
  const levels = adventure.LEVELS.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE);
  const zones = [...new Set(levels.map((l) => l.zone))].map((z) => adventure.ZONES[z - 1]!.name);

  return (
    <Stage bg={art.bgLevelMap}>
      <div className="map">
        <h2 className="map__title t-outline t-outline--navy">{zones.join(' · ')}</h2>
        <div className="map__grid">
          {levels.map((level) => {
            const earned = stars[level.id] ?? 0;
            const locked = level.id > unlocked;
            const current = level.id === unlocked;
            return (
              <button
                key={level.id}
                type="button"
                className={`level-tile ${locked ? 'is-locked' : ''} ${current ? 'is-current' : ''}`}
                onClick={() => {
                  if (locked) {
                    sfx.miss();
                    toast('Beat the previous level to unlock this one 🔒');
                    return;
                  }
                  sfx.click();
                  setPicked(level);
                }}
                aria-label={`Level ${level.id}${locked ? ', locked' : `, ${earned} stars`}`}
              >
                <img className="level-tile__stars" src={STAR_ROWS[locked ? 0 : earned]} alt="" />
                <span
                  className="level-tile__face"
                  style={{ backgroundImage: `url(${locked ? art.levelTileLocked : earned ? art.levelTileOpen : art.levelTileCurrent})` }}
                >
                  {!locked && <span className="level-tile__num">{level.id}</span>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="map__footer">
          <GreenButton className="map__back" onClick={() => go({ name: 'home' })}>
            Back
          </GreenButton>
          <button
            type="button"
            className="map__arrow"
            disabled={page === 0}
            aria-label="Previous page"
            onClick={() => (sfx.click(), setPage((p) => p - 1))}
          >
            <img src={art.btnArrowLeft} alt="" />
          </button>
          <button
            type="button"
            className="map__arrow"
            disabled={page >= pages - 1}
            aria-label="Next page"
            onClick={() => (sfx.click(), setPage((p) => p + 1))}
          >
            <img src={art.btnArrowRight} alt="" />
          </button>
        </div>
      </div>
      {picked && <LevelStartPopup level={picked} onClose={() => setPicked(null)} />}
    </Stage>
  );
}

function LevelStartPopup({ level, onClose }: { level: LevelDef; onClose(): void }) {
  const stars = useGame((s) => s.stars[level.id] ?? 0);
  const boosters = useGame((s) => s.boosters);
  const coins = useGame((s) => s.coins);
  const spend = useGame((s) => s.spend);
  const addBooster = useGame((s) => s.addBooster);
  const consumeBooster = useGame((s) => s.consumeBooster);
  const go = useGame((s) => s.go);
  const [seagull, setSeagull] = useState(false);
  const [sun, setSun] = useState(false);
  const pattern = PATTERNS_75[level.pattern];

  const toggle = (id: 'seagull' | 'sun', on: boolean, set: (v: boolean) => void) => {
    if (on) return set(false);
    if (boosters[id] > 0) return set(true);
    const price = adventure.BOOSTERS[id].price;
    if (coins >= price && spend(price)) {
      addBooster(id, 1);
      sfx.coin();
      toast(`Bought ${adventure.BOOSTERS[id].name}`, 'win');
      set(true);
    } else {
      toast(`${adventure.BOOSTERS[id].name} costs ${price} coins`, 'warn');
    }
  };

  return (
    <Popup
      title={`Level ${level.id}`}
      onClose={onClose}
      footer={
        <GreenButton
          onClick={() => {
            go({
              name: 'adventure',
              level: level.id,
              seagull: seagull && consumeBooster('seagull'),
              sun: sun && consumeBooster('sun'),
            });
          }}
        >
          ▶ Play
        </GreenButton>
      }
    >
      <div className="popup-center">
        <Stars count={stars} size={4} arc />
        <div className="level-goal">
          <PatternPreview pattern={level.pattern} size={1.6} />
          <div>
            <b>{pattern.name}</b>
            <span>
              {level.cards} card{level.cards > 1 ? 's' : ''} · {level.maxBalls} balls
            </span>
            <span>
              3★ by ball {level.stars[0]} · 2★ by {level.stars[1]}
            </span>
          </div>
        </div>
        <h3>Select boosts</h3>
        <div className="boost-pick">
          {(['seagull', 'sun'] as const).map((id) => {
            const on = id === 'seagull' ? seagull : sun;
            return (
              <button
                key={id}
                type="button"
                className={`boost ${on ? 'is-on' : ''}`}
                onClick={() => (sfx.click(), toggle(id, on, id === 'seagull' ? setSeagull : setSun))}
                aria-pressed={on}
              >
                <span className="boost__icon">{id === 'seagull' ? '🕊️' : '☀️'}</span>
                <span className="boost__count">{boosters[id] > 0 ? boosters[id] : `${formatCoins(adventure.BOOSTERS[id].price)}🪙`}</span>
                <small>{id === 'seagull' ? 'Auto-daub' : '2× coins'}</small>
              </button>
            );
          })}
        </div>
        <p className="small-note">
          Reward: {level.reward}🪙 per star{sun ? ' ×2' : ''}. Crab Pinch and Big Wave can be used during play.
        </p>
      </div>
    </Popup>
  );
}
