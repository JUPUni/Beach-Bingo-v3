import { useEffect, useState } from 'react';
import { Segmented } from '../games/common.tsx';
import { sfx } from '../lib/audio.ts';
import { formatPrice, getShop, isDevShop, MINTS, PACKS, priceFor, SEEKER_DISCOUNT, SKR_DISCOUNT, type Mint, type Pack } from '../shop/shop.ts';
import { useGame, type Purchase } from '../state/store.ts';
import { formatCoins } from '../ui/format.ts';
import { CoinIcon, Confetti, GreenButton } from '../ui/kit.tsx';
import { Popup } from '../ui/Popup.tsx';
import { toast } from '../ui/toast.ts';
import './popups.css';

/** The record of a purchase, stamped now (kept out of the component for the compiler's purity rule). */
const stamped = (p: Omit<Purchase, 'at'>): Purchase => ({ ...p, at: Date.now() });
const restoreSignature = () => `restore-${Date.now().toString(36)}`;

/**
 * The Coin Shop: four packs, five tokens, SKR first. Opens from the coins balance once the age
 * gate is passed (store.requestCoins). The shop behind it is `shop/shop.ts`: the chain shop once
 * it registers itself, the stub in local dev and the devnet build, and none in a production
 * build until then, where the packs show greyed with no Buy button.
 */
export default function ShopPopup() {
  const close = useGame((s) => s.closePopup);
  const coins = useGame((s) => s.coins);
  const purchases = useGame((s) => s.purchases);
  const skrReady = useGame((s) => s.skrReady);
  const seekerVerified = useGame((s) => s.seekerPerkMints.length > 0);
  const creditPurchase = useGame((s) => s.creditPurchase);
  const cap = useGame((s) => s.limits.dailySpendCap);
  const bought = useGame((s) => s.today.bought);
  const [mint, setMint] = useState<Mint>(skrReady ? 'SKR' : 'SOL');
  const [busy, setBusy] = useState<string | null>(null);
  const [celebrate, setCelebrate] = useState(false);
  const [shop] = useState(() => getShop());
  const open = shop !== null;
  // No shop: the catalogue shows greyed from the start; a shop lists its own packs.
  const [packs, setPacks] = useState<Pack[]>(() => (shop ? [] : [...PACKS]));

  useEffect(() => {
    if (!shop) return;
    let on = true;
    void shop.packs().then((p) => on && setPacks(p));
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
      if (creditPurchase(stamped({ signature, pack: pack.id, mint, coins: got }))) {
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
      if (n > 0 && creditPurchase(stamped({ signature: restoreSignature(), pack: 'restore', mint, coins: n }))) {
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

  const skrLine = (pack: Pack) => `Pay with SKR: save ${SKR_DISCOUNT * 100}% · ${formatPrice(priceFor(pack, 'SKR', seekerVerified), 'SKR')}`;

  return (
    <Popup title="Coin Shop" onClose={close} wide>
      {celebrate && <Confetti pieces={40} />}
      <p className="small-note">
        You have <b>{formatCoins(coins)} coins</b>. Coins play the coin tables; SAND stays free.{isDevShop(shop) ? ' Test shop: nothing is charged.' : ''}
      </p>
      {!open && <p className="shop__soon">The Coin Shop opens soon.</p>}
      <h3>Pay with</h3>
      <Segmented options={MINTS} value={mint} onChange={setMint} disabled={busy !== null} />
      <p className="small-note">
        {mint === 'SKR' ? `SKR saves ${SKR_DISCOUNT * 100}% on every pack` : `Pay with SKR to save ${SKR_DISCOUNT * 100}%`}
        {seekerVerified ? `; your Seeker saves another ${SEEKER_DISCOUNT * 100}%` : ''}.
      </p>
      <div className="packs">
        {packs.map((pack) => (
          <div key={pack.id} className={`pack ${open ? '' : 'pack--soon'}`}>
            <CoinIcon size={3.4} />
            <div className="pack__body">
              <b>{formatCoins(pack.coins)} coins</b>
              <span>{formatPrice(priceFor(pack, mint, seekerVerified), mint)}</span>
              {mint !== 'SKR' && <small>{skrLine(pack)}</small>}
              {seekerVerified && <small className="pack__seeker">Seeker saving included</small>}
            </div>
            {open && (
              <GreenButton tone="gold" className="pack__buy" disabled={busy !== null} onClick={() => void buy(pack)}>
                {busy === pack.id ? '…' : 'Buy'}
              </GreenButton>
            )}
          </div>
        ))}
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
