import { KENO_RTP } from './keno.ts';
import { RIPTIDE_LEVELS } from './cashout.ts';
import { EXTRA_BALL_RTP } from './videoBingo.ts';
import { EXTRA_SPIN_RTP } from './spin.ts';
import { ROOM_PRESETS } from './room.ts';

/**
 * Player-facing catalogue of every mode. `wager` modes take a stake; they run on free
 * play-money (COINS) everywhere and only accept on-chain currencies where the
 * compliance layer (geo, age, licensing) allows it — see docs/GAME_MODES.md.
 */
export type ModeKind = 'adventure' | 'house' | 'pvp';

export type ModeId =
  | 'adventure'
  | 'shellSpin'
  | 'riptide'
  | 'videoBingo'
  | 'keno'
  | 'sunsetHall'
  | 'pierHall'
  | 'waveRush'
  | 'riptideDuel';

export interface ModeInfo {
  id: ModeId;
  name: string;
  tagline: string;
  kind: ModeKind;
  players: string;
  roundTime: string;
  /** RTP for house games, prize-pool share for PvP rooms. */
  returnToPlayer: string;
  wager: boolean;
  volatility: 'none' | 'low' | 'medium' | 'high' | 'extreme';
}

const pct = (x: number) => `${(x * 100).toFixed(x * 100 % 1 === 0 ? 0 : 1)}%`;

export const MODES: readonly ModeInfo[] = [
  {
    id: 'adventure',
    name: 'Beach Adventure',
    tagline: '40 island levels, boosters and stars. Free to play.',
    kind: 'adventure',
    players: 'Solo',
    roundTime: '1–3 min',
    returnToPlayer: 'Free to play',
    wager: false,
    volatility: 'none',
  },
  {
    id: 'shellSpin',
    name: 'Shell Spin',
    tagline: 'Slots meet bingo — spin the reels, daub the card, chase 12 slingos.',
    kind: 'house',
    players: 'Solo',
    roundTime: '1 min',
    returnToPlayer: `≈90% base · ${pct(EXTRA_SPIN_RTP)} extra spins`,
    wager: true,
    volatility: 'high',
  },
  {
    id: 'riptide',
    name: 'Riptide Cash-Out',
    tagline: 'Every hit pumps the multiplier. Cash out before the shark bites.',
    kind: 'house',
    players: 'Solo',
    roundTime: '10–60 s',
    returnToPlayer: pct(RIPTIDE_LEVELS.calm.rtp),
    wager: true,
    volatility: 'extreme',
  },
  {
    id: 'videoBingo',
    name: 'Tiki Video Bingo',
    tagline: '4 cards, 30 balls, 13 patterns — then buy extra balls for the big one.',
    kind: 'house',
    players: 'Solo',
    roundTime: '20 s',
    returnToPlayer: `92.3% base · ${pct(EXTRA_BALL_RTP)} extra balls`,
    wager: true,
    volatility: 'medium',
  },
  {
    id: 'keno',
    name: 'Keno Cove',
    tagline: 'Pick up to 10 shells, 10 are drawn. Low, medium or high risk.',
    kind: 'house',
    players: 'Solo',
    roundTime: '5 s',
    returnToPlayer: pct(KENO_RTP),
    wager: true,
    volatility: 'medium',
  },
  {
    id: 'sunsetHall',
    name: 'Sunset Hall',
    tagline: '75-ball room: Line → Two Lines → Blackout, plus a progressive jackpot.',
    kind: 'pvp',
    players: '2–500',
    roundTime: '2–3 min',
    returnToPlayer: `${pct(ROOM_PRESETS.sunsetHall.payoutRate)} of ticket sales`,
    wager: true,
    volatility: 'medium',
  },
  {
    id: 'pierHall',
    name: 'Pier Hall',
    tagline: 'Classic UK 90-ball: One Line, Two Lines, Full House.',
    kind: 'pvp',
    players: '2–500',
    roundTime: '3 min',
    returnToPlayer: `${pct(ROOM_PRESETS.pierHall.payoutRate)} of ticket sales`,
    wager: true,
    volatility: 'medium',
  },
  {
    id: 'waveRush',
    name: 'Wave Rush',
    tagline: '30-ball speed bingo. A full house every minute.',
    kind: 'pvp',
    players: '2–200',
    roundTime: '45 s',
    returnToPlayer: `${pct(ROOM_PRESETS.waveRush.payoutRate)} of ticket sales`,
    wager: true,
    volatility: 'low',
  },
  {
    id: 'riptideDuel',
    name: 'Riptide Duel',
    tagline: '1v1, same balls, no auto-daub. First valid BINGO takes the pot.',
    kind: 'pvp',
    players: '2',
    roundTime: '1–2 min',
    returnToPlayer: `${pct(ROOM_PRESETS.riptideDuel.payoutRate)} of the pot`,
    wager: true,
    volatility: 'low',
  },
];

export function modeInfo(id: ModeId): ModeInfo {
  const mode = MODES.find((m) => m.id === id);
  if (!mode) throw new Error(`unknown mode ${id}`);
  return mode;
}
