import { useEffect, useState } from 'react';
import { address } from '@solana/kit';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import { Segmented } from '../../games/common.tsx';
import { sfx } from '../../lib/audio.ts';
import { rpc, walletClient } from '../../solana/client.ts';
import { CHAIN, CLUSTER, shortAddress } from '../../solana/config.ts';
import * as duel from '../../solana/waveDuel.ts';
import { useGame } from '../../state/store.ts';
import { GreenButton } from '../../ui/kit.tsx';
import { toast } from '../../ui/toast.ts';
import type { LiveRoomMachine } from './machine.ts';

/**
 * The on-chain side of a staked Wave Rush room (programs/wave_duel): the host opens the escrow
 * with a stake, the guest deposits the same, the machine gates the start on the chain's `ready`
 * state and plays the round with the escrow's entropy, and either player settles by revealing
 * the seed. Devnet only, behind VITE_ENABLE_ONCHAIN_STAKES and VITE_WAVE_DUEL_PROGRAM.
 */
type Connected = NonNullable<ReturnType<typeof useConnectedWallet>>;
/** Lamports as numbers for the picker (all well inside a double). */
const PRESETS = duel.STAKE_PRESETS.map((v) => Number(v));

export default function StakePanel({ m }: { m: LiveRoomMachine }) {
  const connected = useConnectedWallet(walletClient);
  const openPopup = useGame((s) => s.openPopup);
  if (!connected) {
    return (
      <div className="stake">
        <p className="stake__title">
          {m.stake ? `Staked room · ${duel.formatSol(BigInt(m.stake.lamports))} each` : `Play for SOL on ${CLUSTER}`}
        </p>
        <p className="small-note">
          {m.stake
            ? 'Connect a wallet to deposit the stake and take the seat. The winner takes the pot on chain.'
            : 'Open this room as an escrow: you and your friend each stake the same SOL and the program pays the winner from the revealed seed.'}
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
  const [busy, setBusy] = useState<string | null>(null);
  const [stakePreset, setStakePreset] = useState<number>(PRESETS[2]!);
  const stakeLamports = BigInt(stakePreset);
  const [config, setConfig] = useState<duel.ConfigAccount | null>(null);
  const [slot, setSlot] = useState<bigint | null>(null);
  const stake = m.stake;
  const chain = m.chain;

  useEffect(() => {
    let cancelled = false;
    duel
      .fetchConfig(rpc)
      .then((c) => !cancelled && setConfig(c))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Read the escrow every few seconds while it matters: the lobby, the results, a claim.
  const roomKey = stake?.room ?? null;
  useEffect(() => {
    if (!roomKey) return;
    let stopped = false;
    const poll = async () => {
      try {
        const room = await duel.fetchRoom(rpc, address(roomKey));
        if (stopped) return;
        m.setChain(
          room
            ? { state: room.state, guest: room.guest, entropy: room.state === 'ready' ? room.entropy : null, commitment: room.commitment, joinedSlot: room.joinedSlot }
            : { state: 'closed', guest: null, entropy: null, commitment: m.commitment, joinedSlot: 0n },
        );
        if (room?.state === 'ready') setSlot(await duel.currentSlot(rpc));
      } catch {
        /* the RPC is down or slow: the next tick tries again */
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 4000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [roomKey, m]);

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

  const openEscrow = () =>
    act('Escrow opened', async () => {
      const sent = await duel.send(rpc, signer, [await duel.openRoomIx(wallet, m.code, stakeLamports, m.commitment)]);
      m.setStake({ lamports: stakeLamports.toString(), host: wallet, program: duel.program(), room: await duel.roomAddress(wallet, m.code) }, wallet);
      return sent.signature;
    });

  const takeSeat = () =>
    act('Seat taken', async () => {
      if (!stake) return null;
      const sent = await duel.send(rpc, signer, [await duel.joinRoomIx(wallet, address(stake.room))]);
      const room = await duel.fetchRoom(rpc, address(stake.room));
      if (room) m.setChain({ state: room.state, guest: room.guest, entropy: room.entropy, commitment: room.commitment, joinedSlot: room.joinedSlot });
      m.seatTaken(wallet);
      return sent.signature;
    });

  const cancel = () =>
    act('Escrow cancelled', async () => {
      if (!stake) return null;
      const sent = await duel.send(rpc, signer, [await duel.cancelRoomIx(wallet, address(stake.room))]);
      m.clearStake();
      return sent.signature;
    });

  const settle = () =>
    act('Settled on chain', async () => {
      if (!stake || !m.revealedSeed || !config) return null;
      const room = await duel.fetchRoom(rpc, address(stake.room));
      if (!room) {
        m.settled('closed');
        toast('Already settled by the other player');
        return null;
      }
      const sent = await duel.send(rpc, signer, [await duel.settleIx(room, config.treasury, wallet, m.revealedSeed)]);
      m.settled(sent.signature);
      return sent.signature;
    });

  const claim = () =>
    act('Pot claimed', async () => {
      if (!stake || !config) return null;
      const room = await duel.fetchRoom(rpc, address(stake.room));
      if (!room) {
        m.settled('closed');
        return null;
      }
      const sent = await duel.send(rpc, signer, [await duel.claimTimeoutIx(room, config.treasury, wallet)]);
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

  /* ---------- Before an escrow exists: the host picks a stake ---------- */
  if (!stake) {
    if (!m.host || m.status !== 'lobby') return null;
    return (
      <div className="stake">
        <p className="stake__title">Play for SOL on {CLUSTER}</p>
        <Segmented options={PRESETS} value={stakePreset} onChange={setStakePreset} render={(v) => duel.formatSol(BigInt(v))} disabled={busy !== null} />
        <p className="small-note">
          You and your friend each stake the same. The program pays the winner from the revealed seed; a tie splits the pot; {feeLine}.
          Wallet {shortAddress(wallet)}.
        </p>
        <GreenButton tone="gold" disabled={busy !== null || config?.paused} onClick={openEscrow}>
          {busy ?? `Open escrow · ${duel.formatSol(stakeLamports)}`}
        </GreenButton>
      </div>
    );
  }

  /* ---------- An escrow exists ---------- */
  const amount = duel.formatSol(BigInt(stake.lamports));
  const state = chain?.state ?? 'reading';
  const iAmSeated = m.myWallet !== null;
  const deadline = chain && chain.joinedSlot > 0n ? chain.joinedSlot + duel.TIMEOUT_SLOTS : null;
  const slotsLeft = deadline !== null && slot !== null ? deadline - slot : null;
  const minutesLeft = slotsLeft !== null ? Math.max(0, Math.ceil((Number(slotsLeft) * 0.4) / 60)) : null;

  return (
    <div className="stake">
      <p className="stake__title">
        Escrow {shortAddress(stake.room)} · {amount} each · {state}
      </p>
      {m.status === 'lobby' && m.host && state === 'open' && (
        <>
          <p className="small-note">Waiting for your friend's deposit. Share the code; they will see this stake in their lobby.</p>
          <GreenButton tone="red" disabled={busy !== null} onClick={cancel}>
            {busy ?? 'Cancel and take my stake back'}
          </GreenButton>
        </>
      )}
      {m.status === 'lobby' && m.host && state === 'ready' && <p className="small-note">Both deposits are in. Start when you are ready; the round plays on both screens and settles on chain.</p>}
      {m.status === 'lobby' && !m.host && !iAmSeated && (
        <>
          <p className="small-note">
            {state === 'open' ? `Deposit ${amount} to take the seat. ${feeLine}.` : state === 'ready' ? 'The seat is taken by another wallet.' : 'The escrow is not open.'}
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
            <GreenButton tone="gold" disabled={busy !== null || state === 'closed'} onClick={settle}>
              {busy ?? (state === 'closed' ? 'Settled by the other player' : 'Settle on chain')}
            </GreenButton>
          )}
        </>
      )}

      {(m.status === 'error' || m.hostLeft) && !m.host && iAmSeated && state === 'ready' && (
        <>
          <p className="small-note">
            The host went quiet with both deposits in the escrow. After about 20 minutes without a reveal, the pot is yours to claim
            {minutesLeft !== null ? ` (about ${minutesLeft} min left)` : ''}.
          </p>
          <GreenButton tone="gold" disabled={busy !== null || (slotsLeft !== null && slotsLeft > 0n)} onClick={claim}>
            {busy ?? 'Claim the pot'}
          </GreenButton>
        </>
      )}
      {m.settleTx && m.status !== 'finished' && <p className="small-note">Done ✓ {link(m.settleTx)}</p>}
    </div>
  );
}
