# Publishing Beach Bingo to the Solana dApp Store

The Android app is the Solana Mobile **web shell** in `android/`: a WebView around
`https://beachbingo.xyz/app/`, so a web deploy reaches every phone without a new APK. This is the
whole road from that folder to a listing, as the store runs it in September 2026, ending with the
steps only the owner can take. Where the store's own docs move, they win:
[docs.solanamobile.com/dapp-publishing](https://docs.solanamobile.com/dapp-publishing/overview).

## 1. What already exists

| Piece | Where | State |
|---|---|---|
| The game | `apps/web`, served at `beachbingo.xyz/app/` | Live. Season 3 with live rooms. |
| The shell | `android/` (AGP 9.3.2, Gradle 9.7.1, compile/target SDK 37, min SDK 28, Kotlin 2.4.10) | `gradle.properties` points it at `/app/`; application id `xyz.beachbingo.app`, version code 1, version name 0.1.0. |
| Launcher icon | `android/app/src/main/res/` | Drawn by `pnpm brand` from the brand kit (adaptive layers, legacy mipmaps, monochrome). |
| Store art | `packages/brand/kit/store/` | `dapp-store-icon-512.png`, `dapp-store-banner-1200x600.{png,jpg}`, `dapp-store-feature-1200x1200.{png,jpg}`, `screenshots/dapp-store-screenshot-01…06-1080x1920.png` |
| Notices | `beachbingo.xyz/privacy/`, `beachbingo.xyz/terms/` | Live; the listing's privacy policy and licence URLs. |
| Wallet | `apps/web/src/solana/` | Wallet Standard + Mobile Wallet Adapter (`@solana-mobile/wallet-standard-mobile` ^0.6, above the 0.5.1 the store asks for); the address and the Seeker check, plus the coin-pack purchase once the chain shop is attached. |
| The Coin Shop | `apps/web/src/shop/`, `apps/web/src/popups/ShopPopup.tsx` | In-app purchases of coins (no cash value, no refunds) behind a one-time 18+ declaration and the `/api/geo` region check (`apps/site/api/geo.js`, Washington blocked). The popup runs on a dev stub until the chain purchase registers itself. |

## 2. Build the shell

Prerequisites: JDK 21, the Android SDK with `platforms;android-37.0`, `build-tools;37.0.0` and
`platform-tools` (`sdkmanager --install …`; note the platform package is `android-37.0`, not
`android-37`), and `ANDROID_HOME` pointing at it.

```bash
cd android
ANDROID_HOME=$HOME/android-sdk ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release-unsigned.apk  (no signing config set)
```

Or with the Solana Mobile CLI, which wraps the same Gradle build and signs it:

```bash
npx solana-mobile@latest webshell build android --keystore-path ../.secrets/dappstore.keystore
```

The build resolves AGP from Google's Maven and Kotlin from Maven Central. In a sandbox behind a
rate-limited proxy, Maven Central answered `429 Too Many Requests` for some artefacts on the first
runs; retries succeed because Gradle keeps what it has already fetched. The record of the build
done from this checkout is at the end of this document.

## 3. Sign it, once and forever

The store identifies an app by its signing certificate: every update must be signed with the
same key, and it must **not** be the key used for Google Play (the store rejects a Play-signed
package). Make one key, keep it out of git (`.secrets/` is ignored), and back it up.

```bash
mkdir -p .secrets
keytool -genkey -v -keystore .secrets/dappstore.keystore -alias beachbingo \
  -keyalg RSA -keysize 2048 -validity 10000
```

`android/app/build.gradle.kts` reads `SOLANA_MOBILE_KEYSTORE_PATH`, `SOLANA_MOBILE_KEYSTORE_ALIAS`
(Gradle properties) and `SOLANA_MOBILE_KEYSTORE_PASSWORD`, `SOLANA_MOBILE_KEY_PASSWORD`
(environment) and signs the release when all four are set. Verify before uploading:

```bash
$ANDROID_HOME/build-tools/37.0.0/apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk
```

Every submission needs a higher `SOLANA_MOBILE_VERSION_CODE` than the last one accepted; bump it
and `SOLANA_MOBILE_VERSION_NAME` in `android/gradle.properties` together.

## 4. The publisher account

Publishing goes through the **Publisher Portal** at
[publish.solanamobile.com](https://publish.solanamobile.com):

1. Sign in with the **publisher wallet**. This wallet is the publisher's identity for good: the
   publisher NFT, the app NFT and every release NFT are minted to it, and later updates must come
   from it. Use a wallet the team controls durably (hardware-backed), not a personal hot wallet.
   Keep about **0.2 SOL** in it for the mints and the Arweave (ArDrive) storage of the assets.
2. Complete **KYC/KYB** in the portal (a person or the business behind the app). Reviews do not
   start until it is done.
3. Create the publisher (name, website, contact email, description) and the app (name, package
   `xyz.beachbingo.app`, category **Games**, age rating, website, privacy policy URL, licence URL,
   support contact).

## 5. The listing

Copy that follows the brand's one rule about words: free to play with SAND; coins are bought and
have no cash value; never a promise of money.

- **Name:** Beach Bingo
- **Short description (≤ 30):** Provably fair island bingo
- **Long description:** Free-to-play bingo on the beach: a 40-level island adventure across four
  islands, 75- and 90-ball halls you can play alone or open for friends, quick games in Casino
  Cove, and rounds you can check yourself. Every draw comes from a seed the game commits to
  before the first ball. SAND is free play money, never bought or sold. Coins, for the coin
  tables, come from the Coin Shop (SOL, USDC, PYUSD, JUP or SKR; SKR 20% off) and have no cash
  value: no selling, no transfers, no refunds. The coin tables and the shop are 18+ and not offered
  in Washington State. Link a Solana wallet on your Seeker for a welcome perk.
- **What's new (0.1.0):** Season 3: the island adventure, five halls, live rooms with friends,
  and the fairness check.
- **Category:** Games. **Age rating:** the questionnaire's answers for simulated casino-style play
  **with in-app purchases** (coin packs: digital goods consumed in the game, no cash value, no
  refunds) and an in-app 18+ gate on the coin tables and the shop; SAND play is open to all. The
  answers that change from the play-money listing: in-app purchases yes; real-money gambling no
  (nothing is paid out, in SAND or in coins); a wallet signature is requested only to pay for a pack.
- **Icon:** `packages/brand/kit/store/dapp-store-icon-512.png` (512 × 512).
- **Banner:** `dapp-store-banner-1200x600.png`. **Feature graphic:** `dapp-store-feature-1200x1200.png`.
- **Screenshots (1080 × 1920):** `screenshots/dapp-store-screenshot-01…06`. Portrait, no device
  frames, captions inside the images.
- **Privacy policy URL:** `https://beachbingo.xyz/privacy/`
- **Licence / terms URL:** `https://beachbingo.xyz/terms/`
- **Website:** `https://beachbingo.xyz/`. **Support:** the team's address at fetelabs.ai.
- **Alpha testers:** optional; the portal lets you list wallet addresses that can install a
  release before it is public.

## 6. Policy points that apply to this app

- **Privacy policy and data deletion.** The policy is live at `/privacy/`; it states that the game
  keeps everything in the browser's storage and that clearing site data (or uninstalling) deletes
  it, and that no account exists. Keep the date on it current.
- **A WebView must load only trusted URLs.** The shell opens `https://beachbingo.xyz/app/` and
  hands anything outside that host to the system browser (`android/README.md`). Do not add other
  hosts to the shell.
- **No misleading financial promises.** No copy says cash, real money or winnings. SAND is free
  play money; coins are bought, have no cash value and never leave the game, and the app, the terms
  (the "Coins and SAND" section) and the listing all say so.
- **In-app purchases and age.** The coin packs are declared as in-app purchases. The 18+
  declaration and the Washington block (`apps/site/api/geo.js`, header-based, nothing stored; an
  unknown region fails open on the declaration) are described in the terms, and the privacy
  policy says the IP address is not kept.
- **Wallet use is honest.** The app reads an address and looks up the Seeker Genesis Token for the
  perk, and asks for a signature only to pay for a coin pack in the shop. Say so in the listing's
  wallet-permissions notes.
- **Updates.** A new release NFT per version; the review takes about **3–5 business days** and the
  result comes by email from `publishersupport@dappstore.solanamobile.com`. Web changes need no
  release; only the shell (icon, package, permissions, URL) does.

## 7. Submitting, and updating later

In the portal: upload the signed APK, fill the listing above, attach the media, submit for review.
After approval the app is in the store and the release NFTs are in the publisher wallet.

For scripted updates the CLI exists too (`@solana-mobile/dapp-store-cli`, with a portal API key in
`DAPP_STORE_API_KEY`): `npx dapp-store create release …` then `npx dapp-store publish update …`.
The portal is the simpler path for a first submission.

## 8. Owner checklist

Only the owner can do these:

- [ ] Choose the publisher wallet, fund it (~0.2 SOL), and keep its seed backed up.
- [ ] Create the portal account with that wallet; complete KYC/KYB.
- [ ] Generate the signing key (`keytool` above), store it in `.secrets/` and in a backup; never in
      git, never the Play key.
- [ ] Build and sign the release (`webshell build … --keystore-path …`, or Gradle with the four
      signing properties); verify with `apksigner`.
- [ ] Fill the listing from section 5, upload the media from `packages/brand/kit/store/`, submit.
- [ ] Answer the questionnaire's in-app-purchase items (coin packs, digital goods, no refunds) and
      point the reviewer at the terms' "Coins and SAND" section and the 18+ gate.
- [ ] Watch the mailbox for the review; fix and resubmit with a higher version code if asked.
- [ ] When it is live: flip the landing page's "Coming soon · Solana dApp Store" card to the store
      link, and the same on fetelabs.ai and in FetePass.

## Build record

- 2026-09-29, from this checkout in a CI sandbox (JDK 21, SDK platform 37.0, build-tools 37.0.0,
  Gradle 9.7.1, AGP 9.3.2, Kotlin 2.4.10): `./gradlew assembleRelease` succeeded on the third
  run, lint-vital included (the first two stopped on Maven Central `429 Too Many Requests`
  through the sandbox's proxy; Gradle kept what it had fetched, so each retry got further).
  Output `app/build/outputs/apk/release/app-release-unsigned.apk`, 2.1 MB, SHA-256 beginning
  `d209634ca25c60a9`. `aapt2 dump badging`: package `xyz.beachbingo.app`, versionCode 1,
  versionName 0.1.0, compileSdk 37, targetSdk 37, label "Beach Bingo", launchable activity
  `xyz.beachbingo.app.MainActivity`, permissions: `INTERNET` only. Unsigned, as expected without
  the signing properties: section 3 is the owner's step.
