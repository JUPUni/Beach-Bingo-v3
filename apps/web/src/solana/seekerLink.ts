import { address, createSolanaRpc } from '@solana/kit';
import { useGame, type SeekerLink } from '../state/store.ts';
import { CHAIN_SHOP_ENABLED, MAINNET_RPC_URL } from './config.ts';
import { findSeekerGenesisToken } from './seeker.ts';
import { resolveSeekerId } from './seekerId.ts';
import { refreshWalletStatus } from './walletStatus.ts';

/**
 * Linking a Seeker: once a wallet is signed in (SIWS, `linkedWallet`), the app reads what makes it a
 * Seeker and keeps the answer in the store as `seekerLink`:
 *
 * - its Seeker ID, the `.skr` name, from mainnet whatever the build's cluster (seekerId.ts) — the
 *   player's name while the wallet stays linked;
 * - its Seeker Genesis Token of the configured group on the build's cluster (the mock group on
 *   devnet) — the proof the program wants for the Seeker fee tier and the Coin Shop's SKR deal.
 *
 * The link is read again at most once an hour per connection, or on demand from the wallet popup.
 * A failed read never wipes a name already known for the same wallet; both reads failing rejects.
 */
let mainnet: ReturnType<typeof createSolanaRpc> | null = null;
const mainnetRpc = () => (mainnet ??= createSolanaRpc(MAINNET_RPC_URL));

/** How long a link stays fresh before a new connection reads it again. */
export const LINK_TTL_MS = 60 * 60 * 1000;

async function genesisOf(wallet: string): Promise<string | null> {
  // The chain bridge's status read carries the token with its account (the shop's proof); without the program the plain lookup does.
  return CHAIN_SHOP_ENABLED ? ((await refreshWalletStatus(wallet)).seeker?.mint ?? null) : await findSeekerGenesisToken(wallet);
}

/** Read `wallet`'s Seeker identity and store it as the link (the wallet must be the signed-in one; the store refuses any other). */
export async function linkSeeker(wallet: string): Promise<SeekerLink> {
  const previous = useGame.getState().seekerLink;
  const known = previous && previous.wallet === wallet ? previous : null;
  const [id, genesis] = await Promise.allSettled([resolveSeekerId(mainnetRpc(), address(wallet)), genesisOf(wallet)]);
  if (id.status === 'rejected' && genesis.status === 'rejected') throw id.reason instanceof Error ? id.reason : new Error('Could not reach the Solana RPC');
  const link: SeekerLink = {
    wallet,
    name: id.status === 'fulfilled' ? (id.value?.name ?? null) : (known?.name ?? null),
    main: id.status === 'fulfilled' ? (id.value?.main ?? false) : (known?.main ?? false),
    names: id.status === 'fulfilled' ? (id.value?.names ?? []) : (known?.names ?? []),
    genesis: genesis.status === 'fulfilled' ? genesis.value : (known?.genesis ?? null),
    at: Date.now(),
  };
  useGame.getState().setSeekerLink(link);
  return link;
}

/** On a connection: read the link again when the signed-in wallet connects and the last read is older than the TTL (never throws). */
export async function refreshSeekerLink(wallet: string): Promise<void> {
  const s = useGame.getState();
  if (s.linkedWallet !== wallet) return;
  if (s.seekerLink && s.seekerLink.wallet === wallet && Date.now() - s.seekerLink.at < LINK_TTL_MS) return;
  await linkSeeker(wallet).catch(() => undefined);
}
