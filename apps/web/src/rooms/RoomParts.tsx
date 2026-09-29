import type { ReactNode } from 'react';
import { CARD_SPECS, cellsToGo, markedMask, playableMask, winningCells, type RoomSettlement, type RoomState } from '@beach-bingo/engine';
import { BingoGrid } from '../ui/BingoGrid.tsx';
import { Ball } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import './rooms.css';

/** The pieces a bingo hall screen is made of, shared by the practice room and the live room. */

export function RoomStat({ label, value, className = '' }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={`room-stat ${className}`}>
      <small>{label}</small>
      <b>{value}</b>
    </div>
  );
}

function openStage(room: RoomState) {
  return room.config.stages[Math.min(room.stage, room.config.stages.length - 1)]!;
}

/** The last ball large, the four before it small, and the stage being played for. */
export function Caller({ room, children }: { room: RoomState; children?: ReactNode }) {
  const stage = openStage(room);
  const recent = room.drawn.slice(-5).reverse();
  return (
    <div className="room__caller">
      {recent[0] ? <Ball key={room.drawn.length} n={recent[0]} variant={room.config.variant} size={5.2} className="ball--enter" /> : children}
      <div className="room__recent">
        {recent.slice(1).map((b) => (
          <Ball key={b} n={b} variant={room.config.variant} size={3} />
        ))}
      </div>
      <div className="room__stage">
        <small>Now playing</small>
        <b>{stage.pattern.name}</b>
        <span>{formatCoins(room.stagePrizes[room.stage] ?? 0)}</span>
      </div>
    </div>
  );
}

/** One player's cards. `daubs` (a mask per card) means manual daubing; otherwise the drawn balls mark the cards. */
export function PlayerCards({
  room,
  playerId,
  daubs,
  onCell,
}: {
  room: RoomState;
  playerId: string;
  daubs?: number[];
  onCell?: (card: number, cell: number) => void;
}) {
  const player = room.players.find((p) => p.id === playerId);
  if (!player) return null;
  const stage = openStage(room);
  const size = room.config.variant === '30' ? 'md' : 'sm';
  return (
    <div className={`room__cards room__cards--v${room.config.variant}`}>
      {player.cards.map((card, i) => {
        const auto = markedMask(card, room.drawn);
        const marked = daubs ? (daubs[i] ?? 0) : auto;
        const toGo = room.phase === 'drawing' ? cellsToGo(auto, stage.pattern, playableMask(card)) : null;
        const won = room.wins.some((w) => w.winners.some((x) => x.playerId === playerId && x.card === i));
        return (
          <div key={i} className="room__card">
            <BingoGrid
              card={card}
              marked={marked}
              onCell={onCell ? (cell) => onCell(i, cell) : undefined}
              highlight={won ? winningCells(auto, stage.pattern, playableMask(card)) : undefined}
              size={size}
              label={`Card ${i + 1}`}
            />
            {toGo !== null && toGo > 0 && toGo <= 3 && <span className="room__togo">{toGo} to go</span>}
          </div>
        );
      })}
    </div>
  );
}

export function Feed({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="room__feed">
      {items.map((f, i) => (
        <li key={i}>{f}</li>
      ))}
    </ul>
  );
}

/** Who won what, for the results popup. */
export function Results({ room, settlement, note }: { room: RoomState; settlement: RoomSettlement; note?: ReactNode }) {
  const name = (id: string) => room.players.find((p) => p.id === id)?.name ?? 'Someone';
  return (
    <>
      <ul className="room__results">
        {room.wins.map((w) => (
          <li key={w.stage}>
            <b>{room.config.stages[w.stage]!.pattern.name}</b> on ball {w.ballCount}: {w.winners.map((x) => name(x.playerId)).join(', ')} ·{' '}
            {formatCoins(w.prizeEach)}
          </li>
        ))}
        {room.wins.length === 0 && <li>Nobody claimed the stage — stakes refunded.</li>}
        {settlement.jackpotPaid > 0 && <li>🌅 Jackpot paid: {formatCoins(settlement.jackpotPaid)}!</li>}
      </ul>
      <p className="small-note">
        {note ?? (
          <>
            Sales {formatCoins(settlement.sales)} · pool {formatCoins(settlement.pool)} · rake {formatCoins(settlement.rake)}. Seed commitment{' '}
            {room.commitment.slice(0, 12)}… · {CARD_SPECS[room.config.variant].maxBall}-ball drum.
          </>
        )}
      </p>
    </>
  );
}
