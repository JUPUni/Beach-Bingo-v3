# Mainnet launch: the Coin Shop

What goes live on mainnet is the **chain Coin Shop**: coin packs paid in SOL, USDC, PYUSD, JUP or
SKR through the `wave_duel` program, SKR 20% cheaper, a Seeker Genesis Token proved on chain 5%
cheaper again. **Staked rooms stay off** on mainnet (wagered bingo is regulated gambling;
docs/PRODUCTION.md). Shells stay free, coins stay in the game, the 18+ gate and the Washington
block stay in front of the shop. This file is the runbook: what is ready, what only the owner can
supply, and the exact steps in order.

## Ready today

| Piece | State |
|---|---|
| Program | `programs/wave_duel`, one key pair for every cluster (`.secrets/wave_duel-keypair.json`), so the id is `6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH` on devnet and on mainnet. Built with `cargo build-sbf` (platform-tools v1.57): 715,776 bytes, sha256 `e592b9b590ea5fe5a75db4e2ca900067bb135c82086098e84cb0957063370091`. 27 LiteSVM tests across `apps/web/src/solana/*.test.ts`. |
| Admin model | `init_config` makes the signer admin and pauser and takes the treasury; `set_config` moves treasury, pauser, fee, pause, SGT group, pack sizes and SOL prices; `transfer_admin` hands the admin role to any address (a multisig vault included); `pause` is open to the pauser; per mint `set_mint` changes prices, tiers and `enabled`. Rounds and purchases snapshot what they need, so a config change never reaches money already in flight. |
| Client | Knows the program through `VITE_WAVE_DUEL_PROGRAM`; knowing it opens the chain shop (`CHAIN_SHOP_ENABLED`) and nothing else. Staked rooms need `VITE_ENABLE_ONCHAIN_STAKES=true` as well, which the mainnet build does not set. The RPC comes from `VITE_SOLANA_RPC_URL`; the Seeker group defaults to the mainnet group `GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te`. Pack prices, discounts and the mint list are read from the chain each session, so repricing needs no release. |
| Operator tooling | `apps/web/scripts/wave-duel-admin.mjs` (`RPC_URL`, `KEYPAIR`, `WAVE_DUEL_PROGRAM`) for every instruction, explorer links following the cluster; `apps/web/scripts/mainnet/setup.mjs` with `plan`, `apply`, `reprice` and `handover`, driven by `apps/web/scripts/mainnet/registry.json`. |
| Site and legal | Terms (Coins and shells, purchases final, 18+, not in Washington State, play limits), privacy notice, the age gate and `/api/geo`, spend caps and cool-off, the "opens soon" state until the program is on mainnet. |

## What only the owner supplies

1. **Funding.** The mainnet deployer created in this checkout is `Bt6c83p9KGKUwPWExmMUFgHrnDBXq4XyhSx55XsMtYMR` (`.secrets/mainnet-deployer.json`, never committed). Send it **8 SOL**: about 3.9 SOL stays as the program account's rent (760,000 bytes of space, recoverable only by closing the program), the buffer's rent comes back once the deploy lands, and the configuration transactions cost well under 0.1 SOL. Alternatively run the deploy steps below from a machine holding your own keys and skip this address entirely.
2. **Addresses.** `TREASURY`: receives every pack payment and every fee (a Squads vault is the right home; a plain wallet works). `ADMIN`: may change prices, pause, register mints and upgrade the program after the handover. The admin script signs with a key pair file, so for day-to-day operation `ADMIN` is best a dedicated CLI key pair kept offline; a Squads vault can hold the role, but then every change is a vault transaction built from the instruction data (not wired into the script yet). `PAUSER` (optional): a hot key that may only pause.
3. **RPC.** A provider URL (Helius, Triton, QuickNode) for `VITE_SOLANA_RPC_URL` and for the operator scripts. The public `api.mainnet-beta.solana.com` endpoint works for a soft launch and rate-limits under load.
4. **Later, for the dApp Store build:** the release keystore (`android/README.md`) and the publisher wallet; the web shell loads the live site, so the shop reaches it without a rebuild.

## Steps, in order

All commands run at the repo root with the Solana CLI on the path
(`export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"`) and
`ADMIN="pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/wave-duel-admin.mjs"`,
`SETUP="pnpm --filter @beach-bingo/engine exec tsx ../../apps/web/scripts/mainnet/setup.mjs"`.
Export once: `RPC_URL=<provider url> KEYPAIR=.secrets/mainnet-deployer.json WAVE_DUEL_PROGRAM=6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH TREASURY=<address> PAUSER=<address or empty>`.

1. **Preflight.** `$SETUP plan` prints the deployer's balance, whether the program and the config exist, the treasury token accounts that would be created, and the pack prices computed from `registry.json` (SOL, JUP and SKR from their USD prices; `--live` refreshes them from Jupiter's price API). Nothing is sent.
2. **Deploy the program** (about 3.9 SOL of rent stays):
   ```bash
   solana program deploy programs/wave_duel/target/deploy/wave_duel.so \
     --program-id .secrets/wave_duel-keypair.json \
     --upgrade-authority .secrets/mainnet-deployer.json \
     -k .secrets/mainnet-deployer.json -u mainnet-beta --max-len 760000
   solana program show 6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH -u mainnet-beta
   ```
   The build is deterministic for the same toolchain: `sha256sum` of the `.so` must match the table above before deploying.
3. **Configure.** `$SETUP apply` runs, idempotently and in this order: `init-config` (fee 500 bps, `TREASURY`); `set-config` (SGT group, pack sizes 5,000 / 15,000 / 40,000 / 100,000, Seeker discount 500 bps, SOL pack prices, SOL Seeker fee 400 bps, `PAUSER`); `register-mint` for USDC, PYUSD, JUP and SKR (creating the treasury's token account for each; USDC and PYUSD at fee 500 / Seeker 400, JUP the same, SKR at 250 / 200 with the 2,000 bps shop discount). It prints the config and the four entries at the end. A step that already matches the chain is skipped.
4. **Prove one purchase.** From any funded wallet's key pair: `KEYPAIR=<test key> $ADMIN shop-buy EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v 0` buys the 4.99 USDC pack and prints the Buyer PDA, the event and the treasury credit. (Or wait for step 6 and buy through the site.)
5. **Hand over.** `$SETUP handover <ADMIN> --confirm <ADMIN>` runs `transfer-admin`, then moves the upgrade authority:
   ```bash
   solana program set-upgrade-authority 6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH \
     --new-upgrade-authority <ADMIN> --skip-new-upgrade-authority-signer-check \
     -k .secrets/mainnet-deployer.json -u mainnet-beta
   ```
   After this the deployer key holds nothing but leftover SOL; sweep it to your wallet.
6. **Switch the site on.** Build the game with the program and the RPC, commit the bundle and deploy production:
   ```bash
   VITE_WAVE_DUEL_PROGRAM=6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH VITE_SOLANA_RPC_URL=<provider url> pnpm site:app
   ```
   Then: open the Coin Shop with a wallet connected, see the five tokens and live prices, buy a pack, watch the treasury receive it, reload and see the coins kept, and run "Restore purchases" in a fresh browser to see the same total credited once.
7. **Reprice when markets move.** `$SETUP reprice --live` rewrites the SOL, JUP and SKR prices from Jupiter's quotes (the stablecoins stay at the USD list), or edit `registry.json` and run `$SETUP reprice`. The app reads prices from the chain, so no release is needed.

## Operations

- **Pause the shop:** `$ADMIN set-config paused=true` (or `pause` from the pauser key). `paused` blocks new purchases and new rounds; claims and refunds keep working. `set-mint <mint> enabled=false` retires one token.
- **Watch:** the treasury's balances; `show-mints`; the `CoinsBought` events; the deployer and admin balances; the RPC provider's error rate.
- **Rollback:** pause, then rebuild the site without `VITE_WAVE_DUEL_PROGRAM` and deploy: the shop returns to "opens soon" and nothing else changes.

## Residual risks, stated plainly

- **The coin ledger lives in the player's browser.** Coins cannot be cashed out, so the house never loses money to an edited balance, but a player who edits storage can play coin rooms against people who paid. A server-side ledger (accounts) is the fix and a product decision; until then coin rooms are play among friends.
- **One admin key.** Until the handover lands on a multisig with a time-lock (Squads v4), a stolen admin key could reprice the shop or pause it; it could not take funds already paid (they go straight to the treasury) and could not change rounds in flight.
- **Upgrade authority.** Same: move it to the multisig, publish a verifiable build (`solana-verify`) and consider freezing the program once the shop has run for a while.
- **Prices.** Volatile tokens are priced in USD terms at the moment of repricing; a 10% move between repricings is a 10% discount or premium. Reprice on a schedule.
- **Law.** The social-casino model (no cash-out, 18+, Washington blocked) is the position taken in docs/PRODUCTION.md; it is not a licence, and counsel has not reviewed other states.

## Costs

| Item | SOL |
|---|---|
| Program account rent, 760,000 bytes (stays; recoverable by closing the program) | 3.86 |
| Buffer during deploy (returned when the deploy lands) | 3.6 |
| Config, four mint entries, four treasury token accounts, transactions | < 0.1 |
| Each pack purchase (payer's fee) | 0.000005 to 0.00001 |
