import { createClient, createSolanaRpc } from '@solana/kit';
import { walletSigner } from '@solana/kit-plugin-wallet';
import {
  createDefaultAuthorizationCache,
  createDefaultChainSelector,
  createDefaultWalletNotFoundHandler,
  registerMwa,
} from '@solana-mobile/wallet-standard-mobile';
import { CHAIN, RPC_URL } from './config.ts';

/**
 * Wallet + RPC client (lazy-loaded with the wallet popup).
 *
 * - Desktop: Phantom, Solflare, Backpack, … announce themselves through Wallet Standard.
 * - Android Chrome and the dApp Store WebView shell: `registerMwa` adds the Mobile Wallet Adapter
 *   wallet (Seed Vault on Seeker) — shown as "Use Installed Wallet".
 */
registerMwa({
  appIdentity: { name: 'Beach Bingo', uri: 'https://beachbingo.xyz', icon: 'assets/icons/icon-192.png' },
  authorizationCache: createDefaultAuthorizationCache(),
  chains: ['solana:mainnet', 'solana:devnet'],
  chainSelector: createDefaultChainSelector(),
  onWalletNotFound: createDefaultWalletNotFoundHandler(),
});

const storage = {
  getItem: (key: string) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key: string, value: string) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* storage unavailable */
    }
  },
  removeItem: (key: string) => {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  },
};

export const walletClient = createClient().use(walletSigner({ chain: CHAIN, storage, storageKey: 'beach-bingo:wallet' }));

export const rpc = createSolanaRpc(RPC_URL);

export type WalletClient = typeof walletClient;
