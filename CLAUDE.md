# Beach Bingo — working context

Session memory. The container a Claude session runs in is ephemeral; this file is not. Read it
first, then `docs/MAINNET.md` (the launch runbook) and `docs/DAPP_STORE.md` (the store steps).

## The goal (owner, 2026-10-06)

Ship a production game: **Solana dApp Store first**, also played at beachbingo.xyz. Everything on:
the chain Coin Shop **and staked rooms** (the owner chose real-money stakes knowingly; the risk is
in docs/PRODUCTION.md). Regulation: only the bare minimum to get on and stay on the dApp Store —
the 18+ declaration, the Washington block (`/api/geo`), the cool-off, the terms and privacy pages.
Publisher: a **Delaware LLC** (documents to follow; approved on the dApp Store).

## Decided

- **Admin = jola.skr** `Dox9t9toz7BwwHJaqqsTpt9J74DWkXidP921FJQgWGE5`; **pauser = solsurfers.skr**
  `ErPdwCQZAujo8TM6PZVvZkd1gdoxwDXnk3GFhAkBVbbD` (looked up on the ANS, checked in reverse).
  Recorded in `apps/web/scripts/mainnet/registry.json` (`roles`); `setup.mjs apply` sets that
  pauser on mainnet, `handover` refuses any other admin without `--other-admin`.
- **Admin panel is in the game** (`apps/web/src/admin/`): wallet popup → Admin, for those two
  wallets only. Pause (both), resume and reprice from Jupiter (admin only). Verified by
  `apps/web/scripts/qa/admin-e2e.mjs` against devnet.
- Stakes go through `requestStake` / `stakeAllowed` (18+, Washington, cool-off); settle, claim,
  cancel and refund are never gated.

## Waiting on the owner (asked by email 2026-10-06, thread "Beach Bingo: what's outstanding to ship")

1. **Treasury address** (receives pack payments and fees).
2. The LLC's **legal name and support email** (terms and privacy pages name no entity yet).
3. The **`.secrets` folder** (program key pair `wave_duel-keypair.json`, deployer) from the devnet
   work, or "new address". It is NOT in this checkout; without it the program id changes.
4. **~9 SOL** for the mainnet deploy.
5. A **paid RPC URL**. Never by email; keys and RPC URLs go into a session or a terminal.

Then, in order: deploy and `setup.mjs apply` → test-buy a pack → `handover` to jola.skr → build
the site with `VITE_WAVE_DUEL_PROGRAM=6fvQ… VITE_ENABLE_ONCHAIN_STAKES=true VITE_SOLANA_RPC_URL=…
pnpm site:app` → redeploy beachbingo.xyz → owner runs `android/release.sh --new-key` and submits.

## How beachbingo.xyz deploys (it does NOT deploy from git)

Vercel project **"website"** (`prj_gEg6YP4IzikSRfSAKyGxG1TyKsn8`, team
`team_b3eA7HexzUXOLsyjVMwipE2I`). A deployment is five files: `fetch-site.mjs` (downloads one
commit of `JUPUni/Beach-Bingo-v3` from codeload and checks `apps/site/public/` against a SHA-256 of
the sorted `"<sha256>  <path>\n"` lines, path relative to public/), `vercel.json`
(buildCommand `node fetch-site.mjs`, outputDirectory `public`), `api/download.js`, `api/geo.js`
and the beta APK, the last three by sha1 and size. To ship a new commit: push it, compute the
digest, `create_deployment` with `target: production` (`request_promote` answers 422). Prove it
by grepping the live page for a string the commit added.

## Branch and builds

- Work branch `claude/practical-cray-imztyh`, not merged to `main`; the live site is pinned to a
  commit on it, so merging is not needed for a deploy.
- `apps/site/public/app/` is the committed game bundle (`pnpm site:app`). Production today is
  built **without** program flags: the shop shows "opens soon" and stake/admin UI is hidden.
- Checks: `pnpm typecheck`, `pnpm lint`, `pnpm test`.
- Android SDK for `release.sh` must be installed per session (not kept).
