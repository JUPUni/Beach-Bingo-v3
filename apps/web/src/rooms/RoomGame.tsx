import { useEffect, useRef, useState } from 'react';
import {
  CARD_SPECS,
  cellsToGo,
  markedMask,
  mathRng,
  playableMask,
  rooms,
  winningCells,
  type RoomPresetId,
  type RoomSettlement,
  type RoomState,
  type StageWin,
} from '@beach-bingo/engine';
import { art } from '../assets/art.ts';
import { callBall, say, sfx } from '../lib/audio.ts';
import { newRound } from '../lib/fair.ts';
import { useModel } from '../lib/hooks.ts';
import { useGame } from '../state/store.ts';
import { BingoGrid } from '../ui/BingoGrid.tsx';
import { Ball, Confetti, GreenButton } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { Popup } from '../ui/Popup.tsx';
import { GameHeader, Stage } from '../ui/Stage.tsx';
import { botReactionMs, botRoster } from './bots.ts';
import './rooms.css';

const ME = 'me';
const LOBBY_SECONDS = 8;
const CLAIM_WINDOW_MS = 1200;
const UI_MAX_CARDS: Record<string, number> = { '75': 4, '90': 3, '30': 4 };

type Phase = 'lobby' | 'countdown' | 'drawing' | 'finished';

export default function RoomGame({ preset }: { preset: RoomPresetId }) {
  const config = rooms.ROOM_PRESETS[preset];
  const go = useGame((s) => s.go);
  const profile = useGame((s) => s.profile);
  const jackpot = useGame((s) => s.jackpot.pool);
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
    const blocked = state.wagerBlockedReason();
    if (blocked) return toast(blocked, 'warn');
    if (!state.spend(cost, { wager: true })) return toast('Not enough coins', 'warn');
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
        contributeJackpot(rooms.jackpotContribution(room));
        setPhase('drawing');
        say(isDuel ? 'Duel on!' : 'Eyes down!');
      }
      setCountdown((c) => c - 1);
    }, 1000);
    return () => window.clearTimeout(id);
  }, [phase, countdown, room, fair, contributeJackpot, isDuel]);

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
    recordWin(s.payouts[ME] ?? 0);
    if (s.jackpotPaid > 0) resetJackpot();
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

  const stage = config.stages[Math.min(room.stage, config.stages.length - 1)]!;
  const pool = room.phase === 'selling' ? Math.floor(rooms.roomSales(room) * config.payoutRate) : room.pool;
  const recent = room.drawn.slice(-5).reverse();
  const cardSize = config.variant === '30' ? 'md' : 'sm';
  const myWin = settlement?.payouts[ME] ?? 0;
  const opponent = isDuel ? room.players.find((p) => p.id !== ME) : undefined;
  const opponentToGo = opponent && room.phase !== 'selling' ? rooms.bestToGo(room, opponent.id) : null;

  return (
    <Stage
      bg={preset === 'pierHall' ? art.bgLevelMap : preset === 'waveRush' ? art.bgSplash : art.bgGame}
      top={<GameHeader title={config.name} onBack={() => go({ name: 'rooms' })} />}
      bottom="none"
      className="room"
    >
      <div className="room__body">
        <div className="room__info">
          <div className="room-stat">
            <small>Prize pool</small>
            <b>{formatCoins(pool)}</b>
          </div>
          <div className="room-stat">
            <small>{room.phase === 'selling' ? 'Players' : 'Stage'}</small>
            <b>{room.phase === 'selling' ? room.players.length : `${Math.min(room.stage + 1, config.stages.length)}/${config.stages.length}`}</b>
          </div>
          <div className="room-stat">
            <small>{room.phase === 'selling' ? 'Card' : 'Balls'}</small>
            <b>{room.phase === 'selling' ? config.cardPrice : room.drawn.length}</b>
          </div>
          {'jackpot' in config && config.jackpot && (
            <div className="room-stat room-stat--jackpot">
              <small>Jackpot ≤{config.jackpot.withinBalls} balls</small>
              <b>{formatCoins(jackpot)}</b>
            </div>
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
              {Math.round(config.payoutRate * 100)}% of card sales.
            </p>
            <div className="room__buy">
              {Array.from({ length: Math.min(UI_MAX_CARDS[config.variant]!, config.maxCardsPerPlayer) - me.cards.length }, (_, i) => i + 1)
                .slice(0, 3)
                .map((n) => (
                  <GreenButton key={n} onClick={() => buy(n)}>
                    +{n} card{n > 1 ? 's' : ''} · {config.cardPrice * n}
                  </GreenButton>
                ))}
            </div>
            <p className="room__count t-outline t-outline--navy">
              {phase === 'countdown' ? `Starting in ${countdown}…` : 'Buy a card to join the next game'}
            </p>
          </div>
        ) : (
          <>
            <div className="room__caller">
              {recent[0] ? <Ball key={room.drawn.length} n={recent[0]} variant={config.variant} size={5.2} className="ball--enter" /> : null}
              <div className="room__recent">
                {recent.slice(1).map((b) => (
                  <Ball key={b} n={b} variant={config.variant} size={3} />
                ))}
              </div>
              <div className="room__stage">
                <small>Now playing</small>
                <b>{stage.pattern.name}</b>
                <span>{formatCoins(room.stagePrizes[room.stage] ?? 0)}</span>
              </div>
            </div>
            {opponent && opponentToGo !== null && (
              <div className="room__opponent">
                {opponent.name} is <b>{opponentToGo}</b> away from a line
              </div>
            )}
          </>
        )}

        <div className={`room__cards room__cards--v${config.variant}`}>
          {me.cards.map((card, i) => {
            const auto = markedMask(card, room.drawn);
            const marked = isDuel ? (daubs[i] ?? 0) : auto;
            const toGo = room.phase === 'drawing' ? cellsToGo(auto, stage.pattern, playableMask(card)) : null;
            const won = room.wins.some((w) => w.winners.some((x) => x.playerId === ME && x.card === i));
            return (
              <div key={i} className="room__card">
                <BingoGrid
                  card={card}
                  marked={marked}
                  onCell={isDuel ? (cell) => onCell(i, cell) : undefined}
                  highlight={won ? winningCells(auto, stage.pattern, playableMask(card)) : undefined}
                  size={cardSize}
                  label={`Card ${i + 1}`}
                />
                {toGo !== null && toGo > 0 && toGo <= 3 && <span className="room__togo">{toGo} to go</span>}
              </div>
            );
          })}
        </div>

        {feed.length > 0 && (
          <ul className="room__feed">
            {feed.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        )}
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
              {myWin > 0 ? (
                <div className="reward-pill">
                  <img src={art.iconCoin} alt="" /> +{formatCoins(myWin)}
                </div>
              ) : (
                <p>No prizes for you this time.</p>
              )}
              <ul className="room__results">
                {room.wins.map((w) => (
                  <li key={w.stage}>
                    <b>{config.stages[w.stage]!.pattern.name}</b> on ball {w.ballCount}:{' '}
                    {w.winners.map((x) => room.players.find((p) => p.id === x.playerId)!.name).join(', ')} · {formatCoins(w.prizeEach)}
                  </li>
                ))}
                {settlement.jackpotPaid > 0 && <li>🌅 Jackpot paid: {formatCoins(settlement.jackpotPaid)}!</li>}
              </ul>
              <p className="small-note">
                Sales {formatCoins(settlement.sales)} · pool {formatCoins(settlement.pool)} · rake {formatCoins(settlement.rake)}. Seed
                commitment {room.commitment.slice(0, 12)}… · {CARD_SPECS[config.variant].maxBall}-ball drum.
              </p>
            </div>
          </Popup>
        </>
      )}
    </Stage>
  );
}
