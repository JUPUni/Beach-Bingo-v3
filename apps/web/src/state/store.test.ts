import { describe, expect, it } from 'vitest';
import { commitSeed } from '@beach-bingo/engine';
import { useGame } from './store.ts';

describe('game store', () => {
  it('counts every navigation, so opening the screen already shown (Replay, Play again) is a new visit', () => {
    const before = useGame.getState().visit;
    useGame.getState().go({ name: 'adventure', level: 1 });
    useGame.getState().go({ name: 'adventure', level: 1 });
    expect(useGame.getState().visit).toBe(before + 2);
    expect(useGame.getState().screen).toEqual({ name: 'adventure', level: 1 });
    useGame.getState().go({ name: 'game', mode: 'sunsetHall' });
    useGame.getState().go({ name: 'game', mode: 'sunsetHall' });
    expect(useGame.getState().visit).toBe(before + 4);
  });

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
