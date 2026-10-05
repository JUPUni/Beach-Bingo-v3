# Fairness

Every ball, card, reel and shell in Beach Bingo comes from a seed the game committed to before
the round, so no result can be changed after the fact, and every round can be recomputed by
anyone with the revealed seed. This document is the specification; `packages/engine/src/rng/fair.ts`
is the implementation and `packages/engine/test/fair.test.ts` checks it against an independent
HMAC implementation.

## The primitive

```
block(counter) = HMAC-SHA256(key = serverSeed bytes,
                             message = JSON.stringify([clientSeed, nonce, domain, counter]))
```

- `serverSeed`: 32 random bytes, lowercase hex. Its **commitment** is `SHA-256(serverSeed bytes)`,
  hex, published before the round.
- `clientSeed`: any string the server did not choose (the player's own string for house games,
  the roster hash for live rooms).
- `nonce`: the round counter for this server seed (0, 1, 2, …).
- `domain`: the name of the stream, so adding a new kind of decision never shifts an existing one
  (`tidePool:draw`, `shellSpin:reels`, `live:card:0`, `live:draw`, …).

Each block gives eight 32-bit words, read big-endian in order; when a block is used up, `counter`
increments. From the words:

- `int(n)`: rejection sampling. With `limit = 2^32 − (2^32 mod n)`, draw words until one is below
  `limit`, and return `word mod n`. Unbiased for every `n ≤ 2^32`.
- `float()`: two words → 53-bit float in `[0, 1)`: `((hi >>> 5) × 2^26 + (lo >>> 6)) / 2^53`.
- `shuffle`: Fisher–Yates from the end, `j = int(i + 1)`.
- `sample(items, k)`: partial Fisher–Yates, the first `k` of the pool in draw order.

`verifyCommitment(serverSeed, commitment)` is the whole check: the seed is 64 hex characters and
its SHA-256 equals the commitment.

## House games (Casino Cove, the adventure's bingo)

The play-money "house" runs in the browser, so the committed server seed lives in the browser's
storage (Settings → Provably fair shows the commitment, the client seed and the next nonce). Each
round takes the next nonce and one or more domains:

| Mode | Domains |
|---|---|
| Tide Pool | `tidePool:draw` |
| Riptide | `riptide:drum` |
| Crab Dig | `crabDig:layout` |
| Shell Spin | `shellSpin:reels` |
| Tiki Video Bingo | `videoBingo:drum` |
| Keno Cove | `keno:draw` |
| Beach Ball Blitz | `blitz:draw` |
| Practice halls | `<preset>:card:<i>` for card number `i`, `<preset>:draw` for the drum |
| Last Castle Standing | `lastCastle:cards`, `lastCastle:draw` |

"Rotate & reveal" retires the current server seed, reveals it, and commits to a new one. The popup
then recomputes any stream of the revealed seed for any nonce, so a player can compare it with
the round they remember. The last 30 rounds of the session are listed with their nonce and result.

The protocol is the same one a server-authoritative deployment would use; only the place the
server seed is kept differs.

## Live rooms

A live room has no server, and no player trusts another. The host commits, the roster supplies the
client seed, and every client rebuilds the round and checks every claim. The rules are in
`apps/web/src/rooms/live/protocol.ts`; the message flow is in `machine.ts`.

1. **Commit.** When the host opens the room (and again for every later round) it draws a fresh
   `serverSeed` and sends `commitment = SHA-256(serverSeed)` to everyone in the lobby. The lobby
   shows the commitment before anyone buys a card.
2. **Roster.** Players announce their name and card count. When the host starts, the roster is the
   players with cards, each capped to the hall's limit, **sorted by peer id**. Duels seat the first
   two players to hold a card. The roster's hash is

   ```
   clientSeed = SHA-256("id1:cards1\nid2:cards2\n…")   (hex)
   ```

   The host commits before it knows who will come or how many cards they will hold, so it cannot
   have chosen a seed that favours anyone.
3. **Reveal and build.** The host's `start` message carries `serverSeed`, the roster and the start
   time. Every client checks `verifyCommitment`, refuses the round if it fails, and otherwise
   builds the same `RoomState` with the engine: players joined in roster order, card number `i`
   (in sale order) from `FairRng({ serverSeed, clientSeed, nonce: 0 }, "live:card:" + i)`, and the
   drum from `sample(1..maxBall, maxBall, FairRng(seed, "live:draw"))`.
4. **Draw.** Ball `n` is called at `startAt + (n − 1) × drawIntervalMs` on each client's own clock.
   Nothing is judged by the clock: whichever client is a little ahead or behind sees the same
   balls in the same order. Auto-daub halls award stages inside the engine's `drawNext`, so no
   message is needed for a win.
5. **Duel claims.** A shout is a message `{ card, ball }`, where `ball` is how many balls were on the
   claimant's table. Every client verifies that the card completes the open pattern within the
   first `ball` balls of the drum (which it holds in full), drops claims more than two balls ahead
   of its own count, and keeps valid ones. The window for a claim at ball `b` closes when ball
   `b + 2` is due; the lowest `ball` wins and equal balls share the stage. A false shout locks the
   shouter out for three balls on their own client; other clients simply ignore it.
6. **Settle.** `settleRoom` runs on every client; each credits its own winnings. Prize money nobody
   won (an unclaimed duel, rounding) is returned in proportion to cards bought.

After the round the game logs the room code, the commitment, the revealed seed and the roster hash
under Settings → Provably fair, and the results popup shows the same. To recompute a round, feed
the seed and the roster to `buildRoom` (the test in `protocol.test.ts` does exactly this).

A modified client can lie about its own name or card count (it pays for those cards itself), can
shout when it has no line (everyone else ignores the shout), or can refuse to show a ball. It
cannot change anyone else's cards, drum or result.

**Staked rooms** (the devnet build only) keep this protocol and change two inputs: the stakes are
SOL held by the `wave_duel` program instead of coins, and the client seed is the entropy the
program fixed when the guest deposited (or when a guest locked a hall), not the roster hash. The
program replays the round from the revealed seed with the same RNG contract and pays, so the
screens and the chain agree card for card. The protocol, its trust model and its addresses are in
[ESCROW.md](ESCROW.md).

## What the fairness model does not cover

- SAND is free play money and coins never leave the game, so nothing here is a financial guarantee. The
  devnet escrow build is the exception; its own guarantees and their limits are in ESCROW.md.
- The relays that help peers find each other are public and third-party; they see room codes and
  peer ids, never a seed before its reveal (the host sends the seed directly to peers over WebRTC).
- Clock skew between phones changes when a ball *appears*, not which ball it is.
