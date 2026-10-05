import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { modeInfo, rooms, type RoomPresetId } from '@beach-bingo/engine';
import { art } from '../assets/art.ts';
import { sfx } from '../lib/audio.ts';
import { useNow } from '../lib/hooks.ts';
import { shortAddress, ONCHAIN_STAKES_ENABLED } from '../solana/config.ts';
import { formatStake } from '../solana/tokens.ts';
import { TABLE_NAME, useGame } from '../state/store.ts';
import { Confetti, GreenButton, RewardPill } from '../ui/kit.tsx';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { Popup } from '../ui/Popup.tsx';
import { GameHeader, Stage } from '../ui/Stage.tsx';
import type { LiveRoomMachine } from './live/machine.ts';
import { inviteLink, makeCode, maxCardsFor } from './live/protocol.ts';
import { useLiveRoom } from './live/useLiveRoom.ts';
import { Caller, Feed, PlayerCards, Results, RoomStat } from './RoomParts.tsx';
import './rooms.css';

/** Staked rooms need the flag and a deployed escrow program; the wallet code loads only then. */
const STAKES = ONCHAIN_STAKES_ENABLED;
/** The stake in the info bar: "◎0.01" for SOL as always, "50 SKR" for a token stake. */
const stakeFigure = (lamports: string, mint: string | undefined): string =>
  mint ? formatStake(BigInt(lamports), mint) : `◎${(Number(lamports) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 3 })}`;
const StakePanel = lazy(() => import('./live/StakePanel.tsx'));
const HallStakePanel = lazy(() => import('./live/HallStakePanel.tsx'));

/** The escrow panel for the room's stake: the 1v1 panel (which also opens either kind), or the hall's once a hall exists. */
function StakeSide({ m }: { m: LiveRoomMachine }) {
  return <Suspense fallback={null}>{m.stake?.kind === 'hall' ? <HallStakePanel m={m} /> : <StakePanel m={m} />}</Suspense>;
}

/** A bingo hall played with friends over a room code. The rules live in `live/machine.ts`. */
export default function LiveRoom({ code, host, preset }: { code: string; host: boolean; preset?: RoomPresetId }) {
  const go = useGame((s) => s.go);
  const openPopup = useGame((s) => s.openPopup);
  const playedMode = useGame((s) => s.playedMode);
  const track = useGame((s) => s.track);
  const m = useLiveRoom({ code, host, preset });
  const status = m?.status ?? 'connecting';
  const config = m?.config ?? (preset ? rooms.ROOM_PRESETS[preset] : null);
  const now = useNow(status === 'countdown' ? 200 : 60_000);
  // Manual daubs for duels, kept per round so a new round starts clean.
  const [daubState, setDaubState] = useState<{ round: number; masks: number[] }>({ round: 0, masks: [] });

  const livePreset = m?.preset ?? null;
  useEffect(() => {
    if (livePreset) playedMode(livePreset);
  }, [livePreset, playedMode]);

  const room = m?.room ?? null;
  const isDuel = config ? !config.autoDaub : false;
  const daubs = m && daubState.round === m.round ? daubState.masks : [];
  const playing = status === 'countdown' || status === 'drawing' || status === 'finished';
  const bg = livePreset === 'pierHall' ? art.bgLevelMap : livePreset === 'waveRush' ? art.bgSplash : art.bgGame;
  // The hall's short name: the header has no room for "Sunset Hall · 75-ball" next to the coins.
  const hall = livePreset ?? preset ?? null;
  const title = hall ? modeInfo(hall).name : 'Live room';

  const onCell = (cardIndex: number, cell: number) => {
    if (!m || !room || !isDuel || room.phase !== 'drawing') return;
    const card = room.players.find((p) => p.id === m.playerId)?.cards[cardIndex];
    const value = card?.cells[cell] ?? -1;
    if (value > 0 && room.drawn.includes(value)) {
      sfx.daub();
      track('daub');
      setDaubState((d) => {
        const masks = d.round === m.round ? [...d.masks] : [];
        masks[cardIndex] = (masks[cardIndex] ?? 0) | (1 << cell);
        return { round: m.round, masks };
      });
    } else {
      sfx.miss();
    }
  };

  const share = async () => {
    const link = inviteLink(code, location.origin, import.meta.env.BASE_URL);
    const text = `Join my ${config?.name ?? 'Beach Bingo'} room — code ${code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Beach Bingo', text, url: link });
      else {
        await navigator.clipboard.writeText(link);
        toast('Invite link copied');
      }
    } catch {
      /* the share sheet was dismissed */
    }
  };

  const practice = () => go(livePreset ? { name: 'game', mode: livePreset } : { name: 'rooms' });
  const currency = m?.currency ?? 'shells';
  const freeGame = useGame((s) => s.freeGames > 0);
  /** A coin room asks a guest for the age declaration first (shell rooms never ask). */
  const buy = (n: number) => {
    if (!m) return;
    const s = useGame.getState();
    if (currency === 'coins' && !s.coinsReady()) {
      if (s.requestCoins('table') === 'blocked') toast(s.coinsBlockedReason() ?? '', 'warn');
      return;
    }
    m.buy(n);
  };
  const reopen = () => go({ name: 'live', code: makeCode(), host: true, preset: livePreset ?? preset ?? 'waveRush' });

  let body: ReactNode;
  if (!m || status === 'connecting') {
    body = (
      <div className="room__lobby panel">
        <h2>Looking for room {code}…</h2>
        <p className="small-note">{relayLine(m?.relays ?? 0)}</p>
        <GreenButton tone="red" onClick={() => go({ name: 'rooms' })}>
          Cancel
        </GreenButton>
      </div>
    );
  } else if (status === 'error') {
    body = (
      <div className="room__lobby panel">
        <h2>Room closed</h2>
        <p>{m.error}</p>
        {STAKES && m.stake && <StakeSide m={m} />}
        <div className="room__buy">
          <GreenButton onClick={() => go({ name: 'rooms' })}>Rooms</GreenButton>
          {(m.hostLeft || host) && (
            <GreenButton tone="gold" onClick={reopen}>
              Open a new room
            </GreenButton>
          )}
          {livePreset && (
            <GreenButton tone="blue" onClick={practice}>
              Practice instead
            </GreenButton>
          )}
        </div>
      </div>
    );
  } else if (status === 'lobby' && config) {
    const players = m.players;
    const withCards = players.filter((p) => p.cards > 0).length;
    // A staked hall lists the chain's seats; peers without one are watching until they buy in.
    const seats = m.isHall ? m.seats : [];
    const unseated = m.isHall ? players.filter((p) => !seats.some((s) => s.peer?.id === p.id)) : players;
    body = (
      <div className="room__lobby panel">
        <h2>Room {code}</h2>
        <p>
          {isDuel
            ? 'Same balls, no auto-daub. Tap your numbers and hit BINGO first — false calls lock you out.'
            : `Stages: ${config.stages.map((s) => `${s.pattern.name} ${Math.round(s.share * 100)}%`).join(' → ')}. Cards daub themselves.`}{' '}
          Everyone sees the same balls, and every phone checks every win.
        </p>
        {m.stakeRefused && <p className="small-note">This room plays for a stake on chain, which this app does not join.</p>}
        {!m.stake && !m.stakeRefused && (
          <p className="small-note">
            {currency === 'coins' ? `A coin room: cards are ${config.cardPrice} coins each and prizes pay coins.` : `Cards are ${config.cardPrice} shells each and prizes pay shells.`}
          </p>
        )}
        <button type="button" className="room__link" onClick={() => (sfx.click(), void share())}>
          🔗 Share the invite link
        </button>
        <ul className="room__players" aria-label="Players">
          {seats.map((s) => (
            <li key={s.wallet} className={s.me ? 'is-me' : ''}>
              <span>{s.host ? '👑' : '🎟️'}</span>
              <b>{s.peer?.name || shortAddress(s.wallet)}</b>
              <em>
                {s.me ? 'you · ' : ''}
                {s.cards} card{s.cards > 1 ? 's' : ''}
              </em>
            </li>
          ))}
          {unseated.map((p) => (
            <li key={p.id} className={p.id === m.selfId ? 'is-me' : ''}>
              <span>{p.id === m.hostId ? '👑' : '🏖️'}</span>
              <b>{p.name || 'Joining…'}</b>
              <em>
                {p.id === m.selfId ? 'you · ' : ''}
                {m.isHall ? 'no seat yet' : p.cards ? `${p.cards} card${p.cards > 1 ? 's' : ''}` : 'no cards yet'}
              </em>
            </li>
          ))}
        </ul>
        {!m.stake && !m.stakeRefused && (
          <div className="room__buy">
            {Array.from({ length: maxCardsFor(config) - m.myCards }, (_, i) => i + 1)
              .slice(0, 3)
              .map((n) => (
                <GreenButton key={n} onClick={() => buy(n)}>
                  +{n} card{n > 1 ? 's' : ''} · {currency === 'coins' && freeGame && n === 1 ? 'Free game' : config.cardPrice * n}
                </GreenButton>
              ))}
          </div>
        )}
        {STAKES && livePreset === 'waveRush' && (m.host || m.stake) && <StakeSide m={m} />}
        {m.host ? (
          <GreenButton tone="gold" disabled={!m.canStart} onClick={() => m.start()}>
            {m.canStart ? `Start · ${m.isHall ? seats.length : withCards} players` : m.isHall ? 'Start · once the table is locked' : `Need ${m.minPlayers} players with cards`}
          </GreenButton>
        ) : (
          <p className="room__count t-outline t-outline--navy">
            {m.myCards ? `Waiting for ${m.hostName} to start…` : m.stake ? 'Take a seat to play the next round' : m.stakeRefused ? 'Watching this room' : 'Buy a card to play the next round'}
          </p>
        )}
        <button type="button" className="room__fair" onClick={() => openPopup('fairness')}>
          🔐 Round {m.round} · seed commitment {m.commitment.slice(0, 12)}… · {relayLine(m.relays)}
        </button>
      </div>
    );
  } else if (room && config) {
    const seconds = Math.max(0, Math.ceil((m.startAt - now) / 1000));
    const opponent = isDuel && m.isParticipant ? room.players.find((p) => p.id !== m.selfId) : undefined;
    const opponentToGo = opponent ? rooms.bestToGo(room, opponent.id) : null;
    body = (
      <>
        <Caller room={room}>
          {status === 'countdown' && <span className="room__count t-outline t-outline--navy">Starting in {seconds}…</span>}
        </Caller>
        {opponent && opponentToGo !== null && (
          <div className="room__opponent">
            {opponent.name} is <b>{opponentToGo}</b> away from a line
          </div>
        )}
        {!m.isParticipant && status !== 'finished' && (
          <div className="room__opponent">You're watching this round — buy a card when it ends.</div>
        )}
      </>
    );
  }

  const myWin = m?.myPayout ?? 0;
  const won = m ? (m.stake ? m.iWon : myWin > 0) : false;

  return (
    <Stage bg={bg} top={<GameHeader title={title} onBack={() => go({ name: 'rooms' })} />} bottom="none" className="room">
      <div className="room__body">
        {config && m && (
          <div className="room__info">
            <RoomStat
              label={m.stake ? (m.isHall ? 'A card' : 'Stake') : 'Prize pool'}
              value={m.stake ? stakeFigure(m.stake.lamports, m.stake.mint) : formatCoins(room ? room.pool : m.poolPreview)}
            />
            <RoomStat
              label={room ? 'Stage' : m.isHall ? 'Seats' : 'Players'}
              value={room ? `${Math.min(room.stage + 1, config.stages.length)}/${config.stages.length}` : m.isHall && m.stake?.kind === 'hall' ? `${m.seats.length}/${m.stake.maxPlayers}` : m.players.length}
            />
            <RoomStat label={room ? 'Balls' : 'Card'} value={room ? room.drawn.length : config.cardPrice} />
          </div>
        )}
        {body}
        {room && m && playing && <PlayerCards room={room} playerId={m.playerId} daubs={isDuel ? daubs : undefined} onCell={isDuel ? onCell : undefined} />}
        {m && <Feed items={m.feed} />}
      </div>

      {m && isDuel && status === 'drawing' && m.isParticipant && (
        <div className="room__claim">
          <button type="button" className="bingo-btn is-ready anim-pulse" onClick={() => m.claim()}>
            <span className="t-outline t-outline--red">BINGO!</span>
          </button>
        </div>
      )}

      {m && status === 'finished' && room && m.settlement && (
        <>
          {won && <Confetti />}
          <Popup
            title={won ? 'You Win' : 'Round Over'}
            footer={
              <>
                <GreenButton onClick={() => go({ name: 'rooms' })}>Rooms</GreenButton>
                {m.hostLeft ? (
                  <GreenButton tone="gold" onClick={reopen}>
                    Open a new room
                  </GreenButton>
                ) : (
                  <GreenButton tone="gold" onClick={() => m.again()}>
                    {m.nextRoundReady ? 'Join next round' : 'Play again'}
                  </GreenButton>
                )}
              </>
            }
          >
            <div className="popup-center">
              {STAKES && m.stake ? (
                <StakeSide m={m} />
              ) : myWin > 0 ? (
                <RewardPill amount={myWin} table={currency} />
              ) : (
                <p>{m.isParticipant ? `No ${TABLE_NAME[currency]} for you this time.` : 'You watched this one.'}</p>
              )}
              <Results
                room={room}
                settlement={m.settlement}
                note={
                  <>
                    {m.hostLeft ? 'The host left during the round. ' : ''}
                    Pool {formatCoins(m.settlement.pool)} of {formatCoins(m.settlement.sales)} in cards. Seed {m.revealedSeed?.slice(0, 12)}… matches
                    commitment {room.commitment.slice(0, 12)}…; roster hash {m.rosterHash?.slice(0, 12)}…. Verify in Settings → Provably fair.
                  </>
                }
              />
            </div>
          </Popup>
        </>
      )}
    </Stage>
  );
}

function relayLine(relays: number): string {
  return relays === 0 ? 'connecting to relays…' : `${relays} relay${relays > 1 ? 's' : ''} connected`;
}
