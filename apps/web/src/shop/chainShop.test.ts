import { describe, expect, it } from 'vitest';
import type { Address } from '@solana/kit';
import { TOKEN_2022_PROGRAM, TOKEN_PROGRAM, type MintEntryAccount } from '../solana/waveToken.ts';
import type { ConfigAccount } from '../solana/waveDuel.ts';
import { catalogueFrom, packId, packIndex, restoreAmount } from './chainShop.ts';
import { quote } from './shop.ts';

const KEY = '5VcGxKLHDJhPAFSN8VK9qpxkM4gniQtPKwRrMnUcqA8u' as Address;
export const SKR = 'GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz' as Address;
export const JUP = '8r9rjzkMoUEJ4pxy38UvXwokiCjRkq9vWhWyJMMF1UCW' as Address;
export const USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' as Address;
export const PYUSD_LOOKALIKE = '8ag6aEwVmBNgvSECWartbSJXSgEtYbhbT87hoUPrBApV' as Address;
export const PYUSD_DEVNET = 'CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM' as Address;
export const UNKNOWN = '3VNBmFpQ1hrTbNF4wMKwQ57zxZ6cwGZEYGJoNv41tVf6' as Address;

/** The devnet config as `show` prints it. */
export const config: ConfigAccount = {
  admin: KEY,
  treasury: KEY,
  feeBps: 500,
  paused: false,
  pauser: KEY,
  sgtGroup: 'GRhL4t47LyWkVtHJ3ierasdcxyjXmzkE6uMJvv38CsHn' as Address,
  packCoins: [5000, 15000, 40000, 100000],
  seekerDiscountBps: 500,
  solPackPrices: [40_000_000n, 110_000_000n, 270_000_000n, 600_000_000n],
  solSeekerFeeBps: 400,
};

export function entry(mint: Address, over: Partial<MintEntryAccount> = {}): MintEntryAccount {
  return {
    address: KEY,
    mint,
    tokenProgram: TOKEN_PROGRAM,
    decimals: 6,
    minStake: 1_000_000n,
    maxStake: 100_000_000n,
    feeBps: 500,
    seekerFeeBps: 400,
    enabled: true,
    flags: { hasFreezeAuthority: false, permanentDelegate: false, transferFeeConfigPresent: false, pausable: false, defaultStateFrozen: false, hookProgram: null },
    treasuryAta: KEY,
    packPrices: [4_990_000n, 13_990_000n, 34_990_000n, 79_990_000n],
    discountBps: 0,
    ...over,
  };
}

/** The devnet registry as `show-mints` prints it, plus an unknown mint and a disabled one. */
export const entries: MintEntryAccount[] = [
  entry(JUP, { minStake: 2_000_000n, maxStake: 500_000_000n, packPrices: [12_000_000n, 33_000_000n, 82_000_000n, 0n] }),
  entry(SKR, { minStake: 50_000_000n, maxStake: 5_000_000_000n, feeBps: 250, seekerFeeBps: 200, packPrices: [120_000_000n, 330_000_000n, 800_000_000n, 1_800_000_000n], discountBps: 2_000 }),
  entry(PYUSD_DEVNET, { tokenProgram: TOKEN_2022_PROGRAM }),
  entry(USDC, { enabled: false }),
  entry(PYUSD_LOOKALIKE, { tokenProgram: TOKEN_2022_PROGRAM }),
  entry(UNKNOWN, { packPrices: [1n, 1n, 1n, 1n] }),
];

describe('the chain shop catalogue', () => {
  const cat = catalogueFrom(config, entries);

  it('prices every pack from the config and the registry, in base units with the token decimals and discount', () => {
    expect(cat.packs.map((p) => p.coins)).toEqual([5000, 15000, 40000, 100000]);
    expect(cat.packs.map((p) => p.id)).toEqual(['pack-0', 'pack-1', 'pack-2', 'pack-3']);
    expect(cat.seekerDiscountBps).toBe(500);
    const first = cat.packs[0]!;
    expect(first.offers.SOL).toEqual({ base: 40_000_000n, decimals: 9, discountBps: 0 });
    expect(first.offers.SKR).toEqual({ base: 120_000_000n, decimals: 6, discountBps: 2_000 });
    expect(first.offers.PYUSD).toEqual({ base: 4_990_000n, decimals: 6, discountBps: 0 });
    expect(first.offers.JUP).toEqual({ base: 12_000_000n, decimals: 6, discountBps: 0 });
  });

  it('offers only mints with a non-zero price for the pack, skips disabled and unnamed mints, and takes the first entry by address when two share a symbol', () => {
    expect(cat.packs[3]!.offers.JUP).toBeUndefined();
    expect(cat.packs[0]!.offers.USDC).toBeUndefined();
    expect(Object.keys(cat.packs[0]!.offers).sort()).toEqual(['JUP', 'PYUSD', 'SKR', 'SOL']);
    expect(cat.mints.PYUSD?.mint).toBe(PYUSD_LOOKALIKE);
    expect(cat.mints.USDC).toBeUndefined();
  });

  it('quotes the program price: SKR 20% off, 25% off with the Seeker proof, SOL with the Seeker saving only', () => {
    const first = cat.packs[0]!;
    expect(quote(first, 'SKR', false, cat.seekerDiscountBps)).toBe(96_000_000n);
    expect(quote(first, 'SKR', true, cat.seekerDiscountBps)).toBe(90_000_000n);
    expect(quote(first, 'SOL', true, cat.seekerDiscountBps)).toBe(38_000_000n);
    expect(quote(first, 'PYUSD', false, cat.seekerDiscountBps)).toBe(4_990_000n);
  });

  it('round-trips pack ids and restores only the difference to the chain total', () => {
    expect(packIndex(packId(2))).toBe(2);
    expect(packIndex('pack-5k')).toBeNull();
    expect(restoreAmount(5_000n, 0)).toBe(5000);
    expect(restoreAmount(20_000n, 15_000)).toBe(5000);
    expect(restoreAmount(5_000n, 5_000)).toBe(0);
    expect(restoreAmount(5_000n, 9_000)).toBe(0);
  });
});
