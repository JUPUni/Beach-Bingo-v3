import { describe, expect, it } from 'vitest';
import { config, entries, entry, JUP, PYUSD_DEVNET, PYUSD_LOOKALIKE, SKR, UNKNOWN } from '../../shop/chainShop.test.ts';
import { MAX_STAKE, MIN_STAKE, STAKE_PRESETS } from '../../solana/waveDuel.ts';
import { choiceFor, defaultChoice, feeLine, presetsBetween, stakeChoices } from './stakeTokens.ts';

const U = 1_000_000n;

describe('the stake picker', () => {
  const choices = stakeChoices(config, entries);

  it('lists SKR first, then SOL, the named tokens in the app order, and unnamed mints last; a disabled mint is left out', () => {
    expect(choices.map((c) => c.symbol)).toEqual(['SKR', 'SOL', 'PYUSD', 'PYUSD', 'JUP', '3VNB…tVf6']);
    expect(choices.map((c) => c.key)).toEqual([SKR, 'SOL', PYUSD_LOOKALIKE, PYUSD_DEVNET, JUP, UNKNOWN]);
    expect(choices.find((c) => c.symbol === 'USDC')).toBeUndefined();
  });

  it('carries the registry terms: bounds, fee tiers, decimals, program', () => {
    const skr = choices[0]!;
    expect(skr).toMatchObject({ mint: SKR, decimals: 6, feeBps: 250, seekerFeeBps: 200, min: 50n * U, max: 5_000n * U });
    expect(skr.entry?.tokenProgram).toBe(entries[1]!.tokenProgram);
    const sol = choices[1]!;
    expect(sol).toMatchObject({ key: 'SOL', mint: null, decimals: 9, feeBps: 500, seekerFeeBps: 400, min: MIN_STAKE, max: MAX_STAKE, entry: null });
    expect(sol.presets).toEqual([...STAKE_PRESETS]);
  });

  it('offers round presets inside the bounds, the minimum first when it is not round', () => {
    expect(presetsBetween(50n * U, 5_000n * U, 6)).toEqual([50n, 100n, 250n, 500n, 1000n].map((n) => n * U));
    expect(presetsBetween(U, 100n * U, 6)).toEqual([1n, 2n, 5n, 10n, 20n].map((n) => n * U));
    expect(presetsBetween(2n * U, 500n * U, 6)).toEqual([2n, 5n, 10n, 20n, 25n].map((n) => n * U));
    expect(presetsBetween(3n * U, 100n * U, 6)).toEqual([3n, 5n, 10n, 20n, 25n].map((n) => n * U));
    expect(presetsBetween(7n, 9n, 6)).toEqual([7n]);
    expect(choices.find((c) => c.symbol === 'JUP')!.presets).toEqual([2n, 5n, 10n, 20n, 25n].map((n) => n * U));
  });

  it('preselects SKR when the wallet holds some, SOL otherwise, and falls back to SOL without a registry', () => {
    expect(defaultChoice(choices, true).symbol).toBe('SKR');
    expect(defaultChoice(choices, false).symbol).toBe('SOL');
    const solOnly = stakeChoices(config, []);
    expect(solOnly.map((c) => c.key)).toEqual(['SOL']);
    expect(defaultChoice(solOnly, true).symbol).toBe('SOL');
    expect(stakeChoices(null, [entry(SKR, { feeBps: 250 })])[1]!.feeBps).toBe(0);
  });

  it('names the fee tier per token', () => {
    expect(feeLine(choices[0]!, false)).toBe('House fee 2.5% with SKR');
    expect(feeLine(choices[0]!, true)).toBe('House fee 2% as a verified Seeker');
    expect(feeLine(choices[1]!, false)).toBe('House fee 5%');
    expect(feeLine(choices[1]!, true)).toBe('House fee 4% as a verified Seeker');
  });

  it('finds the choice a stake on chain was made with, and shapes one for a mint the registry no longer lists', () => {
    expect(choiceFor(choices, null)?.key).toBe('SOL');
    expect(choiceFor(choices, SKR)?.symbol).toBe('SKR');
    const gone = choiceFor(choices, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(gone).toMatchObject({ symbol: 'USDC', decimals: 6, entry: null });
    expect(choiceFor([], null)).toBeNull();
  });
});
