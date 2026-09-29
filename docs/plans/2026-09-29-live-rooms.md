# Live rooms and store readiness — implementation plan

> Design: `2026-09-29-live-rooms-design.md`. Executed in one session on 2026-09-29;
> this file is the order of work and the checks, kept so the next person can follow it.

**Goal:** friends play the four bingo halls together over a room code, with every phone
verifying every ball and every win; the site carries the notices the dApp Store needs; the
Android shell is proved to build; the copy and docs match what shipped.

**Architecture:** the practice `RoomGame` is split into a shared view and two drivers. The
practice driver keeps its bots and its timer. The live driver (`rooms/live/`) connects peers
through `trystero/nostr` (imported on demand), and turns the host's committed seed plus the
sorted roster into the same `RoomState` on every client with the engine's own `rooms`
functions; balls are called on a shared clock; duel claims are verified locally.

**Tech:** `trystero@0.25.4` (MIT), the existing `@beach-bingo/engine`, WebCrypto SHA-256
for the roster hash, `ws` (dev only) for a local Nostr relay in tests, Playwright for the
two-browser run.

---

### Task 1: protocol (pure) with tests

- Create `apps/web/src/rooms/live/protocol.ts`: `CODE_ALPHABET`, `makeCode()`,
  `isCode()`, message types (`me`, `room`, `start`, `claim`), `sortRoster()`,
  `rosterHash()` (SHA-256 of `id:cards` lines), `buildRoom(preset, serverSeed,
  rosterHash, roster)` → `RoomState` (createRoom → joinRoom → buyCards in roster order,
  card `i` from `FairRng({serverSeed, clientSeed: rosterHash, nonce: 0}, "card:i")`, drum
  from domain `draw`), `ballsCalledAt(now, startAt, intervalMs, maxBalls)`,
  `winBall(state, playerId, card)` (first ball count at which the card completes the open
  stage), `claimValid(...)`, `resolveClaims(...)` (lowest win ball; ties split).
- Test `apps/web/src/rooms/live/protocol.test.ts` (vitest): codes round-trip; two
  `buildRoom` calls from the same inputs draw identical balls and stage wins; a different
  roster changes the drum; `ballsCalledAt` never exceeds the drum; claim rule accepts a
  true claim at its ball, rejects one a ball early, rejects one far ahead of the local
  count, and picks the lowest ball.
- Run `pnpm --filter @beach-bingo/web test`; commit.

### Task 2: transport

- Create `apps/web/src/rooms/live/net.ts`: `connectRoom(code, on: {peerJoin, peerLeave,
  message}) → Promise<Net>` where `Net = { selfId, send(msg, to?), leave() }`; dynamic
  `import('trystero/nostr')`; app id `beachbingo-season3`; relay override from
  `import.meta.env.VITE_NOSTR_RELAYS` or `localStorage['beach-bingo:relays']` (dev/test
  hook, documented in the module); a join timeout surfaced as an error.
- Create `apps/web/scripts/nostr-relay.mjs`: a minimal NIP-01 relay for tests (EVENT →
  OK + fan-out to matching REQ subscriptions on kinds/#tags/authors; EOSE; CLOSE; a short
  in-memory tail for late subscribers). `ws` as a devDependency.
- Commit.

### Task 3: the live room screen

- `apps/web/src/state/store.ts`: `Screen` gains `{ name: 'live'; code: string; host: boolean;
  mode?: RoomPresetId }` and session `pendingJoin: string | null` (set from
  `#join=CODE` at boot, consumed by the splash's Play).
- Extract the presentational parts of `RoomGame.tsx` into `rooms/RoomView.tsx` (stats,
  caller, cards, feed, results popup) so practice and live render the same way.
- Create `rooms/live/useLiveRoom.ts` (state machine: connecting → lobby → countdown →
  drawing → finished | error; peers, host id, commitment, my cards, refunds on abandon,
  ticker, claims, settlement, `logExternalRound` into the fairness history) and
  `rooms/LiveRoom.tsx` (lobby with code, invite link, players, buy buttons, host Start;
  game view; results with Play again).
- `App.tsx`: route `live`; parse `location.hash` at boot. `Splash.tsx`: honour
  `pendingJoin`. `ModeList.tsx` (Beach Rooms): "Have a room code?" join box.
  `RoomGame.tsx` practice lobby: "Open a room for friends" button.
- `lib/fair.ts`: `logExternalRound()`.
- Typecheck, lint, tests; commit.

### Task 4: two-browser end-to-end

- Create `apps/web/scripts/live-room-e2e.mjs`: build with `VITE_NOSTR_RELAYS=ws://127.0.0.1:PORT`
  (or the localStorage hook), start the relay and a static server, open two Chromium
  contexts, host opens a Wave Rush room, guest joins by code, both buy, host starts, both
  reach the same settlement (same winner list, same balls); then a duel where the guest
  claims first. Fail on any page error.
- Run it; fix until green; commit.

### Task 5: site pages, copy, docs

- `apps/site/public/privacy/index.html`, `apps/site/public/terms/index.html`; footer links
  on the landing page; `scripts/build.mjs` stamps icons into them too; credits popup links.
- Landing copy ("Until live rooms open…" → live rooms are open), in-game fair note,
  `/play` wording, fetelabs.ai Lab card, FetePass screen (branch only).
- `README.md` (UTF-8, monorepo), `docs/FAIRNESS.md`, `docs/GAME_MODES.md`,
  `docs/DAPP_STORE.md`.
- Android: `ANDROID_HOME=… ./gradlew assembleRelease` once; record the result in
  `docs/DAPP_STORE.md`.
- Commit.

### Task 6: ship

- `pnpm site:app`; `pnpm -r typecheck && pnpm -r test && pnpm --filter @beach-bingo/web lint`.
- Local: `scripts/serve.mjs`, `drive.mjs` (extended with the join box and lobby), fit
  audit, safe-area sweep on the new pages.
- Push the branch; Vercel preview → the same drive against the preview → production;
  verify live with curl and the browser.
- fetelabs.ai: commit on main, push; verify. FetePass: commit on the branch, push.
