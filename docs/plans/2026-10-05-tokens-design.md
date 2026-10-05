# Token stakes, Seeker detection and SKR rewards: design

Status: 2026-10-05, written from the security review of the escrow, the mint accounts read from
mainnet and devnet, the app's existing wallet layer and the research reports on the five tokens and
on Seeker detection (all in the session's research folder; the facts that matter are repeated here). Nothing here is legal advice; staked play
stays on devnet behind the build flags (docs/PRODUCTION.md).

## 1. What the owner asked for

1. Stakes in **SOL, USDC, PYUSD, JUP and SKR only**.
2. The app **detects the Seed Vault** (the Seeker's secure key custody, through its wallet) and
   **the Seed Vault token**, read as the Seeker Genesis Token the app already checks for the
   welcome perk.
3. **SKR is the main token**: players get more for using it.
4. **Secure and cannot be gamed.**
5. (Added 2026-10-05.) The app ships as an **APK on the Solana dApp Store**; gameplay stays
   **easy**; **coins stay the in-game currency**, players can **buy coin packs** of several sizes
   with the supported tokens, and **SKR gets a discount** on coin packs.

## 2. Assumptions (say so if either is wrong)

- "More rewards for SKR" means a **lower house fee** on SKR stakes and **play-money boosts**
  (coins, boosters, cosmetics, task progress) for SKR rounds and Seeker owners. The house does not
  pay out SKR or any token as a reward. A token paid by the house is what two wallets owned by one
  person farm by playing each other; a fee discount cannot be farmed (it only lowers a cost) and
  play money has no cash value and never becomes a stake.
- "The Seed Vault token" is the **Seeker Genesis Token** (SGT): one soulbound Token-2022 token
  per Seeker, verifiable on chain. The app also reports the **Seed Vault wallet** itself when it can
  tell (section 5).

## 3. The five assets

| Asset | Mint (mainnet) | Program | Decimals | Facts that shape the design |
|---|---|---|---|---|
| SOL | native | system | 9 | Stays as today: lamports held in the escrow account, no vault. |
| USDC | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` | SPL Token | 6 | Freeze authority present: a frozen player account must not block a settlement (claim path). Devnet twin `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle faucet). |
| PYUSD | `2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo` | Token-2022 | 6 | Extensions read on chain: permanent delegate (the issuer can move funds out of any account, the vault included), transfer-fee config at 0 bps / max 0 (allowed while zero; re-checked at every transfer), transfer hook with no program set (allowed while none; re-checked), confidential transfers, metadata, mint close authority. Devnet twin `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM`, same extensions. |
| JUP | `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN` | SPL Token | 6 | No authorities at all. No devnet mint: a look-alike is created on devnet by the admin script. |
| SKR | `SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3` | SPL Token | 6 | The game's main token: lowest fee tier, the play-money boosts. Classic SPL mint, no freeze authority, an active mint authority (staking inflation), launched 21 Jan 2026 with the Seeker airdrop; staking lives in program `SKRskrmtL83pcL4YqLWt6iPefDqwXQWHSw9S9vz94BZ` (a wallet's stake is readable from its `UserStake` PDA). No devnet mint: a look-alike with the same shape, created by the admin script. |

Presets per asset: SOL as today (0.01–0.25); USDC and PYUSD 1 / 5 / 10 / 25 (base units ×10⁶,
minimum 1, maximum 100); JUP and SKR in whole tokens sized at registration to the same dollar
range and adjusted with `set_mint` as prices move. Order of shipping on devnet: USDC (official
devnet mint and faucet), SKR look-alike, PYUSD (the Token-2022 path), JUP look-alike.

## 4. The program

The escrow keeps the proven SOL paths byte for byte and gains token paths beside them. The
changes, in the order they ship:

1. **Snapshot per round.** `fee_bps`, `treasury`, `mint` and `token_program` are copied into the
   Room or Hall when it opens; settlement and timeouts read the copy. An admin change can never
   move money in a round that is already open.
2. **Mint registry.** One `MintEntry` PDA per allowed mint: token program, decimals, min and max
   stake, fee tier, enabled flag, the extension flags read from the mint at registration, and the
   treasury's token account for that mint. Registration refuses what an escrow cannot hold safely:
   non-transferable mints, mints whose new accounts start frozen, a transfer fee above zero, an
   active transfer hook. Allow-listed is not trusted: every transfer re-reads the mint and fails
   cleanly if a fee or a hook appeared since, or if the mint is paused.
3. **Vaults.** A token room or hall holds its stakes in the associated token account of its own
   PDA; the host pays its rent and gets it back when it closes. Deposits and payouts are
   `transfer_checked` under the mint's own token program, the PDA signing for payouts; the mint,
   the vault and every player account are constrained to the snapshot's mint and the right owner.
4. **The claim path.** A settlement never fails because of one recipient. Accounts that cannot be
   paid (frozen, closed, memo-required) are credited inside the Room or Hall; everyone else is
   paid; the creditor claims later with a fresh account; the last claim closes the vault. If the
   vault holds less than the pot (a permanent delegate moved funds), payouts scale pro rata.
5. **Hall timeout forfeit.** A host that goes quiet after the lock loses its own deposit to the
   guests (pro rata to their cards); today the hall refunds everyone, which gives the host a free
   re-roll of any round it dislikes. Rooms already forfeit the host.
6. **Roles.** `paused` and a disabled mint stop opens, joins and locks and never a settlement,
   timeout, cancel or claim. A separate `pauser` key can only pause; unpausing and every other
   change stay with the admin, which moves to a multisig before mainnet.
7. **Arithmetic.** Overflow is an error, not a panic; per-mint maximums keep `max_stake × 32`
   inside a u64 at 6 and 9 decimals; fee and share rounding stays floor-with-dust-to-treasury.

Fee tiers at launch on devnet: SOL, USDC, PYUSD, JUP 500 bps; SKR 250 bps; a Seeker-verified SKR
round 200 bps once the eligibility proof in section 6 exists on chain. All tiers are registry values.

## 5. Detecting the Seeker, the Seed Vault and SKR

Two facts from the research decide the shape. First, Mobile Wallet Adapter never tells a web app
which wallet answered: the authorize result carries account labels, icons and a cached wallet URI,
not the wallet's name or package, so the Seed Vault Wallet and Phantom or Solflare running on top of
the Seed Vault look the same from the page. Second, the Seeker Genesis Token is the device
identity Solana Mobile documents for exactly this purpose: one per Seeker, minted into the Seed
Vault Wallet, movable only between the owner's own Seed Vault accounts, with a mint address that
never changes. So the app detects the Seed Vault through its token, and treats everything else as
a hint. Strongest first:

| Rank | Signal | How | Shown as | May unlock |
|---|---|---|---|---|
| 1 | Seeker Genesis Token proved **on chain** | The player passes the SGT token account and mint to the program, which checks owner, balance and the mint's metadata-pointer and group-member extensions against the configured group | "Seeker verified" | The Seeker fee tier on SKR rounds; no server, no database, nothing to spoof |
| 2 | Seeker Genesis Token seen by the app after Sign-In-With-Solana | `seeker.ts` as today (Token-2022 accounts, both extensions point at `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`), after a signed-in wallet | "Seeker verified" | Play-money perks, deduplicated on the SGT mint per device (as today) |
| 3 | SKR balance and stake | The SKR token account; the `UserStake` PDA of the staking program | "SKR ready", "SKR staker" | The SKR preset preselected; play-money multipliers re-read at grant time; never a gate for value (balances are borrowable) |
| 4 | Shell and device | The "Solana Mobile Web Shell" user-agent marker the shell already sets, plus a `SeedVault/1 Model/<model>` marker the shell adds after `SeedVault.isAvailable`, plus the client-hints model | "dApp Store app", "Seed Vault device" | Layout, wallet order, copy; nothing of value |
| 5 | Wallet hints | The MWA account label or icon, if the Seed Vault Wallet labels its accounts recognisably | "Seed Vault wallet" (only if the label says so) | Cosmetic |

Perks of real value beyond a fee tier (a Seeker leaderboard with prizes, token grants) would need
the official recipe in full: a server-issued Sign-In-With-Solana nonce, server-side verification
and a unique index on the SGT mint. The game has no server today; that stays a listed step in
docs/PRODUCTION.md and is not needed for anything in this design.

## 6. Rewards that cannot be farmed

The invariant from the security review: **for every settled round, everything the house gives
back is worth less than the fee it collected on that round, and rewards are funded only from
collected fees.** Then every wash trade costs more than it earns and farming loses money at any
scale.

- **Fee tiers** (on chain): SKR cheapest; the Seeker tier on SKR rounds when the opener proved
  the Seeker Genesis Token to the program. A discount cannot be farmed.
- **Play-money boosts** (in the app): coins and task progress for a settled SKR round, with a
  daily cap per wallet, none on cancels or timeouts, and the SGT bonus deduplicated per device.
  Coins are not purchasable and never become a stake, so even an unlimited farm buys nothing.
- **No token emissions.** If the owner later wants SKR rebates, they come from a separate
  distributor funded only by the treasury's SKR fees, published per epoch with total ≤ fees.
- **Eligibility is on-chain fact**, not a client claim: the settlement event names the mint, the
  distinct wallets and the settle slot; the app grants boosts from events it read itself.
- **Hosts cannot re-roll** (hall forfeit) and **nobody can make a round un-settleable** (claim path).

## 6b. Coin packs

Coins remain what every mode plays for. The shop sells packs of coins for the five tokens; the
faucet, the daily tasks and the Seeker perk keep giving coins for free, so the game stays free to
play and a purchase is a convenience, never a requirement.

**On chain.** The pack catalogue and the prices live beside the mint registry so that the price a
player pays is enforced by the program, not by the client: `Config.pack_coins[4]` (coins per
pack), per mint `pack_prices[4]` in base units and `discount_bps` (SKR 2,000 = 20 % off, the
others 0), plus `seeker_discount_bps` on top for a buyer who proves the Seeker Genesis Token.
`buy_pack(pack)` pays the discounted price to the treasury (a token transfer to the registered
treasury account, or a system transfer for SOL), creates or updates a `Buyer` PDA per wallet
(`coins_total`, `purchases`, `last_slot`) and emits `CoinsBought`. The PDA is the tamper-evident
record: the app credits coins from the confirmed transaction, and a "restore purchases" on a new
device credits the difference between the PDA's `coins_total` and what this device already
credited. No sell-back, no refund, no transfer of coins between players, no path from coins to
tokens: a pack is a one-way purchase, and `paused` stops the shop like everything else.

**In the app.** A Coin Shop popup from the coins counter: four packs, the token picker limited to
the five assets, SKR preselected when the wallet holds SKR, the SKR saving shown on every price
("Pay with SKR: save 20 %"), one tap to pay through the connected wallet, the coins arriving with
the usual reward animation. Prices per token are admin values updated as markets move; the client
only displays what the registry says. Purchase limits join the responsible-play popup (a daily
spend cap the player can lower, never raise, for 24 hours) and purchases are blocked while a
cool-off is active.

**What this changes legally (the owner decides).** Today's copy promises that coins are never
bought or sold. Purchased coins that are then wagered in chance rounds (the halls, Casino Cove) are
the social-casino model: lawful in most places with no cash-out and no transfers, which is what
Bingo Blitz and its peers do, but Washington State treats purchased chips as a thing of value
(*Kater v. Churchill Downs*, the $155M Big Fish settlement), and several US states have seen class
actions on the same theory. Before the shop opens on mainnet: block purchases for Washington (and
review Idaho, Kentucky, Tennessee, Alabama with counsel), an 18+ gate on the shop, terms and
listing text rewritten (coins have no cash value, are non-refundable and non-transferable), and the
dApp Store questionnaire updated for in-app purchases. On devnet the shop works with test tokens
and none of this applies yet. If the owner prefers to avoid the question entirely, sell cosmetics
and boosters instead of coins: the same shop, a different catalogue.

**Not gameable.** Buying coins cannot be farmed (you pay, you get coins); the discount lowers a
price and pays nothing out; the Seeker discount needs the on-chain token proof; and because coins
never leave the game or become a stake, a tampered local balance costs the house nothing and buys
its owner nothing outside the game.

## 7. Devnet plan

1. Register USDC-devnet and PYUSD-devnet; create JUP and SKR look-alikes with the deployer as
   authority, matching program, decimals and extensions; a faucet command mints test amounts. The
   Seeker Genesis Token exists only on mainnet, so the program's SGT group is a config value: on
   devnet the admin script creates a mock Token-2022 group and mints one member token per tester.
2. Redeploy the program (the data account likely needs `solana program extend`), initialise the
   registry, re-run the SOL proofs (nothing may change) and the new token proofs by script, then
   the browser e2e with a token stake.
3. The devnet build gets the token picker, the badges, the SKR boosts and the coin shop;
   production stays play money with none of this code loaded until the owner's go.

## 7b. Devnet test tokens (created 2026-10-05, deployer `5VcGxKLHDJhPAFSN8VK9qpxkM4gniQtPKwRrMnUcqA8u` as authority)

| Token | Devnet mint | Shape |
|---|---|---|
| USDC | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` | Circle's devnet USDC (SPL Token, 6 decimals, freeze authority); faucet.circle.com |
| PYUSD | `CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM` | Paxos's devnet PYUSD (Token-2022, the mainnet extension set) |
| JUP look-alike | `8r9rjzkMoUEJ4pxy38UvXwokiCjRkq9vWhWyJMMF1UCW` | SPL Token, 6 decimals, no freeze authority, deployer mints test balances (1,000,000 minted) |
| SKR look-alike | `GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz` | SPL Token, 6 decimals, no freeze authority, deployer mints test balances (1,000,000 minted) |
| PYUSD look-alike | `8ag6aEwVmBNgvSECWartbSJXSgEtYbhbT87hoUPrBApV` | Token-2022 with PYUSD's shape: permanent delegate (deployer), transfer-fee config at 0, transfer hook with no program, metadata, mint close authority; 6 decimals; deployer mints test balances (1,000,000 minted). Lets the Token-2022 path be proved without the Paxos faucet; the real devnet PYUSD stays registered too. |
| Mock Seeker Genesis group | `GRhL4t47LyWkVtHJ3ierasdcxyjXmzkE6uMJvv38CsHn` | Token-2022 group mint with metadata ("Mock Seeker Genesis Token", MSGT), max 100,000 members |
| Mock SGT member (deployer) | `DajAyfr9wkxFgUDNeQ1pQBKBAscqdHRjmNFhh2FKJYTz` | Token-2022 member: metadata pointer and group member both point at the mock group; one token, mint authority revoked |

A tester gets a mock SGT with the admin script's `create-devnet-sgt <wallet>` (or the three
`spl-token` commands it wraps); the program's `sgt_group` on devnet is the mock group above.

## 8. Tests

- Program: the 7 native vector tests unchanged; LiteSVM: the 11 SOL tests unchanged; token rooms
  and halls against the engine replay to the base unit; registry refusals; frozen recipient →
  credit → claim → close; permanent-delegate seizure → pro-rata; config change after open → no
  effect; disabled mint; pauser; hall forfeit; compute measured for the 8×4 token hall.
- App: machine tests for token stakes and SKR boosts with caps; detection ladder unit tests with
  mocked wallets; e2e on devnet with a token stake.

## 9. Out of scope here

Mainnet, the licence gate, the audit and the multisig (docs/PRODUCTION.md); the 75- and 90-ball
halls on chain; token rebates paid by the house; a server-side coin ledger (the step that would make
purchased balances tamper-proof across devices; listed in docs/PRODUCTION.md).
