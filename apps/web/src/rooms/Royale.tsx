import { useEffect, useRef, useState } from 'react';
import { popcount, royale, type RoyaleState, type WaveResult } from '@beach-bingo/engine';
import { art } from '../assets/art.ts';
import { say, sfx } from '../lib/audio.ts';
import { newRound, type FairRound } from '../lib/fair.ts';
import { useModel } from '../lib/hooks.ts';
import { playerName, TABLE_NAME, useGame, type Table } from '../state/store.ts';
import { BingoGrid } from '../ui/BingoGrid.tsx';
import { Ball, Confetti, GreenButton, RewardPill } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { Popup } from '../ui/Popup.tsx';
import { GameHeader, Stage } from '../ui/Stage.tsx';
import { Segmented } from '../games/common.tsx';
import { botRoster } from './bots.ts';
import './rooms.css';

const BUY_IN = 50;
const WAVE_MS = 3200;
const SIZES = [16, 32, 64] as const;

export default function Royale() {
  const go = useGame((s) => s.go);
  const name = useGame(playerName);
  const recordWin = useGame((s) => s.recordWin);
  const playedMode = useGame((s) => s.playedMode);
  const activeTable = useGame((s) => s.table);
  const freeGame = useGame((s) => s.table === 'coins' && s.freeGames > 0);
  /** The table the running game was bought in on. */
  const [gameTable, setGameTable] = useState<Table>(activeTable);
  const [size, setSize] = useState<number>(32);
  const [wave, setWave] = useState<WaveResult | null>(null);
  const [revealed, setRevealed] = useState(0);
  const { model: state, commit: render, replace } = useModel<RoyaleState | null>(() => null);
  const fairRef = useRef<FairRound | null>(null);

  useEffect(() => playedMode('lastCastle'), [playedMode]);

  const join = () => {
    const s = useGame.getState();
    const blocked = s.wagerBlockedReason(s.table);
    if (blocked) return toast(blocked, 'warn');
    if (!s.charge(BUY_IN, { wager: true, table: s.table, base: BUY_IN })) return toast(`Not enough ${TABLE_NAME[s.table]}`, 'warn');
    setGameTable(s.table);
    const fair = newRound('lastCastle');
    fairRef.current = fair;
    const entrants = [{ id: 'me', name }, ...botRoster(size - 1)];
    replace(royale.createRoyale(entrants, BUY_IN, fair.rng('cards'), fair.rng('draw')));
    setWave(null);
    setRevealed(0);
    say('The tide is coming in!');
  };

  // One wave every few seconds, revealing its five balls one by one.
  useEffect(() => {
    if (!state || state.finished) return;
    const id = window.setTimeout(() => {
      const result = royale.playWave(state);
      setWave(result);
      setRevealed(0);
      sfx.ball();
      const me = state.players.find((p) => p.id === 'me')!;
      if (result.eliminated.includes(me)) {
        sfx.lose();
        toast(`Washed away in place ${me.place} 🌊`, 'warn');
      } else if (state.finished) {
        sfx.bingo();
      } else {
        sfx.win();
      }
      if (state.finished) {
        const payouts = royale.royalePayouts(state);
        recordWin(payouts.me ?? 0, { table: gameTable });
        fairRef.current?.log(`place ${me.place} → ${payouts.me ?? 0}`);
      }
      render();
    }, wave ? WAVE_MS : 1500);
    return () => window.clearTimeout(id);
  }, [state, wave, recordWin, render, gameTable]);

  useEffect(() => {
    if (!wave || revealed >= wave.balls.length) return;
    const id = window.setTimeout(() => setRevealed((r) => r + 1), 260);
    return () => window.clearTimeout(id);
  }, [wave, revealed]);

  const me = state?.players.find((p) => p.id === 'me');
  const alive = state ? royale.alive(state) : [];
  const standings = state
    ? [...state.players].sort((a, b) => (a.place ?? 0) - (b.place ?? 0) || popcount(b.marked) - popcount(a.marked))
    : [];
  const payouts = state?.finished ? royale.royalePayouts(state) : null;

  return (
    <Stage bg={art.bgSplash} top={<GameHeader title="Last Castle Standing" onBack={() => go({ name: 'rooms' })} />} bottom="none" className="room">
      <div className="room__body">
        {!state ? (
          <div className="room__lobby panel">
            <h2>🏰 Battle-royale bingo</h2>
            <p>
              Everyone gets one card. Balls arrive in waves of five; after each wave the bottom half (fewest squares marked) is washed
              away. Last castle standing wins 40% of the pool; places 2–8 get paid too.
            </p>
            <Segmented options={SIZES} value={size} onChange={setSize} render={(n) => `${n} players`} />
            <p className="small-note">
              Buy-in {BUY_IN} {TABLE_NAME[activeTable]} · pool {Math.round(royale.ROYALE_PAYOUT_RATE * 100)}% · practice lobby filled with labelled bots 🤖
            </p>
            <GreenButton onClick={join}>Join · {freeGame ? 'Free game' : BUY_IN}</GreenButton>
          </div>
        ) : (
          <>
            <div className="room__info">
              <div className="room-stat">
                <small>Wave</small>
                <b>{state.wave}/{Math.ceil(Math.log2(state.players.length))}</b>
              </div>
              <div className="room-stat">
                <small>Castles left</small>
                <b>{alive.length}</b>
              </div>
              <div className="room-stat">
                <small>Pool</small>
                <b>{formatCoins(royale.royalePool(state))}</b>
              </div>
              <div className="room-stat">
                <small>Your squares</small>
                <b>{me ? popcount(me.marked) - 1 : 0}</b>
              </div>
            </div>
            <div className="room__caller">
              {wave?.balls.slice(0, revealed).map((b) => (
                <Ball key={b} n={b} size={4} className="ball--enter" />
              ))}
              {!wave && <span className="room__count t-outline t-outline--navy">First wave incoming…</span>}
            </div>
            {me && (
              <div className={`room__cards ${me.place && me.place > 1 ? 'is-out' : ''}`}>
                <BingoGrid card={me.card} marked={me.marked} size="md" dimmed={Boolean(me.place && me.place > 1)} />
              </div>
            )}
            <ol className="royale-board">
              {standings.slice(0, 8).map((p) => (
                <li key={p.id} className={`${p.id === 'me' ? 'is-me' : ''} ${p.place ? 'is-out' : ''}`}>
                  <span>{p.place === 1 ? '👑' : p.place ? `#${p.place}` : '🏰'}</span>
                  <b>{p.name}</b>
                  <em>{popcount(p.marked) - 1}▣</em>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>

      {state?.finished && payouts && (
        <>
          {(payouts.me ?? 0) > 0 && <Confetti />}
          <Popup
            title={me?.place === 1 ? 'Champion!' : `Place #${me?.place}`}
            footer={
              <>
                <GreenButton onClick={() => go({ name: 'rooms' })}>Rooms</GreenButton>
                <GreenButton tone="gold" onClick={join}>
                  Again · {BUY_IN}
                </GreenButton>
              </>
            }
          >
            <div className="popup-center">
              {(payouts.me ?? 0) > 0 ? (
                <RewardPill amount={payouts.me!} table={gameTable} />
              ) : (
                <p>The tide took your castle this time.</p>
              )}
              <p className="small-note">
                Champion: {state.players.find((p) => p.place === 1)!.name} · {state.drawn.length} balls · {state.players.length} players
              </p>
            </div>
          </Popup>
        </>
      )}
    </Stage>
  );
}
