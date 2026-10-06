import { useGame } from '../../state/store.ts';
import { toast } from '../../ui/toast.ts';

/**
 * True when a real-money stake may go ahead. Asks the store's gate (18+, region, cool-off): a
 * blocked region or a cool-off says why in a toast, a missing 18+ declaration opens the age popup.
 * Only the money-in actions call it; settling, claiming, cancelling and refunds never do, so a
 * player's funds can always come back out.
 */
export function stakeAllowed(): boolean {
  const s = useGame.getState();
  const answer = s.requestStake();
  if (answer === 'blocked') toast(s.stakeBlockedReason() ?? '', 'warn');
  return answer === 'done';
}
