# beachbingo.xyz

The public site: the Season 3 landing page, the `/play` browser rooms and the beta download gate.
Static files and one serverless function, served by the Vercel project **website**, which also
holds the `beachbingo.xyz` and `www.beachbingo.xyz` domains.

| Path | What it is |
|---|---|
| `public/index.html` | The landing page. Hand-written, in the Fete Labs site's grammar with the Beach Bingo palette. |
| `public/assets/` | What the page loads: fonts, the logo, the sea and shell, the screenshots, the link card. Made by the build. |
| `public/favicon.*`, `apple-touch-icon.png` | The brand kit's web icons. Made by the build. |
| `public/play/index.html` | The browser multiplayer rooms (peer to peer over Nostr relays). Not linked from the landing page. |
| `public/assets/icon-512.png` | The old site's icon address. It holds the new icon now. |
| `api/download.js` | The beta APK gate: `/api/download?code=…` checks the code, `&dl=1` redirects to the APK. Reads `DOWNLOAD_CODE` and `APK_SECRET_NAME` from the project's environment. |
| `vercel.json` | Every unknown path serves the landing page (except `api/`, `assets/`, `play` and `BeachBingo-*`), APKs download with no caching, and no page can be framed. |

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

## Rules the page keeps

- Free to play: coins are play money. Never "win cash", "payout" or "real money".
- Ink text on every colour; Cream text only on Ink.
- Every claim on the page is something the app does today; the numbers come from
  `packages/engine` (levels, rooms, boosters, the faucet) and `apps/web` (the room card limits).
