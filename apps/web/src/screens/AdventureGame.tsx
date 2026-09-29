import { useEffect, useRef, useState } from 'react';
import { adventure, PATTERNS_75 } from '@beach-bingo/engine';
import { art } from '../assets/art.ts';
import { callBall as speakBall, say, sfx } from '../lib/audio.ts';
import { newRound } from '../lib/fair.ts';
import { clock, useInterval, useModel, useTimeouts } from '../lib/hooks.ts';
import { unlockedLevel, useGame } from '../state/store.ts';
import { BingoGrid } from '../ui/BingoGrid.tsx';
import { Ball, Confetti, GreenButton, RoundButton, Stars, Counter } from '../ui/kit.tsx';
import { toast } from '../ui/toast.ts';
import { PatternPreview } from '../ui/PatternPreview.tsx';
import { Popup } from '../ui/Popup.tsx';
import { Stage } from '../ui/Stage.tsx';
import './adventure.css';

type Phase = 'ready' | 'playing' | 'grace' | 'won' | 'lost';

const GRACE_MS = 4000;
const WAVE_PRICE = adventure.BOOSTERS.wave.price;

export default function AdventureGame({ levelId, seagull, sun }: { levelId: number; seagull?: boolean; sun?: boolean }) {
  const level = adventure.LEVELS[levelId - 1]!;
  const go = useGame((s) => s.go);
  const boosters = useGame((s) => s.boosters);
  const consumeBooster = useGame((s) => s.consumeBooster);
  const completeLevel = useGame((s) => s.completeLevel);
  const spend = useGame((s) => s.spend);
  const track = useGame((s) => s.track);
  const playedMode = useGame((s) => s.playedMode);
  const later = useTimeouts();
  const { model: run, commit: render } = useModel(() =>
    adventure.startLevel(level, newRound('adventure').rng('level'), { autoDaub: seagull, doubleCoins: sun }),
  );
  const calledAt = useRef(new Map<number, number>());
  const [hints, setHints] = useState<number[]>(() => run.cards.map(() => 0));
  const [phase, setPhase] = useState<Phase>('ready');
  const [countdown, setCountdown] = useState(3);
  const [crabMode, setCrabMode] = useState(false);
  const [result, setResult] = useState<{ stars: number; coins: number; newKey: boolean } | null>(null);
  const [shakeCard, setShakeCard] = useState(-1);

  useEffect(() => playedMode('adventure'), [playedMode]);

  /** Squares whose number was called a while ago but is still not daubed. */
  const refreshHints = () => {
    const now = performance.now();
    const hintAfter = level.callMs * 0.7;
    setHints(
      run.cards.map((_, i) => {
        let mask = 0;
        for (let b = 0; b < run.drawnCount; b++) {
          const ball = run.drum[b]!;
          if (now - (calledAt.current.get(ball) ?? 0) < hintAfter) continue;
          const cell = run.lookups[i]![ball] ?? -1;
          if (cell >= 0) mask |= 1 << cell;
        }
        return mask;
      }),
    );
  };

  const nextBall = () => {
    const ball = adventure.callBall(run);
    if (ball === null) {
      setPhase('grace');
      later(() => {
        if (run.status === 'playing') {
          adventure.outOfBalls(run);
          sfx.lose();
          setPhase('lost');
        }
      }, GRACE_MS);
      return;
    }
    calledAt.current.set(ball, performance.now());
    sfx.ball();
    speakBall(ball);
    later(refreshHints, level.callMs * 0.7 + 20);
    render();
  };

  // 3-2-1 countdown, then the first ball.
  useEffect(() => {
    if (phase !== 'ready') return;
    const id = window.setTimeout(() => {
      if (countdown <= 1) {
        setPhase('playing');
        nextBall();
      }
      setCountdown((c) => c - 1);
    }, 700);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, countdown]);

  useInterval(nextBall, phase === 'playing' && run.drawnCount > 0 ? level.callMs : null);

  const onCell = (cardIndex: number, cell: number) => {
    if (phase !== 'playing' && phase !== 'grace') return;
    if (crabMode) {
      if (adventure.crabPinch(run, cardIndex, cell) && consumeBooster('crab')) {
        sfx.daub();
        setCrabMode(false);
        render();
      }
      return;
    }
    const value = run.cards[cardIndex]!.cells[cell]!;
    const reaction = calledAt.current.has(value) ? clock() - calledAt.current.get(value)! : undefined;
    if (adventure.daub(run, cardIndex, cell, reaction)) {
      sfx.daub();
      track('daub');
      setHints((h) => h.map((m, i) => (i === cardIndex ? m & ~(1 << cell) : m)));
      render();
    } else if (!(run.daubs[cardIndex]! & (1 << cell))) {
      sfx.miss();
      setShakeCard(cardIndex);
      later(() => setShakeCard(-1), 450);
    }
  };

  const claim = () => {
    if (phase !== 'playing' && phase !== 'grace') return;
    if (adventure.claimBingo(run)) {
      sfx.bingo();
      say('Bingo!');
      track('bingo');
      const stars = adventure.starsFor(run);
      const coins = adventure.coinsFor(run);
      const { newKey } = completeLevel(level.id, stars, coins);
      setResult({ stars, coins, newKey });
      setPhase('won');
    } else {
      sfx.miss();
      toast('Not a bingo yet! −200 points', 'warn');
      render();
    }
  };

  const addWave = () => {
    const owned = boosters.wave > 0 && consumeBooster('wave');
    if (!owned && !spend(WAVE_PRICE)) {
      toast(`Big Wave costs ${WAVE_PRICE} coins`, 'warn');
      return;
    }
    sfx.win();
    adventure.addBalls(run, 5);
    setPhase('playing');
    render();
  };

  const canBingo = adventure.bingoCards(run).length > 0;
  const recent = run.drum.slice(Math.max(0, run.drawnCount - 5), run.drawnCount).reverse();
  const budget = adventure.ballBudget(run);
  const size = run.cards.length === 1 ? 'lg' : 'sm';

  return (
    <Stage bg={art.bgGame} top="none" bottom="none" className="adv">
      <header className="adv-hud wood-bar">
        <button type="button" className="adv-hud__back" aria-label="Quit level" onClick={() => go({ name: 'map' })}>
          <img src={art.btnArrowLeft} alt="" />
        </button>
        <div className="adv-hud__chip">
          <small>Score</small>
          <b>
            <Counter value={run.score} duration={300} />
          </b>
        </div>
        <div className="adv-hud__chip adv-hud__target">
          <small>Target</small>
          <PatternPreview pattern={level.pattern} size={0.5} />
        </div>
        <div className="adv-hud__chip">
          <small>Balls</small>
          <b>{Math.max(0, budget - run.drawnCount)}</b>
        </div>
      </header>
      <div className="adv-progress" aria-hidden>
        <div className="adv-progress__bar">
          <i style={{ width: `${Math.min(100, (run.drawnCount / budget) * 100)}%` }} />
        </div>
        {[level.stars[0], level.stars[1], budget].map((ball, i) => (
          <span key={i} className={`adv-progress__star ${run.drawnCount > ball ? 'is-gone' : ''}`} style={{ left: `${(ball / budget) * 100}%` }}>
            ★
          </span>
        ))}
      </div>

      <div className="adv-caller">
        <div className="adv-caller__current">
          {recent[0] ? <Ball key={run.drawnCount} n={recent[0]} size={6.4} className="ball--enter" /> : <div className="adv-caller__empty">?</div>}
        </div>
        <div className="adv-caller__recent">
          {recent.slice(1).map((b) => (
            <Ball key={b} n={b} size={3.4} />
          ))}
        </div>
        <div className="adv-caller__level t-outline t-outline--navy">
          Lv {level.id}
          <small>{PATTERNS_75[level.pattern].name}</small>
        </div>
      </div>

      <div className={`card-set card-set--${run.cards.length}`}>
        {run.cards.map((card, i) => (
          <div key={i} className={shakeCard === i ? 'anim-shake' : ''}>
            <BingoGrid
              card={card}
              marked={run.daubs[i]!}
              hints={run.autoDaub ? 0 : (hints[i] ?? 0) & ~run.daubs[i]!}
              targets={crabMode ? run.playable[i]! & ~run.daubs[i]! & ~(1 << 12) : 0}
              highlight={phase === 'won' && run.winningCard === i ? adventure.winningShape(run, i) : undefined}
              onCell={(cell) => onCell(i, cell)}
              size={size}
              label={`Card ${i + 1}`}
            />
          </div>
        ))}
      </div>

      <div className="adv-actions">
        <button type="button" className={`bingo-btn ${canBingo ? 'anim-pulse is-ready' : ''}`} onClick={claim}>
          <span className="t-outline t-outline--red">BINGO!</span>
        </button>
      </div>

      <footer className="booster-bar wood-bar">
        <BoosterSlot icon="🕊️" label="Auto-daub" active={run.autoDaub} count={null} />
        <BoosterSlot
          icon="🦀"
          label="Crab Pinch"
          active={crabMode}
          count={boosters.crab}
          onClick={() => {
            if (boosters.crab <= 0) return toast('No Crab Pinch left — earn more from chests', 'warn');
            setCrabMode((m) => !m);
            toast(crabMode ? 'Crab Pinch cancelled' : 'Tap any square to pinch it!');
          }}
        />
        <BoosterSlot icon="🌊" label="+5 balls" active={false} count={boosters.wave} onClick={() => toast('Big Wave is offered when you run out of balls')} />
        <BoosterSlot icon="☀️" label="2× coins" active={run.doubleCoins} count={null} />
      </footer>

      {phase === 'ready' && (
        <div className="adv-countdown">
          <span key={countdown} className="t-outline t-outline--navy anim-pop">
            {countdown > 0 ? countdown : 'GO!'}
          </span>
        </div>
      )}
      {phase === 'grace' && <div className="adv-banner t-outline t-outline--red anim-pop">Last chance — shout BINGO!</div>}

      {phase === 'won' && result && (
        <>
          <Confetti />
          <Popup
            title="You Win"
            footer={
              <>
                <RoundButton img={art.btnRoundList} label="Level map" size={5.2} onClick={() => go({ name: 'map' })} />
                {level.id < adventure.LEVELS.length && (
                  <RoundButton img={art.btnRoundPlay} label="Next level" size={5.2} onClick={() => go({ name: 'adventure', level: level.id + 1 })} />
                )}
                <RoundButton img={art.btnRoundReplay} label="Replay" size={5.2} onClick={() => go({ name: 'adventure', level: level.id })} />
              </>
            }
          >
            <div className="popup-center">
              <Stars count={result.stars} size={5} arc />
              <p>
                BINGO on ball <b>{run.ballAtBingo}</b> · Score <b>{run.score.toLocaleString()}</b>
              </p>
              <div className="reward-pill">+{result.coins}</div>
              {result.newKey && <p className="small-note">🗝️ You earned a golden key!</p>}
            </div>
          </Popup>
        </>
      )}

      {phase === 'lost' && (
        <Popup
          title="Out of Balls"
          footer={
            <>
              <RoundButton img={art.navBtnList} label="Level map" onClick={() => go({ name: 'map' })} />
              <GreenButton onClick={addWave}>🌊 +5 balls{boosters.wave > 0 ? ` (${boosters.wave})` : ` · ${WAVE_PRICE}🪙`}</GreenButton>
            </>
          }
        >
          <div className="popup-center">
            <p>So close! Ride a Big Wave for 5 more balls, or head back to the map and try again.</p>
            <p className="small-note">
              Level {level.id} · {PATTERNS_75[level.pattern].name} · best level unlocked: {unlockedLevel(useGame.getState().stars)}
            </p>
          </div>
        </Popup>
      )}
    </Stage>
  );
}

function BoosterSlot({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: string;
  label: string;
  count: number | null;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`booster-slot ${active ? 'is-active' : ''}`}
      onClick={() => {
        sfx.click();
        onClick?.();
      }}
      aria-label={label}
      aria-pressed={active}
      disabled={!onClick}
    >
      <span className="booster-slot__icon">{icon}</span>
      {count !== null && <span className="badge">{count}</span>}
      <small>{label}</small>
    </button>
  );
}
