import { adventure } from '@beach-bingo/engine';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { CHEST_KEYS, unlockedLevel, useGame } from '../state/store.ts';
import { Stage } from '../ui/Stage.tsx';
import './screens.css';

export function Home() {
  const go = useGame((s) => s.go);
  const stars = useGame((s) => s.stars);
  const keys = useGame((s) => s.keys);
  const openPopup = useGame((s) => s.openPopup);
  const next = Math.min(unlockedLevel(stars), adventure.LEVELS.length);
  const zone = adventure.ZONES[Math.floor((next - 1) / adventure.LEVELS_PER_ZONE)]!;
  const zoneStart = (zone.id - 1) * adventure.LEVELS_PER_ZONE + 1;
  const zoneDone = Array.from({ length: adventure.LEVELS_PER_ZONE }, (_, i) => zoneStart + i).filter((id) => (stars[id] ?? 0) > 0).length;

  return (
    <Stage bg={art.bgHomeIsland}>
      <div className="home">
        <div className="home__signs">
          <button type="button" className="mode-sign anim-float" onClick={() => (sfx.click(), go({ name: 'casino' }))}>
            <span className="mode-sign__icon">🎰</span>
            <span className="t-outline t-outline--wood">Casino Cove</span>
            <small>Spin · Riptide · Keno</small>
          </button>
          <button
            type="button"
            className="mode-sign anim-float"
            style={{ animationDelay: '0.6s' }}
            onClick={() => (sfx.click(), go({ name: 'rooms' }))}
          >
            <span className="mode-sign__icon">🏝️</span>
            <span className="t-outline t-outline--wood">Beach Rooms</span>
            <small>Bingo halls · Duels</small>
          </button>
        </div>

        <div className="home__bottom">
          <button type="button" className="btn-green home__level" onClick={() => (sfx.click(), go({ name: 'map' }))}>
            <span className="btn-label">Level {next}</span>
          </button>
          <button type="button" className="zone-chip" onClick={() => openPopup('chest')} aria-label="Zone progress and treasure chest">
            <span className="zone-chip__name btn-label">{zone.name}</span>
            <span className="zone-chip__bar">
              <i style={{ width: `${(zoneDone / adventure.LEVELS_PER_ZONE) * 100}%` }} />
              <b>
                {zoneDone}/{adventure.LEVELS_PER_ZONE}
              </b>
            </span>
            <img src={art.iconChestSmall} alt="" className="zone-chip__chest" />
            {keys > 0 && (
              <span className="badge">
                {Math.min(keys, CHEST_KEYS)}
              </span>
            )}
          </button>
        </div>
      </div>
    </Stage>
  );
}
