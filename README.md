# Beach Bingo

Provably fair island bingo, free to play. Live at **[beachbingo.xyz/app/](https://beachbingo.xyz/app/)**;
the Android app for Solana Seeker phones is on its way to the Solana dApp Store.

Two currencies, one switch. **Shells** are the free one: play money from the tide, the daily tasks,
the adventure and the Seeker perk, never bought or sold, no cash value. **Coins** are bought in the
Coin Shop (packs paid in SOL, USDC, PYUSD, JUP or SKR; 18+, not offered in Washington State); they
have no cash value, cannot be sold, transferred or refunded, and never leave the game. Every mode
plays on either table at the same prices and prizes; the switch in the top bar picks which.

## What is in the box

| Path | What it is |
|---|---|
| `packages/engine` | The game engine, pure TypeScript with no DOM: the provably fair RNG (HMAC-SHA256 commit–reveal), cards and patterns for 75-, 90- and 30-ball bingo, every mode's rules and paytables, the bingo-hall state machine, the battle royale. Tested with vitest; `pnpm rtp` prints every mode's return to player. |
| `apps/web` | The game: Vite + React 19, installable as a PWA, served at `/app/`. The 40-level adventure, Casino Cove, the Beach Rooms (practice with bots, or live with friends over WebRTC), the wallet layer (Wallet Standard + Mobile Wallet Adapter), the Coin Shop popup (built against `src/shop/shop.ts`; a stub answers in local dev and the devnet build, a production build shows the packs greyed until the chain shop registers itself), the 18+ gate and the region check behind the coin tables, and, behind a build flag, the staked Wave Rush rooms of the devnet build. |
| `programs/wave_duel` | The Solana escrow (Anchor): a trustless 1v1 Wave Rush room or a hall of two to eight players stake SOL, the host's committed seed and the chain's entropy decide the round, and the program replays it with the engine's own RNG and pays the winners. Devnet only. |
| `apps/site` | beachbingo.xyz: the landing page, the privacy notice and terms, the older `/play` browser rooms, the beta download gate, the `/api/geo` region check, and the built game under `public/app/`. Static plus two functions, deployed to Vercel. |
| `android` | The Solana Mobile web shell around `beachbingo.xyz/app/`, for the dApp Store. |
| `packages/brand` | The brand kit: logo, palette, icons, store art and screenshots, drawn by code. |
| `docs` | [FAIRNESS.md](docs/FAIRNESS.md) (the RNG and the live-room protocol), [GAME_MODES.md](docs/GAME_MODES.md) (every mode's rules), [DAPP_STORE.md](docs/DAPP_STORE.md) (publishing the Android app), [ESCROW.md](docs/ESCROW.md) (the staked rooms and the program), [PRODUCTION.md](docs/PRODUCTION.md) (what running the game for real money would take: licences, stack, revenue), and the plans under `docs/plans/`. |

## Working on it

Node 22 and pnpm 10 (`corepack enable`).

```bash
pnpm install
pnpm dev                 # the game at http://localhost:5173/app/
pnpm test                # engine + web unit tests
pnpm typecheck && pnpm lint
pnpm rtp                 # return-to-player report for every mode
```

Ship the game into the site and check it before deploying:

```bash
pnpm site:app            # builds apps/web into apps/site/public/app/
node apps/site/scripts/serve.mjs   # the site as Vercel serves it, on http://127.0.0.1:8787
```

Live rooms end to end, with two headless browsers and a Nostr relay on localhost:

```bash
pnpm --filter @beach-bingo/web build
node apps/web/scripts/live-room-e2e.mjs
```

QA sweeps live in `apps/web/scripts/qa/`: `safe-areas-game.mjs` walks every screen through 14
iPhone and Android frames with the notch and home indicator emulated and fails on anything inside
an inset band (the site has the same sweep in `apps/site/scripts/safe-areas.mjs`).

## Staked rooms on devnet

The devnet build at **[beach-bingo-eight.vercel.app/app/](https://beach-bingo-eight.vercel.app/app/)**
is the same game with two flags on (`VITE_ENABLE_ONCHAIN_STAKES`, `VITE_WAVE_DUEL_PROGRAM`): a
Wave Rush live room or hall can be opened as an escrow staked in SOL or in a token of the
program's registry (the SKR, JUP and PYUSD look-alikes the admin script created, Circle's devnet
USDC, Paxos's devnet PYUSD; `show-mints` lists them), everyone stakes the same, and the program
`6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH` pays the winners from the revealed seed. The Coin
Shop in that build sells its packs through the same program (`buy_pack`, `buy_pack_token`) for SOL
or any of those tokens, SKR 20% off, once a wallet is connected. To try it, switch a wallet
(Phantom, Solflare, or the Seeker's) to devnet, fund it with SOL from a devnet faucet and with test
tokens from the admin script's `faucet`, open Rooms → Wave Rush → Play with friends, connect the
wallet, pick the token and open the escrow; a friend joins by the invite link, deposits, and the
host starts when the chain says every deposit is in. Coins never move in a staked room; a token
payout the program could not deliver waits as a credit the panel offers to claim.

The Seeker Genesis Token exists only on mainnet, so devnet uses a **mock group**: the admin
script's `create-devnet-sgt <wallet>` mints one member token to a wallet, the program's
`sgt_group` and the build's `VITE_SGT_GROUP` both name that group (mainnet's is the default), and
a wallet holding one shows "Seeker verified", can prove it to the program from the stake panel
("Verify Seeker", the Seeker fee tier for that round) and pays the Seeker saving in the shop.
Badges describe; the program checks the token itself every time.

```bash
cd programs/wave_duel && cargo test --release && cargo build-sbf   # the program and its engine vectors
pnpm --filter @beach-bingo/web test                                  # includes the LiteSVM suites when the .so exists
ADMIN="pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs"
$ADMIN round 0.02                                                    # a scripted SOL room on devnet
$ADMIN hall 0.01 2 1 3                                               # a scripted SOL hall
$ADMIN show-mints                                                    # the registry: mints, bounds, fees, pack prices
$ADMIN token-round GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz 50    # a room staked in the SKR look-alike, checked to the base unit
$ADMIN token-hall GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz 50 2 1 3   # a token hall, a guest locks, settle_hall_token
$ADMIN prove-seeker [mint]                                           # the key pair's mock SGT lowers an open room's fee
$ADMIN shop-buy sol 0 --seeker                                       # buy_pack with the Seeker discount; `shop-buy <mint> 0` for buy_pack_token
$ADMIN faucet <mint> <wallet> 100                                    # test tokens for a wallet
node apps/web/scripts/stake-e2e.mjs                                  # two browsers play a staked SOL room on devnet
node apps/web/scripts/stake-hall-e2e.mjs                             # three browsers play a staked SOL hall (2/1/3 cards)
node apps/web/scripts/stake-token-e2e.mjs                            # two browsers play a room staked in SKR through the real lobby
node apps/web/scripts/shop-e2e.mjs                                   # a browser buys the smallest pack with SKR; a fresh context restores it
```

The scripts need a funded devnet key pair at `.secrets/devnet-deployer.json` (never committed; a
git worktree finds the main checkout's). The browser runs build the game into
`apps/web/dist-devnet` with the devnet flags and the program config's SGT group.
[docs/ESCROW.md](docs/ESCROW.md) explains the protocol, the trust model and the addresses;
[docs/PRODUCTION.md](docs/PRODUCTION.md) explains why it stays on devnet and what would have to be
true before it did not.

## How the pieces fit

- **One engine, everywhere.** The web app never decides an outcome itself: it calls engine
  functions on a mutable model and re-renders. A server-authoritative deployment would run the
  same code with the seed on the server.
- **Fairness first.** Every random decision is a domain-separated HMAC-SHA256 stream from a
  committed seed. The game shows the commitment before the round and lets the player reveal and
  recompute afterwards. Live rooms extend this to friends without a server: the host commits, the
  roster hashes into the client seed, every browser rebuilds the same round.
- **Shells are free, coins are bought, nothing is cashed out.** Wager modes take shells or coins,
  whichever table is on, through one pair of store actions (`charge`, `credit`). Coins come only
  from the Coin Shop and promo grants, have no cash value and never leave the game; the shop and
  the coin tables open after a one-time 18+ declaration and a header-based region check
  (`apps/site/api/geo.js`) that blocks Washington State and otherwise fails open. In production
  nothing on chain moves beyond a coin-pack purchase; the wallet layer reads an address and looks up
  the Seeker Genesis Token for a welcome perk. The devnet build is the one exception, built with the
  flags above and never at beachbingo.xyz.

See [apps/site/README.md](apps/site/README.md) for the site and its deploy, and
[android/README.md](android/README.md) for the shell.
