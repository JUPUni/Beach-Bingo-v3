import { getAddressEncoder, type Address } from '@solana/kit';
import type { LiteSVM } from 'litesvm';
import { programDataAddress } from './waveDuel.ts';

/**
 * LiteSVM installs a program with a ProgramData account whose upgrade authority is None.
 * `init_config` admits only that authority, so a test names its admin as the authority first.
 * UpgradeableLoaderState::ProgramData is a u32 tag, a u64 slot, then Option<Pubkey> (one byte
 * and 32), followed by the ELF.
 */
export async function grantUpgradeAuthority(svm: LiteSVM, program: Address, authority: Address): Promise<void> {
  const pda = await programDataAddress();
  const account = svm.getAccount(pda);
  if (!account.exists) throw new Error(`no ProgramData account for ${program}`);
  const data = new Uint8Array(account.data);
  data[12] = 1;
  data.set(getAddressEncoder().encode(authority), 13);
  svm.setAccount({ ...account, data });
}
