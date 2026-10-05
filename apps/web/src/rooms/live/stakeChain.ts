import { useCallback, useEffect, useMemo, useState } from 'react';
import { address } from '@solana/kit';
import { sfx } from '../../lib/audio.ts';
import { rpc } from '../../solana/client.ts';
import { registryEntries } from '../../solana/walletStatus.ts';
import * as duel from '../../solana/waveDuel.ts';
import * as halls from '../../solana/waveHall.ts';
import type { MintEntryAccount } from '../../solana/waveToken.ts';
import { toast } from '../../ui/toast.ts';
import type { ChainView, LiveRoomMachine } from './machine.ts';
import { loadConfig } from './stakeConfig.ts';
import { stakeChoices, type StakeChoice } from './stakeTokens.ts';

/**
 * What the two stake panels share: the registry-backed picker choices, the escrow polls that feed
 * the machine its chain view (and the panel the whole account, for the fee snapshot, the Seeker
 * flag and the credits of a token round), and the one-at-a-time action wrapper with its toasts.
 */
export const POLL_MS = 4000;

export function useStakeChoices(): { config: duel.ConfigAccount | null; choices: StakeChoice[] } {
  const [config, setConfig] = useState<duel.ConfigAccount | null>(null);
  const [entries, setEntries] = useState<MintEntryAccount[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadConfig(() => cancelled).then((c) => !cancelled && c && setConfig(c));
    void registryEntries()
      .then((e) => !cancelled && setEntries(e))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  const choices = useMemo(() => stakeChoices(config, entries), [config, entries]);
  return { config, choices };
}

export const roomView = (room: duel.RoomAccount | null, commitment: string): ChainView =>
  room
    ? { kind: 'room', state: room.state, guest: room.guest, entropy: room.state === 'ready' ? room.entropy : null, commitment: room.commitment, joinedSlot: room.joinedSlot }
    : { kind: 'room', state: 'closed', guest: null, entropy: null, commitment, joinedSlot: 0n };

export const hallView = (hall: halls.HallAccount | null, commitment: string): ChainView =>
  hall
    ? { kind: 'hall', state: hall.state, seats: hall.seats, entropy: hall.state === 'locked' ? hall.entropy : null, commitment: hall.commitment, lockedSlot: hall.lockedSlot }
    : { kind: 'hall', state: 'closed', seats: [], entropy: null, commitment, lockedSlot: 0n };

/** Read the room every few seconds while it matters (the lobby, the results, a claim); `read()` reads it now. */
export function useRoomAccount(m: LiveRoomMachine, roomKey: string | null) {
  const [room, setRoom] = useState<duel.RoomAccount | null>(null);
  const [slot, setSlot] = useState<bigint | null>(null);
  const read = useCallback(async () => {
    if (!roomKey) return null;
    const r = await duel.fetchRoom(rpc, address(roomKey));
    setRoom(r);
    m.setChain(roomView(r, m.commitment));
    if (r?.state === 'ready') setSlot(await duel.currentSlot(rpc));
    return r;
  }, [roomKey, m]);
  useEffect(() => {
    if (!roomKey) return;
    let stopped = false;
    const poll = () =>
      read().catch(() => {
        /* the RPC is down or slow: the next tick tries again */
      });
    void poll();
    const id = window.setInterval(() => {
      if (!stopped) void poll();
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [roomKey, read]);
  return { room, slot, read };
}

/** The same for a hall, for everyone in the room, wallet or not: the lobby lists the seats as the chain holds them. */
export function useHallAccount(m: LiveRoomMachine, hallKey: string | null) {
  const [hall, setHall] = useState<halls.HallAccount | null>(null);
  const [slot, setSlot] = useState<bigint | null>(null);
  const read = useCallback(async () => {
    if (!hallKey) return null;
    const h = await halls.fetchHall(rpc, address(hallKey));
    setHall(h);
    m.setChain(hallView(h, m.commitment));
    if (h?.state === 'locked') setSlot(await duel.currentSlot(rpc));
    return h;
  }, [hallKey, m]);
  useEffect(() => {
    if (!hallKey) return;
    let stopped = false;
    const poll = () =>
      read().catch(() => {
        /* retry on the next tick */
      });
    void poll();
    const id = window.setInterval(() => {
      if (!stopped) void poll();
    }, POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [hallKey, read]);
  return { hall, slot, read };
}

/** One chain action at a time, behind a tap: the label while it runs, a toast when it lands or fails. */
export function useAct(): [string | null, (label: string, run: () => Promise<string | null>) => Promise<void>] {
  const [busy, setBusy] = useState<string | null>(null);
  const act = useCallback(
    async (label: string, run: () => Promise<string | null>) => {
      setBusy((current) => current ?? label);
      sfx.click();
      try {
        const signature = await run();
        if (signature) toast(`${label}: confirmed`, 'win');
      } catch (e) {
        toast(e instanceof Error ? e.message.slice(0, 120) : 'The transaction did not go through', 'warn');
      } finally {
        setBusy(null);
      }
    },
    [],
  );
  return [busy, act];
}

/** About how long until a slot, in minutes (0.4 s a slot). */
export const minutesUntil = (slotsLeft: bigint | null): number | null => (slotsLeft !== null ? Math.max(0, Math.ceil((Number(slotsLeft) * 0.4) / 60)) : null);
