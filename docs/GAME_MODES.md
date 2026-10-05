# Game modes

## SAND and coins

Every mode plays on one of two currencies, picked with the switch in the top bar (and on the
Casino Cove and Beach Rooms lists, where a game is chosen):

- **SAND** is free play money. The tide (500 every four hours), the daily tasks, the adventure's
  level rewards, the treasure chest and the Seeker perk all pay SAND, and it is never bought or
  sold. Everyone starts on the SAND table with 1,000; a save from before the two currencies keeps
  its old coins as SAND.
- **Coins** come only from the Coin Shop (packs of 5,000 / 15,000 / 40,000 / 100,000, paid in SOL,
  USDC, PYUSD, JUP or SKR; SKR 20% off, a verified Seeker a little more) and from promo grants such
  as the Free Game ticket. They have no cash value, cannot be sold, transferred or refunded, and
  never leave the game. Boosters in the level popup and an extra Big Wave are bought with coins;
  earned boosters still come from tasks, chests and the perk.

Prices and prizes below are **per table currency**: a 25 card costs 25 SAND on the SAND table and
25 coins on the coins table, and its prize pays in the same. The rules never change with the table,
and no round ever asks for a purchase. Every charge and every prize goes through the store's
`charge` and `credit`, which read the active table (a round keeps the table it was bought on).

**The gate.** Coin tables and the shop open after a one-time declaration (18 or older, and not a
resident of Washington State; kept on the device with its date) and a region check: the game asks
`/api/geo` once when it loads, a Vercel function that returns the country and region Vercel
attaches to the request and keeps nothing. A `US-WA` answer closes the shop and the coin tables
with one line and leaves SAND play open; any other answer, and a missing one (local dev, the devnet
build, a failed call), **fails open** and the declaration stands on its own. SAND play never asks
for any of this.

**The Free Game ticket.** Following @mostlyjola on X (Tasks → Rewards) grants one ticket, once per
device and once more per linked wallet; the follow itself cannot be verified without the X API and
a server, so the claim is on the player's word. A ticket pays one coin-table entry at the mode's
base price (one card in a hall, the 10 minimum stake in a casino game, the Last Castle buy-in);
the buy control says "Free game" on that item and the prize is paid in coins as usual.

The exact return-to-player figures are computed from the engine's tables by `pnpm rtp`
(`packages/engine/scripts/rtp-report.ts`) and shown in the game on each mode card; this document
describes the rules. Mode definitions live in `packages/engine/src/modes/`, the catalogue the game
reads in `catalog.ts`.

## Beach Adventure (`adventure`)

Forty levels across four islands (Palm Cove, Coral Reef, Shipwreck Bay, Volcano Isle), ten each.
Each level sets a card count, a pattern and a ball budget; finishing in fewer balls earns up to
three stars, and three stars on a level earns a golden key (three keys open the treasure chest).
Four boosters: Seagull daubs every call, Crab pinches any square, Big Wave adds five balls, Golden
Sun doubles the level's SAND. Free to play; nothing is staked. Level rewards are SAND; an extra
booster costs coins.

## Casino Cove (house games, one player against the island bank)

| Mode | Rules |
|---|---|
| **Tide Pool** (`tidePool`) | Pick a sea (calm, choppy, storm) and a stake; a fixed number of balls splash onto one card; completed lines pay from the sea's paytable, up to 10,000×. |
| **Crab Dig** (`crabDig`) | A card with hidden crabs. Dig squares one at a time; each safe square raises the multiplier; bank at any time, or lose the stake to a crab. |
| **Beach Ball Blitz** (`blitz`) | 30-ball speed limbo: call how many balls it takes to fill your card (12–29); the fewer you call, the higher the multiplier, from 1.38× at 29 to 63,081× at 12 (97% ÷ the exact chance, no cap). |
| **Shell Spin** (`shellSpin`) | Slots meet bingo: spin the reels, daub the matching numbers on the card, chase twelve slingos; extra spins can be bought at a fair price. |
| **Riptide** (`riptide`) | A stream of hits, each pumping the multiplier; bank before the shark bites. Three levels of risk; auto-bank after a chosen number of hits. |
| **Tiki Video Bingo** (`videoBingo`) | Four cards, thirty balls, thirteen patterns; then extra balls for the big one, priced at their fair value. |
| **Keno Cove** (`keno`) | Pick up to ten shells, ten are drawn; low, medium or high risk paytables. |

Every house round is provably fair (docs/FAIRNESS.md): commitment first, HMAC-SHA256 streams,
verification in Settings → Provably fair.

## Beach Rooms (bingo halls)

Four halls share one engine (`modes/room.ts`): a prize pool from card sales, stages with a share
of the pool each, a drum shuffled from the committed seed, auto-daub except in the duel.

| Hall | Cards | Stages | Pool |
|---|---|---|---|
| **Sunset Hall** (`sunsetHall`) | 75-ball, up to 4 shown (engine max 6) at 25 a card | Line 20% → Two Lines 30% → Blackout 50%; practice rooms add a progressive jackpot for a blackout within 48 balls | 85% of sales |
| **Pier Hall** (`pierHall`) | 90-ball, up to 3 shown (engine max 6) at 25 a card | One Line 15% → Two Lines 25% → Full House 60% | 85% of sales |
| **Wave Rush** (`waveRush`) | 30-ball, up to 4 at 10 a card | Full House 100% | 88% of sales |
| **Riptide Duel** (`riptideDuel`) | 75-ball, one card each at 50, two players | Any Line 100%; no auto-daub: tap your numbers and shout BINGO. A false shout locks you out for three balls | 95% of the pot |

Each hall opens as a **practice room**: labelled bots (🤖) buy cards, the round starts on a short
timer, and the jackpot pool (one per table) grows from a 2% contribution. Bots only ever appear in
practice rooms; they are never allowed in a room with anything at stake (`allowBots`).

**Play with friends** turns the same hall into a **live room**: the host opens a room, shares a
five-letter code or the invite link `beachbingo.xyz/app/#join=CODE`, friends buy cards in the
host's currency (the host's table when the room opened travels as `currency` in the `room`
message; a guest in a coin room passes the gate first), and the host starts the round. There is no server: players find each other through
public Nostr relays and play browser to browser over WebRTC. The host commits to the seed before
anyone buys a card, the roster's hash is the client seed, and every client rebuilds the same round
and verifies every win (docs/FAIRNESS.md, "Live rooms"). Live rooms take no rake beyond the hall's
pool share and pay no progressive jackpot; prize money nobody won is returned in proportion to
cards bought. A player who joins during a round watches it and buys in for the next one.

**Last Castle Standing** (`lastCastle`) is a separate engine (`modes/royale.ts`): everyone gets one
card, balls arrive in waves of five, and after each wave the half with the fewest squares marked is
washed away until one castle stands. The winner takes 40% of the pool; places 2–8 are paid. It is
practice-only for now.

## Responsible play

Settings → Responsible play offers a play-time reminder (every 30, 60 or 90 minutes), a daily
loss limit applied per table across wager modes, a daily cap on the coins the shop may sell (a
lower cap applies at once, a higher one after 24 hours), and a cool-off that locks wager modes and
the Coin Shop for a chosen time. SAND is free and refills from the tide (500 every four hours) and
the daily tasks, so no limit on the SAND table ever costs a player anything of value. Coin tables
and the shop are for players aged 18 and over (the gate above).
