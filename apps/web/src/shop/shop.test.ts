import { describe, expect, it } from 'vitest';
import { packPrice } from '../solana/shop.ts';
import {
  devStub,
  discounted,
  formatPrice,
  getShop,
  isDevShop,
  PACKS,
  quote,
  registerShop,
  SEEKER_DISCOUNT_BPS,
  shopNeedsWallet,
  SKR_DISCOUNT_BPS,
  stubAllowed,
  subscribeShop,
  type Shop,
} from './shop.ts';

describe('the shop behind the popup', () => {
  it('offers the pretend shop only in local dev and a devnet build without a program; a build with the program waits for a wallet; production has none until a chain shop registers', () => {
    expect(stubAllowed({ DEV: false })).toBe(false);
    expect(stubAllowed({})).toBe(false);
    expect(getShop({ DEV: false })).toBeNull();
    expect(getShop({ DEV: false, VITE_ENABLE_ONCHAIN_STAKES: 'false' })).toBeNull();
    expect(getShop({ DEV: true })).toBe(devStub);
    expect(getShop({ DEV: false, VITE_ENABLE_ONCHAIN_STAKES: 'true' })).toBe(devStub);
    // The devnet build: the chain shop sells, once a wallet is connected; no stub stands in.
    const devnet = { DEV: false, VITE_ENABLE_ONCHAIN_STAKES: 'true', VITE_WAVE_DUEL_PROGRAM: '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH' };
    expect(getShop(devnet)).toBeNull();
    expect(shopNeedsWallet(devnet)).toBe(true);
    expect(shopNeedsWallet({ DEV: true })).toBe(false);
    const chain: Shop = { packs: async () => ({ packs: [], seekerDiscountBps: 0 }), buy: async () => ({ signature: 'x', coins: 1 }), restore: async () => 0 };
    let notified = 0;
    const off = subscribeShop(() => notified++);
    registerShop(chain);
    try {
      expect(notified).toBe(1);
      expect(getShop({ DEV: false })).toBe(chain);
      expect(getShop(devnet)).toBe(chain);
      expect(getShop({ DEV: true })).toBe(chain);
      expect(isDevShop(chain)).toBe(false);
      registerShop(chain); // the same shop again is not a change
      expect(notified).toBe(1);
    } finally {
      registerShop(null);
      off();
    }
    expect(notified).toBe(2);
    expect(getShop({ DEV: false })).toBeNull();
    expect(isDevShop(devStub)).toBe(true);
    expect(isDevShop(null)).toBe(false);
  });

  it('the stub sells the four packs for their coins with made-up signatures and restores nothing', async () => {
    const { packs, seekerDiscountBps } = await devStub.packs();
    expect(packs.map((p) => p.coins)).toEqual([5000, 15000, 40000, 100000]);
    expect(seekerDiscountBps).toBe(SEEKER_DISCOUNT_BPS);
    const bought = await devStub.buy('pack-15k', 'SOL');
    expect(bought.coins).toBe(15000);
    expect(bought.signature).toMatch(/^dev-/);
    await expect(devStub.buy('nope', 'SOL')).rejects.toThrow(/No such pack/);
    expect(await devStub.restore()).toBe(0);
  });

  it('discounts with the program arithmetic: floor, never below one base unit', () => {
    const grid = [1n, 7n, 999n, 4_990_000n, 120_000_000n, 600_000_000n];
    for (const base of grid) for (const bps of [0, 500, 2_000, 2_500, 9_999, 10_000]) expect(discounted(base, bps)).toBe(packPrice(base, bps));
    expect(discounted(1n, 2_000)).toBe(1n);
    expect(discounted(120_000_000n, SKR_DISCOUNT_BPS)).toBe(96_000_000n);
  });

  it('quotes 20% off with SKR, 5% more for a verified Seeker, and nothing where a pack is not sold', () => {
    const pack = PACKS[0]!;
    expect(quote(pack, 'SOL', false, SEEKER_DISCOUNT_BPS)).toBe(40_000_000n);
    expect(quote(pack, 'SKR', false, SEEKER_DISCOUNT_BPS)).toBe(96_000_000n);
    expect(quote(pack, 'SKR', true, SEEKER_DISCOUNT_BPS)).toBe(90_000_000n);
    expect(quote(pack, 'USDC', true, SEEKER_DISCOUNT_BPS)).toBe(4_740_500n);
    expect(quote({ id: 'x', coins: 1, offers: { SKR: pack.offers.SKR } }, 'SOL', false, 0)).toBeNull();
    expect(formatPrice(40_000_000n, 'SOL', 9)).toBe('0.040 SOL');
    expect(formatPrice(96_000_000n, 'SKR', 6)).toBe('96 SKR');
    expect(formatPrice(4_990_000n, 'USDC', 6)).toBe('4.99 USDC');
    expect(formatPrice(4_740_500n, 'PYUSD', 6)).toBe('4.74 PYUSD');
    expect(formatPrice(12_000_000n, 'JUP', 6)).toBe('12 JUP');
  });
});
