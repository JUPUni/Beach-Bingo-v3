import { useEffect, useRef, useState } from 'react';
import { markedMask, mathRng, modeInfo, rooms, type RoomPresetId, type RoomSettlement, type RoomState, type StageWin } from '@beach-bingo/engine';
import { art } from '../assets/art.ts';
import { callBall, say, sfx } from '../lib/audio.ts';
import { newRound } from '../lib/fair.ts';
import { useModel } from '../lib/hooks.ts';
import { TABLE_NAME, useGame } from '../state/store.ts';
import { Confetti, GreenButton, RewardPill } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { Popup } from '../ui/Popup.tsx';
import { GameHeader, Stage } from '../ui/Stage.tsx';
import { botReactionMs, botRoster } from './bots.ts';
import { makeCode, maxCardsFor } from './live/protocol.ts';
import { Caller, Feed, PlayerCards, Results, RoomStat } from './RoomParts.tsx';
import './rooms.css';

const ME = 'me';
const LOBBY_SECONDS = 8;
const CLAIM_WINDOW_MS = 1200;

type Phase = 'lobby' | 'countdown' | 'drawing' | 'finished';

/** A bingo hall with practice bots; `LiveRoom` is the same hall with friends. */
export default function RoomGame({ preset }: { preset: RoomPresetId }) {
  const config = rooms.ROOM_PRESETS[preset];
  const go = useGame((s) => s.go);
  const profile = useGame((s) => s.profile);
  // The table this room plays on: the one active when the screen opened (the switch lives on the lists, not in here).
  const [table] = useState(() => useGame.getState().table);
  const jackpot = useGame((s) => s.jackpots[table].pool);
  const freeGame = useGame((s) => s.table === 'coins' && s.freeGames > 0);
  const contributeJackpot = useGame((s) => s.contributeJackpot);
  const resetJackpot = useGame((s) => s.resetJackpot);
  const recordWin = useGame((s) => s.recordWin);
  const playedMode = useGame((s) => s.playedMode);
  const track = useGame((s) => s.track);
  const isDuel = !config.autoDaub;

  const {
    model: { room, fair },
    commit: render,
  } = useModel(() => {
    const fair = newRound(preset);
    const room = rooms.createRoom(config, fair.commitment, 'jackpot' in config ? jackpot : 0);
    rooms.joinRoom(room, { id: ME, name: profile.name });
    const bots = botRoster(isDuel ? 1 : 6 + mathRng.int(14));
    for (const bot of bots) {
      rooms.joinRoom(room, bot);
      rooms.buyCards(room, bot.id, isDuel ? 1 : 1 + mathRng.int(Math.min(4, config.maxCardsPerPlayer)), (i) => fair.rng(`card:${i}`));
    }
    return { room, fair };
  });
  const me = room.players.find((p) => p.id === ME)!;

  const [phase, setPhase] = useState<Phase>('lobby');
  const [countdown, setCountdown] = useState(LOBBY_SECONDS);
  const [daubs, setDaubs] = useState<number[]>([]);
  const [feed, setFeed] = useState<string[]>([]);
  const [settlement, setSettlement] = useState<RoomSettlement | null>(null);
  const claimTimer = useRef<number | null>(null);

  useEffect(() => playedMode(preset), [playedMode, preset]);

  const buy = (count: number) => {
    const cost = config.cardPrice * count;
    const state = useGame.getState();
    const blocked = state.wagerBlockedReason(table);
    if (blocked) return toast(blocked, 'warn');
    if (!state.charge(cost, { wager: true, table, base: config.cardPrice })) return toast(`Not enough ${TABLE_NAME[table]}`, 'warn');
    rooms.buyCards(room, ME, count, (i) => fair.rng(`card:${i}`));
    setDaubs(me.cards.map((c) => markedMask(c, [])));
    sfx.coin();
    if (phase === 'lobby') setPhase('countdown');
    render();
  };

  // Lobby countdown → draw.
  useEffect(() => {
    if (phase !== 'countdown') return;
    const id = window.setTimeout(() => {
      if (countdown <= 1) {
        rooms.startDrawing(room, fair.rng('draw'));
        contributeJackpot(rooms.jackpotContribution(room), table);
        setPhase('drawing');
        say(isDuel ? 'Duel on!' : 'Eyes down!');
      }
      setCountdown((c) => c - 1);
    }, 1000);
    return () => window.clearTimeout(id);
  }, [phase, countdown, room, fair, contributeJackpot, isDuel, table]);

  const announce = (wins: StageWin[]) => {
    for (const win of wins) {
      const names = win.winners.map((w) => room.players.find((p) => p.id === w.playerId)!.name);
      const mine = win.winners.filter((w) => w.playerId === ME).length;
      const label = config.stages[win.stage]!.pattern.name;
      setFeed((f) => [`🏆 ${label}: ${names.join(', ')} (+${formatCoins(win.prizeEach)} each)`, ...f].slice(0, 6));
      if (mine) {
        sfx.bingo();
        say('Bingo!');
        track('bingo');
      } else {
        sfx.win();
      }
    }
  };

  const finish = () => {
    const s = rooms.settleRoom(room);
    setSettlement(s);
    recordWin(s.payouts[ME] ?? 0, { table });
    if (s.jackpotPaid > 0) resetJackpot(table);
    fair.log(`won ${s.payouts[ME] ?? 0} of pool ${s.pool}`);
    setPhase('finished');
  };

  const scheduleClose = () => {
    if (claimTimer.current !== null) return;
    claimTimer.current = window.setTimeout(() => {
      claimTimer.current = null;
      const win = rooms.closeClaims(room);
      if (win) {
        announce([win]);
        if (room.phase === 'finished') window.setTimeout(finish, 900);
      }
      render();
    }, CLAIM_WINDOW_MS);
  };

  // Ball ticker.
  useEffect(() => {
    if (phase !== 'drawing') return;
    const id = window.setInterval(() => {
      if (room.phase !== 'drawing') return;
      const event = rooms.drawNext(room);
      if (event.ball) {
        sfx.ball();
        callBall(event.ball, config.variant);
      }
      announce(event.stageWins);
      if (isDuel && room.phase === 'drawing') {
        // The bot notices its bingo after a human-like delay.
        for (const w of rooms.completedCards(room)) {
          if (w.playerId !== ME) {
            window.setTimeout(() => {
              if (room.phase === 'drawing' && rooms.claimBingo(room, w.playerId, w.card).ok) scheduleClose();
            }, botReactionMs());
          }
        }
      }
      if (event.finished || (room.phase as RoomState['phase']) === 'finished') {
        window.clearInterval(id);
        window.setTimeout(finish, 900);
      }
      render();
    }, config.drawIntervalMs);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const claim = () => {
    const my = rooms.completedCards(room, ME);
    const res = rooms.claimBingo(room, ME, my[0]?.card ?? 0);
    if (res.ok) {
      sfx.bingo();
      toast('BINGO claimed! Checking…', 'win');
      scheduleClose();
    } else {
      sfx.miss();
      toast(res.reason === 'locked' ? 'Locked out — wait a few balls' : `False call! Locked for ${config.falseClaimPenaltyBalls} balls`, 'warn');
    }
  };

  const onCell = (cardIndex: number, cell: number) => {
    if (!isDuel || room.phase !== 'drawing') return;
    const value = me.cards[cardIndex]!.cells[cell]!;
    if (value > 0 && room.drawn.includes(value)) {
      sfx.daub();
      track('daub');
      setDaubs((d) => d.map((m, i) => (i === cardIndex ? m | (1 << cell) : m)));
    } else {
      sfx.miss();
    }
  };

  const pool = room.phase === 'selling' ? Math.floor(rooms.roomSales(room) * config.payoutRate) : room.pool;
  const myWin = settlement?.payouts[ME] ?? 0;
  const opponent = isDuel ? room.players.find((p) => p.id !== ME) : undefined;
  const opponentToGo = opponent && room.phase !== 'selling' ? rooms.bestToGo(room, opponent.id) : null;

  return (
    <Stage
      bg={preset === 'pierHall' ? art.bgLevelMap : preset === 'waveRush' ? art.bgSplash : art.bgGame}
      top={<GameHeader title={modeInfo(preset).name} onBack={() => go({ name: 'rooms' })} />}
      bottom="none"
      className="room"
    >
      <div className="room__body">
        <div className="room__info">
          <RoomStat label="Prize pool" value={formatCoins(pool)} />
          <RoomStat
            label={room.phase === 'selling' ? 'Players' : 'Stage'}
            value={room.phase === 'selling' ? room.players.length : `${Math.min(room.stage + 1, config.stages.length)}/${config.stages.length}`}
          />
          <RoomStat label={room.phase === 'selling' ? 'Card' : 'Balls'} value={room.phase === 'selling' ? config.cardPrice : room.drawn.length} />
          {'jackpot' in config && config.jackpot && (
            <RoomStat className="room-stat--jackpot" label={`Jackpot ≤${config.jackpot.withinBalls} balls`} value={formatCoins(jackpot)} />
          )}
        </div>

        {phase === 'lobby' || phase === 'countdown' ? (
          <div className="room__lobby panel">
            <h2>{isDuel ? 'Duel lobby' : 'Practice room'}</h2>
            <p>
              {isDuel
                ? 'Same balls, no auto-daub. Tap your numbers and hit BINGO first — false calls lock you out.'
                : `Stages: ${config.stages.map((s) => `${s.pattern.name} ${Math.round(s.share * 100)}%`).join(' → ')}. Cards daub themselves.`}
            </p>
            <p className="small-note">
              {room.players.length - 1} labelled bot{room.players.length > 2 ? 's' : ''} 🤖 are playing with you. Pool =
              {' '}
              {Math.round(config.payoutRate * 100)}% of card sales, in {TABLE_NAME[table]}.
            </p>
            <div className="room__buy">
              {Array.from({ length: maxCardsFor(config) - me.cards.length }, (_, i) => i + 1)
                .slice(0, 3)
                .map((n) => (
                  <GreenButton key={n} onClick={() => buy(n)}>
                    +{n} card{n > 1 ? 's' : ''} · {freeGame && n === 1 ? 'Free game' : config.cardPrice * n}
                  </GreenButton>
                ))}
            </div>
            <p className="room__count t-outline t-outline--navy">
              {phase === 'countdown' ? `Starting in ${countdown}…` : 'Buy a card to join the next game'}
            </p>
            {phase === 'lobby' && (
              <button type="button" className="room__link" onClick={() => (sfx.click(), go({ name: 'live', code: makeCode(), host: true, preset }))}>
                🌐 Play with friends instead — open a room and share the code
              </button>
            )}
          </div>
        ) : (
          <>
            <Caller room={room} />
            {opponent && opponentToGo !== null && (
              <div className="room__opponent">
                {opponent.name} is <b>{opponentToGo}</b> away from a line
              </div>
            )}
          </>
        )}

        <PlayerCards room={room} playerId={ME} daubs={isDuel ? daubs : undefined} onCell={isDuel ? onCell : undefined} />
        <Feed items={feed} />
      </div>

      {isDuel && phase === 'drawing' && (
        <div className="room__claim">
          <button type="button" className="bingo-btn is-ready anim-pulse" onClick={claim}>
            <span className="t-outline t-outline--red">BINGO!</span>
          </button>
        </div>
      )}

      {phase === 'finished' && settlement && (
        <>
          {myWin > 0 && <Confetti />}
          <Popup
            title={myWin > 0 ? 'You Win' : 'Round Over'}
            footer={
              <>
                <GreenButton onClick={() => go({ name: 'rooms' })}>Rooms</GreenButton>
                <GreenButton tone="gold" onClick={() => go({ name: 'game', mode: preset })}>
                  Play again
                </GreenButton>
              </>
            }
          >
            <div className="popup-center">
              {myWin > 0 ? <RewardPill amount={myWin} table={table} /> : <p>No {TABLE_NAME[table]} for you this time.</p>}
              <Results room={room} settlement={settlement} />
            </div>
          </Popup>
        </>
      )}
    </Stage>
  );
}
