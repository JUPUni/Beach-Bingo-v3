import { describe, expect, it } from 'vitest';
import { packPrice } from '../solana/shop.ts';
import { buyBlockedReason, devStub, discounted, formatPrice, getShop, isDevShop, MIN_SOL_FOR_FEES, PACKS, quote, registerShop, savingPercent, SEEKER_DISCOUNT_BPS, shopNeedsWallet, SKR_DISCOUNT_BPS, stubAllowed, subscribeShop, type Shop } from './shop.ts';

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
    // The mainnet build: the program is known, staked rooms stay off; the chain shop sells, nothing stands in.
    const mainnet = { DEV: false, VITE_WAVE_DUEL_PROGRAM: '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH' };
    expect(stubAllowed(mainnet)).toBe(false);
    expect(getShop(mainnet)).toBeNull();
    expect(shopNeedsWallet(mainnet)).toBe(true);
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

  it('switches Buy off before the wallet would fail: short of the token, or of the SOL for the fee and the rent', () => {
    const held = { sol: 10_000_000n, token: 90_000_000n };
    expect(buyBlockedReason('SKR', 96_000_000n, held)).toBe('Not enough SKR in this wallet');
    expect(buyBlockedReason('SKR', 90_000_000n, held)).toBeNull();
    expect(buyBlockedReason('USDC', 4_990_000n, { sol: 2_999_999n, token: 5_000_000n })).toBe('Needs about 0.003 SOL for fees');
    expect(buyBlockedReason('USDC', 4_990_000n, { sol: MIN_SOL_FOR_FEES, token: 5_000_000n })).toBeNull();
    expect(buyBlockedReason('SOL', 40_000_000n, { sol: 42_000_000n, token: 42_000_000n })).toBe('Not enough SOL in this wallet');
    expect(buyBlockedReason('SOL', 40_000_000n, { sol: 43_000_000n, token: 43_000_000n })).toBeNull();
    // Unknown balances block nothing; an unknown token balance still needs the SOL.
    expect(buyBlockedReason('SKR', 96_000_000n, null)).toBeNull();
    expect(buyBlockedReason('JUP', 12_000_000n, { sol: 1_000_000n, token: null })).toBe('Needs about 0.003 SOL for fees');
    expect(buyBlockedReason('JUP', 12_000_000n, { sol: 5_000_000n, token: null })).toBeNull();
  });

  it('discounts with the program arithmetic: floor, never below one base unit', () => {
    const grid = [1n, 7n, 999n, 4_990_000n, 120_000_000n, 600_000_000n];
    for (const base of grid) for (const bps of [0, 500, 2_000, 2_500, 9_999, 10_000]) expect(discounted(base, bps)).toBe(packPrice(base, bps));
    expect(discounted(1n, 2_000)).toBe(1n);
    expect(discounted(120_000_000n, SKR_DISCOUNT_BPS)).toBe(96_000_000n);
  });

  it('quotes the list price without the Seeker proof, 25% off with SKR and 5% off the rest for a linked Seeker, and nothing where a pack is not sold', () => {
    const pack = PACKS[0]!;
    expect(quote(pack, 'SOL', false, SEEKER_DISCOUNT_BPS)).toBe(40_000_000n);
    // The SKR deal is a Seeker deal: no proof, no saving — the program's rule since the 2026-10-05 upgrade.
    expect(quote(pack, 'SKR', false, SEEKER_DISCOUNT_BPS)).toBe(120_000_000n);
    expect(quote(pack, 'SKR', true, SEEKER_DISCOUNT_BPS)).toBe(90_000_000n);
    expect(quote(pack, 'SOL', true, SEEKER_DISCOUNT_BPS)).toBe(38_000_000n);
    expect(quote(pack, 'USDC', true, SEEKER_DISCOUNT_BPS)).toBe(4_740_500n);
    expect(savingPercent(pack, 'SKR', SEEKER_DISCOUNT_BPS)).toBe(25);
    expect(savingPercent(pack, 'USDC', SEEKER_DISCOUNT_BPS)).toBe(5);
    expect(quote({ id: 'x', coins: 1, offers: { SKR: pack.offers.SKR } }, 'SOL', false, 0)).toBeNull();
    expect(formatPrice(40_000_000n, 'SOL', 9)).toBe('0.040 SOL');
    expect(formatPrice(96_000_000n, 'SKR', 6)).toBe('96 SKR');
    expect(formatPrice(4_990_000n, 'USDC', 6)).toBe('4.99 USDC');
    expect(formatPrice(4_740_500n, 'PYUSD', 6)).toBe('4.74 PYUSD');
    expect(formatPrice(12_000_000n, 'JUP', 6)).toBe('12 JUP');
    // The fraction a discount leaves is shown as the chain charges it: 330 SKR at 25% off is 247.5 SKR, not 248.
    expect(formatPrice(discounted(330_000_000n, 2_500), 'SKR', 6)).toBe('247.5 SKR');
    expect(formatPrice(discounted(110_000_000n, 500), 'SOL', 9)).toBe('0.1045 SOL');
    expect(formatPrice(discounted(12_000_000n, 500), 'JUP', 6)).toBe('11.4 JUP');
    expect(formatPrice(discounted(1_800_000_000n, 2_500), 'SKR', 6)).toBe('1,350 SKR');
    expect(formatPrice(960_000n, 'SKR', 6)).toBe('0.96 SKR');
  });
});
