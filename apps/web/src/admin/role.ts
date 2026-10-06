import { useEffect, useState } from 'react';
import { address } from '@solana/kit';
import { rpc } from '../solana/client.ts';
import { CHAIN_SHOP_ENABLED } from '../solana/config.ts';
import * as duel from '../solana/waveDuel.ts';

export type AdminRole = 'admin' | 'pauser';

/** Which role `wallet` holds in the program's config, or null. The admin outranks the pauser when one wallet holds both. */
export function roleOf(wallet: string, config: Pick<duel.ConfigAccount, 'admin' | 'pauser'>): AdminRole | null {
  if (wallet === config.admin) return 'admin';
  if (wallet === config.pauser) return 'pauser';
  return null;
}

/**
 * The connected wallet's role, read from the chain (null while reading, for any other wallet, and
 * in a build that knows no program). Only decides whether the wallet popup offers the Admin
 * button: the program checks the signer on every admin instruction itself.
 */
export function useAdminRole(wallet: string | null): AdminRole | null {
  const [read, setRead] = useState<{ wallet: string; role: AdminRole | null } | null>(null);
  useEffect(() => {
    if (!wallet || !CHAIN_SHOP_ENABLED) return;
    let live = true;
    duel
      .fetchConfig(rpc)
      .then((config) => live && setRead({ wallet, role: config ? roleOf(address(wallet), config) : null }))
      .catch(() => live && setRead({ wallet, role: null }));
    return () => {
      live = false;
    };
  }, [wallet]);
  return read && read.wallet === wallet ? read.role : null;
}
