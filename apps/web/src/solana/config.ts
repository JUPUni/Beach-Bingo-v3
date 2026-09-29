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
 * a mint whose MetadataPointer AND TokenGroupMember point here.
 * Source: docs.solanamobile.com/solana-mobile-stack/seeker-genesis-token (verified 2026-09-29).
 */
export const SGT_GROUP = 'GT22s89nU4iWFkNXj1Bw6uYhJJWDRPpShHt4Bk8f99Te';

/** Real-money stakes stay off unless explicitly enabled AND the compliance gate passes. */
export const ONCHAIN_STAKES_ENABLED = import.meta.env.VITE_ENABLE_ONCHAIN_STAKES === 'true';

/** True inside the Solana Mobile dApp Store WebView shell (`npx solana-mobile webshell`). */
export function isWebShell(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Solana Mobile Web Shell');
}

export function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}
