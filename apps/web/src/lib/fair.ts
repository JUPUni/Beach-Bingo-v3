import { FairRng, type FairSeed, type ModeId } from '@beach-bingo/engine';
import { useGame } from '../state/store.ts';

/**
 * Provably-fair round helper for house games.
 *
 * In play-money mode the "house" runs in the browser, so the committed server seed lives in
 * local storage — the protocol and verification are identical to the server-authoritative
 * version used for anything of value (see docs/FAIRNESS.md).
 */
export interface RoundLog {
  mode: ModeId;
  nonce: number;
  commitment: string;
  clientSeed: string;
  at: number;
  summary: string;
}

const history: RoundLog[] = [];

export interface FairRound {
  seed: FairSeed;
  commitment: string;
  rng(domain: string): FairRng;
  log(summary: string): void;
}

export function newRound(mode: ModeId): FairRound {
  const { commitment, ...seed } = useGame.getState().nextFairSeed();
  const entry: RoundLog = { mode, nonce: seed.nonce, commitment, clientSeed: seed.clientSeed, at: Date.now(), summary: '' };
  history.unshift(entry);
  history.length = Math.min(history.length, 30);
  return {
    seed,
    commitment,
    rng: (domain) => new FairRng(seed, `${mode}:${domain}`),
    log: (summary) => {
      entry.summary = summary;
    },
  };
}

export function roundHistory(): readonly RoundLog[] {
  return history;
}
