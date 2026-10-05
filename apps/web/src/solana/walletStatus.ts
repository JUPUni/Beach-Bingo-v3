import { address, type Address } from '@solana/kit';
import { useGame, type WalletStatus } from '../state/store.ts';
import { rpc } from './client.ts';
import { SGT_GROUP } from './config.ts';
import { findSeekerToken } from './sgt.ts';
import { tokenBalance } from './seeker.ts';
import { knownSymbol } from './tokens.ts';
import { ataAddress, fetchMintEntries, type MintEntryAccount } from './waveToken.ts';
import { enabled as programConfigured } from './waveDuel.ts';

/**
 * What the app knows about the connected wallet beyond its address: its Seeker Genesis Token (the
 * proof the program accepts) and its SKR balance. Read once per connection by the chain bridge
 * and on demand ("Verify Seeker"); kept in the store for the badges, the shop and the stake
 * panels. Nothing here grants anything: the program re-checks the token on every proof.
 */
let entriesCache: { at: number; entries: MintEntryAccount[] } | null = null;

/** The registry, cached for a minute: the picker and the status share one read. */
export async function registryEntries(): Promise<MintEntryAccount[]> {
  if (!programConfigured()) return [];
  if (entriesCache && Date.now() - entriesCache.at < 60_000) return entriesCache.entries;
  const entries = await fetchMintEntries(rpc);
  entriesCache = { at: Date.now(), entries };
  return entries;
}

export const skrEntry = (entries: MintEntryAccount[]): MintEntryAccount | null => entries.find((e) => e.enabled && knownSymbol(e.mint) === 'SKR') ?? null;

/** The wallet's token account for a registry mint (its ATA). */
export const walletAta = (wallet: string, entry: MintEntryAccount): Promise<Address> => ataAddress(address(wallet), entry.mint, entry.tokenProgram);

export async function loadWalletStatus(wallet: string): Promise<WalletStatus> {
  const [seeker, entries] = await Promise.all([findSeekerToken(rpc, wallet, SGT_GROUP).catch(() => null), registryEntries().catch(() => [] as MintEntryAccount[])]);
  const skr = skrEntry(entries);
  const skrBalance = skr ? (await tokenBalance(await walletAta(wallet, skr))).toString() : null;
  return { address: wallet, seeker: seeker ? { mint: seeker.mint, tokenAccount: seeker.tokenAccount } : null, skrBalance };
}

/** Read the wallet again and put the answer in the store ("Verify Seeker", a fresh connection). */
export async function refreshWalletStatus(wallet: string): Promise<WalletStatus> {
  const status = await loadWalletStatus(wallet);
  useGame.getState().setWalletStatus(status);
  return status;
}
