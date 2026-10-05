import type { Address, TransactionSendingSigner } from '@solana/kit';
import { buyPackIx, buyPackTokenIx, fetchBuyer, fetchCoinsBought } from '../solana/shop.ts';
import { SGT_GROUP } from '../solana/config.ts';
import { knownSymbol, SOL_DECIMALS } from '../solana/tokens.ts';
import { fetchConfig, NO_KEY, PACKS, send, type ConfigAccount, type SolanaRpc } from '../solana/waveDuel.ts';
import { fetchMintEntries, type MintEntryAccount, type SeekerProof } from '../solana/waveToken.ts';
import type { Catalogue, Mint, Offer, Pack, Shop } from './shop.ts';

/**
 * The Coin Shop sold by the `wave_duel` program (`buy_pack` for SOL, `buy_pack_token` for a
 * registered mint): the catalogue is the config's `pack_coins` priced by `sol_pack_prices` and each
 * mint entry's `pack_prices` / `discount_bps`, only where the price is non-zero; a purchase goes
 * through the connected wallet's sending signer, is confirmed, and the coins come from the
 * `CoinsBought` event of the confirmed transaction (or the `Buyer` PDA's delta when the log cannot
 * be read); "restore" credits `coins_total` less what this device already credited the wallet.
 * The Seeker saving needs no action from the player: when the wallet holds a Seeker Genesis Token
 * of the configured group its accounts travel with the purchase and the program checks them, but
 * only when the chain's group is the build's (`seekerApplies`); otherwise the buyer pays full price
 * rather than failing.
 */
export const packId = (index: number): string => `pack-${index}`;
export const packIndex = (id: string): number | null => {
  const m = /^pack-(\d)$/.exec(id);
  return m ? Number(m[1]) : null;
};

export interface ChainCatalogue extends Catalogue {
  /** The registry entry each symbol sells through (the first enabled one by mint address when two share a symbol, as devnet's PYUSD pair does). */
  mints: Partial<Record<Mint, MintEntryAccount>>;
}

/** The catalogue as the registry sells it. Pure, so the mapping is tested without a chain. */
export function catalogueFrom(config: ConfigAccount, entries: MintEntryAccount[]): ChainCatalogue {
  const mints: Partial<Record<Mint, MintEntryAccount>> = {};
  for (const entry of [...entries].sort((a, b) => (a.mint < b.mint ? -1 : 1))) {
    if (!entry.enabled) continue;
    const symbol = knownSymbol(entry.mint);
    if (symbol && !mints[symbol]) mints[symbol] = entry;
  }
  const packs: Pack[] = [];
  for (let i = 0; i < PACKS; i++) {
    const offers: Partial<Record<Mint, Offer>> = {};
    const sol = config.solPackPrices[i] ?? 0n;
    if (sol > 0n) offers.SOL = { base: sol, decimals: SOL_DECIMALS, discountBps: 0 };
    for (const [symbol, entry] of Object.entries(mints) as [Mint, MintEntryAccount][]) {
      const base = entry.packPrices[i] ?? 0n;
      if (base > 0n) offers[symbol] = { base, decimals: entry.decimals, discountBps: entry.discountBps };
    }
    packs.push({ id: packId(i), coins: config.packCoins[i] ?? 0, offers });
  }
  return { packs, seekerDiscountBps: config.seekerDiscountBps, mints };
}

/**
 * Whether the Seeker proof goes with a purchase: only when the config's group is the group this
 * build looked the token up in, and that group is set. A proof against another group (a devnet
 * mock, a config not set up yet) would fail the whole purchase (`SeekerGroupUnset`, `NotSeeker`);
 * without it the buyer pays the full price and the shop still works.
 */
export function seekerApplies(chainGroup: string, buildGroup: string = SGT_GROUP): boolean {
  return chainGroup === buildGroup && chainGroup !== NO_KEY;
}

/** What a "restore" credits: the chain's running total less what this device already gave the wallet, never negative. */
export function restoreAmount(coinsTotal: bigint, credited: number): number {
  return Math.max(0, Number(coinsTotal) - credited);
}

export interface ChainShopDeps {
  rpc: SolanaRpc;
  signer: TransactionSendingSigner;
  wallet: Address;
  /** The wallet's Seeker Genesis Token, as last found (null: no discount, no accounts passed). */
  seeker: () => SeekerProof | null;
  /** Coins this device already credited the wallet (purchases and restores). */
  credited: () => number;
}

export function createChainShop(deps: ChainShopDeps): Shop {
  let catalogue: ChainCatalogue | null = null;
  let config: ConfigAccount | null = null;
  const load = async (): Promise<ChainCatalogue> => {
    const cfg = await fetchConfig(deps.rpc);
    if (!cfg) throw new Error('The shop is not open on this network yet');
    config = cfg;
    catalogue = catalogueFrom(cfg, await fetchMintEntries(deps.rpc));
    return catalogue;
  };
  /** The proof to send, if the chain would accept it (known once the config is read). */
  const proofFor = (cfg: ConfigAccount): SeekerProof | null => (seekerApplies(cfg.sgtGroup) ? deps.seeker() : null);
  return {
    wallet: deps.wallet,
    seekerVerified: () => config !== null && proofFor(config) !== null,
    packs: load,
    buy: async (id, mint) => {
      const index = packIndex(id);
      if (index === null) throw new Error('No such pack');
      const cat = catalogue ?? (await load());
      if (config?.paused) throw new Error('The Coin Shop is closed for a moment');
      const pack = cat.packs[index];
      if (!pack?.offers[mint]) throw new Error(`This pack is not sold in ${mint}`);
      const proof = proofFor(config!);
      const ix =
        mint === 'SOL'
          ? await buyPackIx(deps.wallet, config!.treasury, index, proof)
          : await buyPackTokenIx(deps.wallet, cat.mints[mint]!, index, proof, config!.treasury);
      const before = await fetchBuyer(deps.rpc, deps.wallet);
      const sent = await send(deps.rpc, deps.signer, [ix]);
      let coins: number | null = null;
      for (let attempt = 0; attempt < 4 && coins === null; attempt++) {
        const event = await fetchCoinsBought(deps.rpc, sent.signature).catch(() => null);
        if (event) coins = event.coins;
        else await new Promise((r) => setTimeout(r, 1500));
      }
      if (coins === null) {
        const after = await fetchBuyer(deps.rpc, deps.wallet);
        coins = after ? Number(after.coinsTotal - (before?.coinsTotal ?? 0n)) : pack.coins;
      }
      return { signature: sent.signature, coins };
    },
    restore: async () => {
      const buyer = await fetchBuyer(deps.rpc, deps.wallet);
      return buyer ? restoreAmount(buyer.coinsTotal, deps.credited()) : 0;
    },
  };
}
