import { useEffect, useState } from 'react';
import { address } from '@solana/kit';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import { Segmented } from '../../games/common.tsx';
import { sfx } from '../../lib/audio.ts';
import { rpc, walletClient } from '../../solana/client.ts';
import { CHAIN, CLUSTER } from '../../solana/config.ts';
import * as duel from '../../solana/waveDuel.ts';
import * as halls from '../../solana/waveHall.ts';
import { useGame } from '../../state/store.ts';
import { GreenButton } from '../../ui/kit.tsx';
import { toast } from '../../ui/toast.ts';
import type { ChainView, LiveRoomMachine } from './machine.ts';
import { HALL_CARDS, HALL_PLAYERS } from './protocol.ts';
import { loadConfig, needConfig } from './stakeConfig.ts';

/**
 * The on-chain side of a staked Wave Rush hall (programs/wave_duel, "Halls"): the host opened
 * the table from StakePanel; guests buy seats of 1 to 4 cards; a seated guest locks the table
 * once two players are in (the join that fills the last seat locks it by itself); the machine
 * gates the host's start on the chain's `locked` state and plays the round from the chain's
 * seats with its entropy; anyone settles by revealing the seed, and the program pays every card
 * full on the winning ball an equal share of the pot. The table is read every few seconds for
 * everyone in the room, wallet or not, so the lobby lists the seats as the chain holds them.
 */
type Connected = NonNullable<ReturnType<typeof useConnectedWallet>>;
const CARDS = Array.from({ length: HALL_CARDS.max - HALL_CARDS.min + 1 }, (_, i) => HALL_CARDS.min + i);
const POLL_MS = 4000;

const hallView = (hall: halls.HallAccount | null, commitment: string): ChainView =>
  hall
    ? { kind: 'hall', state: hall.state, seats: hall.seats, entropy: hall.state === 'locked' ? hall.entropy : null, commitment: hall.commitment, lockedSlot: hall.lockedSlot }
    : { kind: 'hall', state: 'closed', seats: [], entropy: null, commitment, lockedSlot: 0n };
const accountUrl = (addr: string) => `https://explorer.solana.com/address/${addr}${CLUSTER === 'devnet' ? '?cluster=devnet' : ''}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Staked hall · 0.01 SOL a card · 3 of 6 seats · open" */
function title(m: LiveRoomMachine): string {
  const stake = m.stake;
  if (stake?.kind !== 'hall') return '';
  const chain = m.chain?.kind === 'hall' ? m.chain : null;
  return `Staked hall · ${duel.formatSol(BigInt(stake.stakePerCard))} a card · ${chain?.seats.length ?? '?'} of ${stake.maxPlayers} seats · ${chain?.state ?? 'reading'}`;
}

export default function HallStakePanel({ m }: { m: LiveRoomMachine }) {
  const connected = useConnectedWallet(walletClient);
  const openPopup = useGame((s) => s.openPopup);
  const [slot, setSlot] = useState<bigint | null>(null);
  const stake = m.stake;
  const hallKey = stake?.kind === 'hall' ? stake.room : null;

  // Read the table every few seconds while it matters: the lobby, the results, a refund.
  useEffect(() => {
    if (!hallKey) return;
    let stopped = false;
    const poll = async () => {
      try {
        const hall = await halls.fetchHall(rpc, address(hallKey));
        if (stopped) return;
        m.setChain(hallView(hall, m.commitment));
        if (hall?.state === 'locked') setSlot(await duel.currentSlot(rpc));
      } catch {
        /* the RPC is down or slow: the next tick tries again */
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [hallKey, m]);

  if (stake?.kind !== 'hall') return null;
  if (!connected) {
    return (
      <div className="stake">
        <p className="stake__title">{title(m)}</p>
        <p className="small-note">
          {m.status === 'finished'
            ? 'Connect a wallet to settle the table: the program replays the round from the revealed seed and pays every winning card.'
            : `Connect a wallet to take a seat: 1 to 4 cards at ${duel.formatSol(BigInt(stake.stakePerCard))} each. Every card full on the winning ball takes an equal share of the pot on chain.`}
        </p>
        <GreenButton tone="blue" onClick={() => openPopup('wallet')}>
          Connect wallet
        </GreenButton>
      </div>
    );
  }
  return <HallActions m={m} account={connected.account} slot={slot} />;
}

function HallActions({ m, account, slot }: { m: LiveRoomMachine; account: Connected['account']; slot: bigint | null }) {
  const signer = useWalletAccountTransactionSendingSigner(account, CHAIN as never);
  const wallet = address(account.address);
  const [busy, setBusy] = useState<string | null>(null);
  const [cards, setCards] = useState<number>(1);
  const [config, setConfig] = useState<duel.ConfigAccount | null>(null);
  const stake = m.stake?.kind === 'hall' ? m.stake : null;
  const chain = m.chain?.kind === 'hall' ? m.chain : null;
  const seats = chain?.seats ?? [];
  // A seat this wallet already holds (the page was reloaded mid-lobby): adopt it so the round knows my cards.
  const mySeatCards = seats.find((s) => s.player === wallet)?.cards ?? 0;

  useEffect(() => {
    let cancelled = false;
    void loadConfig(() => cancelled).then((c) => !cancelled && c && setConfig(c));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (mySeatCards > 0 && m.myWallet !== wallet) m.seatTaken(wallet, mySeatCards);
  }, [mySeatCards, wallet, m]);

  if (!stake) return null;
  const hallAddr = address(stake.room);
  const perCard = BigInt(stake.stakePerCard);

  const act = async (label: string, run: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(label);
    sfx.click();
    try {
      const signature = await run();
      if (signature) toast(`${label}: confirmed`, 'win');
    } catch (e) {
      toast(e instanceof Error ? e.message.slice(0, 120) : 'The transaction did not go through', 'warn');
    } finally {
      setBusy(null);
    }
  };

  /** The table as it stands right now; the roster travels as accounts, so every write starts from a fresh read. */
  const readHall = async () => {
    const hall = await halls.fetchHall(rpc, hallAddr);
    m.setChain(hallView(hall, m.commitment));
    return hall;
  };

  const takeSeat = () =>
    act('Seat taken', async () => {
      const sent = await duel.send(rpc, signer, [await halls.joinHallIx(wallet, hallAddr, cards)]);
      await readHall();
      m.seatTaken(wallet, cards);
      return sent.signature;
    });

  const lock = () =>
    act('Table locked', async () => {
      const sent = await duel.send(rpc, signer, [await halls.lockHallIx(wallet, hallAddr)]);
      await readHall();
      return sent.signature;
    });

  const cancel = () =>
    act('Table called off', async () => {
      const hall = await readHall();
      if (!hall) {
        m.clearStake();
        return null;
      }
      const sent = await duel.send(rpc, signer, [halls.cancelHallIx(hall)]);
      m.clearStake();
      return sent.signature;
    });

  const settle = () =>
    act('Settled on chain', async () => {
      if (!m.revealedSeed) return null;
      const cfg = await needConfig(config);
      const hall = await halls.fetchHall(rpc, hallAddr);
      if (!hall) {
        m.settled('closed');
        toast('Settled by another player');
        return null;
      }
      const sent = await duel.send(rpc, signer, await halls.settleHallIxs(hall, cfg.treasury, wallet, m.revealedSeed));
      m.settled(sent.signature);
      return sent.signature;
    });

  const refund = () =>
    act('Stakes sent back', async () => {
      const cfg = await needConfig(config);
      const hall = await halls.fetchHall(rpc, hallAddr);
      if (!hall) {
        m.settled('closed');
        return null;
      }
      const sent = await duel.send(rpc, signer, [await halls.claimTimeoutHallIx(hall, cfg.treasury, wallet)]);
      m.settled(sent.signature);
      return sent.signature;
    });

  const link = (signature: string) =>
    signature === 'closed' ? null : (
      <a href={duel.explorerUrl(signature, CLUSTER)} target="_blank" rel="noopener noreferrer">
        view on the explorer
      </a>
    );
  const feeLine = config ? `${config.feeBps / 100}% of the pot goes to the house` : 'reading the fee…';
  const state = chain?.state ?? 'reading';
  const lobby = m.status === 'lobby';
  const seated = mySeatCards > 0 || m.myWallet === wallet;
  const full = seats.length >= stake.maxPlayers;
  const enough = seats.length >= HALL_PLAYERS.min;
  const deadline = chain && chain.lockedSlot > 0n ? chain.lockedSlot + halls.HALL_TIMEOUT_SLOTS : null;
  const slotsLeft = deadline !== null && slot !== null ? deadline - slot : null;
  const minutesLeft = slotsLeft !== null ? Math.max(0, Math.ceil((Number(slotsLeft) * 0.4) / 60)) : null;
  const canRefund = state === 'locked' && slotsLeft !== null && slotsLeft <= 0n;
  // The round's cards: the roster once it started (the account is gone after settling), the seats before.
  const cardsSold = m.roster ? m.roster.reduce((n, e) => n + e.cards, 0) : seats.reduce((n, s) => n + s.cards, 0);
  const winningCards = m.room?.wins[0]?.winners.length ?? 0;
  const split = config && winningCards > 0 ? halls.splitHallPot(perCard, cardsSold, config.feeBps, winningCards) : null;
  const mine = m.myWinningCards;

  return (
    <div className="stake">
      <p className="stake__title">{title(m)}</p>

      {/* ---------- The lobby: the host waits for the lock, guests buy seats and lock ---------- */}
      {lobby && m.host && state === 'open' && (
        <>
          <p className="small-note">
            Share the code: seats are bought on chain. A guest locks the table once two players are in (the last seat locks it by itself); then you start.
          </p>
          <GreenButton tone="red" disabled={busy !== null} onClick={cancel}>
            {busy ?? 'Call the table off and send the stakes back'}
          </GreenButton>
        </>
      )}
      {lobby && m.host && state === 'locked' && (
        <p className="small-note">
          The table is locked: {plural(seats.length, 'player')}, {plural(cardsSold, 'card')}. Start when you are ready; the round plays on every screen and settles on chain.
        </p>
      )}
      {lobby &&
        !m.host &&
        !seated &&
        (state === 'open' && !full ? (
          <>
            <div className="stake__row">
              <span>Cards</span>
              <Segmented options={CARDS} value={cards} onChange={setCards} disabled={busy !== null} />
            </div>
            <p className="small-note">
              {duel.formatSol(perCard)} a card; {feeLine}.
            </p>
            <GreenButton tone="gold" disabled={busy !== null} onClick={takeSeat}>
              {busy ?? `Take a seat · ${duel.formatSol(perCard * BigInt(cards))}`}
            </GreenButton>
          </>
        ) : (
          <p className="small-note">
            {state === 'open' ? 'The table is full.' : state === 'locked' ? 'The table is locked: watch this one and join the next.' : state === 'closed' ? 'The table is closed.' : 'Reading the table…'}
          </p>
        ))}
      {lobby && !m.host && seated && state === 'open' && (
        <>
          <p className="small-note">
            Your seat is in ✓ · {plural(mySeatCards || m.myCards, 'card')}.{' '}
            {enough ? 'Lock the table when the roster suits you: locking closes the seats and fixes the draw. The host cannot lock.' : 'One more player and the table can lock.'}
          </p>
          {enough && (
            <GreenButton tone="gold" disabled={busy !== null} onClick={lock}>
              {busy ?? 'Lock the table'}
            </GreenButton>
          )}
        </>
      )}
      {lobby && !m.host && seated && state === 'locked' && !canRefund && <p className="small-note">The table is locked ✓ — waiting for {m.hostName} to start.</p>}

      {/* ---------- The results: anyone settles ---------- */}
      {m.status === 'finished' && (
        <>
          <p className="small-note">
            {mine > 0
              ? `${mine === 1 ? 'One' : mine} of your cards ${mine === 1 ? 'was' : 'were'} full on the winning ball${split ? `: ${duel.formatSol(split.share)} each` : ''}.`
              : m.isParticipant
                ? 'Your cards missed the winning ball this time.'
                : 'You watched this one.'}{' '}
            {split ? `${plural(winningCards, 'winning card')} share the pot of ${duel.formatSol(split.pot)}. ` : ''}
            Settling reveals the seed to the program, which replays every card and pays. Anyone can do it.
          </p>
          {m.settleTx ? (
            <p className="small-note">Settled ✓ {link(m.settleTx)}</p>
          ) : (
            <GreenButton tone="gold" disabled={busy !== null || state === 'closed'} onClick={settle}>
              {busy ?? (state === 'closed' ? 'Settled by another player' : 'Settle on chain')}
            </GreenButton>
          )}
        </>
      )}

      {/* ---------- The host is gone: an open table only its host can call off; a locked one refunds after the timeout ---------- */}
      {m.status === 'error' && !m.host && state === 'open' && (
        <>
          <p className="small-note">
            The host left with the table still open. Only the host can call an open table off, and the timeout runs only once a table is locked (
            <a href={accountUrl(stake.room)} target="_blank" rel="noopener noreferrer">
              the table on the explorer
            </a>
            ).
            {seated && enough
              ? ' Lock it now: with nobody to reveal the seed, the program sends every stake back about 20 minutes after the lock.'
              : seated
                ? ' Another player has to join before it can lock.'
                : ''}
          </p>
          {seated && enough && (
            <GreenButton tone="gold" disabled={busy !== null} onClick={lock}>
              {busy ?? 'Lock the table'}
            </GreenButton>
          )}
        </>
      )}
      {(m.status === 'error' || (lobby && !m.host && canRefund)) && state === 'locked' && (
        <>
          <p className="small-note">
            The host went quiet with the table locked. After about 20 minutes without a reveal, anyone can send every stake back
            {minutesLeft !== null && !canRefund ? ` (about ${minutesLeft} min left)` : ''}.
          </p>
          <GreenButton tone="gold" disabled={busy !== null || !canRefund} onClick={refund}>
            {busy ?? 'Send the stakes back'}
          </GreenButton>
        </>
      )}
      {m.settleTx && m.status !== 'finished' && <p className="small-note">Done ✓ {link(m.settleTx)}</p>}
    </div>
  );
}
