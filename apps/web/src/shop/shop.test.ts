import { describe, expect, it } from 'vitest';
import { devStub, formatPrice, getShop, isDevShop, PACKS, priceFor, registerShop, SEEKER_DISCOUNT, SKR_DISCOUNT, stubAllowed, type Shop } from './shop.ts';

describe('the shop behind the popup', () => {
  it('offers the pretend shop only in local dev and the devnet build; a production build has none until a chain shop registers', () => {
    expect(stubAllowed({ DEV: false })).toBe(false);
    expect(stubAllowed({})).toBe(false);
    expect(getShop({ DEV: false })).toBeNull();
    expect(getShop({ DEV: false, VITE_ENABLE_ONCHAIN_STAKES: 'false' })).toBeNull();
    expect(getShop({ DEV: true })).toBe(devStub);
    expect(getShop({ DEV: false, VITE_ENABLE_ONCHAIN_STAKES: 'true' })).toBe(devStub);
    const chain: Shop = { packs: async () => [], buy: async () => ({ signature: 'x', coins: 1 }), restore: async () => 0 };
    registerShop(chain);
    try {
      expect(getShop({ DEV: false })).toBe(chain);
      expect(getShop({ DEV: true })).toBe(chain);
      expect(isDevShop(chain)).toBe(false);
    } finally {
      registerShop(null);
    }
    expect(getShop({ DEV: false })).toBeNull();
    expect(isDevShop(devStub)).toBe(true);
    expect(isDevShop(null)).toBe(false);
  });

  it('the stub sells the four packs for their coins with made-up signatures and restores nothing', async () => {
    const packs = await devStub.packs();
    expect(packs.map((p) => p.coins)).toEqual([5000, 15000, 40000, 100000]);
    const bought = await devStub.buy('pack-15k', 'SOL');
    expect(bought.coins).toBe(15000);
    expect(bought.signature).toMatch(/^dev-/);
    await expect(devStub.buy('nope', 'SOL')).rejects.toThrow(/No such pack/);
    expect(await devStub.restore()).toBe(0);
  });

  it('prices: 20% off with SKR, 5% more for a verified Seeker', () => {
    const pack = PACKS[0]!;
    expect(priceFor(pack, 'SOL', false)).toBe(pack.prices.SOL);
    expect(priceFor(pack, 'SKR', false)).toBeCloseTo(pack.prices.SKR * (1 - SKR_DISCOUNT));
    expect(priceFor(pack, 'SKR', true)).toBeCloseTo(pack.prices.SKR * (1 - SKR_DISCOUNT) * (1 - SEEKER_DISCOUNT));
    expect(priceFor(pack, 'USDC', true)).toBeCloseTo(pack.prices.USDC * (1 - SEEKER_DISCOUNT));
    expect(formatPrice(0.04, 'SOL')).toBe('0.040 SOL');
    expect(formatPrice(96, 'SKR')).toBe('96 SKR');
    expect(formatPrice(4.99, 'USDC')).toBe('4.99 USDC');
  });
});
