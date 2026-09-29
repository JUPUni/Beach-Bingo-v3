# wave_duel

Trustless Wave Rush escrows for Beach Bingo, as an Anchor 1.2 program (`6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH`).
The host commits to a seed, players stake SOL into a PDA, and anyone can settle by revealing the
seed: the program replays the 30-ball round with the engine's own RNG (`fair.rs`, `bingo.rs`) and
pays out. Nothing is trusted off-chain; the screens and the chain compute the same round from the
same seed and entropy (docs/FAIRNESS.md).

Two shapes share the program, the config and the fee:

| | Room (1v1) | Hall (2..=8 players) |
|---|---|---|
| Account | `Room`, PDA `["room", host, code]` | `Hall`, PDA `["hall", host, code]` |
| Stake | one stake, one card each | `stake_per_card`, 1..=4 cards per player |
| Roster | host card 0, guest card 1 | join order, host first; card numbers follow it |
| Entropy fixed | when the guest joins: `sha256(guest ‖ newest slot hash)` | when a guest locks (or the join that fills the hall): `sha256(players ‖ card counts ‖ newest slot hash)` |
| Result | first card full wins; both on one ball split | every card full on the first winning ball takes `prize / winning_cards`; players are paid the sum of their cards' shares |
| Fee | `pot × fee_bps / 10000` to the treasury | the same, plus the split's dust |
| Host silent after `TIMEOUT_SLOTS` (3,000) | guest takes the prize | every deposit refunded, no fee |
| Cancel | host, before a guest joins | host, while open: every deposit refunded |

Shared constants: `MIN_STAKE` 0.001 SOL, `MAX_STAKE` 100 SOL (per card in a hall), `MAX_FEE_BPS`
1,000, `CODE_ALPHABET` (the game's room codes: no 0/O, 1/I/L).

## Accounts

- `Config` (`["config"]`): `admin`, `treasury`, `fee_bps`, `paused`, `bump`. `init_config` and
  `set_config` (admin). Paused blocks opening, joining and locking; settling, timeouts and cancels
  always work so money can always leave.
- `Room`: `host`, `guest`, `stake`, `commitment`, `code`, `state` (Open 0 / Ready 1), `created_slot`,
  `joined_slot`, `entropy`, `bump`.
- `Hall`: `host`, `stake_per_card`, `max_players` (2..=8), `commitment`, `code`, `state` (Open 0 /
  Locked 1), `players: [Pubkey; 8]`, `cards: [u8; 8]`, `player_count`, `cards_sold`, `entropy`,
  `locked_slot`, `created_slot`, `bump`. The first `player_count` entries of `players`/`cards` are
  the roster in join order; the host is entry 0.

Lamports are held in the escrow account itself. The account's rent goes back to the host when it
closes (settle, timeout, cancel).

## Instructions

Room: `open_room(code, stake, commitment)`, `join_room()`, `cancel_room()`, `settle(server_seed)`,
`claim_timeout()`.

Hall:

- `open_hall(code, stake_per_card, max_players, cards, commitment)`: the host deposits
  `cards × stake_per_card` and holds cards `0..cards`.
- `join_hall(cards)`: any other wallet, while Open; one seat per wallet; deposits `cards × stake`;
  appended to the roster. The join that fills the last seat also locks the hall.
- `lock_hall()`: any seated **guest**, once two players are in. Fixes the entropy and closes sales.
  The host may not lock: it knows the seed, so choosing the slot would let it grind the slot hash
  for an outcome it likes; a guest cannot tell outcomes apart, so its timing is harmless (the
  reasoning is in `lib.rs`).
- `cancel_hall()`: host, while Open. Remaining accounts: the roster, in order, writable.
- `settle_hall(server_seed)`: anyone, while Locked. Checks `sha256(seed) == commitment`, rebuilds
  every card (`live:card:i`) and the drum (`live:draw`), pays the winning cards' owners, the fee and
  the dust to the treasury, and closes the hall to the host. Remaining accounts: the roster, in
  order, writable.
- `claim_timeout_hall()`: anyone, while Locked and `slot ≥ locked_slot + TIMEOUT_SLOTS`. Refunds
  every deposit (no fee) and closes. Same accounts as `settle_hall`.

Events: `RoomOpened/Joined/Settled/TimedOut`, `HallOpened/Joined/Locked/Cancelled/Settled/TimedOut`.
Hall error codes follow the room's, so no existing code number moved.

## Compute

Measured in LiteSVM (`apps/web/src/solana/waveHall.test.ts` prints them): `settle_hall` costs
about 19k CU for 2 cards, 29k for 6 and 97k for the worst case of 32 (8 players × 4 cards), well
inside the 200k default. The client still sends a `SetComputeUnitLimit` of 150k with the
settlement (`settleHallIxs`), so a priority fee is priced on the real need. Three things keep it
cheap: HMAC block messages and card domains are written byte by byte instead of with `format!`,
the HMAC pads are computed once per round, and a card's completion ball is the drum position of
its last number rather than a ball-by-ball daub. All three are checked against the engine's
vectors, so the replay stays bit for bit the engine's.

## Testing

```sh
# Native tests: fair.rs against JSON.stringify, and the replay against the engine's vectors
# (tests/vectors/rounds.json for rooms, tests/vectors/halls.json for halls).
cd programs/wave_duel && cargo test --release

# The deployable program (target/deploy/wave_duel.so).
PATH=/root/.local/share/solana/install/active_release/bin:$PATH cargo build-sbf

# The clients against the .so in LiteSVM (skipped when the .so is missing).
pnpm --filter @beach-bingo/web exec vitest run src/solana/waveDuel.test.ts
pnpm --filter @beach-bingo/web exec vitest run src/solana/waveHall.test.ts

# Regenerate the vectors from the engine (then rerun cargo test).
pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-vectors.mjs > programs/wave_duel/tests/vectors/rounds.json
pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-hall-vectors.mjs > programs/wave_duel/tests/vectors/halls.json
```

Clients: `apps/web/src/solana/waveDuel.ts` (rooms, config, sending) and `waveHall.ts` (halls).
Both hand-encode the layouts from `lib.rs`, so the three files move together. To replay a hall
with the engine, give `buildRoom` the roster from `hallRoster(hall)` and `hall.entropy` as the
client seed; the test does exactly this and checks every lamport against it.
