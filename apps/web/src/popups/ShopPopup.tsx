import { useEffect, useState, useSyncExternalStore } from 'react';
import { Segmented } from '../games/common.tsx';
import { sfx } from '../lib/audio.ts';
import { formatPrice, getShop, isDevShop, MINTS, PACKS, quote, savingPercent, shopNeedsWallet, subscribeShop, type Catalogue, type Mint, type Pack, type Shop } from '../shop/shop.ts';
import { Badges } from '../solana/Badges.tsx';
import { useGame, type Purchase } from '../state/store.ts';
import { formatCoins } from '../ui/format.ts';
import { CoinIcon, Confetti, GreenButton } from '../ui/kit.tsx';
import { Popup } from '../ui/Popup.tsx';
import { toast } from '../ui/toast.ts';
import './popups.css';

/** The record of a purchase, stamped now (kept out of the component for the compiler's purity rule). */
const stamped = (p: Omit<Purchase, 'at'>): Purchase => ({ ...p, at: Date.now() });
const restoreSignature = () => `restore-${Date.now().toString(36)}`;
const EMPTY: Catalogue = { packs: [], seekerDiscountBps: 0 };
/** The shop registered right now (the chain shop follows the wallet; the popup follows the shop). */
const useShop = () => useSyncExternalStore(subscribeShop, () => getShop(), () => getShop());

/**
 * The Coin Shop: four packs, five tokens, SKR first. Opens from the coins balance once the age
 * gate is passed (store.requestCoins). The shop behind it is `shop/shop.ts`: the chain shop while
 * a wallet is connected in the devnet build, the stub in local dev, and none in a production
 * build until then, where the packs show greyed with no Buy button. Prices come from the shop in
 * base units and are discounted with the program's own arithmetic, so the number on the button is
 * the number the chain charges; the Seeker saving applies when the connected wallet holds a
 * Seeker Genesis Token the program accepts (its accounts travel with the purchase).
 */
export default function ShopPopup() {
  const close = useGame((s) => s.closePopup);
  const openPopup = useGame((s) => s.openPopup);
  const coins = useGame((s) => s.coins);
  const purchases = useGame((s) => s.purchases);
  const skrReady = useGame((s) => s.skrReady);
  const perkSeeker = useGame((s) => s.seekerPerkMints.length > 0);
  const walletSeeker = useGame((s) => s.walletStatus?.seeker !== null && s.walletStatus !== null);
  const creditPurchase = useGame((s) => s.creditPurchase);
  const cap = useGame((s) => s.limits.dailySpendCap);
  const bought = useGame((s) => s.today.bought);
  const shop = useShop();
  const [picked, setMint] = useState<Mint>(skrReady ? 'SKR' : 'SOL');
  const [busy, setBusy] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  // The catalogue of the shop that answered; a different shop (the wallet changed) starts over.
  const [loaded, setLoaded] = useState<{ shop: Shop; catalogue: Catalogue } | null>(null);
  const catalogue = loaded && loaded.shop === shop ? loaded.catalogue : null;
  const open = shop !== null;
  const needsWallet = !open && shopNeedsWallet();
  // The chain shop knows its wallet's token; the stub and the greyed catalogue fall back to the perk's record.
  const seekerVerified = shop?.wallet ? walletSeeker : perkSeeker;
  // No shop: the catalogue shows greyed from the start; a shop lists its own packs.
  const packs: Pack[] = catalogue?.packs ?? (shop ? [] : [...PACKS]);
  const seekerBps = catalogue?.seekerDiscountBps ?? EMPTY.seekerDiscountBps;
  const offered = MINTS.filter((m) => packs.some((p) => p.offers[m]));
  // SKR when the wallet holds some and the shop sells it; otherwise the first token on offer.
  const mint: Mint = !offered.length || offered.includes(picked) ? picked : skrReady && offered.includes('SKR') ? 'SKR' : offered[0]!;

  useEffect(() => {
    if (!shop) return;
    let on = true;
    shop
      .packs()
      .then((c) => on && setLoaded({ shop, catalogue: c }))
      .catch((e: unknown) => on && toast(e instanceof Error ? e.message.slice(0, 120) : 'Could not read the shop', 'warn'));
    return () => {
      on = false;
    };
  }, [shop]);

  const buy = async (pack: Pack) => {
    if (!shop) return;
    const reason = useGame.getState().purchaseBlockedReason(pack.coins);
    if (reason) return toast(reason, 'warn');
    setBusy(pack.id);
    sfx.click();
    try {
      const { signature, coins: got } = await shop.buy(pack.id, mint);
      if (creditPurchase(stamped({ signature, pack: pack.id, mint, coins: got, ...(shop.wallet ? { wallet: shop.wallet } : {}) }))) {
        sfx.coin();
        setCelebrate(true);
        toast(`+${formatCoins(got)} coins`, 'win');
      } else {
        toast('That purchase was already credited', 'warn');
      }
    } catch (e) {
      toast(e instanceof Error ? e.message.slice(0, 120) : 'The purchase did not go through', 'warn');
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    if (!shop) return;
    setBusy('restore');
    sfx.click();
    try {
      const n = await shop.restore();
      if (n > 0 && creditPurchase(stamped({ signature: restoreSignature(), pack: 'restore', mint, coins: n, ...(shop.wallet ? { wallet: shop.wallet } : {}) }))) {
        sfx.coin();
        toast(`Restored ${formatCoins(n)} coins`, 'win');
      } else {
        toast('Nothing to restore');
      }
    } catch {
      toast('Could not reach the shop — try again later', 'warn');
    } finally {
      setBusy(null);
    }
  };

  const price = (pack: Pack, m: Mint) => {
    const q = quote(pack, m, seekerVerified, seekerBps);
    return q === null ? null : formatPrice(q, m, pack.offers[m]!.decimals);
  };
  const skrSaving = packs[0] ? savingPercent(packs[0], 'SKR') : 20;
  const skrLine = (pack: Pack) => {
    const p = price(pack, 'SKR');
    return p ? `Pay with SKR: save ${skrSaving}% · ${p}` : null;
  };

  return (
    <Popup title="Coin Shop" onClose={close} wide>
      {celebrate && <Confetti pieces={40} />}
      <p className="small-note">
        You have <b>{formatCoins(coins)} coins</b>. Coins play the coin tables; shells stay free.{isDevShop(shop) ? ' Test shop: nothing is charged.' : ''}
      </p>
      {!open && !needsWallet && <p className="shop__soon">The Coin Shop opens soon.</p>}
      {needsWallet && (
        <div className="shop__connect">
          <p className="small-note">Connect a wallet to buy coins with SOL, SKR, USDC, PYUSD or JUP. The program sells the packs; the wallet pays.</p>
          <GreenButton tone="blue" onClick={() => openPopup('wallet')}>
            Connect wallet
          </GreenButton>
        </div>
      )}
      <h3>Pay with</h3>
      <Segmented options={offered.length ? offered : MINTS} value={mint} onChange={setMint} disabled={busy !== null} />
      <p className="small-note">
        {mint === 'SKR' ? `SKR saves ${skrSaving}% on every pack` : `Pay with SKR to save ${skrSaving}%`}
        {seekerVerified ? `; your Seeker saves another ${seekerBps / 100}%` : shop?.wallet ? `; a verified Seeker saves another ${seekerBps / 100}%` : ''}.
      </p>
      {shop?.wallet && <Badges className="shop__badges" />}
      <div className="packs">
        {packs.map((pack) => {
          const shown = price(pack, mint);
          return (
            <div key={pack.id} className={`pack ${open ? '' : 'pack--soon'}`}>
              <CoinIcon size={3.4} />
              <div className="pack__body">
                <b>{formatCoins(pack.coins)} coins</b>
                <span>{shown ?? `Not sold in ${mint}`}</span>
                {mint !== 'SKR' && skrLine(pack) && <small>{skrLine(pack)}</small>}
                {seekerVerified && shown && <small className="pack__seeker">Seeker saving included</small>}
              </div>
              {open && (
                <GreenButton tone="gold" className="pack__buy" disabled={busy !== null || !shown} onClick={() => void buy(pack)}>
                  {busy === pack.id ? '…' : 'Buy'}
                </GreenButton>
              )}
            </div>
          );
        })}
        {packs.length === 0 && <p className="small-note">Loading packs…</p>}
      </div>
      {cap !== null && (
        <p className="small-note">
          Today's cap: {formatCoins(bought)} of {formatCoins(cap)} coins bought (Settings → Responsible play).
        </p>
      )}
      {purchases.length > 0 && (
        <>
          <h3>Your purchases</h3>
          <ul className="round-log shop__history">
            {purchases.slice(0, 5).map((p) => (
              <li key={p.signature}>
                {formatCoins(p.coins)} coins · {p.mint} · {new Date(p.at).toLocaleDateString()} · <span className="mono">{p.signature.slice(0, 10)}…</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && (
        <button type="button" className="shop__restore" disabled={busy !== null} onClick={() => void restore()}>
          {busy === 'restore' ? 'Restoring…' : 'Restore purchases'}
        </button>
      )}
      <p className="small-note">
        Coins have no cash value, cannot be sold, transferred or refunded, and never leave the game. 18+ only; not offered in Washington State.
      </p>
    </Popup>
  );
}
