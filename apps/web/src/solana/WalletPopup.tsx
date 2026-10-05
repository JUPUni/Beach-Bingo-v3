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
import { CLUSTER, ONCHAIN_STAKES_ENABLED, isAndroid, isSeedVaultDevice, isWebShell, shellDeviceModel, shortAddress } from './config.ts';
import { solBalance } from './seeker.ts';
import { linkSeeker, refreshSeekerLink } from './seekerLink.ts';
import { createSignInInput, verifySignInLocally } from './siws.ts';
import { formatAmount } from './tokens.ts';
import './wallet.css';

type UiWallet = ReturnType<typeof useWallets>[number];

/**
 * Connect, link, and what the link found. Linking is one tap: Sign in with Solana proves the
 * wallet is the player's (`linkedWallet`), then the app reads the wallet's Seeker identity
 * (seekerLink.ts): its Seeker ID, the `.skr` name on mainnet that becomes the player's name, and
 * its Seeker Genesis Token, the proof behind the Coin Shop's Seeker deals and the one-time perk.
 * "Check Seeker" reads it again (a name claimed after linking); Unlink forgets both.
 */
export default function WalletPopup() {
  const close = useGame((s) => s.closePopup);
  const setLinkedWallet = useGame((s) => s.setLinkedWallet);
  const claimSeekerPerk = useGame((s) => s.claimSeekerPerk);
  const linked = useGame((s) => s.linkedWallet);
  const link = useGame((s) => s.seekerLink);
  const status = useGame((s) => s.walletStatus);
  const wallets = useWallets(walletClient);
  const connected = useConnectedWallet(walletClient);
  const walletStatus = useWalletStatus(walletClient);
  const connect = useConnect(walletClient);
  const disconnect = useDisconnect(walletClient);
  const signIn = useSignIn(walletClient);
  const [balance, setBalance] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const address = connected?.account.address ?? null;
  const linkedHere = address !== null && linked === address;
  const found = link && link.wallet === address ? link : null;

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

  // A signed-in wallet that connects again gets its link read again once it is an hour old.
  useEffect(() => {
    if (address && linked === address) void refreshSeekerLink(address);
  }, [address, linked]);

  // Mobile Wallet Adapter first, labelled the way Solana Mobile's UX guidelines recommend.
  const sorted = [...wallets].sort(
    (a, b) => Number(b.name === SolanaMobileWalletAdapterWalletName) - Number(a.name === SolanaMobileWalletAdapterWalletName),
  );
  const label = (w: UiWallet) => (w.name === SolanaMobileWalletAdapterWalletName ? 'Use Installed Wallet' : w.name);

  /** Read the Seeker identity of the signed-in wallet and say what it found; the perk pays once per Genesis Token on this device. */
  const checkSeeker = async (wallet: string, fresh: boolean) => {
    setChecking(true);
    try {
      const result = await linkSeeker(wallet);
      if (result.name) {
        sfx.win();
        toast(`${fresh ? 'Linked' : 'Playing'} as ${result.name} 🌴`, 'win');
      } else if (fresh) {
        toast('Wallet linked — no Seeker ID (.skr) in this wallet', 'win');
      } else {
        toast('No Seeker ID (.skr) in this wallet');
      }
      if (result.genesis && claimSeekerPerk(result.genesis)) {
        sfx.bingo();
        toast(`Seeker Genesis Token found! +${SEEKER_PERK_SHELLS.toLocaleString('en-US')} shells and 8 boosters 🌴`, 'win');
      }
    } catch {
      toast('Could not reach the Solana RPC — try again later', 'warn');
    } finally {
      setChecking(false);
    }
  };

  /** Sign in with Solana (the wallet signs a message, nothing is sent anywhere), then read the Seeker link. */
  const doLink = async () => {
    if (!connected) return;
    try {
      const input = createSignInInput();
      const output = await signIn.dispatchAsync(connected.wallet, input);
      if (!verifySignInLocally(input, output)) {
        toast('Signature did not verify', 'warn');
        return;
      }
      const fresh = linked !== output.account.address;
      setLinkedWallet(output.account.address);
      await checkSeeker(output.account.address, fresh);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Sign-in cancelled', 'warn');
    }
  };

  const unlink = () => {
    sfx.click();
    setLinkedWallet(null);
    toast('Wallet unlinked — your profile name is back');
  };

  const skr = status && status.address === address && status.skrBalance !== null ? BigInt(status.skrBalance) : null;

  return (
    <Popup title="Wallet" onClose={close} wide>
      <p className="small-note">
        Link a Solana wallet to play as your Seeker: your Seeker ID (the .skr name) becomes your player name, the Seeker Genesis Token
        unlocks the Coin Shop's deals (SKR at the best price) and a one-time welcome perk, and the wallet pays for coin packs. Beach Bingo
        never asks for your seed phrase. Shells stay free; coins never leave the game. Network: <b>{CLUSTER}</b>
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
          {linked && (
            <div className="wallet-linked">
              <span>
                Linked: <b>{link?.wallet === linked && link.name ? link.name : shortAddress(linked)}</b>
                {link?.wallet === linked && link.name ? ` (${shortAddress(linked)})` : ''}
              </span>
              <button type="button" className="wallet-unlink" onClick={unlink}>
                Unlink
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="wallet-card">
            {connected.wallet.icon && <img src={connected.wallet.icon} alt="" />}
            <div>
              <b>{found?.name ?? shortAddress(connected.account.address)}</b>
              <small>
                {found?.name ? `${shortAddress(connected.account.address)} · ` : ''}
                {connected.wallet.name} · {balance === null ? '… SOL' : `${balance.toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`}
              </small>
            </div>
            {linkedHere && <span className="wallet-card__ok">✓ linked</span>}
          </div>
          {skr !== null && <p className="small-note wallet-skr">{formatAmount(skr, 6, 'SKR')} in this wallet{skr > 0n ? (ONCHAIN_STAKES_ENABLED ? ' — the shop and the stake picker start on SKR.' : ' — the shop starts on SKR.') : '.'}</p>}
          <Badges />
          {linkedHere && found && (
            <ul className="wallet-found" aria-label="What the link found">
              <li className={found.name ? 'is-on' : ''}>
                {found.name ? (
                  <>
                    Seeker ID <b>{found.name}</b> — your player name while linked{found.main ? ' (your main domain)' : ''}
                    {found.names.length > 1 ? `; also ${found.names.filter((n) => n !== found.name).slice(0, 3).join(', ')}` : ''}.
                  </>
                ) : (
                  <>No Seeker ID (.skr) in this wallet. Seeker owners: link the wallet set up on the phone.</>
                )}
              </li>
              <li className={found.genesis ? 'is-on' : ''}>
                {found.genesis ? (
                  <>
                    Seeker Genesis Token <b>{shortAddress(found.genesis)}</b> — the Coin Shop's Seeker deals are yours.
                  </>
                ) : (
                  <>No Seeker Genesis Token in this wallet — the Seeker deals wait for one.</>
                )}
              </li>
            </ul>
          )}
          <div className="wallet-actions">
            <GreenButton onClick={doLink} disabled={signIn.isRunning || checking}>
              {signIn.isRunning ? 'Signing…' : linkedHere ? 'Re-sign' : 'Link wallet'}
            </GreenButton>
            {linkedHere && (
              <GreenButton tone="gold" onClick={() => void checkSeeker(connected.account.address, false)} disabled={checking || signIn.isRunning}>
                {checking ? 'Checking…' : 'Check Seeker'}
              </GreenButton>
            )}
          </div>
          {!linkedHere && <p className="small-note">Linking signs a message in your wallet (no transaction, no fee) and then looks for your Seeker ID and Genesis Token.</p>}
          <div className="wallet-foot">
            {linkedHere && (
              <button type="button" className="wallet-unlink" onClick={unlink}>
                Unlink
              </button>
            )}
            <button type="button" className="wallet-disconnect" onClick={() => disconnect.dispatch()}>
              Disconnect
            </button>
          </div>
        </>
      )}

      <div className="divider" />
      <h3>SOL, USDC, PYUSD, JUP and SKR</h3>
      <p className="small-note">
        {ONCHAIN_STAKES_ENABLED
          ? 'Devnet stakes are enabled: staked Wave Rush rooms and halls in SOL or a test token, and the Coin Shop paid in the same. A linked Seeker pays the Seeker fee tier once it is proved to the program, and gets the shop deals: 25% off with SKR, 5% off with the rest. Badges describe your wallet and never grant anything by themselves.'
          : 'The Coin Shop takes these five tokens. A linked Seeker gets the deals: 25% off every pack with SKR, 5% off with the rest; everyone else pays the list price. Staked rooms stay switched off on this site: real-money bingo is regulated gambling, so they wait for licensing, geo-checks and age verification. Playing with shells is free for everyone.'}
      </p>
    </Popup>
  );
}
