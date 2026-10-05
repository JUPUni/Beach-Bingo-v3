import { useEffect, useState } from 'react';
import {
  useConnect,
  useConnectedWallet,
  useDisconnect,
  useSignIn,
  useWalletStatus,
  useWallets,
} from '@solana/kit-plugin-wallet/react';
import { SolanaMobileWalletAdapterWalletName } from '@solana-mobile/wallet-standard-mobile';
import { sfx } from '../lib/audio.ts';
import { SEEKER_PERK_SHELLS, useGame } from '../state/store.ts';
import { GreenButton } from '../ui/kit.tsx';
import { Popup } from '../ui/Popup.tsx';
import { toast } from '../ui/toast.ts';
import { Badges } from './Badges.tsx';
import { walletClient } from './client.ts';
import { CHAIN_SHOP_ENABLED, CLUSTER, ONCHAIN_STAKES_ENABLED, isAndroid, isSeedVaultDevice, isWebShell, shellDeviceModel, shortAddress } from './config.ts';
import { findSeekerGenesisToken, solBalance } from './seeker.ts';
import { createSignInInput, verifySignInLocally } from './siws.ts';
import { formatAmount } from './tokens.ts';
import { refreshWalletStatus } from './walletStatus.ts';
import './wallet.css';

type UiWallet = ReturnType<typeof useWallets>[number];

export default function WalletPopup() {
  const close = useGame((s) => s.closePopup);
  const setLinkedWallet = useGame((s) => s.setLinkedWallet);
  const claimSeekerPerk = useGame((s) => s.claimSeekerPerk);
  const linked = useGame((s) => s.linkedWallet);
  const status = useGame((s) => s.walletStatus);
  const wallets = useWallets(walletClient);
  const connected = useConnectedWallet(walletClient);
  const walletStatus = useWalletStatus(walletClient);
  const connect = useConnect(walletClient);
  const disconnect = useDisconnect(walletClient);
  const signIn = useSignIn(walletClient);
  const [balance, setBalance] = useState<number | null>(null);
  const [seeker, setSeeker] = useState<'idle' | 'checking' | 'none' | string>('idle');
  const address = connected?.account.address ?? null;

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    solBalance(address)
      .then((b) => !cancelled && setBalance(b))
      .catch(() => !cancelled && setBalance(null));
    return () => {
      cancelled = true;
    };
  }, [address]);

  // Mobile Wallet Adapter first, labelled the way Solana Mobile's UX guidelines recommend.
  const sorted = [...wallets].sort(
    (a, b) => Number(b.name === SolanaMobileWalletAdapterWalletName) - Number(a.name === SolanaMobileWalletAdapterWalletName),
  );
  const label = (w: UiWallet) => (w.name === SolanaMobileWalletAdapterWalletName ? 'Use Installed Wallet' : w.name);

  const doSignIn = async () => {
    if (!connected) return;
    try {
      const input = createSignInInput();
      const output = await signIn.dispatchAsync(connected.wallet, input);
      if (verifySignInLocally(input, output)) {
        setLinkedWallet(output.account.address);
        sfx.win();
        toast('Wallet linked — signed in with Solana ✓', 'win');
      } else {
        toast('Signature did not verify', 'warn');
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Sign-in cancelled', 'warn');
    }
  };

  /** Look for the Seeker Genesis Token (and, in the devnet build, the SKR balance); the perk pays once per token on this device. */
  const verifySeeker = async () => {
    if (!address) return;
    setSeeker('checking');
    try {
      const mint = CHAIN_SHOP_ENABLED ? ((await refreshWalletStatus(address)).seeker?.mint ?? null) : await findSeekerGenesisToken(address);
      if (!mint) {
        setSeeker('none');
        return;
      }
      setSeeker(mint);
      if (claimSeekerPerk(mint)) {
        sfx.bingo();
        toast(`Seeker verified! +${SEEKER_PERK_SHELLS.toLocaleString('en-US')} shells and 8 boosters 🌴`, 'win');
      } else {
        toast('Seeker verified — perk already claimed on this device');
      }
    } catch {
      setSeeker('idle');
      toast('Could not reach the Solana RPC — try again later', 'warn');
    }
  };

  const skr = status && status.address === address && status.skrBalance !== null ? BigInt(status.skrBalance) : null;

  return (
    <Popup title="Wallet" onClose={close} wide>
      <p className="small-note">
        Link a Solana wallet to carry your beach profile to the Seeker, claim Seeker perks and pay for coin packs. Beach Bingo never
        asks for your seed phrase. Shells stay free; coins are bought in the Coin Shop and never leave the game. Network: <b>{CLUSTER}</b>
        {isWebShell() ? ' · dApp Store app' : ''}
        {isSeedVaultDevice() ? ` · Seed Vault device${shellDeviceModel() ? ` (${shellDeviceModel()})` : ''}` : ''}.
      </p>

      {!connected ? (
        <>
          <h3>Connect</h3>
          {walletStatus === 'pending' || walletStatus === 'reconnecting' ? <p className="small-note">Looking for wallets…</p> : null}
          <div className="wallet-list">
            {sorted.map((w) => (
              <button
                key={w.name}
                type="button"
                className="wallet-btn"
                disabled={connect.isRunning}
                onClick={() => {
                  sfx.click();
                  // Connect straight from the tap: Chrome blocks wallet intents without a user gesture.
                  connect.dispatch(w);
                }}
              >
                {w.icon ? <img src={w.icon} alt="" /> : <span className="wallet-btn__dot" />}
                <span>{label(w)}</span>
              </button>
            ))}
          </div>
          {sorted.length === 0 && (
            <p className="small-note">
              No wallet found. {isAndroid() ? 'Install a Solana wallet or open Beach Bingo on a Solana Seeker.' : 'Install Phantom, Solflare or Backpack, then reopen this window.'}
            </p>
          )}
          {connect.isError && <p className="small-note neg">{String((connect.error as Error)?.message ?? connect.error)}</p>}
        </>
      ) : (
        <>
          <div className="wallet-card">
            {connected.wallet.icon && <img src={connected.wallet.icon} alt="" />}
            <div>
              <b>{shortAddress(connected.account.address)}</b>
              <small>
                {connected.wallet.name} · {balance === null ? '… SOL' : `${balance.toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`}
              </small>
            </div>
            {linked === connected.account.address && <span className="wallet-card__ok">✓ linked</span>}
          </div>
          {skr !== null && <p className="small-note wallet-skr">{formatAmount(skr, 6, 'SKR')} in this wallet{skr > 0n ? (ONCHAIN_STAKES_ENABLED ? ' — the shop and the stake picker start on SKR.' : ' — the shop starts on SKR.') : '.'}</p>}
          <Badges />
          <div className="wallet-actions">
            <GreenButton onClick={doSignIn} disabled={signIn.isRunning}>
              {linked === connected.account.address ? 'Re-sign' : 'Sign in'}
            </GreenButton>
            <GreenButton tone="gold" onClick={verifySeeker} disabled={seeker === 'checking'}>
              {seeker === 'checking' ? 'Checking…' : 'Verify Seeker'}
            </GreenButton>
          </div>
          {seeker === 'none' && <p className="small-note">No Seeker Genesis Token in this wallet — perks are for Solana Seeker owners.</p>}
          {seeker.length > 20 && <p className="small-note">Seeker Genesis Token: {shortAddress(seeker)} 🌴</p>}
          <button type="button" className="wallet-disconnect" onClick={() => disconnect.dispatch()}>
            Disconnect
          </button>
        </>
      )}

      <div className="divider" />
      <h3>SOL, USDC, PYUSD, JUP and SKR</h3>
      <p className="small-note">
        {ONCHAIN_STAKES_ENABLED
          ? 'Devnet stakes are enabled: staked Wave Rush rooms and halls in SOL or a test token, and the Coin Shop paid in the same. Pay with SKR for the lowest house fee and the best pack price; a Seeker verified on chain pays less again. Badges describe your wallet and never grant anything by themselves.'
          : 'The Coin Shop takes these five tokens, SKR at the best price. Staked rooms stay switched off on this site: real-money bingo is regulated gambling, so they wait for licensing, geo-checks and age verification. Playing with shells is free for everyone.'}
      </p>
    </Popup>
  );
}
