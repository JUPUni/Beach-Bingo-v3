# Token stakes, Seeker detection and SKR rewards: design

Status: draft of 2026-10-05, written from the security review of the escrow
(`scratchpad/research/escrow-security-report.md`), the mint accounts read from mainnet and devnet,
the app's existing wallet layer and the two research reports on tokens and on Seeker detection
(sections marked *pending* fill in when those land). Nothing here is legal advice; staked play
stays on devnet behind the build flags (docs/PRODUCTION.md).

## 1. What the owner asked for

1. Stakes in **SOL, USDC, PYUSD, JUP and SKR only**.
2. The app **detects the Seed Vault** (the Seeker's secure key custody, through its wallet) and
   **the Seed Vault token**, read as the Seeker Genesis Token the app already checks for the
   welcome perk.
3. **SKR is the main token**: players get more for using it.
4. **Secure and cannot be gamed.**

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
| SKR | *pending the tokens report* | *pending* | *pending* | The game's main token: lowest fee tier, the play-money boosts. If the mint is Token-2022 its extension set decides the registry flags like PYUSD's. No devnet mint expected: a look-alike with the same program, decimals and extensions. |

Presets per asset (base units; final numbers in the tokens report): SOL as today (0.01–0.25),
USDC and PYUSD 1 / 5 / 10 / 25 / 50, JUP and SKR sized to a similar value at registration time and
adjustable with `set_mint`.

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

What the app can know, strongest first (details *pending the Seeker report*):

| Signal | How | Can it be faked? | What it unlocks |
|---|---|---|---|
| Seeker Genesis Token on the connected wallet | Token-2022 account whose mint's metadata pointer and group member both point at the SGT group (already implemented in `seeker.ts`) | Only by controlling a Seeker owner's wallet; soulbound, one per device | Seeker perks and the Seeker fee tier, after a Sign-In-With-Solana proof of wallet control |
| Seed Vault wallet | The Mobile Wallet Adapter wallet's identity as exposed in the authorize result and the Wallet Standard object; the Android shell's own check, passed to the page in the user agent beside the existing "Solana Mobile Web Shell" marker | A modified client can claim it; treat as a display signal | "Seed Vault wallet ✓" badge, MWA-first wallet list |
| Android shell / Seeker device | User-agent marker, device model | Trivially | Layout and copy only |
| SKR balance | Token account balance for the SKR mint | No (it is a balance) but it is borrowable, so never a gate for anything of value | "SKR ready" badge, the SKR preset preselected |

The badges live in the wallet popup and in the stake panel. Nothing of value is granted on a
signal alone: perks that cost the house anything require the SGT check plus a signed-in wallet,
and are deduplicated on the SGT mint, which is unique per device.

## 6. Rewards that cannot be farmed

The invariant from the security review: **for every settled round, everything the house gives
back is worth less than the fee it collected on that round, and rewards are funded only from
collected fees.** Then every wash trade costs more than it earns and farming loses money at any
scale.

- **Fee tiers** (on chain): SKR cheapest. A discount cannot be farmed.
- **Play-money boosts** (in the app): coins and task progress for a settled SKR round, with a
  daily cap per wallet, none on cancels or timeouts, and the SGT bonus deduplicated per device.
  Coins are not purchasable and never become a stake, so even an unlimited farm buys nothing.
- **No token emissions.** If the owner later wants SKR rebates, they come from a separate
  distributor funded only by the treasury's SKR fees, published per epoch with total ≤ fees.
- **Eligibility is on-chain fact**, not a client claim: the settlement event names the mint, the
  distinct wallets and the settle slot; the app grants boosts from events it read itself.
- **Hosts cannot re-roll** (hall forfeit) and **nobody can make a round un-settleable** (claim path).

## 7. Devnet plan

1. Register USDC-devnet and PYUSD-devnet; create JUP and SKR look-alikes with the deployer as
   authority, matching program, decimals and extensions; a faucet command mints test amounts.
2. Redeploy the program (the data account likely needs `solana program extend`), initialise the
   registry, re-run the SOL proofs (nothing may change) and the new token proofs by script, then
   the browser e2e with a token stake.
3. The devnet build gets the token picker, the badges and the SKR boosts; production stays
   play money with none of this code loaded.

## 8. Tests

- Program: the 7 native vector tests unchanged; LiteSVM: the 11 SOL tests unchanged; token rooms
  and halls against the engine replay to the base unit; registry refusals; frozen recipient →
  credit → claim → close; permanent-delegate seizure → pro-rata; config change after open → no
  effect; disabled mint; pauser; hall forfeit; compute measured for the 8×4 token hall.
- App: machine tests for token stakes and SKR boosts with caps; detection ladder unit tests with
  mocked wallets; e2e on devnet with a token stake.

## 9. Out of scope here

Mainnet, the licence gate, the audit and the multisig (docs/PRODUCTION.md); the 75- and 90-ball
halls on chain; token rebates paid by the house.
