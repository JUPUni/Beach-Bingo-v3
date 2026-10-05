/**
 * The record of a purchase between "sent" and "credited". `sendPurchase` (purchaseFlow.ts) writes
 * it to localStorage before it waits for the chain, so a tab closed on a slow confirmation, a
 * wallet that answered late or an RPC that timed out never loses a payment: the next shop open or
 * wallet connection settles it (pendingCredit.ts). One record at a time, since the shop sends one
 * purchase at a time. This file is pure of the chain and the store, so the rules are unit-tested;
 * the RPC side is purchaseFlow.ts.
 */
export const PENDING_PURCHASE_KEY = 'beach-bingo:pending-purchase';

export interface PendingPurchase {
  signature: string;
  /** The last block height the transaction's blockhash is valid at: past it, a transaction the chain has not seen can no longer land. */
  lastValidBlockHeight: number;
  wallet: string;
  packId: string;
  mint: string;
  /** The Buyer PDA's `coins_total` before the purchase: the coins are its growth when the event cannot be read. */
  coinsTotalBefore: number;
  at: number;
}

/** What the player reads when the chain has not answered in time: the coins are not lost. */
export const PENDING_MESSAGE = 'Your payment may still be confirming; the coins arrive as soon as it lands. Reopen the shop or press Restore.';

/** The purchase was sent and may still land; its record stays for the next open. */
export class PendingPurchaseError extends Error {
  readonly pending: PendingPurchase;
  constructor(pending: PendingPurchase) {
    super(PENDING_MESSAGE);
    this.name = 'PendingPurchaseError';
    this.pending = pending;
  }
}

export type PendingStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The browser's localStorage, or null where there is none (tests, a locked-down context). */
function browserStorage(): PendingStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A stored record, when it is well-formed; the fields a purchase cannot do without are checked. */
export function parsePendingPurchase(text: string | null): PendingPurchase | null {
  if (!text) return null;
  try {
    const p = JSON.parse(text) as Partial<PendingPurchase> | null;
    if (!p || typeof p.signature !== 'string' || typeof p.wallet !== 'string' || typeof p.lastValidBlockHeight !== 'number') return null;
    return {
      signature: p.signature,
      lastValidBlockHeight: p.lastValidBlockHeight,
      wallet: p.wallet,
      packId: typeof p.packId === 'string' ? p.packId : 'pack',
      mint: typeof p.mint === 'string' ? p.mint : 'SOL',
      coinsTotalBefore: typeof p.coinsTotalBefore === 'number' ? p.coinsTotalBefore : 0,
      at: typeof p.at === 'number' ? p.at : 0,
    };
  } catch {
    return null;
  }
}

/** The pending record, for `wallet` when one is given (another wallet's waits for its owner). */
export function readPendingPurchase(wallet?: string, storage: PendingStorage | null = browserStorage()): PendingPurchase | null {
  let pending: PendingPurchase | null;
  try {
    pending = parsePendingPurchase(storage?.getItem(PENDING_PURCHASE_KEY) ?? null);
  } catch {
    return null;
  }
  return pending && (wallet === undefined || pending.wallet === wallet) ? pending : null;
}

export function writePendingPurchase(pending: PendingPurchase, storage: PendingStorage | null = browserStorage()): void {
  try {
    storage?.setItem(PENDING_PURCHASE_KEY, JSON.stringify(pending));
  } catch {
    /* storage unavailable: "restore purchases" still finds the coins on the chain */
  }
}

/** Forget the record; given `signature`, only when the record is that purchase's. */
export function clearPendingPurchase(signature?: string, storage: PendingStorage | null = browserStorage()): void {
  try {
    if (signature !== undefined && readPendingPurchase(undefined, storage)?.signature !== signature) return;
    storage?.removeItem(PENDING_PURCHASE_KEY);
  } catch {
    /* ignore */
  }
}

export type PendingState = 'confirmed' | 'failed' | 'dropped' | 'pending';

/** The part of `getSignatureStatuses` the decision reads. */
export interface SignatureStatusLike {
  err: unknown;
  confirmationStatus: string | null;
}

/**
 * Where a sent purchase stands. A status settles it: confirmed or finalized is paid, an error
 * means nothing was charged. Without one, the chain's block height decides: past the blockhash's
 * last valid height the transaction can no longer land (dropped); before it, or when the height
 * could not be read, it may still (pending).
 */
export function pendingState(status: SignatureStatusLike | null | undefined, blockHeight: bigint | number | null, lastValidBlockHeight: number): PendingState {
  if (status?.err) return 'failed';
  if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') return 'confirmed';
  if (!status && blockHeight !== null && Number(blockHeight) > lastValidBlockHeight) return 'dropped';
  return 'pending';
}

/** The coins a confirmed purchase gave: the `CoinsBought` event's, else the Buyer total's growth since the record; null while neither can be read. */
export function pendingCoins(event: { coins: number } | null, coinsTotalAfter: bigint | null, pending: Pick<PendingPurchase, 'coinsTotalBefore'>): number | null {
  if (event) return event.coins;
  if (coinsTotalAfter === null) return null;
  return Math.max(0, Number(coinsTotalAfter) - pending.coinsTotalBefore);
}
