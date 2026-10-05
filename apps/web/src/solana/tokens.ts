/**
 * The five assets as the app names them, their known mints on both clusters, and the amount
 * formatting every screen shares. Nothing here reads the chain: the registry (`MintEntry`,
 * waveToken.ts) says which mints are enabled and at what terms; this table only turns a mint
 * address into a symbol and a decimal count the UI can show before (or without) that read.
 * A registered mint missing here is still playable: it is shown by its short address.
 */
export type TokenSymbol = 'SOL' | 'SKR' | 'USDC' | 'PYUSD' | 'JUP';

/** SKR first: the game's main token, preselected wherever the wallet holds it. */
export const TOKEN_SYMBOLS: readonly TokenSymbol[] = ['SKR', 'SOL', 'USDC', 'PYUSD', 'JUP'];
export const SOL_DECIMALS = 9;

export interface KnownMint {
  symbol: TokenSymbol;
  decimals: number;
  cluster: 'mainnet' | 'devnet';
  /** Devnet stand-ins created by the admin script (docs/plans/2026-10-05-tokens-design.md §7b). */
  note?: string;
}

export const KNOWN_MINTS: Readonly<Record<string, KnownMint>> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: { symbol: 'USDC', decimals: 6, cluster: 'mainnet' },
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': { symbol: 'PYUSD', decimals: 6, cluster: 'mainnet' },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: 'JUP', decimals: 6, cluster: 'mainnet' },
  SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3: { symbol: 'SKR', decimals: 6, cluster: 'mainnet' },
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': { symbol: 'USDC', decimals: 6, cluster: 'devnet', note: "Circle's devnet USDC" },
  CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM: { symbol: 'PYUSD', decimals: 6, cluster: 'devnet', note: "Paxos's devnet PYUSD" },
  '8ag6aEwVmBNgvSECWartbSJXSgEtYbhbT87hoUPrBApV': { symbol: 'PYUSD', decimals: 6, cluster: 'devnet', note: 'look-alike' },
  '8r9rjzkMoUEJ4pxy38UvXwokiCjRkq9vWhWyJMMF1UCW': { symbol: 'JUP', decimals: 6, cluster: 'devnet', note: 'look-alike' },
  GY3JAeDQskMFYz25VJwdFUg8yDEVNhEfP6vUFDm4RPzz: { symbol: 'SKR', decimals: 6, cluster: 'devnet', note: 'look-alike' },
};

export const shortMint = (mint: string): string => `${mint.slice(0, 4)}…${mint.slice(-4)}`;

/** The symbol of a known mint, or null for one the table does not name. */
export function knownSymbol(mint: string): TokenSymbol | null {
  return KNOWN_MINTS[mint]?.symbol ?? null;
}

/** What to call a stake's asset: SOL for no mint, the symbol of a known mint, the short address otherwise. */
export function symbolOf(mint: string | null | undefined): string {
  if (!mint) return 'SOL';
  return knownSymbol(mint) ?? shortMint(mint);
}

/** The decimals to format a mint's amounts with before the registry is read (every supported token has 6). */
export function decimalsOf(mint: string | null | undefined, fallback = 6): number {
  if (!mint) return SOL_DECIMALS;
  return KNOWN_MINTS[mint]?.decimals ?? fallback;
}

export function fromBase(base: bigint, decimals: number): number {
  return Number(base) / 10 ** decimals;
}

/** Display units to base units, exactly (the string path avoids float error on "4.99"). */
export function toBase(display: number | string, decimals: number): bigint {
  const text = typeof display === 'number' ? display.toFixed(decimals) : display.trim();
  const m = /^(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m) throw new Error(`not an amount: ${display}`);
  const whole = m[1] || '0';
  const frac = (m[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac || '0');
}

/** "50 SKR", "4.99 USDC", "0.01 SOL": up to four fraction digits, trailing zeros dropped. */
export function formatAmount(base: bigint, decimals: number, symbol: string): string {
  const value = fromBase(base, decimals);
  return `${value.toLocaleString('en-US', { maximumFractionDigits: Math.min(decimals, 4) })} ${symbol}`;
}

/** A stake amount in its own units: lamports for SOL, base units of the mint otherwise. */
export function formatStake(base: bigint, mint: string | null | undefined, decimals = decimalsOf(mint)): string {
  return formatAmount(base, decimals, symbolOf(mint));
}
