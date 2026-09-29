# Beach Bingo brand

The Beach Bingo logo, drawn in code, and the generator for everything made from it: the brand kit,
the web app's icons and link card, the Android launcher icon and the Solana dApp Store listing art.

Open [`index.html`](index.html) for the guidelines and every file (serve this folder, for example
`python3 -m http.server` here, then visit `/index.html`). The kit is in [`kit/`](kit/) and zipped
as [`beach-bingo-brand-kit.zip`](beach-bingo-brand-kit.zip).

## The idea

The original Beach Bingo icon, kept and redrawn in the Fete Labs brand language:

| From the original icon | In the Fete Labs language |
|---|---|
| Teal rounded-square app tile | Fete Labs Teal `#1FB5A8`, the Fete Labs app-icon corner (46 of 200) |
| Chunky BEACH over BiNGO, navy outline, 3D letters | Bungee (the Fete Labs sign face), one Ink outline round everything, a hard Ink block shadow, no gradients |
| Coral BEACH, cream BiNGO | Soca Pink BEACH, Cream BiNGO: Fete Labs' alternating two-line headline |
| Bingo ball with a 1 dotting the i | Kept: Gold ball, Cream face, Ink 1. Fete Labs' one Gold spark |
| Palm behind the B | Lime fronds, Coconut trunk and coconuts |
| Water band with a shell | The sea: Surf over Deep, crests in Ink, a Soca Pink shell. It plays the part Fete Labs' three waves play: the one pattern, at the foot of every layout |
| (none) | A 4-degree lean, as the Fete Labs test tube leans |

Every colour comes from the Fete Labs family: Ink, Cream, Teal, Soca Pink, Gold and Lime from the Fete
Labs logo kit; Surf (Deck Cyan), Deep (the site blue) and Coconut (the seed-tier orange) from the Fete
Labs site; Sand from the Fete Labs kit. The fonts are the Fete Labs faces: Bungee, Rubik Wet Paint and
Barlow Condensed (SIL OFL 1.1, in [`fonts/`](fonts/)).

## Rebuild

```bash
pnpm brand          # from the repo root; about 90 s
```

It rewrites, and all of it is committed:

- `packages/brand/kit/`, the zip and `index.html`;
- `apps/web/public/`: `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, `icons/icon-{192,512}.png`,
  `icons/icon-maskable-512.png`, `og.png`;
- `apps/web/src/assets/brand/`: the logo the splash screen shows;
- `android/app/src/main/res/`: adaptive icon layers (background, foreground, monochrome), the legacy
  mipmaps and the launcher Teal in `values/colors.xml`.

Every word in every file is outlined from the TTFs, so no file needs a font installed. The zip is
byte-for-byte reproducible (fixed entry times, sorted names, UTC).

## Store screenshots

`kit/store/screenshots/` holds six 1080 x 1920 screenshots for the Solana dApp Store (it wants at least
four, each at least 1080 px on both sides, all one orientation). Each is the app captured at 3x in the
phone's screen shape, inside the Generic Phone from "Device Mockups With Long Shadows" on Figma
Community, on Teal with a caption. The phone is drawn as vector from the component's own geometry and
styles ([`devices/generic-phone/device.json`](devices/generic-phone/device.json)), with its long-shadow
corners exported from the file (`shadows.svg`), so it stays sharp at any size.

To re-shoot them after the UI changes:

```bash
pnpm dev                                    # the web app, in another shell
pnpm --filter @beach-bingo/brand screens    # captures into screens/captures/ (needs Chrome, or CHROME_PATH)
pnpm brand                                  # composes them into the kit
```

The captions, order and status-bar colour are in [`src/screens.mjs`](src/screens.mjs); the capture steps
and the saved game they start from are in [`scripts/capture-screens.mjs`](scripts/capture-screens.mjs).

## Where things live

- [`src/palette.mjs`](src/palette.mjs): the ten colours, with their roles.
- [`src/type.mjs`](src/type.mjs): font loading and outlined text. Glyph paths are serialised by hand
  because opentype.js 2.0 can print `NaN`, which makes librsvg drop the rest of a word.
- [`src/draw.mjs`](src/draw.mjs): the drawing. The words, the ball-dotted i (cut from Bungee's plain
  `I.salt` stem), the palm, the sea, the shell, and the compositions: `logo`, `stack`, `wordLine`,
  `symbol`, `appIcon`. Every shape goes through one paint function with three modes: `color`, `mask`
  (the one-colour versions) and `halo` (the Cream sticker outline).
- [`src/compose.mjs`](src/compose.mjs): social, store and avatar layouts.
- [`src/screens.mjs`](src/screens.mjs): the store screenshots.
- [`src/page.mjs`](src/page.mjs): the guidelines page.
- [`scripts/build.mjs`](scripts/build.mjs): writes every file.

## Rules, short

- The lean, the colours and the order of BEACH over BiNGO don't change. The i is dotted with the ball.
- On Ink or a photograph, use the sticker logo.
- Below 64 px use the symbol; below 32 px the symbol drops the palm and the number.
- Free to play: coins are play money. Never "win cash", "payout" or "real money" next to the logo.

## Credits

- Fonts: Bungee (The Bungee Project Authors), Rubik Wet Paint (The Rubik Filtered Project Authors) and
  Barlow Condensed (The Barlow Project Authors), SIL Open Font License 1.1.
- Phone mockup: the Generic Phone from "Device Mockups With Long Shadows", Figma Community.
