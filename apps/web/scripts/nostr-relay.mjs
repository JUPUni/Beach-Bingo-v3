#!/usr/bin/env node
// A small Nostr relay (NIP-01: EVENT, REQ, CLOSE, OK, EOSE) for testing live rooms on one
// machine, where the public relays are out of reach. It keeps the last few hundred events so a
// client that subscribes a moment late still sees a room's announcements.
//
//   node scripts/nostr-relay.mjs [port]        (default 7447)
//   import { startRelay } from './nostr-relay.mjs'; const relay = await startRelay(0);
import { WebSocketServer } from 'ws';

const KEEP = 500;

export function startRelay(port = 7447, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const events = [];
    const subs = new Map(); // socket -> Map(subId -> filters)
    const wss = new WebSocketServer({ port, host });
    const matches = (ev, f) =>
      (!f.ids || f.ids.some((id) => ev.id.startsWith(id))) &&
      (!f.authors || f.authors.some((a) => ev.pubkey.startsWith(a))) &&
      (!f.kinds || f.kinds.includes(ev.kind)) &&
      (f.since === undefined || ev.created_at >= f.since) &&
      (f.until === undefined || ev.created_at <= f.until) &&
      Object.entries(f)
        .filter(([k]) => k.startsWith('#') && k.length === 2)
        .every(([k, values]) => ev.tags.some((t) => t[0] === k.slice(1) && values.includes(t[1])));
    const matchesAny = (ev, filters) => filters.length === 0 || filters.some((f) => matches(ev, f));
    const send = (socket, msg) => socket.readyState === 1 && socket.send(JSON.stringify(msg));

    wss.on('connection', (socket) => {
      subs.set(socket, new Map());
      socket.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return send(socket, ['NOTICE', 'invalid json']);
        }
        if (!Array.isArray(msg)) return;
        const [type, a, ...rest] = msg;
        if (type === 'EVENT') {
          const ev = a;
          if (!ev || typeof ev.id !== 'string' || typeof ev.pubkey !== 'string' || !Array.isArray(ev.tags)) return send(socket, ['NOTICE', 'invalid event']);
          if (!events.some((e) => e.id === ev.id)) {
            events.push(ev);
            if (events.length > KEEP) events.shift();
            for (const [other, map] of subs) {
              for (const [subId, filters] of map) if (matchesAny(ev, filters)) send(other, ['EVENT', subId, ev]);
            }
          }
          send(socket, ['OK', ev.id, true, '']);
        } else if (type === 'REQ') {
          const filters = rest.filter((f) => f && typeof f === 'object');
          subs.get(socket)?.set(a, filters);
          let n = 0;
          const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
          for (const ev of events) {
            if (n >= limit) break;
            if (matchesAny(ev, filters)) {
              send(socket, ['EVENT', a, ev]);
              n++;
            }
          }
          send(socket, ['EOSE', a]);
        } else if (type === 'CLOSE') {
          subs.get(socket)?.delete(a);
        }
      });
      socket.on('close', () => subs.delete(socket));
    });
    wss.on('error', reject);
    wss.on('listening', () => {
      const address = wss.address();
      const url = `ws://${host}:${address.port}`;
      resolve({
        url,
        port: address.port,
        events,
        close: () => new Promise((done) => wss.close(() => done())),
      });
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const relay = await startRelay(Number(process.argv[2] || 7447));
  console.log(`nostr relay on ${relay.url}`);
}
