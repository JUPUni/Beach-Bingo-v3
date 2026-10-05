/**
 * Solana settings for the web client. Everything here is public configuration —
 * no keys or secrets ever ship in the web bundle.
 */
export type Cluster = 'mainnet' | 'devnet';

export const CLUSTER: Cluster = import.meta.env.VITE_SOLANA_CLUSTER === 'devnet' ? 'devnet' : 'mainnet';

export const CHAIN = `solana:${CLUSTER}` as const;

export const RPC_URL =
  import.meta.env.VITE_SOLANA_RPC_URL ||
  (CLUSTER === 'devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');

/**
 * Seeker Genesis Token group/metadata address (Token-2022). A wallet holds a Seeker if it owns
 * a mint whose MetadataPointer AND TokenGroupMember point here. The mainnet group by default
 * (docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token, verified 2026-09-29); the
 * devnet build names the admin script's mock group in `VITE_SGT_GROUP`, the same value the
 * program's config holds, so the app and the chain agree on what a Seeker is.
 */
export const MAINNET_SGT_GROUP = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';
export const SGT_GROUP: string = import.meta.env.VITE_SGT_GROUP || MAINNET_SGT_GROUP;

/**
 * The wave_duel program this build knows (`VITE_WAVE_DUEL_PROGRAM`). Knowing the program opens the
 * chain Coin Shop: packs paid in SOL or a registered token, the Seeker and SKR discounts, restore.
 * It does not open staked rooms: those need the flag below as well.
 */
export const WAVE_DUEL_PROGRAM: string | null = import.meta.env.VITE_WAVE_DUEL_PROGRAM || null;
export const CHAIN_SHOP_ENABLED = WAVE_DUEL_PROGRAM !== null;

/**
 * Real-token staked rooms stay off unless `VITE_ENABLE_ONCHAIN_STAKES=true` AND the program is known.
 * Mainnet runs the shop with this off: wagered bingo is regulated gambling (docs/PRODUCTION.md).
 */
export const ONCHAIN_STAKES_ENABLED = import.meta.env.VITE_ENABLE_ONCHAIN_STAKES === 'true' && WAVE_DUEL_PROGRAM !== null;

/** True inside the Solana Mobile dApp Store WebView shell (`npx solana-mobile webshell`). */
export function isWebShell(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Solana Mobile Web Shell');
}

/**
 * True when the Android shell found the Seed Vault Wallet on the device (it appends `SeedVault/1`
 * to the user agent). A hint for badges and layout, never a proof: anything of value goes through
 * the Seeker Genesis Token on chain.
 */
export function isSeedVaultDevice(): boolean {
  return typeof navigator !== 'undefined' && /\bSeedVault\/\d/.test(navigator.userAgent);
}

/** The device model the shell reports (`Model/Seeker`), or null outside the shell. */
export function shellDeviceModel(): string | null {
  if (typeof navigator === 'undefined') return null;
  const m = /\bModel\/([A-Za-z0-9._-]+)/.exec(navigator.userAgent);
  return m ? m[1]! : null;
}

export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
