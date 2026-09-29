/**
 * Money is always an integer count of a currency's minor unit (lamports, micro-USDC, coins).
 * Multipliers are decimals with a fixed number of places; settlement rounds DOWN.
 */

export type CurrencyCode = 'COINS' | 'SOL' | 'USDC' | 'SKR';

export interface Currency {
  code: CurrencyCode;
  symbol: string;
  decimals: number;
  /** `play` = free play-money, never withdrawable. */
  kind: 'play' | 'native' | 'spl';
  /** SPL mint (mainnet). Undefined for play money and native SOL. */
  mint?: string;
  /** Stake presets in minor units. */
  stakes: number[];
}

export const CURRENCIES: Readonly<Record<CurrencyCode, Currency>> = {
  COINS: { code: 'COINS', symbol: '🪙', decimals: 0, kind: 'play', stakes: [10, 25, 50, 100, 250, 500] },
  SOL: {
    code: 'SOL',
    symbol: '◎',
    decimals: 9,
    kind: 'native',
    stakes: [10_000_000, 25_000_000, 50_000_000, 100_000_000, 250_000_000, 500_000_000],
  },
  USDC: {
    code: 'USDC',
    symbol: '$',
    decimals: 6,
    kind: 'spl',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    stakes: [100_000, 250_000, 500_000, 1_000_000, 5_000_000, 10_000_000],
  },
  SKR: {
    code: 'SKR',
    symbol: 'SKR',
    decimals: 6,
    kind: 'spl',
    // Verified on mainnet 2026-09-29 (SPL Token, 6 decimals) — docs.solanamobile.com/solana-mobile-stack/skr
    mint: 'SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3',
    stakes: [1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000, 500_000_000],
  },
};

/** `amount × multiplier`, rounded down, exact for any safe-integer amount (BigInt maths). */
export function applyMultiplier(amount: number, multiplier: number, places = 2): number {
  const scale = 10 ** places;
  const m = Math.round(multiplier * scale);
  return Number((BigInt(amount) * BigInt(m)) / BigInt(scale));
}

/** `amount × numerator / denominator`, rounded down. */
export function mulDiv(amount: number, numerator: number, denominator: number): number {
  return Number((BigInt(amount) * BigInt(numerator)) / BigInt(denominator));
}

/** Round a multiplier down to `places` decimals (house-favourable). */
export function floorMultiplier(multiplier: number, places = 2): number {
  const scale = 10 ** places;
  return Math.floor(multiplier * scale + 1e-9) / scale;
}

export function formatAmount(amount: number, currency: Currency, maxFraction = 4): string {
  if (currency.decimals === 0) return amount.toLocaleString('en-US');
  const value = amount / 10 ** currency.decimals;
  return value.toLocaleString('en-US', { maximumFractionDigits: Math.min(maxFraction, currency.decimals) });
}

/** Parse a decimal string into minor units (throws on too many decimals). */
export function parseAmount(text: string, currency: Currency): number {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error(`invalid amount: ${text}`);
  const [whole, fraction = ''] = trimmed.split('.');
  if (fraction.length > currency.decimals) throw new Error(`too many decimals for ${currency.code}`);
  const units = BigInt(whole!) * 10n ** BigInt(currency.decimals) + BigInt(fraction.padEnd(currency.decimals, '0') || '0');
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('amount too large');
  return Number(units);
}
