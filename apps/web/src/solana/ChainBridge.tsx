import { useEffect } from 'react';
import { address } from '@solana/kit';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import { createChainShop } from '../shop/chainShop.ts';
import { registerShop } from '../shop/shop.ts';
import { useGame } from '../state/store.ts';
import { rpc, walletClient } from './client.ts';
import { CHAIN } from './config.ts';
import { refreshWalletStatus } from './walletStatus.ts';

/**
 * The devnet build's link between the wallet layer and the game: while a wallet is connected the
 * chain Coin Shop (`buy_pack` / `buy_pack_token` through its sending signer) is the shop the popup
 * sells through, and the wallet's Seeker Genesis Token and SKR balance are read into the store for
 * the badges, the shop's Seeker saving and the SKR preselection. Disconnecting unplugs the shop
 * and clears the status. Mounted by App.tsx only when `CHAIN_SHOP_ENABLED` (the stakes flag and a
 * program), so production builds never load it and keep no shop at all.
 */
type Connected = NonNullable<ReturnType<typeof useConnectedWallet>>;

export default function ChainBridge() {
  const connected = useConnectedWallet(walletClient);
  useEffect(() => {
    if (connected) return;
    registerShop(null);
    useGame.getState().setWalletStatus(null);
  }, [connected]);
  return connected ? <Bound account={connected.account} /> : null;
}

function Bound({ account }: { account: Connected['account'] }) {
  const signer = useWalletAccountTransactionSendingSigner(account, CHAIN as never);
  const wallet = account.address;
  useEffect(() => {
    const owner = address(wallet);
    registerShop(
      createChainShop({
        rpc,
        signer,
        wallet: owner,
        seeker: () => {
          const s = useGame.getState().walletStatus;
          return s && s.address === wallet && s.seeker ? { tokenAccount: address(s.seeker.tokenAccount), mint: address(s.seeker.mint) } : null;
        },
        credited: () => useGame.getState().credited[wallet] ?? 0,
      }),
    );
    void refreshWalletStatus(wallet).catch(() => undefined);
    return () => registerShop(null);
  }, [wallet, signer]);
  return null;
}
