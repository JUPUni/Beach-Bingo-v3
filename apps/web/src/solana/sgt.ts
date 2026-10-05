import { address, unwrapOption, type Address, type Rpc, type SolanaRpcApi } from '@solana/kit';
import { fetchAllMaybeMint, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

/** A Seeker Genesis Token as the program wants it: the holder's token account and the member mint. */
export interface SeekerToken {
  mint: Address;
  tokenAccount: Address;
}

interface ParsedTokenAccount {
  mint: string;
  tokenAmount: { amount: string };
}

/**
 * The owner's Seeker Genesis Token (Solana Mobile's documented check): a non-zero Token-2022
 * account whose mint has a MetadataPointer AND a TokenGroupMember that both point at `group`.
 * Pure of the app's wallet layer, so the scripts use it too; `seeker.ts` binds the app's RPC and
 * the configured group (a mock group on devnet, `VITE_SGT_GROUP`).
 */
export async function findSeekerToken(rpc: Rpc<SolanaRpcApi>, owner: string, group: string): Promise<SeekerToken | null> {
  const { value } = await rpc
    .getTokenAccountsByOwner(address(owner), { programId: TOKEN_2022_PROGRAM_ADDRESS }, { encoding: 'jsonParsed' })
    .send();
  const byMint = new Map<Address, Address>();
  for (const account of value) {
    const info = (account.account.data as { parsed: { info: ParsedTokenAccount } }).parsed.info;
    if (info.tokenAmount.amount !== '0' && !byMint.has(address(info.mint))) byMint.set(address(info.mint), account.pubkey);
  }
  const mints = [...byMint.keys()];
  for (let i = 0; i < mints.length; i += 100) {
    const batch = await fetchAllMaybeMint(rpc, mints.slice(i, i + 100));
    for (const mint of batch) {
      if (!mint.exists) continue;
      let metadata = false;
      let member = false;
      for (const ext of unwrapOption(mint.data.extensions) ?? []) {
        if (ext.__kind === 'MetadataPointer') metadata = unwrapOption(ext.metadataAddress) === group;
        if (ext.__kind === 'TokenGroupMember') member = ext.group === group;
      }
      if (metadata && member) return { mint: mint.address, tokenAccount: byMint.get(mint.address)! };
    }
  }
  return null;
}
