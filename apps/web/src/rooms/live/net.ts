import { APP_ID, type Connect, type LiveMessage, type Net, type NetHandlers } from './protocol.ts';

/**
 * The transport for live rooms: WebRTC between browsers, with public Nostr relays to find each
 * other (trystero). Loaded on demand, so a player who never opens a room never downloads it.
 *
 * Relays: trystero's defaults. `VITE_NOSTR_RELAYS` (comma-separated, at build time) or the
 * localStorage key `beach-bingo:relays` (per browser) replace them — for running against a relay
 * of your own, and for the two-browser test against a relay on localhost.
 */
export const RELAYS_STORAGE_KEY = 'beach-bingo:relays';

function relayUrls(): string[] | undefined {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(RELAYS_STORAGE_KEY);
  } catch {
    /* storage unavailable */
  }
  const raw: string = import.meta.env.VITE_NOSTR_RELAYS || stored || '';
  const urls = raw
    .split(',')
    .map((u) => u.trim())
    .filter((u) => /^wss?:\/\//.test(u));
  return urls.length ? urls : undefined;
}

export const connectRoom: Connect = async (code: string, on: NetHandlers): Promise<Net> => {
  const { joinRoom, selfId, getRelaySockets } = await import('trystero/nostr');
  const urls = relayUrls();
  const room = joinRoom(
    {
      appId: APP_ID,
      relayConfig: urls ? { urls, redundancy: urls.length } : undefined,
    },
    code,
    { onJoinError: (details) => console.warn('live room: join error', details.error) },
  );
  const action = room.makeAction<LiveMessage>('bb', {
    onMessage: (data, { peerId }) => on.message(data, peerId),
  });
  room.onPeerJoin = (id) => on.peerJoin(id);
  room.onPeerLeave = (id) => on.peerLeave(id);
  return {
    selfId,
    send: (msg, to) => {
      void action.send(msg, to ? { target: to } : undefined).catch((e: unknown) => console.warn('live room: send failed', e));
    },
    leave: () => {
      void room.leave();
    },
    relayCount: () => {
      const sockets = getRelaySockets() as Record<string, WebSocket> | undefined;
      let open = 0;
      for (const socket of Object.values(sockets ?? {})) if (socket?.readyState === 1) open++;
      return open;
    },
  };
};
