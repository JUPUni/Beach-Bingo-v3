# wave_duel

Trustless Wave Rush escrows for Beach Bingo, as an Anchor 1.2 program (`6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH`).
The host commits to a seed, players stake SOL or a registered token into a PDA, and anyone can
settle by revealing the seed: the program replays the 30-ball round with the engine's own RNG
(`fair.rs`, `bingo.rs`) and pays out. Nothing is trusted off-chain; the screens and the chain
compute the same round from the same seed and entropy (docs/FAIRNESS.md).

Two shapes share the program, the config and the registry:

| | Room (1v1) | Hall (2..=8 players) |
|---|---|---|
| Account | `Room`, PDA `["room", host, code]` | `Hall`, PDA `["hall", host, code]` |
| Stake | one stake, one card each | `stake_per_card`, 1..=4 cards per player |
| Roster | host card 0, guest card 1 | join order, host first; card numbers follow it |
| Entropy fixed | when the guest joins: `sha256(guest ‖ newest slot hash)` | when a guest locks (or the join that fills the hall): `sha256(players ‖ card counts ‖ newest slot hash)` |
| Result | first card full wins; both on one ball split | every card full on the first winning ball takes `prize / winning_cards`; players are paid the sum of their cards' shares |
| Fee | `pot × fee_bps / 10000` to the treasury | the same, plus the split's dust |
| Host silent after `TIMEOUT_SLOTS` (3,000) | guest takes the prize | guests get their deposits back and split the host's deposit pro rata to their cards; no fee |
| Cancel | host, before a guest joins | host, while open: every deposit refunded |

Every round **snapshots** its fee, treasury, mint and token program when it opens (`fee_bps`,
`treasury`, `mint`, `token_program` on the Room/Hall); settlement, timeouts, cancels and claims
read the snapshot, never the live config. An admin change can never move money in a round that is
already running (and the SOL `settle*` / `claim_timeout*` accounts now check the treasury against
the snapshot, `TreasuryMismatch` otherwise).

Shared constants: `MIN_STAKE` 0.001 SOL, `MAX_STAKE` 100 SOL (per card in a hall) for SOL;
per-mint bounds for tokens, with `MAX_MINT_STAKE = u64::MAX / 32` so that a 32-card pot fits a
u64 at any decimals; `MAX_FEE_BPS` 1,000; `CODE_ALPHABET` (the game's room codes: no 0/O, 1/I/L).
Overflow anywhere is `DuelError::Overflow`, never a panic.

## Accounts

Sizes include the 8-byte discriminator; field order is the layout the clients hand-decode.

- `Config` (`["config"]`, 192 bytes): `admin`, `treasury`, `fee_bps: u16`, `paused`, `bump`, then
  (v2) `pauser: Pubkey`, `sgt_group: Pubkey`, `pack_coins: [u32; 4]`, `seeker_discount_bps: u16`,
  `sol_pack_prices: [u64; 4]`, `sol_seeker_fee_bps: u16`. `init_config(fee_bps)` fills the v2
  fields with defaults (pauser = admin, no group, packs 5,000 / 15,000 / 40,000 / 100,000, no
  discount, SOL packs not sold, SOL Seeker fee = fee); `set_config(fee_bps, paused, pauser,
  sgt_group, pack_coins, seeker_discount_bps, sol_pack_prices, sol_seeker_fee_bps)` (admin, the
  treasury as an account) writes everything; `pause()` (pauser or admin) only sets `paused = true`.
  **Devnet's config predates v2 (76 bytes): run `migrate_config` once** (admin; reallocs in place,
  keeps admin/treasury/fee/pause, fills the defaults, the admin pays the extra rent). A fresh
  deployment never needs it. Paused blocks `open*`, `join*`, `lock_hall` and `buy_pack*` only;
  settling, timeouts, cancels and claims always work so money can always leave.
- `MintEntry` (`["mint", mint]`, 199 bytes): `mint`, `token_program`, `decimals`, `min_stake`,
  `max_stake`, `fee_bps`, `seeker_fee_bps` (≤ `fee_bps`), `enabled`, `flags { has_freeze_authority,
  permanent_delegate, transfer_fee_config_present, pausable, default_state_frozen, hook_program:
  Option<Pubkey> }`, `treasury_ata`, `pack_prices: [u64; 4]`, `discount_bps`, `bump`.
- `Room` (290 bytes): `host`, `guest`, `stake`, `commitment`, `code`, `state` (Open 0 / Ready 1 /
  Settled 2), `created_slot`, `joined_slot`, `entropy`, `bump`, then the snapshot `fee_bps`,
  `treasury`, `mint` (`Pubkey::default()` = SOL), `token_program`, `seeker: bool`,
  `credits: [u64; 2]` (host, guest), `treasury_credit`.
- `Hall` (574 bytes): `host`, `stake_per_card`, `max_players` (2..=8), `commitment`, `code`,
  `state` (Open 0 / Locked 1 / Settled 2), `players: [Pubkey; 8]`, `cards: [u8; 8]`,
  `player_count`, `cards_sold`, `entropy`, `locked_slot`, `created_slot`, `bump`, then the same
  snapshot fields, `seeker`, `credits: [u64; 8]` (by roster position), `treasury_credit`. The first
  `player_count` entries of `players`/`cards` are the roster in join order; the host is entry 0.
- `Buyer` (`["buyer", wallet]`, 61 bytes): `wallet`, `coins_total: u64`, `purchases: u32`,
  `last_slot`, `bump`; created by the wallet's first purchase.

SOL stakes are held in the escrow account itself; token stakes in the escrow PDA's **associated
token account** for the mint (the vault), which the host pays for at open and gets back when the
escrow closes. The state account's rent goes back to the host when it closes (settle, timeout,
cancel, or the last credit claim).

## Mint registry

`register_mint(min_stake, max_stake, fee_bps, seeker_fee_bps, pack_prices, discount_bps)` (admin)
reads the mint with `StateWithExtensions` and refuses what an escrow cannot hold safely:
`NonTransferable`, `DefaultAccountState == Frozen`, a `TransferFeeConfig` whose current or
scheduled fee is non-zero (PYUSD's zero-rate config is allowed), a `TransferHook` with a program
id set, and any owner other than SPL Token or Token-2022 (the `token_program` account must own
the mint). It requires the treasury's ATA for the mint (`config.treasury × mint × token program`)
to exist and records it. `set_mint(..., enabled)` updates stakes, fees, prices, discount and
`enabled`; a disabled mint blocks new rounds and purchases only.

Allow-listed is not trusted: every deposit (`open_*_token`, `join_*_token`, `buy_pack_token`)
re-reads the mint and fails cleanly if a fee or a hook has appeared since (`MintHasTransferFee`,
`MintHasTransferHook`) or the mint is paused (`MintPaused`); every payout re-checks the pause. A
mint's extension *set* is fixed at creation, so the registry flags are stable; only their values
can move, and those are what the re-checks read.

## Instructions

Room (SOL, unchanged names, arguments and account lists): `open_room(code, stake, commitment)`,
`join_room()`, `cancel_room()`, `settle(server_seed)`, `claim_timeout()`.

Hall (SOL, unchanged): `open_hall(code, stake_per_card, max_players, cards, commitment)`,
`join_hall(cards)`, `lock_hall()` (mint-agnostic: it locks token halls too), `cancel_hall()`,
`settle_hall(server_seed)`, `claim_timeout_hall()`. Remaining accounts for cancel, settle and
timeout: the roster in order, writable. The SOL instructions refuse a token escrow
(`NotSolEscrow`), so a token round's rent can never be paid out as if it were a pot.

Token rooms: `open_room_token(code, stake, commitment)` with accounts config, mint_entry, mint,
room, vault, host_ata, host, token program, associated token program, system program;
`join_room_token()`; `cancel_room_token()`; `settle_token(server_seed)` and
`claim_timeout_token()` with accounts room, host, mint, vault, host_ata, guest_ata, treasury_ata,
token program, settler; `claim_credit(index)`.

Token halls: `open_hall_token(code, stake_per_card, max_players, cards, commitment)`,
`join_hall_token(cards)`, `cancel_hall_token()`, `settle_hall_token(server_seed)`,
`claim_timeout_hall_token()`, `claim_credit_hall(index)`.

**The remaining-accounts convention for token halls:** one token account per roster entry, in
roster order, each writable, owned by that player for the hall's mint. The client passes the
associated token accounts (`rosterTokenAccounts`); the program checks owner and mint, pays the
account if it can, and otherwise requires it to be the player's ATA and credits the player
(`RosterMismatch` for anything else, which only costs the settler a retry). The SOL halls keep
passing the wallets themselves.

Deposits are `transfer_checked` with the player as authority; payouts are `transfer_checked`
signed by the escrow PDA; the vault is created with `create_idempotent` at open and must be the
PDA's ATA (`BadVault`); the mint must be the snapshot's and be owned by the token program passed
(`MintMismatch`, `BadTokenProgram`); the vault is constrained by associated derivation.

### The claim path

A settlement never reverts because of a recipient. Before each payout the program checks that the
recipient account exists, is a token account of the right mint owned by the right wallet, is
`Initialized` (not frozen) and does not require incoming memos (CPI Guard does not restrict
receiving, so a guarded account is paid). Accounts that pass are paid; the rest are recorded in
`credits` (by roster position; `treasury_credit` for a treasury that cannot be paid) and the
escrow stays open in state `Settled` with its vault. `claim_credit(index)` /
`claim_credit_hall(index)` (anyone may send it; `index` is the roster position, or
`TREASURY_CREDIT` = 255) pays the creditor to any token account it owns for the mint, sending a
Memo first when the account requires one. The claim that clears the last credit sweeps any
residue to the treasury's ATA, closes the vault (harvesting withheld fees first if a Token-2022
mint ever had any) and then the state account, rent to the host. Order on every close: transfers
→ sweep → close vault → close state.

If `vault.amount` is below the expected pot (a permanent delegate moved funds), every payout is
scaled pro rata (`amount × available / expected`, floor) and the treasury takes the rounding; a
vault holding more than the pot (a donation) sends the surplus to the treasury.

What this version does not do: pass a transfer hook's extra accounts. A hook installed on a
registered mint after registration blocks that mint's deposits by the re-check and makes its
payouts' CPIs fail (cleanly, retryable) until a client that resolves the hook's accounts exists.
PYUSD's hook authority is live but its program id is null; a hook is therefore an issuer action
the operator would see (monitoring in docs/PRODUCTION.md).

### Hall timeout forfeit

`claim_timeout_hall` and `claim_timeout_hall_token` pay each guest its own deposit plus
`host deposit × its cards / guest cards` (floor); the host gets nothing but the rent; the split's
dust goes to the treasury; no fee. A refund-only timeout let a host that saw the outcome first stay
silent on every loss for free; the forfeit makes silence cost exactly what losing would. The room
timeout is unchanged (the guest takes the prize).

### Seeker proof

`prove_seeker_room()` / `prove_seeker_hall()`: the host, while the escrow is Open, passes the
mint entry (or the program id in its place for a SOL round), its Seeker Genesis Token account and
that token's mint. The program checks both are owned by Token-2022, the account belongs to the
host with `amount ≥ 1`, and the mint's `MetadataPointer.metadata_address` and
`TokenGroupMember.group` both equal `config.sgt_group`; then it lowers the round's snapshotted
`fee_bps` to the entry's `seeker_fee_bps` (`sol_seeker_fee_bps` for SOL) and sets `seeker = true`,
which the settle events carry. `sgt_group` is a config value because devnet uses a mock group
(`create-devnet-sgt` in the admin script); mainnet's is `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`.

### Coin shop

`buy_pack(pack)` (SOL) and `buy_pack_token(pack)`: price = `pack_prices[pack] × (10_000 −
discount_bps − (seeker ? seeker_discount_bps : 0)) / 10_000` (floor, never below one base unit),
paid to the treasury (a system transfer to `config.treasury`, or `transfer_checked` to the
registered treasury ATA); `seeker` is true when the buyer passes a valid SGT token account and
mint as the two trailing optional accounts (both or neither; the program id stands for "none"; a
pair that fails the check is an error, not a full-price sale). The `Buyer` PDA is created by the
first purchase (the buyer pays its rent) and incremented after; event `CoinsBought { wallet, mint,
pack, coins, paid, discount_bps, seeker }`. A pack with price 0 is not sold (`PackNotForSale`).
Paused blocks purchases. No refunds, no sell-back.

Events: `RoomOpened/Joined/Settled/TimedOut`, `HallOpened/Joined/Locked/Cancelled/Settled/TimedOut`
(settle events now end with `mint` and `seeker`, `HallTimedOut` with `forfeited` and `mint`),
`MintRegistered`, `MintUpdated`, `CreditClaimed`, `SeekerProven`, `CoinsBought`, `Paused`. New
error codes follow the existing ones, so no number moved.

## Compute

Measured in LiteSVM (the suites print them): `settle_hall` costs about 20k CU for 2 cards, 30k
for 6 and 98k for the worst case of 32 (8 × 4), inside the 150k the SOL client requests. Token
rounds add the transfer CPIs: `settle_token` on a USDC-like SPL Token mint 28k, a six-card
PYUSD-like Token-2022 hall 50k, the 8 × 4 PYUSD-like hall with eight payouts, the treasury's and
the vault close **118k CU**; the token hall client sends a `SetComputeUnitLimit` of 250k (the measured worst case varies with the cards drawn, 118–124k across runs, and the test keeps a 1.5× margin under the limit), the
measured worst case × 1.5, and `waveToken.test.ts` asserts that headroom. The replay stays cheap
for the reasons the SOL version had: HMAC block messages and card domains written byte by byte,
the HMAC pads computed once per round, and a card's completion ball read off the drum.

## Testing

```sh
# Native tests: fair.rs against JSON.stringify, and the replay against the engine's vectors
# (tests/vectors/rounds.json for rooms, tests/vectors/halls.json for halls).
cd programs/wave_duel && cargo test --release

# The deployable program (target/deploy/wave_duel.so, about 711 KB with the token paths; the
# devnet program-data account holds 303,048 bytes, so the upgrade needs
# `solana program extend 6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH 450000` first).
PATH=/root/.local/share/solana/install/active_release/bin:$PATH cargo build-sbf

# The clients against the .so in LiteSVM (skipped when the .so is missing): the 11 SOL tests and
# the 15 token tests (registry and its refusals, USDC-like room and PYUSD-like halls to the base
# unit, the 8 × 4 compute figure, frozen recipient → credit → claim → close, permanent-delegate
# seizure → pro rata, config change after a join, disabled mint, pauser, forfeit, Seeker proof
# with a mock group, the shop in SOL and SKR, a paused mint).
pnpm --filter @beach-bingo/web exec vitest run src/solana/waveDuel.test.ts src/solana/waveHall.test.ts src/solana/waveToken.test.ts

# Regenerate the vectors from the engine (then rerun cargo test).
pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-vectors.mjs > programs/wave_duel/tests/vectors/rounds.json
pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-hall-vectors.mjs > programs/wave_duel/tests/vectors/halls.json
```

Clients: `apps/web/src/solana/waveDuel.ts` (SOL rooms, config, sending), `waveHall.ts` (SOL
halls), `waveToken.ts` (registry, token rooms and halls, credits, Seeker proof, ATA and vault
derivation) and `shop.ts` (coin packs, `Buyer`). All hand-encode the layouts from `lib.rs`, so
they move together. The admin script (`apps/web/scripts/wave-duel-admin.mjs`) adds
`migrate-config`, `set-config`, `register-mint`, `set-mint`, `show-mints`, `create-devnet-mint`
and `create-devnet-sgt`; docs/ESCROW.md has the operating notes.

## Before mainnet

- `init_config` is gated on the program's upgrade authority: the account that runs it must be
  the ProgramData's `upgrade_authority_address`, so nobody can take the admin role between a
  deployment and its configuration. The client passes the program and its ProgramData account;
  LiteSVM tests grant their admin the authority first (`litesvmSupport.ts`).
- `transfer_admin` hands the admin role to any address; there is no two-step accept, so tooling
  confirms the address twice.
- `buy_pack_token` pays the treasury named by the config at the time of purchase, its associated
  token account for the mint; `set_config treasury=` therefore moves token revenue too.
- Discounts: a mint's `discount_bps` is at most 4,900 and the config's `seeker_discount_bps` at
  most 5,000, so their sum stays under 10,000.

