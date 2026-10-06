/**
 * The Coin Shop's prices, worked out the way `scripts/mainnet/setup.mjs` works them out, so the
 * admin panel and the operator script never disagree: each pack has a list price in US dollars
 * (`PACK_USD`, the same four as `registry.json`, held equal by a test), and a token's price is that
 * many dollars of the token at its live USD quote, rounded to a tidy step.
 *
 * Stablecoins stay at one dollar whatever the quote. Pure: the only network call is
 * `fetchUsdPrices`, and it takes its `fetch`.
 */

/** List prices in US dollars for the four packs (5,000 / 15,000 / 40,000 / 100,000 coins). */
export const PACK_USD: readonly number[] = [4.99, 13.99, 34.99, 79.99];
export const SOL_MINT = 'So11111111111111111111111111111111111111112';
/** Priced at one dollar, never from a quote. */
export const STABLE_MINTS: ReadonlySet<string> = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
]);
export const PRICE_SOURCE = 'https://lite-api.jup.ag/price/v3';

/** Base units for `usd` worth of an asset at `usdPrice`, rounded to a multiple of `step` (setup.mjs `units`). */
export function unitsFor(usd: number, usdPrice: number, decimals: number, step: number): bigint {
  if (!(usdPrice > 0)) throw new Error('a price must be above zero');
  return BigInt(Math.round(Math.round((usd / usdPrice) * 10 ** decimals) / step) * step);
}

/** Lamports per pack, to 0.0001 SOL. */
export function solPackPrices(solUsd: number): bigint[] {
  return PACK_USD.map((usd) => unitsFor(usd, solUsd, 9, 100_000));
}

/** Base units per pack for a token: to 0.01 of a token worth 50 cents or more, else to 0.0001. */
export function mintPackPrices(usdPrice: number, decimals: number): bigint[] {
  const step = usdPrice >= 0.5 ? 10 ** (decimals - 2) : 10 ** (decimals - 4);
  return PACK_USD.map((usd) => unitsFor(usd, usdPrice, decimals, step));
}

/**
 * Live USD quotes for `mints` from Jupiter's price API, which answers beachbingo.xyz's browser
 * directly. Returns the mints it has a positive price for and leaves out any it has not (a token
 * Jupiter does not quote keeps its old prices; the panel says so). Throws only when the API itself
 * fails.
 */
export async function fetchUsdPrices(mints: readonly string[], fetcher: typeof fetch = fetch): Promise<Record<string, number>> {
  const res = await fetcher(`${PRICE_SOURCE}?ids=${mints.join(',')}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`price API: HTTP ${res.status}`);
  const quotes = (await res.json()) as Record<string, { usdPrice?: unknown } | undefined>;
  const out: Record<string, number> = {};
  for (const mint of mints) {
    const price = quotes[mint]?.usdPrice;
    if (typeof price === 'number' && price > 0) out[mint] = price;
  }
  return out;
}
