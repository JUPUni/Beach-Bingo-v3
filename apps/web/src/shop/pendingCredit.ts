import { ALREADY_CREDITED, useGame } from '../state/store.ts';
import { formatCoins } from '../ui/format.ts';
import { toast } from '../ui/toast.ts';
import { PENDING_MESSAGE } from './pendingPurchase.ts';
import type { PendingSettlement, Shop } from './shop.ts';

/**
 * Settle the connected wallet's pending purchase, if the shop keeps one (pendingPurchase.ts): a
 * confirmed one is credited once (the store refuses a signature it already holds), a purchase
 * still confirming is said so, a dropped one too. Called when the shop opens and when the chain
 * bridge sees a wallet; one run per wallet at a time, since both can happen together.
 */
const running = new Map<string, Promise<void>>();

export function settlePendingPurchase(shop: Shop): Promise<void> {
  const settlePending = shop.settlePending;
  if (!settlePending) return Promise.resolve();
  const key = shop.wallet ?? '';
  let run = running.get(key);
  if (!run) {
    run = settle(settlePending).finally(() => running.delete(key));
    running.set(key, run);
  }
  return run;
}

async function settle(settlePending: () => Promise<PendingSettlement | null>): Promise<void> {
  let outcome: PendingSettlement | null;
  try {
    outcome = await settlePending();
  } catch {
    return; // the chain could not be read; the record waits for the next open
  }
  if (!outcome) return;
  if (outcome.status === 'pending') return toast(PENDING_MESSAGE, 'warn');
  if (outcome.status === 'dropped') return toast('An earlier payment did not go through; nothing was charged.', 'warn');
  const purchase = { ...outcome.purchase, at: Date.now() };
  const s = useGame.getState();
  if (s.creditPurchase(purchase)) return toast(`+${formatCoins(purchase.coins)} coins from your earlier purchase`, 'win');
  // Already held: credited before its record was cleared. Anything else is said, with the way to the coins.
  const reason = s.creditBlockedReason(purchase);
  if (reason && reason !== ALREADY_CREDITED) toast(`${reason} Press Restore purchases to collect them.`, 'warn');
}
