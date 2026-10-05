import { describe, expect, it } from 'vitest';
import { badges } from './badges.ts';
import { decimalsOf, formatAmount, formatStake, symbolOf, toBase } from './tokens.ts';

describe('wallet and device badges', () => {
  const none = { seekerToken: null, seedVaultDevice: false, deviceModel: null, skrBalance: null };

  it('shows nothing for a plain wallet on a plain browser', () => {
    expect(badges(none)).toEqual([]);
    expect(badges({ ...none, skrBalance: 0n })).toEqual([]);
  });

  it('names the Seeker, the Seed Vault device and SKR, each from its own signal', () => {
    const all = badges({ seekerToken: 'DajAyfr9wkxFgUDNeQ1pQBKBAscqdHRjmNFhh2FKJYTz', seedVaultDevice: true, deviceModel: 'Seeker', skrBalance: 50_000_000n });
    expect(all.map((b) => b.id)).toEqual(['seeker', 'seedVault', 'skr']);
    expect(all.map((b) => b.label)).toEqual(['Seeker verified', 'Seed Vault device (Seeker)', 'SKR ready']);
  });

  it('puts the Seeker ID first, as the name itself', () => {
    const list = badges({ ...none, seekerId: 'poseid0n.skr', seekerToken: 'x' });
    expect(list.map((b) => b.id)).toEqual(['seekerId', 'seeker']);
    expect(list[0]!.label).toBe('poseid0n.skr');
    expect(badges({ ...none, seekerId: null })).toEqual([]);
  });

  it('marks the proof once the instruction landed, and a Seed Vault without a model', () => {
    expect(badges({ ...none, seekerToken: 'x', provedThisRound: true })[0]!.label).toBe('Seeker verified · proved this round');
    expect(badges({ ...none, seedVaultDevice: true })[0]!.label).toBe('Seed Vault device');
    // A proof without a token cannot happen; the badge follows the token, not the flag.
    expect(badges({ ...none, provedThisRound: true })).toEqual([]);
  });
});

describe('token amounts', () => {
  it('formats per decimals and names known mints', () => {
    expect(formatAmount(50_000_000n, 6, 'SKR')).toBe('50 SKR');
    expect(formatAmount(4_990_000n, 6, 'USDC')).toBe('4.99 USDC');
    expect(formatStake(10_000_000n, null)).toBe('0.01 SOL');
    expect(formatStake(292_500_000n, 'GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz')).toBe('292.5 SKR');
    expect(symbolOf(null)).toBe('SOL');
    expect(symbolOf('8ag6aEwVmBNgvSECWartbSJXSgEtYbhbT87hoUPrBApV')).toBe('PYUSD');
    expect(symbolOf('3VNBmFpQ1hrTbNF4wMKwQ57zxZ6cwGZEYGJoNv41tVf6')).toBe('3VNB…tVf6');
    expect(decimalsOf(null)).toBe(9);
    expect(decimalsOf('3VNBmFpQ1hrTbNF4wMKwQ57zxZ6cwGZEYGJoNv41tVf6')).toBe(6);
  });

  it('turns display amounts into base units exactly', () => {
    expect(toBase('4.99', 6)).toBe(4_990_000n);
    expect(toBase(0.04, 9)).toBe(40_000_000n);
    expect(toBase('50', 6)).toBe(50_000_000n);
    expect(toBase('0.1234567', 6)).toBe(123_456n);
    expect(() => toBase('abc', 6)).toThrow();
  });
});
