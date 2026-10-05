import { useMemo, useState } from 'react';
import { address } from '@solana/kit';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import { Segmented } from '../../games/common.tsx';
import { Badges } from '../../solana/Badges.tsx';
import { rpc, walletClient } from '../../solana/client.ts';
import { CHAIN, CLUSTER, WAVE_DUEL_PROGRAM, shortAddress } from '../../solana/config.ts';
import { formatAmount, formatStake } from '../../solana/tokens.ts';
import * as duel from '../../solana/waveDuel.ts';
import * as halls from '../../solana/waveHall.ts';
import * as tok from '../../solana/waveToken.ts';
import { useGame } from '../../state/store.ts';
import { GreenButton } from '../../ui/kit.tsx';
import { toast } from '../../ui/toast.ts';
import type { LiveRoomMachine } from './machine.ts';
import { HALL_CARDS, HALL_PLAYERS } from './protocol.ts';
import { needConfig } from './stakeConfig.ts';
import { minutesUntil, useAct, useRoomAccount, useStakeChoices } from './stakeChain.ts';
import { choiceFor, defaultChoice, feeLine, type StakeChoice } from './stakeTokens.ts';
import { VerifySeeker } from './VerifySeeker.tsx';

/**
 * The on-chain side of a staked Wave Rush room (programs/wave_duel): the host opens the escrow
 * with a stake in SOL or a registered token, the guest deposits the same, the machine gates the
 * start on the chain's `ready` state and plays the round with the escrow's entropy, and either
 * player settles by revealing the seed. Devnet only, behind VITE_ENABLE_ONCHAIN_STAKES and
 * VITE_WAVE_DUEL_PROGRAM.
 *
 * The host's picker also opens a hall (2 to 8 players, 1 to 4 cards each at a stake per card);
 * once one exists the room mounts HallStakePanel.tsx instead of this panel. The token picker is
 * the registry's enabled mints plus SOL (stakeTokens.ts); a token round's payouts that could not
 * be delivered stay as credits on the room, which "Claim your share" collects.
 */
type Connected = NonNullable<ReturnType<typeof useConnectedWallet>>;
type Mode = 'duel' | 'hall';
const MODES: readonly Mode[] = ['duel', 'hall'];
const range = (min: number, max: number) => Array.from({ length: max - min + 1 }, (_, i) => min + i);
const SEATS = range(HALL_PLAYERS.min, HALL_PLAYERS.max);
const CARDS = range(HALL_CARDS.min, HALL_CARDS.max);

export default function StakePanel({ m }: { m: LiveRoomMachine }) {
  const connected = useConnectedWallet(walletClient);
  const openPopup = useGame((s) => s.openPopup);
  // A stake on another program (another build, a crafted peer): this app cannot read or settle it, so no button.
  if (m.stake && m.stake.program !== WAVE_DUEL_PROGRAM) {
    return (
      <div className="stake">
        <p className="small-note">This stake is on a program this app does not know.</p>
      </div>
    );
  }
  if (!connected) {
    return (
      <div className="stake">
        <p className="stake__title">{m.stake ? `Staked room · ${formatStake(BigInt(m.stake.lamports), m.stake.mint)} each` : `Play for SOL on ${CLUSTER}`}</p>
        <p className="small-note">
          {m.stake
            ? 'Connect a wallet to deposit the stake and take the seat. The winner takes the pot on chain.'
            : 'Open this room as an escrow: you and your friend each stake the same, in SOL, SKR, USDC, PYUSD or JUP, and the program pays the winner from the revealed seed.'}
        </p>
        <GreenButton tone="blue" onClick={() => openPopup('wallet')}>
          Connect wallet
        </GreenButton>
      </div>
    );
  }
  return <StakeActions m={m} account={connected.account} />;
}

function StakeActions({ m, account }: { m: LiveRoomMachine; account: Connected['account'] }) {
  const signer = useWalletAccountTransactionSendingSigner(account, CHAIN as never);
  const wallet = address(account.address);
  const [busy, act] = useAct();
  const { config, choices } = useStakeChoices();
  const skrReady = useGame((s) => s.skrReady);
  const seekerToken = useGame((s) => s.walletStatus?.seeker ?? null);
  const [choiceKey, setChoiceKey] = useState<string | null>(null);
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('duel');
  const [seats, setSeats] = useState<number>(4);
  const [hostCards, setHostCards] = useState<number>(1);
  const stake = m.stake;
  const chain = m.chain;
  const { room: onChain, slot, read } = useRoomAccount(m, stake?.room ?? null);

  const choice: StakeChoice = useMemo(() => choices.find((c) => c.key === choiceKey) ?? defaultChoice(choices, skrReady), [choices, choiceKey, skrReady]);
  const stakeAmount = useMemo(() => {
    const picked = presetKey ? choice.presets.find((v) => v.toString() === presetKey) : undefined;
    return picked ?? choice.presets[Math.min(2, choice.presets.length - 1)] ?? choice.min;
  }, [choice, presetKey]);
  // After an escrow exists its asset is the stake's, whatever the picker says.
  const staked = stake ? choiceFor(choices, stake.mint ?? null) : null;
  const fmt = (base: bigint) => (staked ? formatAmount(base, staked.decimals, staked.symbol) : formatAmount(base, choice.decimals, choice.symbol));
  const symbolCount = useMemo(() => choices.reduce<Record<string, number>>((n, c) => ({ ...n, [c.symbol]: (n[c.symbol] ?? 0) + 1 }), {}), [choices]);
  const tokenLabel = (key: string) => {
    const c = choices.find((x) => x.key === key)!;
    return (symbolCount[c.symbol] ?? 0) > 1 && c.mint ? `${c.symbol} ${c.mint.slice(0, 4)}` : c.symbol;
  };
  const proof = seekerToken ? { tokenAccount: address(seekerToken.tokenAccount), mint: address(seekerToken.mint) } : null;

  const openEscrow = () =>
    act('Escrow opened', async () => {
      const ix = choice.entry ? await tok.openRoomTokenIx(wallet, m.code, stakeAmount, m.commitment, choice.entry) : await duel.openRoomIx(wallet, m.code, stakeAmount, m.commitment);
      const sent = await duel.send(rpc, signer, [ix]);
      m.setStake(
        { kind: 'room', lamports: stakeAmount.toString(), host: wallet, program: duel.program(), room: await duel.roomAddress(wallet, m.code), ...(choice.mint ? { mint: choice.mint } : {}) },
        wallet,
      );
      return sent.signature;
    });

  const openHall = () =>
    act('Table opened', async () => {
      const ix = choice.entry
        ? await tok.openHallTokenIx(wallet, m.code, stakeAmount, seats, hostCards, m.commitment, choice.entry)
        : await halls.openHallIx(wallet, m.code, stakeAmount, seats, hostCards, m.commitment);
      const sent = await duel.send(rpc, signer, [ix]);
      const lamports = stakeAmount.toString();
      m.setStake(
        { kind: 'hall', lamports, stakePerCard: lamports, maxPlayers: seats, host: wallet, program: duel.program(), room: await halls.hallAddress(wallet, m.code), ...(choice.mint ? { mint: choice.mint } : {}) },
        wallet,
        hostCards,
      );
      return sent.signature;
    });

  /** The escrow as it stands right now; every write starts from a fresh read. */
  const current = async (): Promise<duel.RoomAccount | null> => (stake ? duel.fetchRoom(rpc, address(stake.room)) : null);

  const takeSeat = () =>
    act('Seat taken', async () => {
      const room = await current();
      if (!room) throw new Error('The escrow is not open any more');
      const sent = await duel.send(rpc, signer, [room.mint ? await tok.joinRoomTokenIx(wallet, room) : await duel.joinRoomIx(wallet, room.address)]);
      await read();
      m.seatTaken(wallet);
      return sent.signature;
    });

  const cancel = () =>
    act('Escrow cancelled', async () => {
      const room = await current();
      if (!room) {
        m.clearStake();
        return null;
      }
      const sent = await duel.send(rpc, signer, [room.mint ? await tok.cancelRoomTokenIx(room) : await duel.cancelRoomIx(wallet, room.address)]);
      m.clearStake();
      return sent.signature;
    });

  const settle = () =>
    act('Settled on chain', async () => {
      if (!m.revealedSeed) return null;
      const room = await current();
      if (!room || room.settled) {
        m.settled('closed');
        toast('Already settled by the other player');
        return null;
      }
      const ix = room.mint ? await tok.settleTokenIx(room, wallet, m.revealedSeed) : await duel.settleIx(room, (await needConfig(config)).treasury, wallet, m.revealedSeed);
      const sent = await duel.send(rpc, signer, [ix]);
      m.settled(sent.signature);
      await read().catch(() => undefined);
      return sent.signature;
    });

  const claimTimeout = () =>
    act('Pot claimed', async () => {
      const room = await current();
      if (!room) {
        m.settled('closed');
        return null;
      }
      const ix = room.mint ? await tok.claimTimeoutTokenIx(room, wallet) : await duel.claimTimeoutIx(room, (await needConfig(config)).treasury, wallet);
      const sent = await duel.send(rpc, signer, [ix]);
      m.settled(sent.signature);
      await read().catch(() => undefined);
      return sent.signature;
    });

  const claimCredit = () =>
    act('Share claimed', async () => {
      const room = await current();
      if (!room?.mint) return null;
      const sent = await duel.send(rpc, signer, [await tok.claimCreditIx(room, room.host === wallet ? 0 : 1, wallet)]);
      await read().catch(() => undefined);
      return sent.signature;
    });

  const proveSeeker = () =>
    act('Seeker verified', async () => {
      const room = await current();
      if (!room || !proof) return null;
      const sent = await duel.send(rpc, signer, [await tok.proveSeekerRoomIx(room, proof)]);
      await read().catch(() => undefined);
      return sent.signature;
    });

  const link = (signature: string) =>
    signature === 'closed' ? null : (
      <a href={duel.explorerUrl(signature, CLUSTER)} target="_blank" rel="noopener noreferrer">
        view on the explorer
      </a>
    );
  const pct = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

  /* ---------- Before an escrow exists: the host picks an asset and a stake, as a duel or a hall ---------- */
  if (!stake) {
    if (!m.host || m.status !== 'lobby') return null;
    const hall = mode === 'hall';
    const fee = config ? feeLine(choice, false) : 'reading the fee…';
    return (
      <div className="stake">
        <p className="stake__title">Play for {choice.symbol} on {CLUSTER}</p>
        <Segmented options={MODES} value={mode} onChange={setMode} render={(v) => (v === 'duel' ? 'Duel (1v1)' : 'Hall')} disabled={busy !== null} />
        {choices.length > 1 && (
          <div className="stake__row">
            <span>Token</span>
            <Segmented
              options={choices.map((c) => c.key)}
              value={choice.key}
              onChange={(k) => {
                setChoiceKey(k);
                setPresetKey(null);
              }}
              render={tokenLabel}
              disabled={busy !== null}
            />
          </div>
        )}
        <Segmented options={choice.presets.map((v) => v.toString())} value={stakeAmount.toString()} onChange={setPresetKey} render={(v) => fmt(BigInt(v))} disabled={busy !== null} />
        {hall && (
          <>
            <div className="stake__row">
              <span>Seats</span>
              <Segmented options={SEATS} value={seats} onChange={setSeats} disabled={busy !== null} />
            </div>
            <div className="stake__row">
              <span>My cards</span>
              <Segmented options={CARDS} value={hostCards} onChange={setHostCards} disabled={busy !== null} />
            </div>
          </>
        )}
        <p className="small-note">
          {hall
            ? `Up to ${seats} players with 1 to 4 cards each at ${fmt(stakeAmount)} a card. A guest locks the table, you start, and every card full on the winning ball takes an equal share of the pot. ${fee}.`
            : `You and your friend each stake the same. The program pays the winner from the revealed seed; a tie splits the pot. ${fee}.`}
          {seekerToken ? ` Verify your Seeker once the table is open and the fee drops to ${pct(choice.seekerFeeBps)}.` : ''} Wallet {shortAddress(wallet)}.
        </p>
        <Badges />
        <GreenButton tone="gold" disabled={busy !== null || config?.paused} onClick={hall ? openHall : openEscrow}>
          {busy ?? (hall ? `Open a table · ${hostCards} card${hostCards > 1 ? 's' : ''} · ${fmt(stakeAmount * BigInt(hostCards))}` : `Open escrow · ${fmt(stakeAmount)}`)}
        </GreenButton>
      </div>
    );
  }

  /* ---------- An escrow exists ---------- */
  const amount = fmt(BigInt(stake.lamports));
  const state = chain?.kind === 'room' ? chain.state : 'reading';
  const iAmSeated = m.myWallet !== null;
  const deadline = chain?.kind === 'room' && chain.joinedSlot > 0n ? chain.joinedSlot + duel.TIMEOUT_SLOTS : null;
  const slotsLeft = deadline !== null && slot !== null ? deadline - slot : null;
  const minutesLeft = minutesUntil(slotsLeft);
  const feeNow = onChain ? `${feeLine({ symbol: staked?.symbol ?? 'SOL', feeBps: onChain.feeBps, seekerFeeBps: onChain.feeBps }, onChain.seeker)}` : 'reading the fee…';
  const myCredit = onChain?.settled ? (onChain.host === wallet ? onChain.credits[0] : onChain.guest === wallet ? onChain.credits[1] : 0n) : 0n;
  const othersCredit = onChain?.settled ? onChain.credits[0] + onChain.credits[1] + onChain.treasuryCredit - myCredit : 0n;

  return (
    <div className="stake">
      <p className="stake__title">
        Escrow {shortAddress(stake.room)} · {amount} each · {onChain?.settled ? 'settled' : state}
      </p>
      {m.status === 'lobby' && m.host && state === 'open' && (
        <>
          <p className="small-note">
            Waiting for your friend's deposit. Share the code; they will see this stake in their lobby. {feeNow}.
          </p>
          <VerifySeeker proved={onChain?.seeker ?? false} available={!!proof} busy={busy !== null} onProve={proveSeeker} />
          <GreenButton tone="red" disabled={busy !== null} onClick={cancel}>
            {busy ?? 'Cancel and take my stake back'}
          </GreenButton>
        </>
      )}
      {m.status === 'lobby' && m.host && state === 'ready' && (
        <p className="small-note">
          Both deposits are in. Start when you are ready; the round plays on both screens and settles on chain. {feeNow}.
        </p>
      )}
      {m.status === 'lobby' && !m.host && !iAmSeated && (
        <>
          <p className="small-note">
            {state === 'open' ? `Deposit ${amount} to take the seat. ${feeNow}.` : state === 'ready' ? 'The seat is taken by another wallet.' : 'The escrow is not open.'}
          </p>
          <GreenButton tone="gold" disabled={busy !== null || state !== 'open'} onClick={takeSeat}>
            {busy ?? `Deposit ${amount} and play`}
          </GreenButton>
        </>
      )}
      {m.status === 'lobby' && !m.host && iAmSeated && <p className="small-note">Your deposit is in ✓ — waiting for {m.hostName} to start.</p>}

      {m.status === 'finished' && (
        <>
          <p className="small-note">
            {m.iWon ? 'Your card finished first: the pot is yours.' : 'Your friend finished first: the pot is theirs.'} Settling reveals the seed to the program, which replays
            the round and pays. Either player can do it.
          </p>
          {m.settleTx ? (
            <p className="small-note">Settled ✓ {link(m.settleTx)}</p>
          ) : (
            <GreenButton tone="gold" disabled={busy !== null || state === 'closed' || onChain?.settled} onClick={settle}>
              {busy ?? (state === 'closed' || onChain?.settled ? 'Settled by the other player' : 'Settle on chain')}
            </GreenButton>
          )}
        </>
      )}

      {onChain?.settled && (
        <>
          {myCredit > 0n ? (
            <>
              <p className="small-note">Your share of {fmt(myCredit)} is waiting on the escrow: your token account could not be paid at settlement. Claim it to any account of yours for this token.</p>
              <GreenButton tone="gold" disabled={busy !== null} onClick={claimCredit}>
                {busy ?? `Claim your share · ${fmt(myCredit)}`}
              </GreenButton>
            </>
          ) : othersCredit > 0n ? (
            <p className="small-note">Settled; a share for another account is still waiting to be claimed, then the escrow closes.</p>
          ) : null}
        </>
      )}

      {(m.status === 'error' || m.hostLeft) && !m.host && iAmSeated && state === 'ready' && !onChain?.settled && (
        <>
          <p className="small-note">
            The host went quiet with both deposits in the escrow. After about 20 minutes without a reveal, the pot is yours to claim
            {minutesLeft !== null ? ` (about ${minutesLeft} min left)` : ''}.
          </p>
          <GreenButton tone="gold" disabled={busy !== null || (slotsLeft !== null && slotsLeft > 0n)} onClick={claimTimeout}>
            {busy ?? 'Claim the pot'}
          </GreenButton>
        </>
      )}
      {m.settleTx && m.status !== 'finished' && <p className="small-note">Done ✓ {link(m.settleTx)}</p>}
      <Badges provedThisRound={onChain?.seeker ?? false} />
    </div>
  );
}
