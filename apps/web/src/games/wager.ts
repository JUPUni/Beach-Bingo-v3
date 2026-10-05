import { useEffect, useRef, useState } from 'react';
import type { ModeId } from '@beach-bingo/engine';
import { TABLE_NAME, useGame, type Table } from '../state/store.ts';
import { toast } from '../ui/toast.ts';

export const COIN_STAKES = [10, 25, 50, 100, 250, 500, 1000] as const;
/** The smallest entry: what a free-game ticket pays for on a coin table. */
export const BASE_STAKE: number = COIN_STAKES[0];

/**
 * Stake handling for the house games on either table: limits, cool-off, task tracking. The
 * table is read when the bet is placed and kept for the round, so an extra ball or spin and
 * the prize land on the ledger the stake came from.
 */
export function useWager(mode: ModeId, initial = 50) {
  const table = useGame((s) => s.table);
  const balance = useGame((s) => s[s.table]);
  const freeGame = useGame((s) => s.table === 'coins' && s.freeGames > 0);
  const recordWin = useGame((s) => s.recordWin);
  const track = useGame((s) => s.track);
  const playedMode = useGame((s) => s.playedMode);
  const openPopup = useGame((s) => s.openPopup);
  const [stake, setStake] = useState<number>(initial);
  const roundTable = useRef<Table>(table);

  useEffect(() => playedMode(mode), [mode, playedMode]);

  /** Take `amount` from the active table; false (with a toast) if unaffordable or limited. */
  const placeBet = (amount: number): boolean => {
    const s = useGame.getState();
    const t = s.table;
    const blocked = s.wagerBlockedReason(t);
    if (blocked) {
      toast(blocked, 'warn');
      return false;
    }
    if (!s.freeGameCovers(amount, BASE_STAKE, t) && s.balance(t) < amount) {
      if (t === 'shells') {
        // The free path never sees a purchase prompt: shells come from the tide.
        toast('Not enough shells — the tide brings more at the + button', 'warn');
        openPopup('faucet');
      } else {
        toast('Not enough coins', 'warn');
        openPopup('shop');
      }
      return false;
    }
    roundTable.current = t;
    return s.charge(amount, { wager: true, table: t, base: BASE_STAKE });
  };

  /** An extra bought inside the round (a ball, a spin), on the round's table. */
  const buyExtra = (price: number, what: string): boolean => {
    const t = roundTable.current;
    if (useGame.getState().charge(price, { wager: true, table: t })) return true;
    toast(`Not enough ${TABLE_NAME[t]} for ${what}`, 'warn');
    return false;
  };

  /** Settle a round: credit winnings (0 allowed) on the round's table and count it for daily tasks. */
  const settle = (payout: number) => {
    recordWin(payout, { table: roundTable.current });
    track('spins');
  };

  /** True when the free-game ticket pays this entry (the base stake on the coins table). */
  const covers = (amount: number) => freeGame && amount === BASE_STAKE;

  return { table, balance, stake, setStake, placeBet, buyExtra, settle, covers };
}

export const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
