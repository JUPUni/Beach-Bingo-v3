import { SOL_DECIMALS, TOKEN_SYMBOLS, type TokenSymbol } from '../solana/tokens.ts';

/**
 * The Coin Shop behind the popup: four packs of coins, paid with one of five tokens. This file
 * holds the interface and a stub that answers after a short delay, so the popup is complete and
 * testable before a chain is attached; the chain implementation (`chainShop.ts`, the escrow
 * program's `buy_pack` / `buy_pack_token`, docs/plans/2026-10-05-tokens-design.md §6b) registers
 * itself with `registerShop` once a wallet is connected and the popup never knows the difference.
 * The stub exists only in local dev and in a devnet build without a program: a production build
 * has no shop at all (`getShop()` is null and the popup shows the packs greyed), because a stub
 * there would let players credit themselves coins through a pretend purchase.
 *
 * Prices are kept in base units with the token's decimals and discounted with the program's own
 * arithmetic (`discounted`), so what the popup shows is what the chain charges.
 *
 * Coins have no cash value, cannot be sold, transferred or refunded, and never leave the game.
 */
export type Mint = TokenSymbol;

/** SKR first: it is the game's main token and the one the shop preselects when the wallet holds it. */
export const MINTS: readonly Mint[] = TOKEN_SYMBOLS;

/** Pay with SKR: 20% off every pack (the registry's `discount_bps` for SKR, and the stub's). */
export const SKR_DISCOUNT_BPS = 2_000;
/** A verified Seeker owner saves a little more, on top (the config's `seeker_discount_bps`). */
export const SEEKER_DISCOUNT_BPS = 500;

/** How a pack is sold in one token. */
export interface Offer {
  /** List price in base units of the token, before any discount. */
  base: bigint;
  decimals: number;
  /** The token's own saving in bps (SKR 2,000; the others 0). */
  discountBps: number;
}

export interface Pack {
  id: string;
  coins: number;
  /** A token missing here does not sell this pack. */
  offers: Partial<Record<Mint, Offer>>;
}

export interface Catalogue {
  packs: Pack[];
  /** On top of a token's own saving for a buyer whose Seeker Genesis Token is proved. */
  seekerDiscountBps: number;
}

/** A purchase sent earlier, as the shop settles it on a later open: the purchase to credit (once), still confirming, or gone. */
export type PendingSettlement =
  | { status: 'confirmed'; purchase: { signature: string; pack: string; mint: string; coins: number; wallet: string } }
  | { status: 'pending' }
  | { status: 'dropped' };

export interface Shop {
  packs(): Promise<Catalogue>;
  /** Pay for a pack; resolves once the transaction is confirmed with the coins to credit. */
  buy(packId: string, mint: Mint): Promise<{ signature: string; coins: number }>;
  /** Coins bought by this wallet that this device has not credited yet (0 when nothing). */
  restore(): Promise<number>;
  /** The wallet the shop is bound to (the chain shop); purchases are recorded against it. */
  wallet?: string;
  /** The bound wallet holds a Seeker Genesis Token the program accepts, so the Seeker saving applies. */
  seekerVerified?: () => boolean;
  /** Settle a purchase this device sent and never credited (the chain shop; shop/pendingPurchase.ts); null when there is none. */
  settlePending?(): Promise<PendingSettlement | null>;
}

/** The program's price: `base × (10_000 − bps) / 10_000`, floor, never below one base unit. */
export function discounted(base: bigint, bps: number): bigint {
  const paid = (base * BigInt(10_000 - bps)) / 10_000n;
  return paid > 0n ? paid : 1n;
}

/** What the player pays for `pack` in `mint`, in base units, or null when the pack is not sold in it. */
export function quote(pack: Pack, mint: Mint, seekerVerified: boolean, seekerDiscountBps: number): bigint | null {
  const offer = pack.offers[mint];
  if (!offer) return null;
  return discounted(offer.base, offer.discountBps + (seekerVerified ? seekerDiscountBps : 0));
}

/** The saving on a pack with `mint` as a whole percentage ("20"), from its offer. */
export function savingPercent(pack: Pack, mint: Mint): number {
  return (pack.offers[mint]?.discountBps ?? 0) / 100;
}

/**
 * "0.040 SOL", "4.99 USDC", "96 SKR", "247.5 SKR": SOL to at least three places, the dollar coins
 * to two, the rest whole, and the fraction a discount leaves shown as the chain charges it (up to
 * two places from 1 up, four below), so the button carries the price the wallet signs for.
 */
export function formatPrice(base: bigint, mint: Mint, decimals: number): string {
  const value = Number(base) / 10 ** decimals;
  const min = mint === 'SOL' ? 3 : mint === 'USDC' || mint === 'PYUSD' ? 2 : 0;
  const max = Math.max(min, value >= 1 ? 2 : 4);
  return `${value.toLocaleString('en-US', { minimumFractionDigits: min, maximumFractionDigits: max })} ${mint}`;
}

const units = (display: number, decimals: number): bigint => BigInt(Math.round(display * 10 ** decimals));
const offer = (display: number, mint: Mint): Offer => ({
  base: units(display, mint === 'SOL' ? SOL_DECIMALS : 6),
  decimals: mint === 'SOL' ? SOL_DECIMALS : 6,
  discountBps: mint === 'SKR' ? SKR_DISCOUNT_BPS : 0,
});
const pack = (id: string, coins: number, prices: Record<Mint, number>): Pack => ({
  id,
  coins,
  offers: Object.fromEntries(MINTS.map((m) => [m, offer(prices[m], m)])) as Partial<Record<Mint, Offer>>,
});

/** The stub's catalogue, also shown greyed where no shop is open yet. */
export const PACKS: readonly Pack[] = [
  pack('pack-5k', 5_000, { SKR: 120, SOL: 0.04, USDC: 4.99, PYUSD: 4.99, JUP: 12 }),
  pack('pack-15k', 15_000, { SKR: 330, SOL: 0.11, USDC: 13.99, PYUSD: 13.99, JUP: 33 }),
  pack('pack-40k', 40_000, { SKR: 800, SOL: 0.27, USDC: 34.99, PYUSD: 34.99, JUP: 82 }),
  pack('pack-100k', 100_000, { SKR: 1800, SOL: 0.6, USDC: 79.99, PYUSD: 79.99, JUP: 185 }),
];

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** No chain configured: a purchase "confirms" after a moment with a made-up signature. */
export const devStub: Shop = {
  packs: async () => ({ packs: [...PACKS], seekerDiscountBps: SEEKER_DISCOUNT_BPS }),
  buy: async (packId) => {
    const found = PACKS.find((p) => p.id === packId);
    if (!found) throw new Error('No such pack');
    await wait(900);
    return { signature: `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, coins: found.coins };
  },
  restore: async () => {
    await wait(600);
    return 0;
  },
};

let configured: Shop | null = null;
const listeners = new Set<() => void>();

/** The chain shop plugs itself in here once a wallet is connected (and unplugs when it leaves). */
export function registerShop(shop: Shop | null): void {
  if (configured === shop) return;
  configured = shop;
  for (const l of listeners) l();
}

/** Notified whenever the registered shop changes; returns the unsubscribe. */
export function subscribeShop(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The part of the build environment that decides whether the pretend shop may appear. */
export interface ShopEnv {
  DEV?: boolean;
  VITE_ENABLE_ONCHAIN_STAKES?: string;
  VITE_WAVE_DUEL_PROGRAM?: string;
}

/** Local dev, and a devnet build that has no escrow program to buy from; never a production build. */
export function stubAllowed(env: ShopEnv = import.meta.env as ShopEnv): boolean {
  return env.DEV === true || (env.VITE_ENABLE_ONCHAIN_STAKES === 'true' && !env.VITE_WAVE_DUEL_PROGRAM);
}

/** A build that knows the program sells through the chain, so the shop opens once a wallet is connected (stakes may stay off). */
export function shopNeedsWallet(env: ShopEnv = import.meta.env as ShopEnv): boolean {
  return Boolean(env.VITE_WAVE_DUEL_PROGRAM);
}

/** The shop to sell through: the chain shop once registered, the stub where it is allowed, otherwise none. */
export function getShop(env?: ShopEnv): Shop | null {
  return configured ?? (stubAllowed(env) ? devStub : null);
}

export function isDevShop(shop: Shop | null): boolean {
  return shop !== null && shop === devStub;
}
