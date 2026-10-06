# beachbingo.xyz

The public site: the Season 3 landing page, the game itself at `/app/`, the `/play` browser rooms and
the beta download gate.
Static files and one serverless function, served by the Vercel project **website**, which also
holds the `beachbingo.xyz` and `www.beachbingo.xyz` domains.

| Path | What it is |
|---|---|
| `public/index.html` | The landing page. Hand-written, in the Fete Labs site's grammar with the Beach Bingo palette. |
| `public/assets/` | What the page loads: fonts, the logo, the sea and shell, the screenshots, the link card. Made by the build. |
| `public/favicon.*`, `apple-touch-icon.png` | The brand kit's web icons. Made by the build. |
| `public/app/` | The Season 3 game (`apps/web`), built for `/app/`. Both Play now buttons open it. Made by `pnpm site:app`. |
| `public/play/index.html` | The browser multiplayer rooms (peer to peer over Nostr relays). Not linked from the landing page. |
| `public/assets/icon-512.png` | The old site's icon address. It holds the new icon now. |
| `api/download.js` | The beta APK gate: `/api/download?code=…` checks the code, `&dl=1` redirects to the APK. Reads `DOWNLOAD_CODE` and `APK_SECRET_NAME` from the project's environment. |
| `api/geo.js` | The region check behind the Coin Shop and the coin tables: `/api/geo` returns the country and region from Vercel's `x-vercel-ip-country*` headers and stores nothing. The game treats anything but a clean answer as unknown and fails open. |
| `vercel.json` | Every unknown path serves the landing page (except `api/`, `assets/`, `app/`, `play` and `BeachBingo-*`), `/app` redirects to `/app/`, the game's hashed files cache for a year, APKs download with no caching, and no page can be framed. |

## Rebuild

After the brand kit changes (`pnpm brand`), refresh everything the page takes from it:

```bash
pnpm --filter @beach-bingo/site build
```

It copies the kit's icons and link card, draws the hero logo, the sea and the shell with the brand's
own drawing code, makes 480 and 720 px WebP copies of the six dApp Store screenshots, subsets the
fonts to Latin WOFF2 (only if `pyftsubset` from fonttools is installed; otherwise it keeps the
committed ones), rewrites the screenshot strip between the `BUILD:screens` markers, and stamps every
asset URL in both pages with a hash of the file (`?v=`), so a changed icon or card gets a new URL.
Commit what it writes.

## The game at /app/

After a change to the game or the engine, rebuild it into the site:

```bash
pnpm site:app
```

It builds `apps/web` (Vite's `base` is `/app/`), checks that the page, the manifest and the service
worker all stay inside `/app/`, and replaces `public/app/` with the result. Commit it. The game's
service worker can only control `/app/`, so it never caches or takes over the landing page or
`/play`. The game keeps its progress, shells and coins in the browser's local storage; there is no
account and no server (the one function it calls, `/api/geo`, keeps nothing).

## Icons and link previews

One list of icon tags, written by the build between `<!-- BUILD:icons -->` markers into both
pages, so the landing page and `/play` cannot drift: `favicon.ico` (16/32/48) and `favicon.svg`,
PNG favicons at 16/32/48 and 192, the 180 px home-screen icon (also at
`apple-touch-icon-precomposed.png`, for clients that ask for that name blind), the Safari pinned
tab, `site.webmanifest` (192, 512, maskable 512) and `browserconfig.xml` with a 150 px Windows
tile. Link previews use `assets/og.png` (1200 x 630) through `og:image` and `twitter:image`, and
the JSON-LD names `assets/icons/icon-512.png` as the logo. `assets/icon-512.png`, the address the
old site used for its icon and link card, now holds the new icon, so an old preview shows it when
it is read again.

## Safe areas

Every page sets `viewport-fit=cover`, so padding against a screen edge adds that edge's
`env(safe-area-inset-*)`. `scripts/safe-areas.mjs` checks it against the iPhone sizes and their
UIKit insets (the iOS Safe Area Guide) and the Android compact, medium and expanded frames,
upright and sideways: no text line and no control may sit in an inset band. `--control` switches
the insets off in the stylesheet and must fail, or the sweep is measuring nothing.

```bash
node scripts/serve.mjs &
CHROME_PATH=<chromium> node scripts/safe-areas.mjs
```

## Deploy

The APK is not in git. Put it in `public/` first, under the name `APK_SECRET_NAME` holds
(today `BeachBingo-v1.5.0-b162.apk`), or the download gate redirects to a missing file. Then:

```bash
cd apps/site
vercel link          # once: the "website" project
vercel deploy        # a preview; check it
vercel deploy --prod
```

`.vercelignore` keeps `package.json` and `scripts/` out of the upload, so Vercel serves the files
as they are and runs no build.

## Credits

Every credit lives behind the **Credits** button in the footer of the landing page and both
notices: the studio and the copyright line, the art licence (the Island Figma kit, CC BY 4.0) and
the fonts (SIL Open Font License). The chrome itself carries only the wordmark. The button opens a
`popover` (no script; Escape, a click outside and its Close button dismiss it, focus returns to the
button); the same markup sits before `</body>` on the three pages, styled in `index.html` and
`assets/legal.css`, so edit all three together. A browser without the Popover API shows the card
inline under the footer instead. The notices still name the operator in their own text, as a
contract and a privacy notice must. `/#credits` opens the card on load; the game's Settings →
Credits & legal links there instead of repeating the art and font credits.

## Rules the page keeps

- Free to play: shells are play money; coins are bought, have no cash value and never leave the game. Never "win cash", "payout" or "real money".
- Ink text on every colour; Cream text only on Ink.
- Every claim on the page is something the app does today; the numbers come from
  `packages/engine` (levels, rooms, boosters, the faucet) and `apps/web` (the room card limits).
