import { address, type Address } from '@solana/kit';
import { rpc } from './client.ts';
import { SGT_GROUP } from './config.ts';
import { findSeekerToken, type SeekerToken } from './sgt.ts';

/**
 * Returns the owner's Seeker Genesis Token mint, or null.
 *
 * Follows Solana Mobile's documented check (sgt.ts) against the configured group: the real one
 * on mainnet, the admin script's mock group on devnet (`VITE_SGT_GROUP`). The mint address is
 * unique per device, so perks should be de-duplicated on it (server-side for anything of value).
 */
export async function findSeekerGenesisToken(owner: string): Promise<Address | null> {
  return (await findSeekerProof(owner))?.mint ?? null;
}

/** The token account and mint the program checks (`prove_seeker_*`, the shop's Seeker discount), or null. */
export function findSeekerProof(owner: string): Promise<SeekerToken | null> {
  return findSeekerToken(rpc, owner, SGT_GROUP);
}

export async function solBalance(owner: string): Promise<number> {
  const { value } = await rpc.getBalance(address(owner)).send();
  return Number(value) / 1e9;
}

/** A wallet's balance of a mint (base units) from a token account; 0 when the account does not exist. */
export async function tokenBalance(tokenAccount: Address): Promise<bigint> {
  try {
    const { value } = await rpc.getTokenAccountBalance(tokenAccount).send();
    return BigInt(value.amount);
  } catch {
    return 0n;
  }
}
