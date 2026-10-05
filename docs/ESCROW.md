# Staked rooms: the wave_duel escrow

`programs/wave_duel` is a Solana program that holds the stakes of a Wave Rush round, a 1v1 room
or a hall of two to eight players, and pays the winners without a server, an arbiter or any trust
between the players. It is the
live-room protocol of docs/FAIRNESS.md with two changes: the stakes are SOL held by the program
instead of coins held by each browser, and the client seed is fixed by the chain instead of the
roster. It runs on **devnet only**, behind a build flag; the reasons are in "The money rule"
below and in docs/PRODUCTION.md.

## What it is

Two people who share a room code each deposit the same amount of SOL into a room account owned by
the program. The host commits to a secret seed before anyone joins; the guest's join fixes the
round's entropy; both screens play the 30-ball round from those two inputs; and the program, given
the revealed seed, replays the round with the engine's exact random-number contract and moves the
money. Nobody holds anyone else's funds, the program cannot choose the outcome, and a host who goes
quiet forfeits.

## The protocol, step by step

1. **Open.** The host opens a live Wave Rush room as usual (its commitment is already on screen),
   picks a stake, and sends `open_room(code, stake, commitment)`. The program creates the room PDA,
   transfers the stake into it, and records the commitment. The lobby now shows the escrow.
2. **Join.** The guest, seeing the same stake in their lobby, sends `join_room`. The program
   transfers the same stake, refuses the host's own wallet, and fixes
   `entropy = SHA-256(guest pubkey ‖ newest SlotHashes entry)`: 32 bytes nobody knew when the host
   committed. The room becomes `Ready` and records `joined_slot`.
3. **Play.** The screens poll the room account. Once it is `Ready`, the host may start; the `start`
   message carries the seed, the two-entry roster (host first, one card each) and the chain's
   entropy. Every client checks the seed against the commitment and the entropy against what it
   read from the chain itself, then builds the round with `buildRoom(preset, commitment, seed,
   roster, clientSeed = entropy)`: the host's card is card 0, the guest's card 1, the drum is the
   `live:draw` stream. A start with another entropy or roster is refused by honest clients, and
   cannot change what the chain pays.
4. **Settle.** Anyone who knows the seed (both players do after `start`) sends `settle(seed)`. The
   program checks `SHA-256(seed) == commitment`, replays the round from the seed and the stored
   entropy, and pays: the winner takes the prize, a tie splits it (one lamport of dust goes to the
   treasury), and the fee in basis points from the config goes to the treasury. The room account is
   closed and its rent returned to the host.
5. **Timeout.** If nobody settles within `TIMEOUT_SLOTS` (3,000 slots, about 20 minutes) after
   the join, anyone may send `claim_timeout`: the guest receives the prize and the treasury the fee.
6. **Cancel.** Before a join, the host may `cancel_room` and take the stake and the rent back.

One escrow is one round: after settlement the live room continues unstaked until the host opens a
new escrow with a new commitment.

## Halls: the same escrow for two to eight players

A `Hall` is a room with seats. The host opens it with a stake **per card**, a number of seats
(2–8) and its own cards (1–4), committing to the seed as before; each guest joins once with 1–4
cards and deposits `cards × stake_per_card`; the roster is the join order, the host first, and the
cards are numbered in that order, exactly as the engine numbers them when a live room sells cards.
Sales close when a **guest** locks the hall (or when the join that fills the last seat lands): the
entropy is `SHA-256(players in roster order ‖ their card counts ‖ newest SlotHashes entry)`. The
host may never lock, because it knows the seed and choosing the slot would let it grind the slot
hash; a guest cannot tell one outcome from another, so its timing is harmless. Settlement replays
every card and the drum and pays every card that is full on the first winning ball an equal share
of the prize, each player receiving the sum of its cards' shares; the fee and the split's dust go
to the treasury. A host that goes quiet after the lock has every deposit refunded to its owner
after the timeout, with no fee (a hall has no single counterparty to award the host's stake to).
The host may cancel while the hall is open; every deposit goes back.

The program, its client (`apps/web/src/solana/waveHall.ts`) and the LiteSVM suite are proven on
devnet (see the addresses below), and the live-room lobby stakes halls too: the host's stake panel
has a "Hall" mode (seats, its own cards, the stake per card), guests buy seats from their lobby,
which lists the seats as the chain holds them, a seated guest locks the table, the host's Start
enables once the chain reads `locked`, every screen builds the round from the chain's seats and
entropy and refuses a start that is not the table it read itself, and anyone settles from the
results (`apps/web/src/rooms/live/HallStakePanel.tsx`, `machine.ts`). `programs/wave_duel/README.md`
has the account and instruction detail and the compute figures (about 19k CU to settle 2 cards,
97k for the worst case of 32).

## Accounts and instructions

Program id `6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH` (`declare_id!` in `lib.rs`; Anchor
1.2.0). All amounts are lamports; `MIN_STAKE` 0.001 SOL, `MAX_STAKE` 100 SOL, `MAX_FEE_BPS` 1,000.

| Account | PDA seeds | Fields | Size |
|---|---|---|---|
| `Config` | `["config"]` | `admin`, `treasury`, `fee_bps: u16`, `paused: bool`, `bump` | 76 bytes |
| `Room` | `["room", host, code]` | `host`, `guest` (zero until a join), `stake: u64`, `commitment: [u8; 32]`, `code: [u8; 5]`, `state: u8` (0 Open, 1 Ready), `created_slot`, `joined_slot`, `entropy: [u8; 32]`, `bump` | 167 bytes |
| `Hall` | `["hall", host, code]` | `host`, `stake_per_card: u64`, `max_players: u8`, `commitment`, `code`, `state: u8` (0 Open, 1 Locked), `players: [Pubkey; 8]`, `cards: [u8; 8]`, `player_count`, `cards_sold: u16`, `entropy`, `locked_slot`, `created_slot`, `bump` | 403 bytes |

| Instruction | Arguments | Accounts, in order | Checks |
|---|---|---|---|
| `init_config` | `fee_bps` | config (init), admin (signer, payer), treasury (any), system program | fee ≤ 1,000 bps |
| `set_config` | `fee_bps`, `paused` | config (`has_one = admin`), admin (signer), treasury | fee ≤ 1,000 bps |
| `open_room` | `code: [u8; 5]`, `stake: u64`, `commitment: [u8; 32]` | config, room (init, paid by host), host (signer), system program | not paused; stake in range; code from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` |
| `join_room` | none | config, room, guest (signer), SlotHashes sysvar (by address), system program | not paused; Open; guest ≠ host |
| `cancel_room` | none | room (`close = host`, `has_one = host`), host (signer) | Open |
| `settle` | `server_seed: [u8; 32]` | config (`has_one = treasury`), room (`close = host`, `has_one = host, guest`), host, guest, treasury, settler (signer) | Ready; `SHA-256(seed) == commitment` |
| `claim_timeout` | none | same as `settle` | Ready; `slot ≥ joined_slot + 3,000` |
| `open_hall` | `code`, `stake_per_card: u64`, `max_players: u8` (2–8), `cards: u8` (1–4), `commitment` | config, hall (init, paid by host), host (signer), system program | not paused; stake, seats and cards in range; code alphabet |
| `join_hall` | `cards: u8` | config, hall, player (signer), SlotHashes sysvar, system program | not paused; Open; a seat left; one seat per wallet; the join that fills the hall locks it |
| `lock_hall` | none | config, hall, player (signer), SlotHashes sysvar | not paused; Open; two players or more; a seated guest, never the host |
| `cancel_hall` | none | hall (`close = host`, `has_one = host`), host (signer); then the roster in order, writable | Open; every deposit refunded |
| `settle_hall` | `server_seed: [u8; 32]` | config (`has_one = treasury`), hall (`close = host`, `has_one = host`), host, treasury, settler (signer); then the roster in order, writable | Locked; `SHA-256(seed) == commitment`; the roster passed matches the hall's |
| `claim_timeout_hall` | none | same as `settle_hall` | Locked; `slot ≥ locked_slot + 3,000`; every deposit refunded, no fee |

A room: `pot = 2 × stake`, `fee = pot × fee_bps / 10,000` (u128 arithmetic), `prize = pot − fee`.
A hall: `pot = stake_per_card × cards_sold`, the same fee, `share = prize / winning_cards` to each
winning card and `prize mod winning_cards` of dust to the treasury with the fee. Events
`RoomOpened`, `RoomJoined`, `RoomSettled` (seed, win ball, who won, pot, fee), `RoomTimedOut` and
`HallOpened`, `HallJoined`, `HallLocked`, `HallCancelled`, `HallSettled`, `HallTimedOut` are
emitted for indexers; the error codes are listed at the end of `lib.rs`, the hall's after the
room's so that no number moved.

The TypeScript clients, `apps/web/src/solana/waveDuel.ts` (rooms, config, sending) and
`waveHall.ts` (halls), hand-encode these layouts with `@solana/kit` (Anchor discriminators,
`sha256("global:<ix>")[..8]`), so they and `lib.rs` move together. The lobby's stake presets are
0.01, 0.025, 0.05, 0.1 and 0.25 SOL.

## The RNG contract shared with the engine

`fair.rs` is `packages/engine/src/rng/fair.ts` bit for bit, and `bingo.rs` is the engine's
30-ball room for up to eight players with up to four cards each; the 1v1 room is its two-card
case, and a native test asserts the two paths agree on every room vector. Anything that differs
by one bit would make the chain pay someone other than the player both screens saw win.

```
block(counter) = HMAC-SHA256(key = serverSeed (32 bytes),
                             message = ["<clientSeed>",<nonce>,"<domain>",<counter>])
```

- The message is `JSON.stringify([clientSeed, nonce, domain, counter])`: no spaces, the client
  seed and domain quoted, the numbers bare. The Rust side writes the same bytes directly, without
  `format!`, to keep settlement cheap; a native test checks them against `JSON.stringify`, which is
  safe because the client seed is hex and the domains need no escaping.
- `clientSeed` is the escrow's `entropy` as 64 lowercase hex characters; `nonce` is `0`; the
  domains are `live:card:<i>` for card *i* (a room: 0 the host, 1 the guest; a hall: the cards
  numbered in roster order) and `live:draw`.
- Each block gives eight big-endian `u32` words; when a block is used up the counter increments.
- `int(n)`: `n = 1` returns 0; otherwise `limit = 2^32 − (2^32 mod n)`, draw words until one is
  below `limit`, return `word mod n` (rejection sampling, unbiased).
- `sample(items, k)`: partial Fisher–Yates, `j = i + int(len − i)` for `i` in `0..k`, the first
  `k` of the pool in draw order.
- A card: for column `c` in 0..3, `sample` three numbers from `c·10+1 ..= c·10+10` with the card's
  stream, sort them ascending, and place them at `cells[r·3 + c]` (row-major). No free cell.
- The drum is `sample(1..=30, 30)` on `live:draw`. Balls are applied in order; the first ball on
  which any card is full ends the round. In a room, both full on the same ball is a tie; in a hall,
  every card full on that ball shares the prize.

`apps/web/scripts/wave-duel-vectors.mjs` asks the engine (`buildRoom` and `drawNext`, exactly as
a live room does) for N random rounds and writes `serverSeed`, `commitment`, `clientSeed`, both
cards, the drum, `winBall` and `winners` (0 host, 1 guest). `programs/wave_duel/tests/vectors/
rounds.json` holds 32 of them, ties included; `wave-hall-vectors.mjs` does the same for halls of
two to eight players (`halls.json`, 32 vectors, the 32-card worst case among them). `bingo.rs`
includes both files at compile time and its tests assert every field. The LiteSVM suites close the
loop from the other side: they run the compiled program and check that the lamports go to the
players the engine names.

## Trust and threat model

- **A malicious host** commits before it knows the guest's key or the slot hash, so it cannot pick a
  seed that favours it. After the join it knows the outcome before anyone else; if it lost, its only
  move is silence, and silence pays the guest the same prize after the timeout. It can cancel just
  before a join lands (the guest's transaction fails; nothing is lost). A modified host client
  cannot make honest clients play a different round, and the chain never reads the screens.
- **A malicious guest** cannot grind the entropy: the outcome needs the seed, which it does not have
  until `start`. Once it has the seed it can settle early, which changes nothing.
- **A hall** is locked by a guest, never the host, for the same reason: whoever fixes the slot must
  not know the seed. The residual risk is a host that also controls a guest wallet, the residue of
  every public-beacon commit–reveal; honest guests shrink the window by locking as soon as they are
  happy with the roster. A timed-out hall refunds every deposit, so a host has no financial reason
  to reveal a round it lost; the app treats a timed-out hall as the host's failure.
- **Relays and the WebRTC path** see room codes, peer ids, the `StakeInfo` (all public on chain
  anyway) and, at `start`, the seed. Blocking messages can stop the round on screen; it cannot stop
  either player settling.
- **A settler** can only provide a seed that matches the commitment; who is paid, and how much, is
  fixed by the program. Front-running a settle with the same seed is harmless.
- **Clock skew** moves when balls appear, not which balls; the chain's only time rule is the
  timeout, counted in slots.
- **Slot-hash entropy.** The newest SlotHashes entry during slot *S* is the hash of slot *S − 1*,
  public once slot *S* begins. That is safe here only because the outcome also needs the secret
  seed. The theoretical surface is a host who is, or colludes with, the leader of slots *S − 1* and
  *S*: it knows the seed, receives the guest's join, could try to grind the block hash and then
  include the join. It cannot predict when a guest will join and grinding a bank hash is expensive,
  but the surface is not zero.
- **The host's seed lives in memory.** The machine keeps `serverSeed` in the tab and never stores
  it. A reload between the guest's join and `start` loses it; the host cannot reveal and the guest
  takes the pot after 20 minutes (in a hall, every seat is refunded; a guest whose host left an open
  table can lock it to start that clock). After `start` every player holds the seed.

For mainnet the list is known: the upgrade authority and the config admin moved from one hot key to
a multisig (or the program frozen after review); an independent audit; SPL tokens (USDC, SKR)
alongside SOL; a second source of entropy or a delayed entropy step to close the leader surface;
monitoring that can use the existing `paused` switch quickly; and the 75- and 90-ball halls, whose
card builders and patterns are not ported (the hall escrow plays Wave Rush's 30-ball card only).

## Build, test and operate

```bash
cd programs/wave_duel
cargo test --release               # 7 tests: room and hall vectors, room == two-card hall, the message bytes, int() at the edge
cargo build-sbf                    # → target/deploy/wave_duel.so (303,048 bytes)
cd ../..
pnpm --filter @beach-bingo/web test  # runs the LiteSVM suites (5 room tests, 6 hall tests) when the .so exists, else skips them
```

`cargo build-sbf` writes a fresh key pair to `target/deploy/`; that is not the program id. The
program's key pair is `.secrets/wave_duel-keypair.json` and the deployer's `.secrets/devnet-deployer.json`
(`.secrets/` is ignored by git). `solana program deploy target/deploy/wave_duel.so --program-id
.secrets/wave_duel-keypair.json --keypair .secrets/devnet-deployer.json --url devnet` deploys, and
upgrades in place while the deployer is the upgrade authority (the hall upgrade extended the
program-data account to 303,048 bytes; it holds about 1.54 SOL of rent).

The admin script, run with the engine's `tsx`:

```bash
pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs init-config [feeBps] [treasury]
pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs show [host code]
pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs round [stakeSol]
pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs hall [stakeSol] [cards per seat...]
```

`RPC_URL`, `KEYPAIR` and `WAVE_DUEL_PROGRAM` override the defaults. `round` funds two throwaway
wallets, plays open → join → settle with the deployer as settler, compares the payout with the
engine's replay (allowing for the transaction fee when the treasury is the payer), and sweeps the
wallets back. `hall` does the same for a hall: the card counts given (default `2 1 3`) become the
seats, a guest locks the table, the deployer settles, and every seat's lamports are checked
against the engine.

`apps/web/scripts/stake-e2e.mjs` is the browser proof: two headless Chromium contexts with a
Wallet Standard test wallet (`scripts/qa/test-wallet.mjs`) play a staked room through the real
lobby on devnet (open, cancel, reopen, join, ready-gated start, the same round on both screens,
settle, the other screen seeing it settled), and the chain's payout is checked against the
engine's replay to the lamport. `apps/web/scripts/stake-hall-e2e.mjs` does the same for a hall
with three contexts: the host opens a table of four seats with two cards, two guests buy one and
three cards, every lobby lists the seats as the chain holds them, a guest locks, the host's Start
enables on `locked`, the three screens finish on the same ball, a guest settles, and each seat's
lamports are checked against `splitHallPot` over the engine's replay. The two scripts share
`scripts/qa/stake-lib.mjs`.

The devnet build at https://beach-bingo-eight.vercel.app/app/ is built with
`VITE_SOLANA_CLUSTER=devnet`, `VITE_ENABLE_ONCHAIN_STAKES=true`, `VITE_WAVE_DUEL_PROGRAM=<program
id>` and `VITE_BUILD_LABEL=devnet`. `LiveRoom.tsx` lazy-loads the stake panel only when both flags
are set, so a build without them ships none of this code.

## The money rule

`lib.rs` says it: "Nothing here is a game of skill: it is a wager between two people, so it ships
behind a flag until the operator's licensing allows it." Production at beachbingo.xyz builds
without the flags; coins stay play money there, and the wallet popup says so. There is no
compliance gate in the code today: the flags, the absence of a program id in the production build
and the on-chain `paused` bit are the only switches. What it takes to turn the flag on for real
money, and in what order, is the subject of docs/PRODUCTION.md.

## Devnet addresses

| Item | Value |
|---|---|
| Program | `6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH` |
| Program data | `BEsKZLmZqiKAkykZB5dZM6ZmwbpVsUADJKraNZjt2u31` (303,048 bytes; first deployed at slot 505607372 with the 1v1 room, upgraded with the halls at slot 505620387) |
| Upgrade authority, config admin and treasury (for now) | `5VcGxKLHDJhPAFSN8VK9qpxkM4gniQtPKwRrMnUcqA8u`, the devnet deployer |
| Config PDA | `5HpFPh9dusDzH1uRU4HoAsH5xnaw8dpTPrEuupfoqKL`: fee 500 bps, not paused |
| `init_config` transaction | `3aJvmoWFqLvZAshSfkVMY2Vow532NwYxQSrjzuaSpSvtNW2AjStazMWH9amsaZnycJnK3YYPkTYHzwQGXN1Xq4Nw` |
| First scripted round | room `4F83W` at `HgTTPnp432QCtKxYBgin5EchpAZXbxEhEz95g6oV7Yoo`, 0.05 SOL each, settled in `oo6dw6xPJEBhHoJYuQhe8DGtQppCFetubnq7xdxi2tkC1VbGp12RcD7s2iM4Tupce7QAUnbnZJLFGAyL7nsruSe`: host won on ball 27, fee 0.005 SOL |
| First room after the hall upgrade | room `N46PM` at `8BGWumEDiBe2r5PZ5W4zGMXy5UvyRUmwooXeANSrFhtQ`, 0.02 SOL each, settled in `4B8ba1hQA5RJLb3NqiEcyVqVSopGDnPbVqmETZscxXLtvuwZqLppT1NGRwZ9unk1KEmjzPH6BqcmRzSLrbGxvJaE`: guest won on ball 28 |
| First scripted hall | hall `8MB97` at `Gyn3Fh59vTHftpdLsgYeLmtjarbHvcPTswKsH8bNSWvi`, 0.01 SOL a card, seats with 2, 1 and 3 cards, locked by seat 2, settled in `3YEKMj3cCVn5KASoDe1YBbpkFqXmJpYE7XjutbLgPPHaCFDL6acyMxk9ZvRgDDwYcGcC17iWYkoDhAeU4j2kLiqW`: two winning cards on ball 27, 0.0285 SOL each, fee 0.003 SOL |
| Browser proof | room `MM4RH`, two test wallets through the real lobby, settled in `4GapfY1LxdkNk7f5yFkZbxXnN69xUJPNLkXy8tDnrW7cg5qN57oPAPuvc4UQKHms8CoYBsfb2NPsCHNc3mUmWwrs`: host won on ball 29 |
| Devnet build | https://beach-bingo-eight.vercel.app/app/ |
