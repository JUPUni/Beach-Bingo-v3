import { decimalsOf, knownSymbol, shortMint, SOL_DECIMALS, symbolOf } from '../../solana/tokens.ts';
import { MAX_STAKE, MIN_STAKE, STAKE_PRESETS, type ConfigAccount } from '../../solana/waveDuel.ts';
import type { MintEntryAccount } from '../../solana/waveToken.ts';

/**
 * The stake picker's choices: SOL plus every enabled mint of the registry, each with the bounds,
 * the presets and the fee tiers the program holds for it. Pure, so the mapping is tested without
 * a chain. SKR comes first and is preselected when the wallet holds some; SOL second; then the
 * other named tokens in the app's order; a registered mint the app has no name for comes last,
 * shown by its short address.
 */
export interface StakeChoice {
  /** 'SOL', or the mint address. */
  key: string;
  mint: string | null;
  symbol: string;
  decimals: number;
  entry: MintEntryAccount | null;
  feeBps: number;
  seekerFeeBps: number;
  min: bigint;
  max: bigint;
  /** Up to five amounts in base units, the smallest first. */
  presets: bigint[];
}

const ORDER = ['SKR', 'SOL', 'USDC', 'PYUSD', 'JUP'];
/** Round numbers to offer as presets, in display units; the first five inside the bounds are used. */
const NICE = [1, 2, 5, 10, 20, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

/** Five round stakes between the bounds (the minimum itself first when no round number sits on it). */
export function presetsBetween(min: bigint, max: bigint, decimals: number): bigint[] {
  const unit = 10n ** BigInt(decimals);
  const out: bigint[] = [];
  for (const n of NICE) {
    const v = BigInt(n) * unit;
    if (v < min || v > max) continue;
    out.push(v);
    if (out.length === 5) break;
  }
  if (out.length === 0 || out[0]! !== min) out.unshift(min);
  return out.slice(0, 5);
}

export function stakeChoices(config: ConfigAccount | null, entries: readonly MintEntryAccount[]): StakeChoice[] {
  const sol: StakeChoice = {
    key: 'SOL',
    mint: null,
    symbol: 'SOL',
    decimals: SOL_DECIMALS,
    entry: null,
    feeBps: config?.feeBps ?? 0,
    seekerFeeBps: config?.solSeekerFeeBps ?? config?.feeBps ?? 0,
    min: MIN_STAKE,
    max: MAX_STAKE,
    presets: [...STAKE_PRESETS],
  };
  const tokens: StakeChoice[] = entries
    .filter((e) => e.enabled)
    .map((e) => ({
      key: e.mint,
      mint: e.mint,
      symbol: knownSymbol(e.mint) ?? shortMint(e.mint),
      decimals: e.decimals,
      entry: e,
      feeBps: e.feeBps,
      seekerFeeBps: e.seekerFeeBps,
      min: e.minStake,
      max: e.maxStake,
      presets: presetsBetween(e.minStake, e.maxStake, e.decimals),
    }));
  const rank = (c: StakeChoice) => {
    const i = ORDER.indexOf(c.symbol);
    return i < 0 ? ORDER.length : i;
  };
  return [sol, ...tokens].sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
}

/** SKR when the wallet holds some and the registry sells it; SOL otherwise. */
export function defaultChoice(choices: readonly StakeChoice[], skrHeld: boolean): StakeChoice {
  const skr = skrHeld ? choices.find((c) => c.symbol === 'SKR') : undefined;
  return skr ?? choices.find((c) => c.key === 'SOL') ?? choices[0]!;
}

const pct = (bps: number) => `${(bps / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;

/** "House fee 2.5% with SKR", "House fee 2% as a verified Seeker", "House fee 5%". */
export function feeLine(choice: Pick<StakeChoice, 'symbol' | 'feeBps' | 'seekerFeeBps'>, seekerProved: boolean): string {
  if (seekerProved) return `House fee ${pct(choice.seekerFeeBps)} as a verified Seeker`;
  return choice.symbol === 'SKR' ? `House fee ${pct(choice.feeBps)} with SKR` : `House fee ${pct(choice.feeBps)}`;
}

/** The choice a stake on chain was made with, from its mint (SOL when none); unknown mints still get a choice from the table. */
export function choiceFor(choices: readonly StakeChoice[], mint: string | null): StakeChoice | null {
  const found = choices.find((c) => c.mint === mint);
  if (found) return found;
  if (!mint) return null;
  return {
    key: mint,
    mint,
    symbol: symbolOf(mint),
    decimals: decimalsOf(mint),
    entry: null,
    feeBps: 0,
    seekerFeeBps: 0,
    min: 0n,
    max: 0n,
    presets: [],
  };
}
