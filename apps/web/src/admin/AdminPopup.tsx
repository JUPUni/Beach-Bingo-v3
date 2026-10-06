import { useEffect, useState } from 'react';
import { address, type Address, type Instruction } from '@solana/kit';
import { useConnectedWallet } from '@solana/kit-plugin-wallet/react';
import { useWalletAccountTransactionSendingSigner } from '@solana/react';
import { rpc, walletClient } from '../solana/client.ts';
import { CHAIN, CLUSTER, shortAddress } from '../solana/config.ts';
import { formatAmount, symbolOf } from '../solana/tokens.ts';
import * as duel from '../solana/waveDuel.ts';
import * as tok from '../solana/waveToken.ts';
import { useGame } from '../state/store.ts';
import { GreenButton } from '../ui/kit.tsx';
import { Popup } from '../ui/Popup.tsx';
import { toast } from '../ui/toast.ts';
import { fetchUsdPrices, mintPackPrices, SOL_MINT, solPackPrices, STABLE_MINTS } from './pricing.ts';
import { roleOf, type AdminRole } from './role.ts';
import '../solana/wallet.css';

/**
 * The operator's panel, for the Seeker that holds the program's admin or pauser role: the shop's
 * state, pause and resume, and a reprice of every pack from Jupiter's live quotes. Every action is
 * one transaction the connected wallet signs; the program checks the role itself, so this screen
 * grants nothing, and a wallet holding neither role sees only that. Opened from the wallet popup,
 * where the button shows only for those two wallets.
 */
type Connected = NonNullable<ReturnType<typeof useConnectedWallet>>;
interface Chain {
  config: duel.ConfigAccount;
  mints: tok.MintEntryAccount[];
}
interface Proposal {
  sol: { usd: number; prices: bigint[] };
  mints: { entry: tok.MintEntryAccount; usd: number; prices: bigint[] }[];
  /** Registered mints with no market quote: their prices stay as they are. */
  unquoted: tok.MintEntryAccount[];
}

const accountUrl = (addr: string) => `https://explorer.solana.com/address/${addr}${CLUSTER === 'devnet' ? '?cluster=devnet' : ''}`;
const prices = (base: readonly bigint[], decimals: number, symbol: string) => base.map((p) => (p === 0n ? '—' : formatAmount(p, decimals, symbol))).join(' · ');
const same = (a: readonly bigint[], b: readonly bigint[]) => a.length === b.length && a.every((x, i) => x === b[i]);

async function loadChain(): Promise<Chain> {
  const config = await duel.fetchConfig(rpc);
  if (!config) throw new Error('The program has no config on this cluster yet.');
  return { config, mints: await tok.fetchMintEntries(rpc) };
}

export default function AdminPopup() {
  const close = useGame((s) => s.closePopup);
  const connected = useConnectedWallet(walletClient);
  return (
    <Popup title="Admin" onClose={close} wide>
      {connected ? <Bound account={connected.account} /> : <p className="small-note">Connect the admin or pauser wallet to manage the shop.</p>}
    </Popup>
  );
}

function Bound({ account }: { account: Connected['account'] }) {
  const signer = useWalletAccountTransactionSendingSigner(account, CHAIN as never);
  const wallet = address(account.address);
  const [chain, setChain] = useState<Chain | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);

  // Bumped after every transaction, so the panel reads the chain again.
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let live = true;
    loadChain().then(
      (c) => live && (setChain(c), setError(null)),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      live = false;
    };
  }, [reads]);

  const run = async (label: string, instructions: () => Promise<Instruction[]>) => {
    setBusy(label);
    try {
      const sent = await duel.send(rpc, signer, await instructions());
      toast(`${label} · ${sent.signature.slice(0, 8)}…`, 'info');
      setProposal(null);
      setReads((n) => n + 1);
    } catch (e) {
      toast(e instanceof Error ? e.message.split('\n')[0]! : String(e), 'warn');
    } finally {
      setBusy(null);
    }
  };

  if (error) return <p className="small-note">{error}</p>;
  if (!chain) return <p className="small-note">Reading the program…</p>;
  const { config, mints } = chain;
  const role: AdminRole | null = roleOf(wallet, config);
  if (!role) {
    return (
      <p className="small-note">
        {shortAddress(wallet)} holds neither role. The admin is {shortAddress(config.admin)} and the pauser {shortAddress(config.pauser)}.
      </p>
    );
  }

  const terms = (paused: boolean, solPrices = config.solPackPrices): duel.ConfigTerms => ({
    feeBps: config.feeBps,
    paused,
    pauser: config.pauser,
    sgtGroup: config.sgtGroup,
    packCoins: config.packCoins,
    seekerDiscountBps: config.seekerDiscountBps,
    solPackPrices: solPrices,
    solSeekerFeeBps: config.solSeekerFeeBps,
  });

  const propose = async () => {
    setBusy('Fetching prices');
    try {
      const live = mints.filter((m) => !STABLE_MINTS.has(m.mint)).map((m) => m.mint);
      const quotes = await fetchUsdPrices([SOL_MINT, ...live]);
      const solUsd = quotes[SOL_MINT];
      if (solUsd === undefined) throw new Error('No live SOL price right now; try again in a minute.');
      const usdOf = (entry: tok.MintEntryAccount) => (STABLE_MINTS.has(entry.mint) ? 1 : quotes[entry.mint]);
      setProposal({
        sol: { usd: solUsd, prices: solPackPrices(solUsd) },
        mints: mints.flatMap((entry) => {
          const usd = usdOf(entry);
          return usd === undefined ? [] : [{ entry, usd, prices: mintPackPrices(usd, entry.decimals) }];
        }),
        unquoted: mints.filter((entry) => usdOf(entry) === undefined),
      });
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'warn');
    } finally {
      setBusy(null);
    }
  };

  const applyPrices = (p: Proposal) =>
    run('Prices updated', async () => {
      const ixs: Instruction[] = [];
      if (!same(p.sol.prices, config.solPackPrices)) ixs.push(await duel.setConfigIx(wallet, config.treasury, terms(config.paused, p.sol.prices)));
      for (const m of p.mints) {
        if (same(m.prices, m.entry.packPrices)) continue;
        const e = m.entry;
        ixs.push(await tok.setMintIx(wallet, e.mint as Address, { minStake: e.minStake, maxStake: e.maxStake, feeBps: e.feeBps, seekerFeeBps: e.seekerFeeBps, packPrices: m.prices, discountBps: e.discountBps }, e.enabled));
      }
      if (!ixs.length) throw new Error('Every price already matches the market.');
      return ixs;
    });

  return (
    <div className="admin">
      <p className="small-note">
        Signed in as the <b>{role}</b> ({shortAddress(wallet)}). {role === 'pauser' ? 'The pauser can pause the shop and new rounds; only the admin resumes or reprices.' : 'Every change is one transaction your wallet signs; rounds already running keep the terms they opened with.'}
      </p>

      <h3>{config.paused ? 'Paused' : 'Open'}</h3>
      <p className="small-note">
        {config.paused ? 'No new rounds or pack purchases. Settling, claims and refunds still work.' : 'The shop sells and staked rooms open.'} Fee {config.feeBps / 100}% (SOL Seeker {config.solSeekerFeeBps / 100}%).
      </p>
      <div className="admin__actions">
        {!config.paused && (
          <GreenButton tone="red" disabled={busy !== null} onClick={() => run('Paused', async () => [await duel.pauseIx(wallet)])}>
            Pause
          </GreenButton>
        )}
        {config.paused && role === 'admin' && (
          <GreenButton disabled={busy !== null} onClick={() => run('Resumed', async () => [await duel.setConfigIx(wallet, config.treasury, terms(false))])}>
            Resume
          </GreenButton>
        )}
      </div>

      <h3>Roles</h3>
      <ul className="admin__list">
        <li>
          Treasury <a href={accountUrl(config.treasury)} target="_blank" rel="noopener noreferrer">{shortAddress(config.treasury)}</a>
        </li>
        <li>
          Admin <a href={accountUrl(config.admin)} target="_blank" rel="noopener noreferrer">{shortAddress(config.admin)}</a>
        </li>
        <li>
          Pauser <a href={accountUrl(config.pauser)} target="_blank" rel="noopener noreferrer">{shortAddress(config.pauser)}</a>
        </li>
      </ul>

      <h3>Pack prices</h3>
      <ul className="admin__list">
        <li>SOL: {prices(config.solPackPrices, 9, 'SOL')}</li>
        {mints.map((m) => (
          <li key={m.mint}>
            {symbolOf(m.mint)}: {prices(m.packPrices, m.decimals, symbolOf(m.mint))}
            {m.enabled ? '' : ' (switched off)'}
          </li>
        ))}
      </ul>

      {role === 'admin' && !proposal && (
        <GreenButton tone="blue" disabled={busy !== null} onClick={propose}>
          {busy === 'Fetching prices' ? 'Fetching…' : 'Reprice from live market'}
        </GreenButton>
      )}
      {role === 'admin' && proposal && (
        <>
          <h3>New prices</h3>
          <ul className="admin__list">
            <li>
              SOL at ${proposal.sol.usd.toFixed(2)}: {prices(proposal.sol.prices, 9, 'SOL')}
              {same(proposal.sol.prices, config.solPackPrices) ? ' (no change)' : ''}
            </li>
            {proposal.mints.map((m) => (
              <li key={m.entry.mint}>
                {symbolOf(m.entry.mint)} at ${m.usd < 0.1 ? m.usd.toPrecision(3) : m.usd.toFixed(2)}: {prices(m.prices, m.entry.decimals, symbolOf(m.entry.mint))}
                {same(m.prices, m.entry.packPrices) ? ' (no change)' : ''}
              </li>
            ))}
            {proposal.unquoted.map((e) => (
              <li key={e.mint}>{symbolOf(e.mint)}: no market price, left as it is</li>
            ))}
          </ul>
          <div className="admin__actions">
            <GreenButton disabled={busy !== null} onClick={() => applyPrices(proposal)}>
              Apply new prices
            </GreenButton>
            <GreenButton tone="red" disabled={busy !== null} onClick={() => setProposal(null)}>
              Cancel
            </GreenButton>
          </div>
        </>
      )}
      {busy && busy !== 'Fetching prices' && <p className="small-note">Waiting for your wallet to approve…</p>}
    </div>
  );
}
