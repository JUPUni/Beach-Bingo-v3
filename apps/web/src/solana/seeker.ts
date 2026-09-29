import { address, unwrapOption, type Address } from '@solana/kit';
import { fetchAllMaybeMint, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { rpc } from './client.ts';
import { SGT_GROUP } from './config.ts';

interface ParsedTokenAccount {
  mint: string;
  tokenAmount: { amount: string };
}

/**
 * Returns the owner's Seeker Genesis Token mint, or null.
 *
 * Follows Solana Mobile's documented check: a non-zero Token-2022 account whose mint has a
 * MetadataPointer AND a TokenGroupMember that both point at the SGT group. The mint address is
 * unique per device, so perks should be de-duplicated on it (server-side for anything of value).
 */
export async function findSeekerGenesisToken(owner: string): Promise<Address | null> {
  const { value } = await rpc
    .getTokenAccountsByOwner(address(owner), { programId: TOKEN_2022_PROGRAM_ADDRESS }, { encoding: 'jsonParsed' })
    .send();
  const mints = value
    .map((account) => (account.account.data as { parsed: { info: ParsedTokenAccount } }).parsed.info)
    .filter((info) => info.tokenAmount.amount !== '0')
    .map((info) => address(info.mint));

  for (let i = 0; i < mints.length; i += 100) {
    const batch = await fetchAllMaybeMint(rpc, mints.slice(i, i + 100));
    for (const mint of batch) {
      if (!mint.exists) continue;
      let metadata = false;
      let group = false;
      for (const ext of unwrapOption(mint.data.extensions) ?? []) {
        if (ext.__kind === 'MetadataPointer') metadata = unwrapOption(ext.metadataAddress) === SGT_GROUP;
        if (ext.__kind === 'TokenGroupMember') group = ext.group === SGT_GROUP;
      }
      if (metadata && group) return mint.address;
    }
  }
  return null;
}

export async function solBalance(owner: string): Promise<number> {
  const { value } = await rpc.getBalance(address(owner)).send();
  return Number(value) / 1e9;
}
