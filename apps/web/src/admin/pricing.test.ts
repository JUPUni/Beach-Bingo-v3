import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fetchUsdPrices, mintPackPrices, PACK_USD, SOL_MINT, solPackPrices, STABLE_MINTS, unitsFor } from './pricing.ts';
import { roleOf } from './role.ts';

const registry = JSON.parse(readFileSync(new URL('../../scripts/mainnet/registry.json', import.meta.url), 'utf8'));

describe('admin pricing', () => {
  it('lists the same four pack prices as the operator registry', () => {
    expect([...PACK_USD]).toEqual(registry.packs.usd);
    expect(registry.priceSource).toBe('https://lite-api.jup.ag/price/v3');
  });

  it('treats exactly the registry stablecoins as one dollar', () => {
    const stable = registry.mints.filter((m: { stable?: boolean }) => m.stable).map((m: { mint: string }) => m.mint);
    expect([...STABLE_MINTS].sort()).toEqual(stable.sort());
  });

  it('prices SOL to 0.0001 SOL and tokens to the setup script\'s steps', () => {
    // SOL at $120.75: 4.99 / 120.75 = 0.041325… SOL → 0.0413 SOL.
    expect(solPackPrices(120.75)).toEqual([41_300_000n, 115_900_000n, 289_800_000n, 662_400_000n]);
    // USDC at $1: to the cent.
    expect(mintPackPrices(1, 6)).toEqual([4_990_000n, 13_990_000n, 34_990_000n, 79_990_000n]);
    // SKR at $0.018114 (under 50 cents): to 0.0001 SKR. 4.99 / 0.018114 = 275.477…
    expect(mintPackPrices(0.018114, 6)[0]).toBe(275_477_500n);
    for (const p of mintPackPrices(0.018114, 6)) expect(p % 100n).toBe(0n);
    expect(() => unitsFor(4.99, 0, 9, 1)).toThrow();
  });

  it('returns the quotes it has and leaves out the rest', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 150 }, JUP: { usdPrice: 0.4 } })));
    expect(await fetchUsdPrices([SOL_MINT, 'JUP'], ok as unknown as typeof fetch)).toEqual({ [SOL_MINT]: 150, JUP: 0.4 });
    const hole = vi.fn(async () => new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 150 }, BAD: { usdPrice: 0 }, NAN: { usdPrice: 'x' } })));
    expect(await fetchUsdPrices([SOL_MINT, 'JUP', 'BAD', 'NAN'], hole as unknown as typeof fetch)).toEqual({ [SOL_MINT]: 150 });
    const down = vi.fn(async () => new Response('', { status: 503 }));
    await expect(fetchUsdPrices([SOL_MINT], down as unknown as typeof fetch)).rejects.toThrow('HTTP 503');
  });
});

describe('admin roles', () => {
  const config = { admin: 'Dox9t9toz7BwwHJaqqsTpt9J74DWkXidP921FJQgWGE5', pauser: 'ErPdwCQZAujo8TM6PZVvZkd1gdoxwDXnk3GFhAkBVbbD' } as never;
  it('names the admin, the pauser and nobody else', () => {
    expect(roleOf('Dox9t9toz7BwwHJaqqsTpt9J74DWkXidP921FJQgWGE5', config)).toBe('admin');
    expect(roleOf('ErPdwCQZAujo8TM6PZVvZkd1gdoxwDXnk3GFhAkBVbbD', config)).toBe('pauser');
    expect(roleOf('11111111111111111111111111111111', config)).toBeNull();
  });
});
