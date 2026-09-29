# Beach Bingo — QA report (play-money game, release check)

Branch `worktree-agent-a3eac51dc8b098043`, cut from `claude/epic-allen-4sznsv` at 42fc7fc. The game was
built with `pnpm --filter @beach-bingo/web build`, served from `apps/web/dist` under `/app/` and driven
with playwright-core and Chromium 1194 at **390×844 (mobile, touch)** and **1280×800**. Long ball timers
ran on Playwright's fake clock (`page.clock`), so 75-ball halls and 57-ball levels finish in seconds;
Casino Cove rounds and the live rooms ran in real time. Live rooms used `scripts/nostr-relay.mjs` on
localhost through the `beach-bingo:relays` key, exactly as `scripts/live-room-e2e.mjs` does.

## How to rerun

```sh
pnpm install                                     # once
pnpm -r test && pnpm -r typecheck && pnpm -r lint
pnpm rtp                                         # every mode's return to player next to its mode card; exits 1 on a mismatch
pnpm --filter @beach-bingo/web build
cd apps/web
node scripts/qa/play.mjs                         # the whole walkthrough at both viewports (~12 min)
QA_SUITES=casino,rooms QA_VIEWPORTS=phone node scripts/qa/play.mjs      # a subset: shell,popups,adventure,casino,rooms,limits × phone,laptop
node scripts/qa/live.mjs                         # host (laptop) + guest (phone) + late joiner through a Wave Rush round over the local relay
CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome node scripts/live-room-e2e.mjs   # the existing e2e: Wave Rush by code, Duel by link with a shout
```

`scripts/qa/lib.mjs` holds the static server, the seeded browser contexts (page errors, console errors
and failed requests are collected per player), the fake clock and the **fit audit**: every control in
the top popup layer (or on the screen when no popup is open) must lie inside the window and be the
element at its own centre after its list is scrolled; leaf text must neither overflow its box nor be
ellipsised; nothing may stick out of the stage; no sideways page scroll. Screenshots (one per screen and
viewport) and `results.json` land in `scripts/qa/out/` (git-ignored). `CHROMIUM_PATH` overrides the
browser; the default is the sandbox's Chromium 1194.

## What was tested

Every row ran at both viewports unless noted. "ok" means the flow completed, the coins added up and the
fit audit found nothing; "after fix n" means the row failed on 42fc7fc and passes after that fix.

| Screen / flow | Checks | 390×844 | 1280×800 |
|---|---|---|---|
| Splash | Play sign, legal line, fit | ok | ok |
| Service worker | registers with scope `/app/`, `registration.update()` works, the game opens offline after one visit | ok | ok |
| Home | Level 1, 1,000 coins, 0/3 keys, fit | ok | ok |
| Settings popup | reduce motion (class on `.app` + computed animation duration), sound/music stored, Escape closes, fit | ok | ok |
| Wallet popup, no wallet installed | opens, "No wallet found", no errors, fit | ok | ok |
| Provably fair popup | 64-hex commitment, nonce 0, rotate & reveal, revealed seed hashes to the retired commitment, fit | after fix 1 | after fix 1 |
| Profile popup | rename + avatar saved, shown in the top bar, survive a reload, fit | ok | ok |
| Tasks popup | world progress, four tasks, nothing claimable at start; later "Play 3 different games" claimable once (+250), fit | ok | ok |
| Chest popup | 0/3 keys keeps Open disabled, fit | ok | ok |
| Coins / faucet popup | +500 once, 4 h countdown, second tap does nothing, countdown survives a reload, fit | ok | ok |
| Responsible play popup | today's net result, reminder choice stored, fit | ok | ok |
| Credits popup | play-money text, privacy and terms links, fit | ok | ok |
| Adventure map | Palm Cove page, 19 locked tiles, locked-tile toast; page 2 with level 21 current for a seeded player, fit | ok | ok |
| Level popup | owned booster arms, fit | ok | ok |
| Level 1 win, Seagull | 57 balls, seagull consumed, coins + reward × stars, key on 3★, BINGO task, fit | ok | ok |
| Level 1 win, manual daubs, Replay ×2 | daubs count for the task; each Replay starts a fresh 57-ball run | after fix 2 | after fix 2 |
| Level 1 lose | Out of Balls after the 4 s grace, owned Big Wave (+5 balls), bought Big Wave (−100), level 2 unlocked, stars survive a reload, fit | ok | ok |
| Level 14, four cards, Seagull | 39 balls, four cards laid out, coins + 85 × stars, Next level opens 15, fit | ok | ok |
| Level 21, four cards, manual + Crab Pinch + Golden Sun | reward doubled, pinch consumed; lose path to Out of Balls | ok | ok |
| Casino Cove list | seven cards each with an RTP, fit | ok | ok |
| Tide Pool | 2 cards × 25, 35 balls, a result per card, coins = before − 50 + payout, fair chip shows the nonce, fit | after fix 4 | after fix 4 |
| Crab Dig | start, dig, bank or pinched, Bank label = coins paid, ledger, fit | after fixes 3, 4 | after fixes 3, 4 |
| Beach Ball Blitz | slider moves the payout text, a round, ledger, fit | after fix 4 | after fix 4 |
| Shell Spin | 11 spins with wilds placed via "Best spot", collect, ledger, fit | after fix 4 | after fix 4 |
| Riptide | stake raised to 100, choppy, bank after the first hit, Bank label = coins paid, ledger, fit | after fixes 3, 4 | after fixes 3, 4 |
| Tiki Video Bingo | 1 card × 10, an extra ball costs its listed price, collect, ledger, fit | after fixes 4, 8 | after fixes 4, 8 |
| Keno Cove | quick pick, paytable, ten drawn, ledger, fit | after fix 4 | after fix 4 |
| After the seven games | nonce advanced, spins/modes task progress, "modes" task claimed once, log lines, coins/nonce/tasks survive a reload | ok | ok |
| Beach Rooms list | five halls, join box drops look-alike characters, fit | ok | ok |
| Sunset Hall, practice with bots | buy, 8 s countdown, three stages, jackpot stat, results popup, ledger, Play again opens a fresh lobby, fit | after fixes 2, 5 | after fixes 2, 5 |
| Pier Hall, 90-ball | three tickets with 12 blanks each, three stages, results, ledger, fit | after fix 5 | after fix 5 |
| Wave Rush, 30-ball | three 3×3 cards, full house, results, ledger, fit | after fix 5 | after fix 5 |
| Last Castle Standing | 32 castles, waves, champion after 25 balls, places paid, Again starts a new game, fit | after fix 6 | after fix 6 |
| Riptide Duel | false call → "Locked for 3 balls", locked shout refused, manual daubs count as daubs, real BINGO accepted, 95 of the 100 pot paid, fit | after fix 5 | after fix 5 |
| Provably-fair log | practice rooms (with nonce) and live rooms (with seed and roster hash) listed | ok | ok |
| Cool-off (24 h) | blocks a Tide Pool bet and Sunset Hall cards without taking coins; the adventure stays open | ok | ok |
| Daily loss limit | a −1,000 day is shown with the 1,000 chip selected; a Keno bet is refused | ok | ok |
| Live Wave Rush: host on the laptop, guest on the phone, a late joiner | code, same commitment, cards paid at once, 26-coin pool preview on both, countdown, spectator mid-round, same result and ball count on every screen, ledgers (a same-ball tie splits the pool), round 2 with a new commitment, lobby cards refunded on leaving, "Room closed", the room logged once, no errors | ok | ok |
| `scripts/live-room-e2e.mjs` | Wave Rush by code, Duel by invite link with the guest's shout | 24/24 | — |

Final tally on the fixed build: `play.mjs` 171 checks on the phone and 178 on the laptop, all passing
(the last full runs were 169/171 and 177/178; the three misses were harness locators — the map page for a
restarted level 14, and a strict toast locator meeting two identical toasts — and pass on the rerun of
those suites); `live.mjs` 38/38; `live-room-e2e.mjs` 24/24. Every player context in every run recorded
**no page errors, no console errors and no failed requests**. Unit tests: engine 48/48, web 27 passed +
5 skipped (the on-chain vectors need a validator); `pnpm -r typecheck` and `pnpm -r lint` are clean.
`pnpm rtp`: every house game returns 91–97% (Tide Pool 96.95–97.10%, Crab Dig 96.25–97.00% below the
cap, Blitz 96.55–97.00%, Shell Spin 91% ±1.8 by Monte Carlo against "≈90%" on the card, Riptide
96.38–96.71%, Video Bingo 92.29%, Keno 95.71–96.00%) and every mode card matches the engine.

## Defects found

| # | Severity | Defect | Fix |
|---|---|---|---|
| 1 | high (trust) | **The provably-fair check could not fail.** After "Rotate & reveal" the popup hashed the revealed seed and compared it with that same hash; the commitment the player had been shown was never kept. | 00728c4 — the retired commitment is stored and printed; the seed is verified against it ("not recorded" for older saves). Test in `apps/web/src/state/store.test.ts`. |
| 2 | high | **"Replay" and "Play again" did nothing.** AdventureGame and RoomGame were keyed on the level / hall, so navigating to the screen already shown re-rendered the finished one with its results popup: Replay worked once (the booster flags in the key changed), then never; a practice hall's Play again never. | 7dcc9c7 — the store counts navigations (`visit`) and both screens carry it in their key. Test in `store.test.ts`. |
| 3 | medium (money) | **Bank button off by one coin.** `Math.floor(stake × multiplier)` vs the engine's integer `applyMultiplier`: 100 × 1.13 = 112.999… shows "Bank 112" and pays 113 (Riptide choppy, first hit; Crab Dig likewise for 1.14, 1.15, 0.29, 0.57…). | 0463b98 — both buttons use `applyMultiplier`; the harness compares the button with the amount in the log. |
| 4 | high (layout) | **The casino bet picker rendered as a tall navy panel in all seven house games.** rooms.css (loaded by the mode list, so present in every game) styles the staked-room escrow panel as `.stake`, the kit's StakePicker class: − / value / + stacked vertically, full width, pushing the Play button down the footer. Regressed by 42fc7fc. | 2937a52 — the picker is `.stake-picker`; the staked-room styles are untouched. |
| 5 | low (cosmetic) | Room header cut on every viewport: "Sunset Hall · 75…", "Riptide Duel · 1v…". | dcdf85c — the header shows the catalogue name ("Sunset Hall"); the lobby and the share text keep the long one. |
| 6 | low (cosmetic) | "Last Castle Standing" cut in the header on every viewport. | 119713a — titles over 15 characters render at 1.65rem. |
| 7 | medium (copy) | Blitz card and GAME_MODES.md promised "from 2× to 6,000×"; the slider (targets 12–29) pays 1.38× to 63,081×. | 097912f — the tagline is derived from the engine's table; the docs say the same. |
| 8 | low (cosmetic) | Tiki Video Bingo paytable names unreadable: three columns left about six characters ("Surfb…", "Tiki…"). | 2937a52 — two columns. |
| 9 | medium (tooling) | `pnpm rtp` failed with ERR_MODULE_NOT_FOUND: `packages/engine/scripts/rtp-report.ts`, named by package.json and GAME_MODES.md, did not exist. | e963117 — the report (exact where the maths allows, Monte Carlo for Shell Spin) with a card-vs-engine check that exits 1; it is what caught #7. |

## Left as is (noted, not changed)

- **Blitz has no max-win cap** (63,081× at target 12, on up to 1,000 coins) while every other house
  game caps at 1,000–10,000×. A cap would drop the fastest targets far below the 97% the card states, so
  it is a design decision; the copy now tells the truth about what is paid.
- **Leaving a round forfeits it.** Back out of Tiki Video Bingo with an extra-ball offer open, or out of
  Shell Spin mid-game, and the winnings the cards already earned are gone; Riptide and Crab Dig lose the
  stake at risk; a practice hall left mid-draw is never settled. It is consistent across the app (live
  rooms refund lobby cards only), so it is treated as the design — but an auto-collect on leaving Video
  Bingo / Shell Spin would be kinder to a player whose phone rings.
- **Duel closing window:** for the 0.9 s between the opponent's confirmed bingo and the results popup the
  BINGO button is still shown, and a shout toasts "False call!" (the engine answers `closed`).
- **Shell Spin's card says "≈90% base"**; 200k-round Monte Carlo gives 91% ±1.8 (the 1,500× top prize makes
  it noisy). Within tolerance, unchanged.
- The wallet popup says "Network: mainnet" in the play-money build; `apps/web/src/solana/` was out of scope.
- The play-time reminder checks `minutes % reminder === 0` from a 60 s interval, so it can skip or repeat a
  minute. Cosmetic.
- Keno's footer falls back to "RTP 96%" (`|| 96`) with no picks. Cosmetic.
- Practice rooms log a Provably-fair round the moment they open (nonce used, summary "…" if you leave
  without buying). Harmless.

## Harness notes

- The fit audit ignores disabled controls (a settled card's cells), dismisses the transient win banner the
  way a player does (a tap), and waits out the 0.35 s pop-in before measuring; a forced click during that
  animation lands beside its target, which was the cause of every early "timeout" — in the harness, not
  in the game.
- A perfect dauber still loses a few percent of levels 1 and 14, so `winLevel` restarts a lost level from
  the map (up to three attempts): the win-path checks are about the game, not the dice.
- `innerText` applies `text-transform`, so labels such as "Castles left" arrive upper-cased, and
  `locator.waitFor` is strict, so a toast that may repeat is awaited with `.first()`.
