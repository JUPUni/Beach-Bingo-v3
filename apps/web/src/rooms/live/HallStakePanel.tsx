import { useEffect, useState } from 'react';
import { address } from '@solana/kit';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import { Segmented } from '../../games/common.tsx';
import { Badges } from '../../solana/Badges.tsx';
import { rpc, walletClient } from '../../solana/client.ts';
import { CHAIN, CLUSTER, WAVE_DUEL_PROGRAM } from '../../solana/config.ts';
import { decimalsOf, formatAmount, formatStake, symbolOf } from '../../solana/tokens.ts';
import * as duel from '../../solana/waveDuel.ts';
import * as halls from '../../solana/waveHall.ts';
import * as tok from '../../solana/waveToken.ts';
import { useGame } from '../../state/store.ts';
import { GreenButton } from '../../ui/kit.tsx';
import { toast } from '../../ui/toast.ts';
import type { LiveRoomMachine } from './machine.ts';
import { HALL_CARDS, HALL_PLAYERS } from './protocol.ts';
import { loadConfig, needConfig } from './stakeConfig.ts';
import { minutesUntil, useAct, useHallAccount } from './stakeChain.ts';
import { feeLine } from './stakeTokens.ts';
import { VerifySeeker } from './VerifySeeker.tsx';

/**
 * The on-chain side of a staked Wave Rush hall (programs/wave_duel, "Halls"), in SOL or a
 * registered token: the host opened the table from StakePanel; guests buy seats of 1 to 4 cards;
 * a seated guest locks the table once two players are in (the join that fills the last seat locks
 * it by itself); the machine gates the host's start on the chain's `locked` state and plays the
 * round from the chain's seats with its entropy; anyone settles by revealing the seed, and the
 * program pays every card full on the winning ball an equal share of the pot (a token hall's
 * settlement travels with the roster's token accounts and a compute limit, waveToken.ts). The
 * table is read every few seconds for everyone in the room, wallet or not.
 */
type Connected = NonNullable<ReturnType<typeof useConnectedWallet>>;
const CARDS = Array.from({ length: HALL_CARDS.max - HALL_CARDS.min + 1 }, (_, i) => HALL_CARDS.min + i);
const accountUrl = (addr: string) => `https://explorer.solana.com/address/${addr}${CLUSTER === 'devnet' ? '?cluster=devnet' : ''}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "Staked hall · 0.01 SOL a card · 3 of 6 seats · open" */
function title(m: LiveRoomMachine, settled: boolean): string {
  const stake = m.stake;
  if (stake?.kind !== 'hall') return '';
  const chain = m.chain?.kind === 'hall' ? m.chain : null;
  return `Staked hall · ${formatStake(BigInt(stake.stakePerCard), stake.mint)} a card · ${chain?.seats.length ?? '?'} of ${stake.maxPlayers} seats · ${settled ? 'settled' : (chain?.state ?? 'reading')}`;
}

export default function HallStakePanel({ m }: { m: LiveRoomMachine }) {
  const connected = useConnectedWallet(walletClient);
  const openPopup = useGame((s) => s.openPopup);
  const stake = m.stake;
  // A table on another program (another build, a crafted peer): this app cannot read or settle it, so no button and no reads.
  const known = stake?.program === WAVE_DUEL_PROGRAM;
  const { hall, slot } = useHallAccount(m, stake?.kind === 'hall' && known ? stake.room : null);
  if (stake?.kind !== 'hall') return null;
  if (!known) {
    return (
      <div className="stake">
        <p className="small-note">This stake is on a program this app does not know.</p>
      </div>
    );
  }
  if (!connected) {
    return (
      <div className="stake">
        <p className="stake__title">{title(m, hall?.settled ?? false)}</p>
        <p className="small-note">
          {m.status === 'finished'
            ? 'Connect a wallet to settle the table: the program replays the round from the revealed seed and pays every winning card.'
            : `Connect a wallet to take a seat: 1 to 4 cards at ${formatStake(BigInt(stake.stakePerCard), stake.mint)} each. Every card full on the winning ball takes an equal share of the pot on chain.`}
        </p>
        <GreenButton tone="blue" onClick={() => openPopup('wallet')}>
          Connect wallet
        </GreenButton>
      </div>
    );
  }
  return <HallActions m={m} account={connected.account} slot={slot} onChain={hall} />;
}

function HallActions({ m, account, slot, onChain }: { m: LiveRoomMachine; account: Connected['account']; slot: bigint | null; onChain: halls.HallAccount | null }) {
  const signer = useWalletAccountTransactionSendingSigner(account, CHAIN as never);
  const wallet = address(account.address);
  const [busy, act] = useAct();
  const [cards, setCards] = useState<number>(1);
  const [config, setConfig] = useState<duel.ConfigAccount | null>(null);
  const seekerToken = useGame((s) => s.walletStatus?.seeker ?? null);
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
  const mint = stake.mint ?? null;
  const decimals = onChain?.mint ? decimalsOf(onChain.mint) : decimalsOf(mint);
  const symbol = symbolOf(mint);
  const fmt = (base: bigint) => formatAmount(base, decimals, symbol);
  const proof = seekerToken ? { tokenAccount: address(seekerToken.tokenAccount), mint: address(seekerToken.mint) } : null;

  /** The table as it stands right now; the roster travels as accounts, so every write starts from a fresh read. */
  const readHall = async () => {
    const hall = await halls.fetchHall(rpc, hallAddr);
    m.setChain(
      hall
        ? { kind: 'hall', state: hall.state, seats: hall.seats, entropy: hall.state === 'locked' ? hall.entropy : null, commitment: hall.commitment, lockedSlot: hall.lockedSlot }
        : { kind: 'hall', state: 'closed', seats: [], entropy: null, commitment: m.commitment, lockedSlot: 0n },
    );
    return hall;
  };

  const takeSeat = () =>
    act('Seat taken', async () => {
      const hall = await readHall();
      if (!hall) throw new Error('The table is gone');
      const sent = await duel.send(rpc, signer, [hall.mint ? await tok.joinHallTokenIx(wallet, hall, cards) : await halls.joinHallIx(wallet, hallAddr, cards)]);
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
      const sent = await duel.send(rpc, signer, [hall.mint ? await tok.cancelHallTokenIx(hall) : halls.cancelHallIx(hall)]);
      m.clearStake();
      return sent.signature;
    });

  const settle = () =>
    act('Settled on chain', async () => {
      if (!m.revealedSeed) return null;
      const hall = await halls.fetchHall(rpc, hallAddr);
      if (!hall || hall.settled) {
        m.settled('closed');
        toast('Settled by another player');
        return null;
      }
      const ixs = hall.mint ? await tok.settleHallTokenIxs(hall, wallet, m.revealedSeed) : await halls.settleHallIxs(hall, (await needConfig(config)).treasury, wallet, m.revealedSeed);
      const sent = await duel.send(rpc, signer, ixs);
      m.settled(sent.signature);
      await readHall().catch(() => undefined);
      return sent.signature;
    });

  const refund = () =>
    act('Stakes sent back', async () => {
      const hall = await halls.fetchHall(rpc, hallAddr);
      if (!hall) {
        m.settled('closed');
        return null;
      }
      const ix = hall.mint ? await tok.claimTimeoutHallTokenIx(hall, wallet) : await halls.claimTimeoutHallIx(hall, (await needConfig(config)).treasury, wallet);
      const sent = await duel.send(rpc, signer, [ix]);
      m.settled(sent.signature);
      await readHall().catch(() => undefined);
      return sent.signature;
    });

  const claimCredit = () =>
    act('Share claimed', async () => {
      const hall = await halls.fetchHall(rpc, hallAddr);
      const seat = hall ? halls.seatOf(hall, wallet) : -1;
      if (!hall?.mint || seat < 0) return null;
      const sent = await duel.send(rpc, signer, [await tok.claimCreditHallIx(hall, seat, wallet)]);
      await readHall().catch(() => undefined);
      return sent.signature;
    });

  const proveSeeker = () =>
    act('Seeker verified', async () => {
      const hall = await halls.fetchHall(rpc, hallAddr);
      if (!hall || !proof) return null;
      const sent = await duel.send(rpc, signer, [await tok.proveSeekerHallIx(hall, proof)]);
      await readHall().catch(() => undefined);
      return sent.signature;
    });

  const link = (signature: string) =>
    signature === 'closed' ? null : (
      <a href={duel.explorerUrl(signature, CLUSTER)} target="_blank" rel="noopener noreferrer">
        view on the explorer
      </a>
    );
  const feeBps = onChain?.feeBps ?? config?.feeBps ?? null;
  const feeNow = feeBps !== null ? feeLine({ symbol, feeBps, seekerFeeBps: feeBps }, onChain?.seeker ?? false) : 'reading the fee…';
  const state = chain?.state ?? 'reading';
  const lobby = m.status === 'lobby';
  const seated = mySeatCards > 0 || m.myWallet === wallet;
  const full = seats.length >= stake.maxPlayers;
  const enough = seats.length >= HALL_PLAYERS.min;
  const deadline = chain && chain.lockedSlot > 0n ? chain.lockedSlot + halls.HALL_TIMEOUT_SLOTS : null;
  const slotsLeft = deadline !== null && slot !== null ? deadline - slot : null;
  const minutesLeft = minutesUntil(slotsLeft);
  const canRefund = state === 'locked' && !onChain?.settled && slotsLeft !== null && slotsLeft <= 0n;
  // The round's cards: the roster once it started (the account is gone after settling), the seats before.
  const cardsSold = m.roster ? m.roster.reduce((n, e) => n + e.cards, 0) : seats.reduce((n, s) => n + s.cards, 0);
  const winningCards = m.room?.wins[0]?.winners.length ?? 0;
  const split = feeBps !== null && winningCards > 0 ? halls.splitHallPot(perCard, cardsSold, feeBps, winningCards) : null;
  const mine = m.myWinningCards;
  const mySeat = onChain ? halls.seatOf(onChain, wallet) : -1;
  const myCredit = onChain?.settled && mySeat >= 0 ? (onChain.credits[mySeat] ?? 0n) : 0n;
  const othersCredit = onChain?.settled ? onChain.credits.reduce((a, b) => a + b, 0n) + onChain.treasuryCredit - myCredit : 0n;

  return (
    <div className="stake">
      <p className="stake__title">{title(m, onChain?.settled ?? false)}</p>

      {/* ---------- The lobby: the host waits for the lock, guests buy seats and lock ---------- */}
      {lobby && m.host && state === 'open' && (
        <>
          <p className="small-note">
            Share the code: seats are bought on chain. A guest locks the table once two players are in (the last seat locks it by itself); then you start. {feeNow}.
          </p>
          <VerifySeeker proved={onChain?.seeker ?? false} available={!!proof} busy={busy !== null} onProve={proveSeeker} />
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
              {fmt(perCard)} a card; {feeNow}.
            </p>
            <GreenButton tone="gold" disabled={busy !== null} onClick={takeSeat}>
              {busy ?? `Take a seat · ${fmt(perCard * BigInt(cards))}`}
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
              ? `${mine === 1 ? 'One' : mine} of your cards ${mine === 1 ? 'was' : 'were'} full on the winning ball${split ? `: ${fmt(split.share)} each` : ''}.`
              : m.isParticipant
                ? 'Your cards missed the winning ball this time.'
                : 'You watched this one.'}{' '}
            {split ? `${plural(winningCards, 'winning card')} share the pot of ${fmt(split.pot)}. ` : ''}
            Settling reveals the seed to the program, which replays every card and pays. Anyone can do it.
          </p>
          {m.settleTx ? (
            <p className="small-note">Settled ✓ {link(m.settleTx)}</p>
          ) : (
            <GreenButton tone="gold" disabled={busy !== null || state === 'closed' || onChain?.settled} onClick={settle}>
              {busy ?? (state === 'closed' || onChain?.settled ? 'Settled by another player' : 'Settle on chain')}
            </GreenButton>
          )}
        </>
      )}
      {onChain?.settled &&
        (myCredit > 0n ? (
          <>
            <p className="small-note">Your share of {fmt(myCredit)} is waiting on the table: your token account could not be paid at settlement. Claim it to any account of yours for this token.</p>
            <GreenButton tone="gold" disabled={busy !== null} onClick={claimCredit}>
              {busy ?? `Claim your share · ${fmt(myCredit)}`}
            </GreenButton>
          </>
        ) : othersCredit > 0n ? (
          <p className="small-note">Settled; a share for another seat is still waiting to be claimed, then the table closes.</p>
        ) : null)}

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
      {(m.status === 'error' || (lobby && !m.host && canRefund)) && state === 'locked' && !onChain?.settled && (
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
      <Badges provedThisRound={onChain?.seeker ?? false} />
    </div>
  );
}
