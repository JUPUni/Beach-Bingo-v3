import { useCallback, useId, useSyncExternalStore } from 'react';
import type { RoomPresetId } from '@beach-bingo/engine';
import { callBall, say, sfx } from '../../lib/audio.ts';
import { logExternalRound } from '../../lib/fair.ts';
import { useGame } from '../../state/store.ts';
import { toast } from '../../ui/toast.ts';
import { LiveRoomMachine, type LiveEvent } from './machine.ts';
import { connectRoom } from './net.ts';

interface Snapshot {
  machine: LiveRoomMachine | null;
  tick: number;
}

interface Store {
  snapshot: Snapshot;
  listeners: Set<() => void>;
}

const EMPTY: Snapshot = { machine: null, tick: 0 };
/** One store per mounted screen, keyed by React's id for it; mutated only inside subscriptions. */
const stores = new Map<string, Store>();

/**
 * The live room behind a screen. The machine lives for as long as something is subscribed to it
 * (React's strict-mode double mount opens and leaves a first machine cleanly) and is `null` until
 * the first subscription lands, which is one paint.
 */
export function useLiveRoom(opts: { code: string; host: boolean; preset?: RoomPresetId }): LiveRoomMachine | null {
  const { code, host, preset } = opts;
  const id = useId();
  const subscribe = useCallback(
    (listener: () => void) => {
      let store = stores.get(id);
      if (!store) {
        store = { snapshot: EMPTY, listeners: new Set() };
        stores.set(id, store);
      }
      const s = store;
      s.listeners.add(listener);
      if (!s.snapshot.machine) {
        const machine = new LiveRoomMachine({
          code,
          host,
          preset,
          name: useGame.getState().profile.name,
          wallet: {
            blocked: () => useGame.getState().wagerBlockedReason(),
            spend: (amount) => useGame.getState().spend(amount, { wager: true }),
            refund: (amount) => useGame.getState().refund(amount),
            win: (amount) => useGame.getState().recordWin(amount),
          },
          connect: connectRoom,
          onEvent: (event) => react(machine, event),
        });
        const notify = () => {
          s.snapshot = { machine, tick: s.snapshot.tick + 1 };
          for (const l of s.listeners) l();
        };
        machine.subscribe(notify);
        s.snapshot = { machine, tick: 1 };
        void machine.open();
        queueMicrotask(notify);
      }
      return () => {
        s.listeners.delete(listener);
        if (s.listeners.size === 0) {
          s.snapshot.machine?.leave();
          stores.delete(id);
        }
      };
    },
    [id, code, host, preset],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => stores.get(id)?.snapshot ?? EMPTY,
    () => EMPTY,
  );
  return snapshot.machine;
}

/** Sounds, toasts and the fairness log for what happens in the room. */
function react(machine: LiveRoomMachine, event: LiveEvent): void {
  const game = useGame.getState();
  switch (event.kind) {
    case 'ball':
      sfx.ball();
      callBall(event.ball, machine.config?.variant ?? '75');
      return;
    case 'stage':
      if (event.mine) {
        sfx.bingo();
        say('Bingo!');
        game.track('bingo');
      } else {
        sfx.win();
      }
      return;
    case 'countdown':
      say('Get ready');
      return;
    case 'drawing':
      say(machine.isDuel ? 'Duel on!' : 'Eyes down!');
      return;
    case 'finished':
      logExternalRound({
        mode: event.record.preset,
        nonce: 0,
        commitment: event.record.commitment,
        clientSeed: event.record.rosterHash,
        serverSeed: event.record.serverSeed,
        room: event.record.code,
        summary: event.record.summary,
      });
      return;
    case 'peer':
      toast(`${event.name} ${event.joined ? 'joined' : 'left'}`);
      return;
    case 'claimed':
      if (event.mine) {
        sfx.bingo();
        toast('BINGO claimed! Checking…', 'win');
      } else {
        sfx.win();
      }
      return;
    case 'coin':
      sfx.coin();
      return;
    case 'toast':
      if (event.tone === 'warn') sfx.miss();
      toast(event.text, event.tone);
      return;
  }
}
