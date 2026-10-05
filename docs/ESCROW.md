# Staked rooms: the wave_duel escrow

`programs/wave_duel` is a Solana program that holds the stakes of a Wave Rush round, a 1v1 room
or a hall of two to eight players, and pays the winners without a server, an arbiter or any trust
between the players. It is the live-room protocol of docs/FAIRNESS.md with two changes: the stakes
are SOL, or a token the admin has registered, held by the program instead of coins held by each
browser, and the client seed is fixed by the chain instead of the roster. It runs on **devnet
only**, behind a build flag; the reasons are in "The money rule" below and in docs/PRODUCTION.md.

## What it is

Two people who share a room code each deposit the same stake into a room account owned by the
program: lamports held in the account itself, or a registered token held in the room's own token
account (its vault). The host commits to a secret seed before anyone joins; the guest's join fixes
the round's entropy; both screens play the 30-ball round from those two inputs; and the program,
given the revealed seed, replays the round with the engine's exact random-number contract and
moves the money. Nobody holds anyone else's funds, the program cannot choose the outcome, and a
host who goes quiet forfeits.

## The protocol, step by step

1. **Open.** The host opens a live Wave Rush room as usual (its commitment is already on screen),
   picks a stake, and sends `open_room(code, stake, commitment)`, or `open_room_token` for a
   registered mint. The program creates the room PDA, transfers the stake into it (into the room's
   associated token account for a token, created at the same time at the host's expense), records
   the commitment, and **snapshots the fee, the treasury, the mint and its token program** into the
   room. The lobby now shows the escrow.
2. **Join.** The guest, seeing the same stake in their lobby, sends `join_room` (or
   `join_room_token`). The program transfers the same stake, refuses the host's own wallet, and
   fixes `entropy = SHA-256(guest pubkey ‖ newest SlotHashes entry)`: 32 bytes nobody knew when the
   host committed. The room becomes `Ready` and records `joined_slot`.
3. **Play.** The screens poll the room account. Once it is `Ready`, the host may start; the `start`
   message carries the seed, the two-entry roster (host first, one card each) and the chain's
   entropy. Every client checks the seed against the commitment and the entropy against what it
   read from the chain itself, then builds the round with `buildRoom(preset, commitment, seed,
   roster, clientSeed = entropy)`: the host's card is card 0, the guest's card 1, the drum is the
   `live:draw` stream. A start with another entropy or roster is refused by honest clients, and
   cannot change what the chain pays.
4. **Settle.** Anyone who knows the seed (both players do after `start`) sends `settle(seed)` (or
   `settle_token`). The program checks `SHA-256(seed) == commitment`, replays the round from the
   seed and the stored entropy, and pays: the winner takes the prize, a tie splits it (one unit of
   dust goes to the treasury), and the fee in basis points **from the room's snapshot** goes to the
   treasury the snapshot names. The room account is closed and its rent returned to the host; a
   token room also closes its vault, whose rent the host gets back too.
5. **Timeout.** If nobody settles within `TIMEOUT_SLOTS` (3,000 slots, about 20 minutes) after
   the join, anyone may send `claim_timeout` (or `claim_timeout_token`): the guest receives the
   prize and the treasury the fee.
6. **Cancel.** Before a join, the host may `cancel_room` (or `cancel_room_token`) and take the
   stake and the rent back.

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
to the treasury. **A host that goes quiet after the lock forfeits:** after the timeout the guests
get their deposits back and split the host's deposit pro rata to their cards, the split's dust to
the treasury, no fee. (The first version refunded everyone instead, which let a host that saw the
outcome first stay silent on every round it disliked at no cost; the forfeit makes silence cost
exactly what losing would.) The host may cancel while the hall is open; every deposit goes back.
Token halls (`open_hall_token` and its siblings) are the same table with the stakes in the hall's
vault; `lock_hall` is the same instruction for both.

The program, its client (`apps/web/src/solana/waveHall.ts`) and the LiteSVM suite are proven on
devnet (see the addresses below), and the live-room lobby stakes halls too: the host's stake panel
has a "Hall" mode (seats, its own cards, the stake per card), guests buy seats from their lobby,
which lists the seats as the chain holds them, a seated guest locks the table, the host's Start
enables once the chain reads `locked`, every screen builds the round from the chain's seats and
entropy and refuses a start that is not the table it read itself, and anyone settles from the
results (`apps/web/src/rooms/live/HallStakePanel.tsx`, `machine.ts`). `programs/wave_duel/README.md`
has the account and instruction detail and the compute figures.

## Tokens: the registry and the vaults

A round can be staked in any mint the admin has put in the **registry**: one `MintEntry` PDA
(`["mint", mint]`) per mint, holding its token program, decimals, minimum and maximum stake, fee
tier, Seeker fee tier, `enabled` flag, the extension flags read from the mint at registration, the
treasury's token account for that mint, and the shop's pack prices and discount for it.
`register_mint` reads the mint with `StateWithExtensions` and **refuses what an escrow cannot hold
safely**: a non-transferable mint, a mint whose new accounts start frozen (`DefaultAccountState ==
Frozen`), a transfer fee whose current or scheduled rate is above zero (PYUSD's zero-rate config is
allowed), a transfer hook with a program id set, and any owner other than SPL Token or Token-2022.
It requires the treasury's associated token account for the mint to exist and records it. A
registered mint's maximum stake is bounded (`u64::MAX / 32`) so that the largest hall pot, 32
cards, fits a u64 at any decimals; overflow anywhere in the arithmetic is an error, not a panic.

Allow-listed is not trusted. A mint's extension *set* is fixed when it is created, so the flags
recorded at registration are stable, but their values can move: every deposit (an open, a join, a
shop purchase) re-reads the mint and fails cleanly if a fee or a hook has appeared since
(`MintHasTransferFee`, `MintHasTransferHook`) or the issuer has paused it (`MintPaused`); every
transfer out of a vault re-checks the pause. The five launch assets and the facts that shaped
this are in docs/plans/2026-10-05-tokens-design.md.

A token round's **vault** is the associated token account of its own Room or Hall PDA for the
mint, created idempotently at open (the host pays its rent and gets it back when the escrow
closes). Deposits are `transfer_checked` with the player as authority out of the player's own
token account; everything leaving the vault is `transfer_checked` signed by the PDA under the
mint's own program. The mint must be the snapshot's and be owned by the token program passed, the
vault must derive from the PDA, the mint and that program, and every recipient account is checked
for mint and owner before it is paid. For a token hall the roster travels as remaining accounts,
one token account per seat in seat order, each writable and owned by that player (the client
passes the seats' associated token accounts); a SOL hall keeps passing the wallets themselves.

## The claim path

A settlement never fails because of one recipient. Before each transfer the program checks that
the recipient account exists, is a token account of the round's mint owned by the right wallet,
is `Initialized` (not frozen) and does not require incoming memos (CPI Guard does not restrict
receiving, so a guarded account is paid). Accounts that pass are paid at once; the rest are
**credited** on the Room or Hall (`credits`, by roster position, and `treasury_credit` for a
treasury account that cannot be paid), the escrow moves to state `Settled` and keeps its vault.
`claim_credit(index)` and `claim_credit_hall(index)` may be sent by anyone and pay a creditor into
any token account it owns for the mint (a Memo is sent first when the account requires one); the
claim that clears the last credit sweeps any residue to the treasury's account, closes the vault
and then the state account, rent to the host. The order on every close is the same: transfers, then
the sweep, then the vault, then the state. If the vault holds less than the pot when it settles (an
issuer's permanent delegate moved funds, which PYUSD's can), every amount is scaled pro rata and the
treasury takes the rounding; a vault holding more than the pot (a donation) sends the surplus to the
treasury. Nobody can make a round un-settleable by freezing, closing or guarding an account.

## Roles and the per-round snapshot

The config's `admin` does everything through `set_config`: the fee, the treasury, the pause bit,
the `pauser` key, the Seeker Genesis Token group, the shop's pack sizes and SOL prices, the Seeker
discount and the SOL Seeker fee tier. The **pauser** may only call `pause()`, which sets `paused =
true`; only the admin's `set_config` unpauses. Paused, like a disabled mint, blocks opens, joins,
locks and purchases and never a settlement, a timeout, a cancel or a claim, so money can always
leave. Because every round copies the fee, the treasury, the mint and the token program when it
opens and reads only that copy afterwards, no config change, however the admin key is held, can
move money in a round that is already running; the SOL settle and timeout instructions keep their
account lists and check the treasury passed against the round's snapshot.

## The Seeker proof

The host of an open room or hall may send `prove_seeker_room` / `prove_seeker_hall` with its
Seeker Genesis Token account and that token's mint. The program checks that both are Token-2022
accounts, that the token account belongs to the host with a balance of at least one, and that the
mint's `MetadataPointer.metadata_address` and `TokenGroupMember.group` both equal the config's
`sgt_group`: the on-chain form of the check `seeker.ts` makes in the app, with nothing for a
client to assert. The round's snapshotted fee then drops to the mint's `seeker_fee_bps`
(`sol_seeker_fee_bps` for SOL), `seeker` is set on the round and carried by its settle event. The
group is a config value because the real token exists only on mainnet
(`GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`); on devnet the config names a mock group (below).

## The coin shop

Coins stay what every mode plays for; the shop sells packs of them so that the price a player
pays is enforced by the program, not by the client. The config holds `pack_coins` (coins per pack,
four packs) and `sol_pack_prices` (lamports per pack, 0 = not sold for SOL); each registry entry
holds `pack_prices` in the mint's base units and its own `discount_bps` (SKR carries 2,000, a
fifth off); `seeker_discount_bps` comes on top for a buyer who proves its Seeker Genesis Token.
`buy_pack(pack)` sends `price × (10,000 − discount − Seeker discount) / 10,000` to the treasury;
`buy_pack_token(pack)` does the same by `transfer_checked` to the registered treasury account. A
`Buyer` PDA per wallet (`["buyer", wallet]`, created by the first purchase at the buyer's expense)
counts `coins_total`, `purchases` and `last_slot`, and `CoinsBought` is emitted; the app credits
coins from the confirmed transaction, and a "restore purchases" on a new device credits the
difference between the PDA's total and what the device already gave. A pack priced 0 is not sold,
a paused escrow sells nothing, and there is no refund, no sell-back and no transfer of coins
between players. The legal question purchased coins raise is in docs/plans/2026-10-05-tokens-design.md §6b.

Two things the clients learned on devnet: `buy_pack_token` refuses a buyer that is the treasury
wallet itself (the buyer's and the treasury's token accounts would be the same mutable account,
which Anchor rejects), so the operator cannot test a token purchase from the treasury key, only
from another wallet; and the app's shop (`apps/web/src/shop/chainShop.ts`) credits coins from the
`CoinsBought` event of the confirmed transaction, with the `Buyer` PDA's delta as the fallback,
and restores `coins_total` minus what this device already credited for that wallet.

## Accounts and instructions

Program id `6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH` (`declare_id!` in `lib.rs`; Anchor
1.2.0). SOL amounts are lamports, token amounts base units; `MIN_STAKE` 0.001 SOL, `MAX_STAKE`
100 SOL, per-mint bounds for tokens, `MAX_FEE_BPS` 1,000. Sizes include the 8-byte discriminator;
the fields are in layout order.

| Account | PDA seeds | Fields | Size |
|---|---|---|---|
| `Config` | `["config"]` | `admin`, `treasury`, `fee_bps: u16`, `paused: bool`, `bump`, `pauser`, `sgt_group`, `pack_coins: [u32; 4]`, `seeker_discount_bps: u16`, `sol_pack_prices: [u64; 4]`, `sol_seeker_fee_bps: u16` | 192 bytes |
| `MintEntry` | `["mint", mint]` | `mint`, `token_program`, `decimals`, `min_stake`, `max_stake`, `fee_bps`, `seeker_fee_bps`, `enabled`, `flags` (`has_freeze_authority`, `permanent_delegate`, `transfer_fee_config_present`, `pausable`, `default_state_frozen`, `hook_program: Option<Pubkey>`), `treasury_ata`, `pack_prices: [u64; 4]`, `discount_bps`, `bump` | 199 bytes |
| `Room` | `["room", host, code]` | `host`, `guest` (zero until a join), `stake: u64`, `commitment: [u8; 32]`, `code: [u8; 5]`, `state: u8` (0 Open, 1 Ready, 2 Settled), `created_slot`, `joined_slot`, `entropy: [u8; 32]`, `bump`, then the snapshot `fee_bps`, `treasury`, `mint` (zero = SOL), `token_program`, `seeker: bool`, `credits: [u64; 2]`, `treasury_credit` | 290 bytes |
| `Hall` | `["hall", host, code]` | `host`, `stake_per_card: u64`, `max_players: u8`, `commitment`, `code`, `state: u8` (0 Open, 1 Locked, 2 Settled), `players: [Pubkey; 8]`, `cards: [u8; 8]`, `player_count`, `cards_sold: u16`, `entropy`, `locked_slot`, `created_slot`, `bump`, then the same snapshot fields, `seeker`, `credits: [u64; 8]`, `treasury_credit` | 574 bytes |
| `Buyer` | `["buyer", wallet]` | `wallet`, `coins_total: u64`, `purchases: u32`, `last_slot`, `bump` | 61 bytes |

The SOL instructions keep the names, arguments and account lists of the first deployment:

| Instruction | Arguments | Accounts, in order | Checks |
|---|---|---|---|
| `init_config` | `fee_bps` | config (init), admin (signer, payer), treasury (any), system program | fee ≤ 1,000 bps; the v2 fields start at their defaults |
| `set_config` | `fee_bps`, `paused`, `pauser`, `sgt_group`, `pack_coins`, `seeker_discount_bps`, `sol_pack_prices`, `sol_seeker_fee_bps` | config (`has_one = admin`), admin (signer), treasury | fee ≤ 1,000 bps; SOL Seeker fee ≤ fee |
| `migrate_config` | none | config (the 76-byte first-deployment account), admin (signer, payer), system program | grows the account to 192 bytes in place, keeping admin, treasury, fee and pause; once per deployment that predates v2 |
| `pause` | none | config, authority (signer) | the pauser or the admin; sets `paused` only |
| `register_mint` | `min_stake`, `max_stake`, `fee_bps`, `seeker_fee_bps`, `pack_prices`, `discount_bps` | config (`has_one = admin`), admin (signer, payer), mint, mint_entry (init), treasury's ATA, token program, system program | the refusals above; the treasury ATA exists |
| `set_mint` | the same, plus `enabled` | config, admin (signer), mint_entry | bounds and fee tiers |
| `open_room` | `code: [u8; 5]`, `stake: u64`, `commitment: [u8; 32]` | config, room (init, paid by host), host (signer), system program | not paused; stake in range; code from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` |
| `join_room` | none | config, room, guest (signer), SlotHashes sysvar (by address), system program | not paused; Open; guest ≠ host; a SOL room |
| `cancel_room` | none | room (`close = host`, `has_one = host`), host (signer) | Open; a SOL room |
| `settle` | `server_seed: [u8; 32]` | config, room (`close = host`, `has_one = host, guest, treasury`), host, guest, treasury, settler (signer) | Ready; `SHA-256(seed) == commitment`; the treasury is the snapshot's |
| `claim_timeout` | none | same as `settle` | Ready; `slot ≥ joined_slot + 3,000` |
| `open_hall` | `code`, `stake_per_card: u64`, `max_players: u8` (2–8), `cards: u8` (1–4), `commitment` | config, hall (init, paid by host), host (signer), system program | not paused; stake, seats and cards in range; code alphabet |
| `join_hall` | `cards: u8` | config, hall, player (signer), SlotHashes sysvar, system program | not paused; Open; a seat left; one seat per wallet; the join that fills the hall locks it |
| `lock_hall` | none | config, hall, player (signer), SlotHashes sysvar | not paused; Open; two players or more; a seated guest, never the host; SOL and token halls alike |
| `cancel_hall` | none | hall (`close = host`, `has_one = host`), host (signer); then the roster in order, writable | Open; every deposit refunded |
| `settle_hall` | `server_seed: [u8; 32]` | config, hall (`close = host`, `has_one = host, treasury`), host, treasury, settler (signer); then the roster in order, writable | Locked; `SHA-256(seed) == commitment`; the roster passed matches the hall's |
| `claim_timeout_hall` | none | same as `settle_hall` | Locked; `slot ≥ locked_slot + 3,000`; the guests' deposits back plus the host's deposit pro rata, no fee |

The token instructions beside them:

| Instruction | Arguments | Accounts, in order | Checks |
|---|---|---|---|
| `open_room_token` | `code`, `stake`, `commitment` | config, mint_entry, mint, room (init), vault (the room's ATA, created here), host's token account, host (signer), token program, associated token program, system program | not paused; mint enabled; stake within the entry's bounds; the mint still has no fee, no hook and is not paused |
| `join_room_token` | none | config, mint_entry, room, mint, vault, guest's token account, guest (signer), SlotHashes sysvar, token program | as `join_room`, with the mint re-checked |
| `cancel_room_token` | none | room, host (signer), mint, vault, host's token account, treasury's ATA, token program | Open; the stake back, the vault closed |
| `settle_token`, `claim_timeout_token` | `server_seed` / none | room, host, mint, vault, host's token account, guest's token account, treasury's ATA, token program, settler (signer) | as the SOL ones; each recipient paid or credited |
| `claim_credit` | `index` (0 host, 1 guest, 255 treasury) | room, host, mint, vault, destination, treasury's ATA, token program, Memo program, payer (signer) | Settled; something owed; the destination belongs to the creditor and holds the mint |
| `prove_seeker_room` | none | config, room, host (signer), mint_entry (the program id for a SOL room), SGT token account, SGT mint | Open; the proof above |
| `open_hall_token`, `join_hall_token`, `cancel_hall_token`, `settle_hall_token`, `claim_timeout_hall_token`, `claim_credit_hall`, `prove_seeker_hall` | as the hall's | as the room's, the hall in place of the room; the roster's token accounts as remaining accounts for cancel, settle and timeout | as the room's |
| `buy_pack` | `pack: u8` | config (`has_one = treasury`), buyer (created if needed), wallet (signer, payer), treasury, system program, then the SGT token account and mint or the program id twice | not paused; the pack is sold for SOL; a proof passed must verify |
| `buy_pack_token` | `pack: u8` | config, mint_entry, mint, buyer, wallet (signer), wallet's token account, the registered treasury account, token program, system program, the two optional SGT accounts | not paused; mint enabled; the pack is sold in this mint; the mint re-checked |

A room: `pot = 2 × stake`, `fee = pot × fee_bps / 10,000` (u128 arithmetic), `prize = pot − fee`.
A hall: `pot = stake_per_card × cards_sold`, the same fee, `share = prize / winning_cards` to each
winning card and `prize mod winning_cards` of dust to the treasury with the fee. A timed-out hall:
each guest its deposit plus `host deposit × its cards / guest cards`, the remainder to the
treasury. Events `RoomOpened`, `RoomJoined`, `RoomSettled` (seed, win ball, who won, pot, fee,
mint, seeker), `RoomTimedOut` and `HallOpened`, `HallJoined`, `HallLocked`, `HallCancelled`,
`HallSettled`, `HallTimedOut` (with `forfeited`), plus `MintRegistered`, `MintUpdated`,
`CreditClaimed`, `SeekerProven`, `CoinsBought` and `Paused` are emitted for indexers; the error
codes are listed at the end of `lib.rs`, each generation after the last so that no number moved.

The TypeScript clients, `apps/web/src/solana/waveDuel.ts` (SOL rooms, config, sending),
`waveHall.ts` (SOL halls), `waveToken.ts` (the registry, token rooms and halls, credits, the
Seeker proof, token-account derivation) and `shop.ts` (packs and the `Buyer` PDA), hand-encode
these layouts with `@solana/kit` (Anchor discriminators, `sha256("global:<ix>")[..8]`), so they
and `lib.rs` move together. The lobby's SOL stake presets are 0.01, 0.025, 0.05, 0.1 and 0.25 SOL;
token presets are registry values.

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
loop from the other side: they run the compiled program and check that the lamports, or the base
units, go to the players the engine names.

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
  happy with the roster. A timed-out hall forfeits the host's deposit to the guests, so silence
  costs the host what losing would; the app still treats a timed-out hall as the host's failure.
- **An admin key**, hot or compromised, cannot touch a running round: the fee, the treasury, the
  mint and the token program are read from the round's own snapshot. It can stop new rounds
  (`paused`, a disabled mint) and change the terms of the next ones, and the pauser can only stop.
- **A token issuer** keeps the powers its extensions give it. A freeze (USDC, PYUSD) stops one
  account from being paid and the program credits it instead; a permanent delegate (PYUSD) can
  move funds out of a vault and the program then pays pro rata from what is left; a pause stops
  every transfer until the issuer resumes, and the program fails cleanly rather than half-paying.
  None of these can make a round un-settleable or lose anyone's claim.
- **Relays and the WebRTC path** see room codes, peer ids, the `StakeInfo` (all public on chain
  anyway) and, at `start`, the seed. Blocking messages can stop the round on screen; it cannot stop
  either player settling.
- **A settler** can only provide a seed that matches the commitment; who is paid, and how much, is
  fixed by the program. Front-running a settle with the same seed is harmless. Passing the wrong
  accounts for a seat fails the instruction (`RosterMismatch`); a settler cannot force a credit on
  a player by naming a stranger's account.
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
  takes the pot after 20 minutes (in a hall, the host's deposit goes to the guests; a guest whose
  host left an open table can lock it to start that clock). After `start` every player holds the
  seed.

Known gaps in this version, both documented in `programs/wave_duel/README.md`:

- **Transfer-hook extra accounts are not passed.** A hook installed on a registered mint after
  registration blocks that mint's deposits by the re-check, and makes the transfers of rounds
  already open fail (cleanly, and retryable) until a client that resolves the hook's accounts
  exists. PYUSD's hook authority is live but its program id is null; a hook is an issuer action
  the operator would see.
- **CPI Guard on a player's own account blocks its deposit** (Token-2022 refuses an owner-signed
  transfer made through a program while the guard is on); such a player disables the guard or
  stakes from another account. Receiving is not affected. The delegate or balance-delta route the
  review describes is the change to make if guarded wallets turn out to be common.

For mainnet the list is known: the upgrade authority and the config admin moved from one hot key to
a multisig (or the program frozen after review); an independent audit; a second source of entropy
or a delayed entropy step to close the leader surface; monitoring that can use the `paused` switch
and the per-mint `enabled` flag quickly; and the 75- and 90-ball halls, whose card builders and
patterns are not ported (the hall escrow plays Wave Rush's 30-ball card only).

## Compute

Measured in LiteSVM (the suites print them): `settle_hall` about 20k CU for 2 cards, 30k for 6 and
98k for the worst case of 32 (8 × 4), inside the 150k the SOL hall client requests. Token rounds
add the transfer CPIs: a USDC-like SPL Token room settles in 28k, a six-card PYUSD-like Token-2022
hall in 50k, and the 8 × 4 PYUSD-like hall with eight transfers, the treasury's and the vault close
in **118k CU**; the token hall client sends a `SetComputeUnitLimit` of 180k, the measured worst
case × 1.5, and `waveToken.test.ts` asserts that headroom.

## Build, test and operate

```bash
cd programs/wave_duel
cargo test --release               # 7 tests: room and hall vectors, room == two-card hall, the message bytes, int() at the edge
cargo build-sbf                    # → target/deploy/wave_duel.so (710,680 bytes with the token paths)
cd ../..
pnpm --filter @beach-bingo/web test  # runs the LiteSVM suites (5 room, 6 hall, 15 token tests) when the .so exists, else skips them
```

`cargo build-sbf` writes a fresh key pair to `target/deploy/`; that is not the program id. The
program's key pair is `.secrets/wave_duel-keypair.json` and the deployer's `.secrets/devnet-deployer.json`
(`.secrets/` is ignored by git). The program-data account on devnet holds 303,048 bytes, so the
token upgrade first needs `solana program extend 6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH 450000
--keypair .secrets/devnet-deployer.json --url devnet` (about 3.1 SOL more rent), then
`solana program deploy target/deploy/wave_duel.so --program-id .secrets/wave_duel-keypair.json
--keypair .secrets/devnet-deployer.json --url devnet` upgrades in place while the deployer is the
upgrade authority. Any room or hall still open at the upgrade keeps the old layout and cannot be
read by the new program, so upgrade with none open. The first instruction after the upgrade must be
`migrate-config`: the config predates v2 and nothing else deserialises it until it has grown.

The admin script, run with the engine's `tsx`:

```bash
A="pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs"
$A init-config [feeBps] [treasury]
$A migrate-config                                     # once, right after the token upgrade
$A set-config key=value ...                           # fee, paused, pauser, sgt, packs, seekerDiscount, solPrices, solSeekerFee, treasury
$A register-mint <mint> <min> <max> <feeBps> <seekerFeeBps> [discountBps] [packPrices csv]   # base units; creates the treasury ATA if missing
$A set-mint <mint> key=value ...                      # min, max, fee, seekerFee, discount, prices, enabled
$A show-mints
$A create-devnet-mint <spl|token2022> <decimals> <amount> [wallet] [--freeze] [--pyusd-like]
$A create-devnet-sgt [wallet]                         # a mock Seeker Genesis Token group and one member token
$A show [host code]
$A round [stakeSol]
$A hall [stakeSol] [cards per seat...]
```

`RPC_URL`, `KEYPAIR` and `WAVE_DUEL_PROGRAM` override the defaults. `round` funds two throwaway
wallets, plays open → join → settle with the deployer as settler, compares the result with the
engine's replay (allowing for the transaction fee when the treasury is the payer), and sweeps the
wallets back. `hall` does the same for a hall: the card counts given (default `2 1 3`) become the
seats, a guest locks the table, the deployer settles, and every seat's lamports are checked
against the engine. `create-devnet-mint` makes a look-alike with the deployer as authority
(`--freeze` for a USDC-like freeze authority, `--pyusd-like` for PYUSD's extension set on
Token-2022) and mints to a wallet; `create-devnet-sgt` makes a mock group whose address goes into
`set-config sgt=<group>` so that `prove_seeker_*` and the Seeker shop discount work on devnet.

`apps/web/scripts/stake-e2e.mjs` is the browser proof: two headless Chromium contexts with a
Wallet Standard test wallet (`scripts/qa/test-wallet.mjs`) play a staked room through the real
lobby on devnet (open, cancel, reopen, join, ready-gated start, the same round on both screens,
settle, the other screen seeing it settled), and what the chain paid is checked against the
engine's replay to the lamport. `apps/web/scripts/stake-hall-e2e.mjs` does the same for a hall
with three contexts: the host opens a table of four seats with two cards, two guests buy one and
three cards, every lobby lists the seats as the chain holds them, a guest locks, the host's Start
enables on `locked`, the three screens finish on the same ball, a guest settles, and each seat's
lamports are checked against `splitHallPot` over the engine's replay. The two scripts share
`scripts/qa/stake-lib.mjs`.

Token proofs from the same key pair: `token-round <mint> [stake]`, `token-hall <mint>
[stakePerCard] [cards…]`, `prove-seeker [mint]` (opens a room, and a hall when a mint is given,
proves the deployer's mock Seeker Genesis Token, reads the lowered fee, cancels), `shop-buy
<sol|mint> <pack> [--seeker]` (a throwaway buyer funded by the key pair; `--seeker` mints it a mock
member token first) and `faucet <mint> <wallet> <amount>`. In the browser, `stake-token-e2e.mjs`
plays a room staked in the SKR look-alike through the real lobby (the picker preselects SKR, the
fee line reads 2.5%, the chain pays the winner's token account exactly the engine's share) and
`shop-e2e.mjs` buys the smallest pack with SKR through the real popup, checks the `CoinsBought`
event, the `Buyer` PDA and the credited coins, and restores them in a fresh context. In the lobby
protocol, `StakeInfo.mint` names the token (absent means SOL, as older builds announce it), and a
settled token escrow that still holds a credit for the connected wallet shows "Claim your share".

The devnet build at https://beach-bingo-eight.vercel.app/app/ is built with
`VITE_SOLANA_CLUSTER=devnet`, `VITE_ENABLE_ONCHAIN_STAKES=true`, `VITE_WAVE_DUEL_PROGRAM=<program
id>`, `VITE_SGT_GROUP=<the config's sgt_group; the mock group on devnet>` and
`VITE_BUILD_LABEL=devnet`. `LiveRoom.tsx` lazy-loads the stake panels only when the flags are set,
so a build without them ships none of this code.

## The money rule

`lib.rs` says it: "Nothing here is a game of skill: it is a wager between people, so it ships
behind a flag until the operator's licensing allows it." Production at beachbingo.xyz builds
without the flags; coins stay play money there, and the wallet popup says so. There is no
compliance gate in the code today: the flags, the absence of a program id in the production build
and the on-chain `paused` bit are the only switches. What it takes to turn the flag on for real
money, and in what order, is the subject of docs/PRODUCTION.md.

## Devnet addresses

| Item | Value |
|---|---|
| Program | `6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH` |
| Program data | `BEsKZLmZqiKAkykZB5dZM6ZmwbpVsUADJKraNZjt2u31` (753,048 bytes of space for the 710,680-byte program; first deployed at slot 505607372 with the 1v1 room, upgraded with the halls at slot 505620387 and with tokens, the registry, the claim path, the Seeker proof and the shop at slot 507797285; about 3.83 SOL of rent) |
| Config after the upgrade | migrated to the 192-byte layout; pauser = the deployer; `sgt_group` = the mock group `GRhL4t47LyWkVtHJ3ierasdcxyjXmzkE6uMJvv38CsHn`; packs 5,000 / 15,000 / 40,000 / 100,000 coins; SOL pack prices 0.04 / 0.11 / 0.27 / 0.6 SOL; Seeker discount 500 bps; SOL Seeker fee 400 bps |
| Registry | USDC-devnet, PYUSD-devnet, the PYUSD look-alike (1 to 100 tokens, fee 500 / Seeker 400, packs 4.99 / 13.99 / 34.99 / 79.99), the JUP look-alike (2 to 500, packs 12 / 33 / 82 / 185), the SKR look-alike (50 to 5,000, fee 250 / Seeker 200, discount 2,000 bps, packs 120 / 330 / 800 / 1,800); registration transactions `2zwNoYfd…`, `41uYj13m…`, `WAcsk8Jt…`, `9fd9TwCD…`, `2rwt1GXt…` |
| Upgrade authority, config admin and treasury (for now) | `5VcGxKLHDJhPAFSN8VK9qpxkM4gniQtPKwRrMnUcqA8u`, the devnet deployer |
| Config PDA | `5HpFPh9dusDzH1uRU4HoAsH5xnaw8dpTPrEuupfoqKL`: fee 500 bps, not paused |
| `init_config` transaction | `3aJvmoWFqLvZAshSfkVMY2Vow532NwYxQSrjzuaSpSvtNW2AjStazMWH9amsaZnycJnK3YYPkTYHzwQGXN1Xq4Nw` |
| First scripted round | room `4F83W` at `HgTTPnp432QCtKxYBgin5EchpAZXbxEhEz95g6oV7Yoo`, 0.05 SOL each, settled in `oo6dw6xPJEBhHoJYuQhe8DGtQppCFetubnq7xdxi2tkC1VbGp12RcD7s2iM4Tupce7QAUnbnZJLFGAyL7nsruSe`: host won on ball 27, fee 0.005 SOL |
| First room after the hall upgrade | room `N46PM` at `8BGWumEDiBe2r5PZ5W4zGMXy5UvyRUmwooXeANSrFhtQ`, 0.02 SOL each, settled in `4B8ba1hQA5RJLb3NqiEcyVqVSopGDnPbVqmETZscxXLtvuwZqLppT1NGRwZ9unk1KEmjzPH6BqcmRzSLrbGxvJaE`: guest won on ball 28 |
| First scripted hall | hall `8MB97` at `Gyn3Fh59vTHftpdLsgYeLmtjarbHvcPTswKsH8bNSWvi`, 0.01 SOL a card, seats with 2, 1 and 3 cards, locked by seat 2, settled in `3YEKMj3cCVn5KASoDe1YBbpkFqXmJpYE7XjutbLgPPHaCFDL6acyMxk9ZvRgDDwYcGcC17iWYkoDhAeU4j2kLiqW`: two winning cards on ball 27, 0.0285 SOL each, fee 0.003 SOL |
| Browser proof | room `MM4RH`, two test wallets through the real lobby, settled in `4GapfY1LxdkNk7f5yFkZbxXnN69xUJPNLkXy8tDnrW7cg5qN57oPAPuvc4UQKHms8CoYBsfb2NPsCHNc3mUmWwrs`: host won on ball 29 |
| Devnet build | https://beach-bingo-eight.vercel.app/app/ |

## Devnet test tokens

The mints the registry takes on devnet: the two official devnet twins, and look-alikes of the
assets that have none, created with `spl-token` with the deployer as mint authority (a test token
is a test token: nothing minted here is worth anything anywhere).

| Asset | Devnet mint | Shape |
|---|---|---|
| USDC (official devnet twin) | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | SPL Token, 6 decimals, Circle's freeze authority; faucet at faucet.circle.com |
| PYUSD (official devnet twin) | `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM` | Token-2022, 6 decimals, Paxos' extension set (permanent delegate, zero-rate transfer fee, empty transfer hook, metadata, confidential transfers, mint close authority); faucet at faucet.paxos.com |
| JUP look-alike | `8r9rjzkMoUEJ4pxy38UvXwokiCjRkq9vWhWyJMMF1UCW` | SPL Token, no freeze authority, deployer as mint authority |
| SKR look-alike | `GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz` | SPL Token, no freeze authority, deployer as mint authority; the registry gives it the SKR tiers and the 2,000 bps shop discount |
| PYUSD look-alike | `8ag6aEwVmBNgvSECWartbSJXSgEtYbhbT87hoUPrBApV` | Token-2022 with PYUSD's extension shape, every authority the deployer's: the mint for freeze, seizure and pause rehearsals without Paxos |
| Mock Seeker Genesis group | `GRhL4t47LyWkVtHJ3ierasdcxyjXmzkE6uMJvv38CsHn` | Token-2022 group; the config's `sgt_group` on devnet (`set-config sgt=GRhL4t47LyWkVtHJ3ierasdcxyjXmzkE6uMJvv38CsHn`) |
| Deployer's member token | `DajAyfr9wkxFgUDNeQ1pQBKBAscqdHRjmNFhh2FKJYTz` | A Token-2022 member of that group, held by the deployer: what `prove_seeker_*` and the Seeker shop discount accept on devnet; `create-devnet-sgt <wallet>` mints one for another tester |

The order of registration on devnet follows the design: USDC-devnet, the SKR look-alike, PYUSD
(the Token-2022 path, the devnet twin and the look-alike), the JUP look-alike. After the upgrade:
`migrate-config`, `set-config sgt=…` (and the SOL pack prices), `register-mint` for each, then the
SOL proofs again (`round`, `hall`, nothing may change) and the token proofs.
