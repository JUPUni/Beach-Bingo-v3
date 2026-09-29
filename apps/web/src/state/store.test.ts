import { describe, expect, it } from 'vitest';
import { commitSeed } from '@beach-bingo/engine';
import { useGame } from './store.ts';

describe('game store', () => {
  it('rotating seeds reveals the old seed next to the commitment it was played under', () => {
    const { serverSeed, clientSeed, commitment } = useGame.getState().fairness;
    useGame.getState().commitFairNonce(4);
    useGame.getState().rotateSeeds();
    const { fairness } = useGame.getState();
    expect(fairness.previous).toEqual({ serverSeed, clientSeed, lastNonce: 4, commitment });
    expect(commitSeed(fairness.previous!.serverSeed)).toBe(fairness.previous!.commitment);
    expect(fairness.commitment).not.toBe(commitment);
    expect(fairness.serverSeed).not.toBe(serverSeed);
    expect(fairness.nonce).toBe(0);
  });
});
