import { describe, expect, it } from 'vitest';
import {
  clearPendingPurchase,
  parsePendingPurchase,
  PENDING_MESSAGE,
  PENDING_PURCHASE_KEY,
  pendingCoins,
  PendingPurchaseError,
  pendingState,
  readPendingPurchase,
  writePendingPurchase,
  type PendingPurchase,
  type PendingStorage,
} from './pendingPurchase.ts';

const fakeStorage = (): PendingStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) };
};
const pending: PendingPurchase = { signature: 'sig-1', lastValidBlockHeight: 1_000, wallet: 'WALLET1', packId: 'pack-1', mint: 'SKR', coinsTotalBefore: 5_000, at: 1_700_000_000_000 };

describe('the pending purchase record', () => {
  it('is written before the wait and read back for its wallet only; a bad record reads as none', () => {
    const storage = fakeStorage();
    writePendingPurchase(pending, storage);
    expect(JSON.parse(storage.map.get(PENDING_PURCHASE_KEY)!)).toEqual(pending);
    expect(readPendingPurchase('WALLET1', storage)).toEqual(pending);
    expect(readPendingPurchase('WALLET2', storage)).toBeNull();
    expect(readPendingPurchase(undefined, storage)).toEqual(pending);
    expect(parsePendingPurchase('{"signature":1}')).toBeNull();
    expect(parsePendingPurchase('not json')).toBeNull();
    expect(parsePendingPurchase(null)).toBeNull();
    // The fields a settlement can do without fall back; the ones it cannot are required.
    expect(parsePendingPurchase('{"signature":"s","wallet":"w","lastValidBlockHeight":5}')).toEqual({ signature: 's', wallet: 'w', lastValidBlockHeight: 5, packId: 'pack', mint: 'SOL', coinsTotalBefore: 0, at: 0 });
  });

  it('is cleared only for its own signature, and survives a storage that throws or is missing', () => {
    const storage = fakeStorage();
    writePendingPurchase(pending, storage);
    clearPendingPurchase('sig-other', storage);
    expect(readPendingPurchase('WALLET1', storage)).toEqual(pending);
    clearPendingPurchase('sig-1', storage);
    expect(readPendingPurchase('WALLET1', storage)).toBeNull();
    writePendingPurchase(pending, storage);
    clearPendingPurchase(undefined, storage);
    expect(storage.map.size).toBe(0);
    const broken: PendingStorage = {
      getItem: () => {
        throw new Error('nope');
      },
      setItem: () => {
        throw new Error('nope');
      },
      removeItem: () => {
        throw new Error('nope');
      },
    };
    expect(() => writePendingPurchase(pending, broken)).not.toThrow();
    expect(readPendingPurchase('WALLET1', broken)).toBeNull();
    expect(() => clearPendingPurchase('sig-1', broken)).not.toThrow();
    expect(readPendingPurchase('WALLET1', null)).toBeNull();
  });

  it('settles from the status when there is one, and from the block height when there is none', () => {
    expect(pendingState({ err: null, confirmationStatus: 'confirmed' }, null, 1_000)).toBe('confirmed');
    expect(pendingState({ err: null, confirmationStatus: 'finalized' }, 5_000n, 1_000)).toBe('confirmed');
    expect(pendingState({ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }, null, 1_000)).toBe('failed');
    // Seen but not confirmed yet: still pending, whatever the height says.
    expect(pendingState({ err: null, confirmationStatus: 'processed' }, 5_000n, 1_000)).toBe('pending');
    // Unseen: pending while the blockhash lives (or the height is unknown), dropped once it is past.
    expect(pendingState(null, 999n, 1_000)).toBe('pending');
    expect(pendingState(null, 1_000n, 1_000)).toBe('pending');
    expect(pendingState(null, null, 1_000)).toBe('pending');
    expect(pendingState(null, 1_001n, 1_000)).toBe('dropped');
    expect(pendingState(undefined, 1_001, 1_000)).toBe('dropped');
  });

  it("credits the event's coins, else the Buyer total's growth, and waits while neither can be read", () => {
    expect(pendingCoins({ coins: 15_000 }, 99_999n, pending)).toBe(15_000);
    expect(pendingCoins(null, 20_000n, pending)).toBe(15_000);
    expect(pendingCoins(null, 5_000n, pending)).toBe(0);
    expect(pendingCoins(null, 4_000n, pending)).toBe(0);
    expect(pendingCoins(null, null, pending)).toBeNull();
    const e = new PendingPurchaseError(pending);
    expect(e.message).toBe(PENDING_MESSAGE);
    expect(e.name).toBe('PendingPurchaseError');
    expect(e.pending).toBe(pending);
    expect(e).toBeInstanceOf(Error);
  });
});
