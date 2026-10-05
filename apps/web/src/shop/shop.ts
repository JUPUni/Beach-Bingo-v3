/**
 * The Coin Shop behind the popup: four packs of coins, paid with one of five tokens. This file
 * holds the interface and a stub that answers after a short delay, so the popup is complete and
 * testable before a chain is attached; the chain implementation (the escrow program's
 * `buy_pack`, see docs/plans/2026-10-05-tokens-design.md §6b) registers itself with
 * `registerShop` and the popup never knows the difference.
 *
 * Coins have no cash value, cannot be sold, transferred or refunded, and never leave the game.
 */
export type Mint = 'SKR' | 'SOL' | 'USDC' | 'PYUSD' | 'JUP';

/** SKR first: it is the game's main token and the one the shop preselects when the wallet holds it. */
export const MINTS: readonly Mint[] = ['SKR', 'SOL', 'USDC', 'PYUSD', 'JUP'];

/** Pay with SKR: 20% off every pack. */
export const SKR_DISCOUNT = 0.2;
/** A verified Seeker owner saves a little more, on top. */
export const SEEKER_DISCOUNT = 0.05;

export interface Pack {
  id: string;
  coins: number;
  /** List price per token, in that token's display units, before any discount. */
  prices: Record<Mint, number>;
}

export interface Shop {
  packs(): Promise<Pack[]>;
  /** Pay for a pack; resolves once the transaction is confirmed with the coins to credit. */
  buy(packId: string, mint: Mint): Promise<{ signature: string; coins: number }>;
  /** Coins bought by this wallet that this device has not credited yet (0 when nothing). */
  restore(): Promise<number>;
}

const PACKS: Pack[] = [
  { id: 'pack-5k', coins: 5_000, prices: { SKR: 120, SOL: 0.04, USDC: 4.99, PYUSD: 4.99, JUP: 12 } },
  { id: 'pack-15k', coins: 15_000, prices: { SKR: 330, SOL: 0.11, USDC: 13.99, PYUSD: 13.99, JUP: 33 } },
  { id: 'pack-40k', coins: 40_000, prices: { SKR: 800, SOL: 0.27, USDC: 34.99, PYUSD: 34.99, JUP: 82 } },
  { id: 'pack-100k', coins: 100_000, prices: { SKR: 1800, SOL: 0.6, USDC: 79.99, PYUSD: 79.99, JUP: 185 } },
];

/** The price the player pays: the list price, less the SKR saving, less the Seeker saving. */
export function priceFor(pack: Pack, mint: Mint, seekerVerified: boolean): number {
  let price = pack.prices[mint];
  if (mint === 'SKR') price *= 1 - SKR_DISCOUNT;
  if (seekerVerified) price *= 1 - SEEKER_DISCOUNT;
  return price;
}

export function formatPrice(amount: number, mint: Mint): string {
  const digits = mint === 'SOL' ? 3 : mint === 'USDC' || mint === 'PYUSD' ? 2 : 0;
  return `${amount.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })} ${mint}`;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** No chain configured: a purchase "confirms" after a moment with a made-up signature. */
export const devStub: Shop = {
  packs: async () => PACKS,
  buy: async (packId) => {
    const pack = PACKS.find((p) => p.id === packId);
    if (!pack) throw new Error('No such pack');
    await wait(900);
    return { signature: `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, coins: pack.coins };
  },
  restore: async () => {
    await wait(600);
    return 0;
  },
};

let configured: Shop | null = null;

/** The chain shop plugs itself in here once its program is configured. */
export function registerShop(shop: Shop | null): void {
  configured = shop;
}

export function getShop(): Shop {
  return configured ?? devStub;
}

export function isDevShop(): boolean {
  return configured === null;
}
