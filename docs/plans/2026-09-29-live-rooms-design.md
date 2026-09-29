# Live rooms, and the rest of the way to the store

Design, 2026-09-29. Approved by the owner the same day ("Yes, all of it").

## Where things stood

- The Season 3 game went live at `beachbingo.xyz/app/` on 2026-09-29. Its bingo halls are
  practice rooms: every other player is a labelled bot. The landing page says "Until live rooms
  open, the halls fill with labelled practice bots."
- `/play` (the previous site) has real friend-to-friend bingo: a room code, a shared seed,
  balls on a wall clock, every claim verified by every player. It is a separate page in the old
  branding, with its own rules (five patterns, one card, first claim wins).
- The Solana dApp Store submission is now a publisher portal (KYC/KYB, a connected wallet with
  about 0.2 SOL, ArDrive storage, a 3–5 business-day review). It needs a privacy policy URL and a
  licence URL; beachbingo.xyz has neither. The Android shell in `android/` points at `/app/` and
  has never been built.
- The code references `docs/DAPP_STORE.md`, `docs/FAIRNESS.md` and `docs/GAME_MODES.md`; none
  exists. The root README is the Vite template's, in UTF-16.

## What gets built

### 1. Live rooms in the game

In Sunset Hall, Pier Hall, Wave Rush and Riptide Duel the lobby offers two ways in:
**Practice** (today's bots) and **Play with friends**. A host taps "Open a room" and gets a
five-letter code and an invite link, `https://beachbingo.xyz/app/#join=CODE`; friends type the
code or open the link, buy cards, and the host starts the game. Last Castle Standing keeps its
practice lobby for now: it is a different engine and screen, and one round of feedback on the
four halls should come first.

**Transport.** Browser to browser over WebRTC; players find each other through public Nostr
relays. `trystero@0.25.4` (MIT; 22 kB gzipped) does both and is imported only when somebody
opens or joins a room, so the landing-to-splash path does not pay for it. There is no server
and no account: a room lives as long as its players' tabs.

**One state on every phone.** The engine's `rooms` module already turns a seed into cards,
a drum and stage wins deterministically. A live room is the practice room with the bots
replaced by peers and the timer replaced by a shared clock:

1. **Commit.** The host draws a 32-byte `serverSeed` and sends its SHA-256 (`commitSeed`)
   with the lobby. Everyone sees the commitment before buying a card.
2. **Roster.** Each player announces a name and how many cards they hold (bought with their
   own play-money coins, as in practice). The roster is the list of peers sorted by id, each
   with a card count.
3. **Start.** The host sends `serverSeed`, the roster, and `startAt` (its clock plus a lead).
   Every client checks the seed against the commitment, rebuilds the identical `RoomState`
   with `createRoom → joinRoom → buyCards` in roster order (card `i` from
   `FairRng(seed, "card:i")`), and shuffles the drum from `FairRng(seed, "draw")`. The
   `clientSeed` is the hash of the roster, so the host, who committed before knowing who would
   come, cannot have shaped the draw for anyone.
4. **Draw.** Ball `n` is called when `startAt + n × drawIntervalMs` passes on each client's
   own clock (the `/play` rule: clock skew is only message latency, and nothing is judged by
   wall time). Auto-daub halls resolve stages inside `drawNext`, identically everywhere, with
   no messages at all.
5. **Duel claims.** In Riptide Duel a claim is a message `{ card, ball }`. Each client checks
   it against the deterministic state (the card completes the line by that ball, and the ball
   is not further ahead than the client's own count plus a small allowance), then opens a
   short window; when it closes, the lowest verified ball wins and shouts on the same ball share
   the stage (as built: a coin-flip on latency would be the alternative). Late or false claims
   are ignored and never change anyone's state.
6. **Settle.** `settleRoom` runs on every client; each credits its own winnings. Nobody is
   trusted with anyone else's coins, and a modified client cannot manufacture a win that
   other clients accept.

**Presence and edges.** A peer who leaves mid-game keeps its cards in the roster (the draw
does not change under the others); their wins still show, credited to nobody present. A
joiner during a game is told to wait for the next round. The host's next round sends a fresh
commitment first. If no relay answers within a timeout, the lobby says so and offers
Practice.

**Fairness surface.** The round appears in Settings → Provably fair like any other, with the
commitment, the revealed seed and the roster hash, so a player can recompute every card and
ball after the game.

### 2. Privacy and terms pages

`/privacy` and `/terms` on beachbingo.xyz, in the landing page's grammar. Privacy: no
accounts; progress and coins live in the browser's storage; a wallet address, if linked, is
read from the wallet and kept in the browser; in a live room, relays see a room code and a
random peer id and the other players see the name you typed; the site sets no cookies and
runs no analytics. Terms: free to play, coins are play money with no cash value and cannot be
bought, sold or transferred; no warranty; Fete Labs / Saltwater Brands as the operator name
the FetePass notices use. Linked from the landing page footer and the game's credits popup.

### 3. dApp Store readiness

The Android shell is built here as an unsigned release APK to prove the toolchain (Gradle
9.7.1, AGP 9.3.2, compile SDK 37). `docs/DAPP_STORE.md` records the current process end to
end — portal account and KYC/KYB, wallet and SOL, webshell build and release signing, the
listing fields and media mapped to `packages/brand/kit/store`, the policy points that apply
(privacy policy, data deletion, a WebView that loads only our own URL) — and ends with the
steps only the owner can take.

### 4. Copy and docs

The landing page, the in-game fair-play note, fetelabs.ai's Lab card and FetePass's Beach
Bingo screen stop saying live rooms are coming. `/play`'s "The pot is yours" becomes wording
inside the brand's money rule. The README is rewritten for the monorepo; `docs/FAIRNESS.md`
and `docs/GAME_MODES.md` are written.

## Testing

- Engine: a deterministic test that two independent `RoomState`s built from the same seed
  and roster draw the same balls and award the same stages.
- Protocol: unit tests for the message codec and the claim rule (valid, early, late, tie).
- End to end: a local Nostr relay (a small script in the repo) and two browser contexts in
  headless Chromium play a full Wave Rush round and a duel through the real transport; the
  test asserts both sides settle the same result. The sandbox's proxy cannot carry WebSocket
  upgrades from Chromium to the public relays, so the public path is checked with curl and
  by the owner on a phone.
- The site: the existing drive (`drive.mjs`) extended with the room lobby; the fit audit at
  twelve viewports; the safe-area sweep on the new pages.

## Ship

Branch `claude/epic-allen-4sznsv` for the game repo; deployed to beachbingo.xyz through the
"website" Vercel project as before (preview, checks, then production). fetelabs.ai to its
main. FetePass on its branch only.

## Decisions taken

- Casino Cove stays public (play money; the owner did not object).
- Friends rooms take no rake and pay no progressive jackpot: the pool is the cards' price
  times the preset's payout rate, as in practice, and the jackpot is a practice-only pot.
- Room codes use the `/play` alphabet (no 0/O/1/I) and the trystero app id
  `beachbingo-season3`, so old `/play` rooms and new rooms never meet.
