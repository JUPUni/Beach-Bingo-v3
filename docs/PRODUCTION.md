# From devnet to a business: what it takes to run Beach Bingo for real money

Written 2026-09-29 from the repository, docs/ESCROW.md, docs/DAPP_STORE.md and three research
reports of the same day on licensing, the Solana stack and revenue (cited as [L], [S] and [R] with
their own source numbers; the reports' URLs are in the Sources section). **(unverified)** is the
researchers' own flag: not confirmed against a primary source in their window. **(earlier pass)**
marks a figure that survives only in the summaries of a first research pass whose full reports
were lost. Where the reports disagree, both numbers are given. The reports price SOL at about
$100 [S] or $120 [R] and EUR/USD at 1.17 (unverified). Nothing here is legal advice.

## 1. The one-page answer

**What the game can earn.** Bingo is a $390M-a-year, flat, whale-driven mobile genre [R4] and the
Seeker is a real but small pool of about 100,000 active users [R8]. On the revenue report's base
case a monthly active user is worth about $0.60 a month in duel rake (the program's 5% fee), $0.40
in play-money purchases and $0.10 in rewarded video: at 10,000 MAU roughly $72,000, $48,000 and
$12,000 a year; a tenth of that at 1,000 MAU, ten times at 100,000. Low and high cases sit a
factor of ten either side (section 4). The earlier pass had base rake at 10,000 MAU at about
$126,000 a year, a figure the licensing report still quotes.

**What it costs.** The play-money game costs about $500 a month at 1,000 MAU and $3,500 at 10,000,
marketing and part-time support included [R]. A licence adds a fixed block of roughly $8,300 a
month [R]. Curaçao, the only credible first licence for a small crypto-native team, is €4,592 to
apply and €47,450 a year, with a resident director from day one and a local hire by 1 April 2027;
year one all-in is about €95,000–140,000, later years €85,000–110,000 [L]. One-offs: an audit
budgeted at $10,000–15,000 with a re-review [S14]; an RNG laboratory certificate ($5,000–15,000
for the platform, $15,000–25,000 per game, unverified) [L]; identity checks at about $1.60 a
player (earlier pass).

**What is legally required.** A wagered bingo duel is gambling in every jurisdiction that matters,
and a rake does not change it [L1]. Anguilla issues no online licence [L2]. Real money needs a
licence elsewhere; geo-blocking of the United States, the United Kingdom, the Netherlands,
Australia, France and every locally licensed market; geolocation with VPN detection, an age gate
and tiered KYC; wallet screening and Travel Rule data; segregated wallets; responsible-play
controls on a server; a laboratory-certified RNG; an AML programme. Anonymous play is not
licensable anywhere [L].

**The recommended order.** Go live as a play-money game funded by cosmetics, sponsored free-entry
tournaments and grants: cash-positive from about 1,000 MAU with no licence, processor or
payment-policy exception [R]. Harden the escrow and build the server-side gate while usage is
measured. Apply in Curaçao only when the numbers say so; the reports set the trigger differently:
projected rake above about €150,000 a year, about €3M of annual duel volume at 5% [L], or a
10,000-MAU trajectory with 1,000 devnet practice duels a day sustained [R]. On the base case
€150,000 of rake needs about 24,000 MAU; the licensed business breaks even near 10,000 MAU with
both lines, near 28,000 on rake alone, never in the low case [R]. House games for money come
after the licence, fiat on-ramps last.

## 2. Where we are

| Built | State on 2026-09-29 |
|---|---|
| The game | Live at beachbingo.xyz/app/: the adventure, seven Casino Cove house games, four halls with practice bots, Last Castle Standing. Two currencies: SAND is free (faucet, daily tasks, a Seeker perk); coins come from the Coin Shop (the popup exists; a stub sells in local dev and the devnet build only, production shows the packs greyed until the chain purchase lands) behind an 18+ declaration, a header-based region check that blocks Washington, a daily cap and the cool-off. No accounts, cookies or analytics; progress lives in the browser. Privacy and terms pages are live. |
| Provably fair rounds | Commit → HMAC-SHA256 streams → reveal for every mode (docs/FAIRNESS.md). The house games' committed seed lives in the player's browser: fine for play money, not for real money. |
| Live P2P rooms | The four halls with friends over a room code, browser to browser; every client verifies every ball and win. Play money; 85–95% of sales go to players, no rake. |
| Wallet layer | Wallet Standard and Mobile Wallet Adapter; Sign-In-With-Solana; Seeker Genesis Token check. Display only in production. |
| Devnet escrow | `wave_duel`: a trustless Wave Rush escrow in SOL on devnet, 1v1 rooms and halls of two to eight players with up to four cards each (30-ball only), with a 5% fee, vectors, LiteSVM suites, an admin script, two-browser and three-browser proofs and a devnet build, behind two build flags; the lobby stakes rooms and halls (docs/ESCROW.md). Token stakes (USDC, PYUSD, JUP, SKR), a mint registry, a claim path, a host forfeit on hall timeouts, an on-chain Seeker proof and the coin-shop instructions are being built to docs/plans/2026-10-05-tokens-design.md. |
| Economy (decided 2026-10-05) | SAND is the free currency (faucet, tasks, level rewards, the Seeker perk) and every mode plays for it; coins are the paid currency, bought in the Coin Shop with SOL, USDC, PYUSD, JUP or SKR (20% off with SKR, more for a proved Seeker), played at coin tables with coin prizes and spent on boosters; no sell-back, no transfers, no refunds. The shop and coin tables sit behind an 18+ confirmation and a region check that blocks Washington State. A free coin-table game for following @mostlyjola on X (honour system until an X API integration exists). Being built. |
| Android shell and store kit | The web shell builds (unsigned); listing copy and art exist; owner steps in docs/DAPP_STORE.md. |
| Responsible play | Reminder, daily loss limit and cool-off, a daily spend cap on the shop, enforced in the browser only. |

Not built: **a licence, or an entity prepared for one** (the terms name the operator of a
play-money game); **a server** (the only server-side code is one Vercel function gating the beta
APK; the `@beach-bingo/server` script and `VITE_ROOM_SERVER_URL` point at nothing), so no
server-side geo-blocking, age or identity checks, self-exclusion, deposit limits or transaction
monitoring exist anywhere (the coin gate's 18+ declaration, header-based region check and daily
cap live in the browser), and the "compliance gate" that `config.ts` says must pass before stakes open is not
written; **house games for money** (the seed is in the browser, there is no bankroll); **the 75- and
90-ball halls on chain, and a lobby for staked halls** (the hall escrow plays the 30-ball card
only and has no screen yet); **SPL tokens** (SOL only); **payments**; **operations** (no CI,
indexer, monitoring or multisig; the devnet upgrade authority, admin and treasury are one hot key).

## 3. The legal gate

**It is gambling.** US overviews call bingo a quintessential gambling game and UK law lists it as
gaming [L1]. Peer-to-peer play with a rake is still licensed activity: Malta's Type 3 class is
exactly games of chance not played against the house where the operator takes a commission [L].
Bingo cannot be reframed as skill. The sweepstakes model needs no consideration, and a SOL stake
is consideration; it is also collapsing in the US, with statutory bans in California, Connecticut,
Montana, New York, Oklahoma and six more states [L]. Play money has a boundary too: in *Kater v.
Churchill Downs* purchased virtual chips were a "thing of value", settled for $155M [L][R27];
coins must never be purchasable and staked in a chance round. Sponsored-prize tournaments with no
stake are lawful promotions in the UK and the US, with registration and bonding in New York and
Florida above $5,000 in prizes [L].

**Anguilla** has no online gaming licence. The draft Gaming Policy proposes at most two land-based,
members-only casinos with premises-bound licences, a 15% GGR levy and a 15% tax on winnings;
"online lottery" is its only online word [L2]. Consultation was in March 2023 and the plans were
"still under review" in January 2025 [L]; no Gaming Act was found enacted (unverified negative).
An Anguilla company must license abroad, keep the Anguilla entity as a holding company and meet
its AML/CFT rules; most licensors also require a local operating company [L].

| Jurisdiction | Year one regulator fees | Each later year | Time | Notes [L] |
|---|---|---|---|---|
| Curaçao (CGA, LOK) B2C | €4,592 application + €47,450; UBO checks €150 each; €250 a domain; all-in €95,000–140,000 | €47,450 + local key person and office €25,000–40,000 + compliance €10,000–20,000 | 3–5 months | Crypto allowed under the CGA guideline of 24 Jun 2026. Resident director now, local hire by 1 Apr 2027 (earlier pass: substance from 1 Jan 2026). 0% GGR tax. Excludes Curaçao, the Netherlands and every locally licensed market. |
| Isle of Man (OGRA) | £5,250 + £36,750 | £36,750 + 1.5% duty on GGY | 4–6 months | Crypto since 2008; P2P models permitted. The credible step-up. |
| Kahnawake (CPA) | US$35,000 including the first annual fee + US$5,000 per key person | US$20,000 + US$1,000 per key person; rise from 1 Jan 2027 | 8–12 weeks (unverified) | US-facing banned since 30 Sep 2016; hosting at Mohawk Internet Technologies. |
| Tobique | €36,000 | ≈ €19,875 | 4–8 weeks | 22 excluded jurisdictions including the US and the UK (unverified). |
| Malta (MGA) B2C Type 3 | €5,000 + €25,000 + compliance contribution (minimum €25,000, unverified) + €40,000 share capital (unverified) | €25,000 + contribution + key-function holders | 7–12 months | Crypto only through the sandbox (unverified); no EU passport; running costs past €150,000 a year. Overkill. |
| Anjouan | ≈ €17,000 + €1,700 | ≈ €13,300 | 2–4 weeks | The Central Bank of the Comoros calls the issuing bodies fictitious; the stack report's phase-1 budget still lists an Anjouan legal opinion [S]. |

**Markets to block regardless of licence** [L]: the United States (IGBA, UIGEA and state law;
all fifty attorneys general asked the DOJ to act on offshore gaming on 4 Aug 2025, Michigan sent
twelve cease-and-desist letters on 3 Dec 2025, 5Dimes forfeited $46.8M); the United Kingdom; the
Netherlands (licensed operators may not take crypto, so crypto is unlicensed by definition; a
record €24.85M fine in March 2026); Australia; France; Germany, Italy, Spain, Ontario, Sweden,
Denmark and every locally licensed market; Washington for purchased coins. For a wallet-only game
the wallet address becomes the account: IP geolocation with device GPS and VPN detection, a
declared jurisdiction and an age gate, tiered KYC (mandatory at about €2,000–2,500 cumulative
under LOK, unverified), wallet screening and Travel Rule data, segregated wallets.

**Distribution** [L][S]. The dApp Store's publisher policy (updated 21 Jul 2026) never mentions
gambling; regulated financial services must hold and show their documentation, and Solana Mobile
may remove anything it decides may violate applicable law. A licensed, geo-fenced duel is not
banned as such, but a US publisher can delist at will; the store takes 0%. Google Play admits
real-money gambling only with a licence from each listed country, and Curaçao's is not one. Apple
dropped its 2019 ban on HTML5 real-money games in 2024, but guideline 5.3.4 still requires
licensing in every location, geo-restriction and a free app. Net effect: staked play can live only
on the open web as an installable PWA or in the dApp Store; Play and App Store listings are
realistic only for the play-money and free-entry builds. The dApp Store review time is 3–5
business days in docs/DAPP_STORE.md and "unpublished, days to about two weeks" in the stack report.

| Compliance layer | Options and prices | Origin |
|---|---|---|
| Identity and age | Sumsub $1.35–1.85, Veriff $0.80–1.89 per verification | earlier pass |
| Geolocation | MaxMind $0.0001–0.002 per query | earlier pass |
| Sanctions and wallets | Chainalysis sanctions API free; enterprise wallet screening has no published tiers | earlier pass |
| RNG certification | An ISO 17025 laboratory (GLI, iTech Labs, BMM, eCOGRA); Curaçao's phase 2 requires it; BMM has certified Chainlink VRF against GLI-19, so chain randomness can pass. $5,000–15,000 platform, $15,000–25,000 per game, $2,000–5,000 a year (unverified) | [L] |
| Payment rails | Transak prohibits gambling [R15]; MoonPay prohibits illegal gambling [R16]; Stripe restricts games of chance [R17]; Circle Mint bars unlicensed casino use (earlier pass); Coinbase and Sphere not re-verified [R19][R20]; a direct wallet transfer has no intermediary policy | [R] |

Commit–reveal is a transparency mechanism, not a certificate; a laboratory will also flag
last-revealer aborts [L].

## 4. Revenue models with the numbers

The revenue report's formula: monthly revenue = MAU × participation × frequency × price × take,
with DAU/MAU assumed at 22% [R5].

| Line | Low | Base | High | Assumptions [R] |
|---|---|---|---|---|
| Duel rake, 5% (the program's fee; the code caps it at 10%) | $0.06 | $0.60 | $3.00 per MAU per month | stakers 3% / 6% / 10% of MAU; 10 / 20 / 30 duels a month; pots $4 / $10 / $20 |
| Coin packs (play-money purchases) | $0.13 | $0.40 | $1.00 | ARPDAU $0.02 / $0.06 / $0.15 × 22% × 30 days; Playtika's $0.93 is the ceiling [R1]; the SKR discount lowers the take per pack and should lift conversion among Seeker users |
| Rewarded video | $0.04 | $0.10 | $0.30 | 2 / 3 / 4 views per DAU per day × net eCPM $3 / $5 / $11 [R23] |
| House games (this document's assumption; not in the report) | $0.08 | $0.40 | $2.25 | 5% / 10% / 15% of MAU × $50 / $100 / $300 monthly handle × 3% / 4% / 5% edge (the engine's paytables return 96–97%, Shell Spin about 90%) |
| Also | | | | sponsored free-entry tournaments ($500 a month at 10,000 MAU); grants $10,000–30,000 in year one [R11][R12][R14]; B2B licensing of the engine (speculative) |

Annual revenue in US dollars, low / base / high:

| MAU | Duel rake | Play-money purchases | Rewarded video | House games (assumption) |
|---|---|---|---|---|
| 1,000 | $720 / $7,200 / $36,000 | $1,560 / $4,800 / $12,000 | $480 / $1,200 / $3,600 | $960 / $4,800 / $27,000 |
| 10,000 | $7,200 / $72,000 / $360,000 | $15,600 / $48,000 / $120,000 | $4,800 / $12,000 / $36,000 | $9,600 / $48,000 / $270,000 |
| 100,000 | $72,000 / $720,000 / $3,600,000 | $156,000 / $480,000 / $1,200,000 | $48,000 / $120,000 / $360,000 | $96,000 / $480,000 / $2,700,000 |

The report's sanity check on the rake: the base case implies $200 of pots per staker per month,
against about $370 of entries per paying Skillz user [R6]: plausible for a crypto-native audience,
not for the mainstream bingo demographic. Behind it: Bingo Blitz at $158.5M a quarter, flat, with
4.5% of DAU paying daily [R1]; Bingo Bash at $146,000–551,000 a week in the US [R2][R3]; median D30
retention under 1% [R5]; Gamba's on-chain casino protocol at 0.5–1% creator fees with no public
volume [R7]; no Solana P2P duel product with audited volume; 200,000+ Seekers shipped and 700+
dApps [R8][R9] (earlier pass: 150,000+ and 1,561, on other dates and definitions); a
Seeker-exclusive launch reaching 12,800 installs in weeks [R8]; UK remote bingo yield £147.8M [R26].

The research's conservative line was to sell only cosmetics, story passes and convenience, never
coins to keep playing chance rounds [R]. The owner decided otherwise on 2026-10-05: coins are sold
in packs (the social-casino model that Bingo Blitz runs), SAND stays free for everyone, and the
consequences are taken on: purchases are final, coins have no cash value and never leave the game,
the shop and the coin tables are gated to 18+ and closed to Washington State (*Kater v. Churchill
Downs*), the listing, terms and store questionnaire change accordingly (docs/DAPP_STORE.md), and
counsel reviews the other US states with social-casino suits (Idaho, Kentucky, Tennessee, Alabama)
before a mainnet shop. Prices are set per token in the on-chain registry and enforced by the
program; the SKR discount is a price cut, not a payout, so it cannot be farmed.

## 5. The technical roadmap to mainnet

Effort figures are engineering estimates; costs come from the stack report unless stated.

**Phase A: escrow hardening, before any real stake.**

| Item | What it means here | Effort |
|---|---|---|
| Entropy | Two surfaces are weak [S]: a host who is or bribes the join-slot leader (with the seed known, three or four re-rolls turn 50% into about 90%; validators only), and a colluding RPC that holds the guest's signed `join_room` for up to ~150 slots and lands it in a favourable slot, "the real hole". Fix without an oracle: hash a slot `joined_slot + 2..4`, read from SlotHashes in `settle`; the sysvar keeps 512 entries, so settle within about 3.4 minutes or take a no-fee refund. Above about 0.5 SOL mix in a VRF word, request-then-settle, charged to the host at `open_room`: MagicBlock 0.0005 SOL a request [S3], ORAO 0.001 SOL [S4]; Switchboard shut down on 25 Sep 2026 [S2]. Keep the oracle behind an interface. | 1–2 weeks |
| Stake limits | Make `max_stake` configurable and start at 1 SOL rather than the coded 100; add a global exposure ceiling. | days |
| The other halls and a staked-hall lobby | The 30-ball hall escrow exists on devnet; the 75- and 90-ball card builders, pattern masks and staged prizes still have to be ported to Rust with vectors, as `bingo.rs` was for 30-ball, and the live-room lobby has to learn to stake a hall. | 3–6 weeks |
| SPL | A mint on the room, a vault token account owned by the room PDA, `transfer_checked`, ATAs for host, guest and treasury, per-mint bounds and a mint allow-list; Token-2022 extensions rejected unless allow-listed. About 40–60 lines and 30–50 KB more binary (estimate). SOL and USDC first; SKR's token program unverified. | 1–2 weeks |
| Authority | Squads v4 vaults (2-of-3 hardware keys, time-lock) for the upgrade authority and, separately, for `config.admin` so the pause survives immutability; multisig now, VRF and SPL, second audit, then `--final`. | days |
| Audit and fuzzing | Accretion's Simple tier, $7,000–20,000 in about a week [S14]; budget $10,000–15,000 with a re-review, booked 3–6 weeks ahead; other firms from a one-week minimum of $15,000–45,000 (unverified). Trident fuzzing and Sec3 X-Ray first, but they do not reason about entropy. A self-hosted bounty at $500 / $2,500 / $10,000. | external |
| Monitoring and CI | The Rust tests, `cargo build-sbf` and the LiteSVM suite in CI; an indexer over the four events; a crank that fires `claim_timeout` for stuck rooms; alerts on pauses, failed settles, stuck rooms. | 1–2 weeks |
| Client and transport | Persist the host's seed, or hand it to the guest right after the join as the stack report suggests; `accountSubscribe` on the room PDA with polling on mobile; compute limits at measured use plus 20% (settle used 30,900 CU on devnet) and priority fees under about 11,000 lamports a transaction; two self-hosted Nostr relays and TURN ($10–40 a month), since settlement never depends on the P2P channel but liveness does. | 1–2 weeks |

**Phase B: the compliance gate**, server-side, before the flag opens anywhere. A small service
checks geography (IP, device GPS, VPN detection), age and identity through a vendor, sanctions
lists and the player's own limits and self-exclusion, then issues a short-lived signed eligibility
attestation for the wallet, which the program requires on `open_room` and `join_room` (an ed25519
signature checked through the instructions sysvar, or a per-wallet account with an expiry).
Limits, cool-offs and self-exclusion move from browser storage to it. Estimate 4–6 weeks plus
vendor integration; the revenue report budgets $1.60 a check on new stakers.

**Phase C: house games for money.** Move the committed seed out of the browser (an operator-run
service running the unchanged engine, or a VRF for the draws), add a bankroll vault with exposure
limits, obtain certified RTP from a laboratory. 8–12 weeks before certification.

**Phase D: payments and on-ramps.** Gated by the providers on the licence (section 3); with
wagering, deposits come from the player's own wallet. Mobile Wallet Adapter already works in the
devnet build; iOS has no MWA and goes through wallet deep links, so room state must be persisted
before each call [S].

**Phase E: operations.** Helius Developer at $49 a month covers the roughly 2.4 million calls of
10,000 MAU, with Triton pay-as-you-go as failover ($60–90 a month together); Helius Business at
$499 only when sustained sends exceed five a second [S10][S13]. Rent is 5,080 lamports a byte since
11 Sep 2026 (SIMD-0437 step 2 [S6]; the figure reproduces the devnet program-data and room balances
exactly): the program's data account holds about 3.83 SOL today for the 753 KB of space the token
version needs (the program is 711 KB with the Token-2022 crates; it was 303 KB with SOL halls and
1.54 SOL, 215 KB and 1.09 SOL at the 1v1 size the stack report priced) and about 0.52 SOL at the
final 696 lamports a byte, expected around November 2026; a room costs 0.0015 SOL, a token room
its vault's rent on top, fronted by the host and returned at close.
An indexer, a status page, runbooks, key custody.

**Phase F: the dApp Store.** The play-money listing (docs/DAPP_STORE.md) goes first. A licensed
build is a separate listing judged under applicable law; the shell loads only beachbingo.xyz, so
it needs its own URL and flags; Play and the App Store are closed to it.

## 6. Budget and timeline

Monthly running costs from the revenue report (estimates from public price lists):

| | 1,000 MAU | 10,000 MAU | 50,000 MAU |
|---|---|---|---|
| Common: RPC, hosting, monitoring, tooling, company and accounting, support, marketing | ≈ $500 | ≈ $3,500 | ≈ $17,300 |
| Licensed add-on: Curaçao licence ($4,600) and substance ($2,500), audit amortised ($650), VRF for high stakes, KYC and geo-IP, AML and responsible-play tooling | ≈ $8,300 | ≈ $9,100 | ≈ $11,900 |

The stack report's infrastructure line for 10,000 MAU is $100–150 a month; its phases run from
devnet at no cost beyond a $12 VPS, through an audited mainnet beta in 6–10 weeks (audit
$10,000–15,000, about 1.1 SOL to deploy at the size it priced and 3.8 SOL at today's 711 KB, under 0.2 SOL
for Squads and store NFTs, VRF at 0.0005 SOL a room), to scale at 10,000 MAU with a second audit
($10,000–20,000) and a $25,000–50,000 bounty reserve [S].

Year one, two scenarios, before salaries:

| | A: play money, escrow hardened, stakes off | B: licensed P2P duels in Curaçao, at 10,000 MAU |
|---|---|---|
| Running costs | $6,000 (1,000 MAU) to $42,000 (10,000 MAU) [R] | $42,000 common + $109,000 licensed add-on [R]; the licensing report's independent all-in is €95,000–140,000 [L] |
| One-offs | store listing ~0.2 SOL; audit $10,000–15,000, optional until launch | application €4,592; audit $10,000–15,000; RNG laboratory $5,000–15,000 (unverified); terms and rules €2,000–8,000 [L] |
| Engineering | Phases A, E, F: 3–4 months | Phases A–B, E–F: 5–7 months; C after the licence |
| **Cash** | **≈ $10,000–60,000** | **≈ $160,000–200,000** |
| Base-case result | cash-positive from about 1,000 MAU, 7,000 with a $3,000 founder draw [R] | −$5,100 a month on rake alone; break-even near 10,000 MAU with both lines, 28,000 on rake alone, 4,000 in the high case, never in the low case [R] |

Timeline: A fits in a quarter and a half. B is six to twelve months, the licence application
(3–5 months) run in parallel with phases A and B, mainnet deployed with the flag off until the
licence is granted; both reports put licensed duels no earlier than month five or six.

## 7. Risks and the honest recommendation

- **Legal exposure ends the business.** A staked duel reachable from the United States without a
  licence is the pattern the cited prosecutions were built on, and the fiat rails already refuse
  it. Nothing ships for real money before Phase B exists and blocks the section 3 markets.
- **The numbers are estimates.** Several licence figures are unverified; the reports disagree on
  the SOL price, the base rake, the licence trigger, the Seeker counts and Anjouan; the house-game
  row is this document's assumption. Treat section 4 as an order of magnitude.
- **The market is small and the licence block is fixed.** About $8,300 a month has to be earned
  before the first dollar of rake profit; in the low case it never is.
- **Technical residue.** The RPC-hold and leader entropy surfaces, the single hot key, the seed held
  only in the host's tab, a 100 SOL maximum stake, no CI and no monitoring: all fixable, all real
  today. Oracle vendors can vanish at six days' notice, as Switchboard did.
- **Vendors and platforms can say no.** On-ramps refuse unlicensed gambling, the store can remove
  an app at will, Play and Apple are closed to a web real-money build, and selling cosmetics on
  chain changes what the listing and terms currently promise.

**Next 30 days.** Production stays play-money only. Complete the owner steps and submit the
play-money dApp Store listing; submit to CLOCK IN by 8 Oct 2026 [R12]; apply for the $10,000
Builder Grant [R11]. Decide whether to open a cosmetics shop and a sponsored free-entry tournament
and, if so, revise the terms and listing first. On devnet, ship the future-slot entropy fix and a
configurable maximum stake, persist the host's seed, add CI, pin the relays and move the authority
to a multisig. Decide with counsel which entity would hold a licence.

**Before the Coin Shop sells on mainnet.** The popup, the dev stub, the 18+ declaration, the
header-based region check and the daily cap exist in the app today; still missing are the chain
purchase itself (`buy_pack`, in progress), a server-side coin ledger (a purchased balance in the
browser is tamper-evident through the Buyer PDA but not tamper-proof across devices), counsel's
review of the Washington block and of the other states named in
docs/plans/2026-10-05-tokens-design.md §6b, and a way to verify the X follow behind the Free Game
ticket: today the ticket is granted on the player's word, once per device and once per linked
wallet, because checking a follow needs the X API and a server.

**Next 90 days.** The staked-hall lobby, the other halls' Rust port and the SPL design, and the
fuzz suite behind the flag on devnet; scope
and book the audit; prototype the compliance gate against a KYC vendor's sandbox; rewarded video
in the play-money halls if the shop decision is yes; measure MAU and duel participation, and count
devnet practice duels against the 1,000-a-day threshold.

**Next 180 days.** If the threshold and a 10,000-MAU trajectory are met, file in Curaçao,
commission the audit and the laboratory, deploy to mainnet with the flag off, and open staked
duels by geography once the licence is granted. If not, stay play-money, keep the escrow as a
proven devnet capability, and revisit when the numbers change.

## Sources

Licensing report [L] (accessed 2026-09-29): [L1] https://www.lexology.com/library/detail.aspx?g=ae495709-9298-40c6-981f-2821e985a782 ·
https://www.legislation.gov.uk/ukpga/2005/19 · [L2] https://www.gov.ai/document/Gaming%20policy%20draft%20Cons.%20review.pdf ·
https://anguillafocus.com/anguillas-casino-plans-remain-under-consultation-two-years-later/ · http://fsc.org.ai/amlcft.php ·
https://www.mga.org.mt/faqs/what-are-the-different-types-of-games-that-are-licensable-by-the-authority/ ·
https://www.thepointlegal.com/guides/curacao-gaming-licence · https://igamingbusiness.com/legal-compliance/cga-curacao-crypto-gambling-regulations-mid-2027-deadline/ ·
https://gflolaw.com/en/curacao-gambling-license/ · https://www.mygaminglicense.com/blog/curacao-gaming-license-restricted-countries ·
https://www.sanctions.io/blog/curacaos-lok-regime-igaming · https://www.applebyglobal.com/publications/guide-to-gambling-law-in-the-isle-of-man-2026/ ·
https://www.isleofmangsc.com/media/envj2xsk/aml-cft-guidance-for-virtual-assets_goods.pdf · https://gamingcommission.ca/news/ ·
https://www.casino.org/news/kahnawake-pulls-licensees-us-markets/ · https://vantegris.com/blog/tobique-gaming-licence/ ·
https://globallawexperts.com/is-the-tobique-gaming-licence-right-for-your-operation-a-practitioners-assessment/ ·
https://www.softswiss.com/knowledge-base/malta-igaming-license-guide/ · https://www.riotimesonline.com/comoros-anjouan-online-casino-licenses-2026/ ·
https://www.law.cornell.edu/uscode/text/18/1955 · https://www.mass.gov/doc/multistate-doj-offshore-gaming-letter/download ·
https://www.michigan.gov/mgcb/news/2025/12/03/mgcb-issues-12-cease-and-desist-letters ·
https://www.justice.gov/usao-edpa/pr/offshore-internet-sports-betting-company-agrees-forfeit-over-468-million-proceeds ·
https://cdn.ca9.uscourts.gov/datastore/opinions/2018/03/28/16-35010.pdf · https://www.geekwire.com/2020/big-fish-games-pay-155m-tweak-games-part-class-action-settlement-gambling/ ·
https://brightsideofnews.com/gambling/sweepstakes-casino-bans-us-states-2026/ · https://www.nysenate.gov/legislation/laws/GBS/369-E ·
https://kleinmoynihan.com/sweepstakes-registration-and-bonding-requirements-2/ · https://www.legislation.gov.uk/ukpga/2014/17 ·
https://www.gamblingcommission.gov.uk/manual/understanding-the-consumer-landscape-in-free-draws-and-prize-competitions/definitions-understanding-the-consumer-landscape-in-free-draws-and-prize ·
https://casinobeats.com/2026/03/11/dutch-gambling-regulator-issues-record-25m-fine-novatech/ · https://www.acma.gov.au/articles/2026-09/latest-illegal-online-gambling-websites-blocked ·
https://www.crowdfundinsider.com/2026/07/292748-french-regulators-ordered-internet-providers-to-restrict-polymarket-access-before-world-cup-final/ ·
https://legal.solanamobile.com/publisher-policy-web · https://support.google.com/googleplay/android-developer/answer/9877032?hl=en ·
https://www.gummicube.com/blog/google-play-developer-policy-changes-real-money-gambling/ · https://developer.apple.com/app-store/review/guidelines/ ·
https://developer.apple.com/news/?id=06032019j · https://tech-insider.org/igt-provably-fair-vs-ecogra-audited-vs-gli-audited-rng-appr-en-d186/ ·
https://www.intergameonline.com/igaming/bmm-grants-first-blockchain-certification · Kahnawake Gaming Commission, Regulations concerning
Interactive Gaming, amended 14 Jan 2026 (`kgc.txt`) · MGA, Licence Fees and Taxation, Feb 2023 v2 (`mga.txt`).

Stack report [S] (accessed 2026-09-29): [S1] https://docs.anza.xyz/runtime/sysvars · [S2] https://solanacompass.com/news/switchboard-oracle-protocol-shuts-down-giving-solana-defi-six-days-to-migrate ·
[S3] https://docs.magicblock.gg/pages/verifiable-randomness-functions-vrfs/introduction/pricing · [S4] https://github.com/orao-network/solana-vrf/blob/master/README.md ·
[S5] https://www.pyth.network/entropy · [S6] https://solanacompass.com/news/simd-0437-step-2-goes-live-on-solana-mainnet-rent-drops-to-5080-lamports-per-byte ·
[S7] https://github.com/solana-foundation/solana-improvement-documents/pull/437 · [S8] https://solana.com/docs/core/fees/fee-structure ·
[S9] https://docs.chainstack.com/docs/solana-estimate-priority-fees-getrecentprioritizationfees · [S10] https://www.helius.dev/pricing ·
[S11] https://www.quicknode.com/pricing · [S12] https://www.alchemy.com/pricing · [S13] https://triton.one/pricing ·
[S14] https://accretion.xyz/blog/solana-audit-cost · [S15] https://www.zealynx.io/blogs/audit-pricing-2026 · [S16] https://github.com/Ackee-Blockchain/trident ·
[S17] https://sec3.dev/audits · [S18] https://squads.xyz/blog/v4-security-measures · [S19] https://immunefi.com/bug-bounty/immunefi/information/ ·
[S20] https://www.tradingview.com/news/cointelegraph:3361aa554094b:0-solana-mobile-launches-skr-token-airdrop-for-seeker-phone-users/ ·
[S21] https://docs.solanamobile.com/mobile-wallet-adapter/web-apps · [S22] https://github.com/solana-mobile/mobile-wallet-adapter/issues/1484 ·
[S23] https://github.com/anza-xyz/wallet-adapter/pull/673 · [S24] https://phantom.com/learn/blog/the-complete-guide-to-phantom-deeplinks ·
[S25] https://docs.solanamobile.com/dapp-publishing/prepare · [S26] https://docs.solanamobile.com/dapp-publishing/submit ·
[S27] https://docs.solanamobile.com/dapp-publishing/publishing-a-pwa · [S28] https://github.com/dmotz/trystero/blob/main/README.md ·
[S29] https://developers.cloudflare.com/realtime/turn/faq/ · [S30] https://squads.xyz/blog/solana-multisig-program-upgrades-management.

Revenue report [R] (accessed 2026-09-29): [R1] https://investors.playtika.com/news-releases/news-release-details/playtika-holding-corp-reports-q4-and-2025-financial-results/ ·
[R2] https://sensortower.com/blog/2025-q1-unified-top-5-bingo%20games-revenue-us-600abc3e241bc16eb8501706 ·
[R3] https://sensortower.com/blog/2025-q4-android-top-5-bingo-games-revenue-us-600abc3e241bc16eb8501706 ·
[R4] https://gamedevreports.substack.com/p/appmagic-mobile-games-monetization · [R5] https://www.gameanalytics.com/reports/2026-mobile-pc-gaming-benchmarks ·
[R6] https://www.businesswire.com/news/home/20260331578872/en/Skillz-Reports-2025-Fourth-Quarter-and-Full-Year-2025-Results ·
[R7] https://solanacompass.com/projects/gamba · [R8] https://blog.solanamobile.com/post/builder-grants-are-live-the-dapp-store-crosses-700-apps-and-seeker-season-2-keeps-shipping ·
[R9] https://solanamobile.com/blog/sms-goes-global-and-season-2-wrapup · [R10] https://solanamobile.com/blog/your-skr-guide ·
[R11] https://solanamobile.com/grants · https://cryptobriefing.com/solana-mobile-builder-grants-program-launched/ ·
[R12] https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon · [R13] https://docs.solanamobile.com/dapp-publishing/publisher-policy ·
[R14] https://superteam.fun/earn/grants/solana-foundation-usa-grants · https://solana.org/grants-funding · [R15] https://transak.com/acceptable-use-policy ·
[R16] https://www.moonpay.com/legal/terms_of_use_usa · [R17] https://stripe.com/legal/restricted-businesses · https://stripe.com/legal/crypto-onramp ·
[R18] https://igamingpaymentsolutions.com/providers/helio-pay · [R19] https://www.coinbase.com/legal/prohibited_use (403; not re-verified) ·
[R20] https://spherepay.co/terms (not re-verified) · [R21] https://www.helius.dev/pricing · [R22] https://www.thepointlegal.com/guides/curacao-gaming-licence ·
https://henkwolff.com/insights/curacao-gaming-licence-cost/ · [R23] https://www.applixir.com/blog/how-much-do-rewarded-video-ads-pay-web-cpm-revenue/ ·
https://adsense.google.com/start/h5-games-ads/ · [R24] https://www.kraken.com/prices/solana · https://www.coingecko.com/en/coins/seeker ·
[R25] https://fintelegram.com/crypto-casino-buy-crypto-on-ramps-as-de-facto-payment-processors/ ·
[R26] https://www.gamblingcommission.gov.uk/statistics-and-research/publication/industry-statistics · [R27] https://cdn.ca9.uscourts.gov/datastore/opinions/2018/03/28/16-35010.pdf.

Earlier research pass (summaries only; no URLs survived): Sumsub, Veriff, MaxMind and Chainalysis
pricing; Circle Mint's terms; the $126,000 base rake; the 1 Jan 2026 substance date; the Seeker
counts of 150,000+ devices and 1,561 apps.

Repository: docs/ESCROW.md, docs/FAIRNESS.md, docs/GAME_MODES.md, docs/DAPP_STORE.md,
`programs/wave_duel`, `apps/web/src/solana`, `packages/engine/src/modes`.
