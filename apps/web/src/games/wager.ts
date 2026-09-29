import { useEffect, useState } from 'react';
import type { ModeId } from '@beach-bingo/engine';
import { useGame } from '../state/store.ts';
import { toast } from '../ui/toast.ts';

export const COIN_STAKES = [10, 25, 50, 100, 250, 500, 1000] as const;

/** Stake handling for play-money wager games: limits, cool-off, task tracking. */
export function useWager(mode: ModeId, initial = 50) {
  const coins = useGame((s) => s.coins);
  const spend = useGame((s) => s.spend);
  const recordWin = useGame((s) => s.recordWin);
  const track = useGame((s) => s.track);
  const playedMode = useGame((s) => s.playedMode);
  const openPopup = useGame((s) => s.openPopup);
  const [stake, setStake] = useState<number>(initial);

  useEffect(() => playedMode(mode), [mode, playedMode]);

  /** Take `amount` from the balance; false (with a toast) if unaffordable or limited. */
  const placeBet = (amount: number): boolean => {
    const blocked = useGame.getState().wagerBlockedReason();
    if (blocked) {
      toast(blocked, 'warn');
      return false;
    }
    if (useGame.getState().coins < amount) {
      toast('Not enough coins — grab free coins from the + button', 'warn');
      openPopup('faucet');
      return false;
    }
    return spend(amount, { wager: true });
  };

  /** Settle a round: credit winnings (0 allowed) and count it for daily tasks. */
  const settle = (payout: number) => {
    recordWin(payout);
    track('spins');
  };

  return { coins, stake, setStake, placeBet, settle };
}

export const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
