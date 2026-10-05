import {
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type Instruction,
  type Signature,
  type TransactionSendingSigner,
} from '@solana/kit';
import { fetchBuyer, fetchCoinsBought } from '../solana/shop.ts';
import type { SolanaRpc } from '../solana/waveDuel.ts';
import { clearPendingPurchase, PendingPurchaseError, pendingCoins, pendingState, writePendingPurchase, type PendingPurchase, type PendingState } from './pendingPurchase.ts';

/**
 * Sending a purchase so that it is never reported lost. `send` in waveDuel.ts signs, sends and
 * waits; this does the same for the shop, with the record of pendingPurchase.ts written between
 * sending and waiting, and the wait ended by the chain itself: a status settles it, and without
 * one the blockhash's last valid height says whether the transaction can still land. A purchase
 * that may still land throws `PendingPurchaseError` and keeps its record; a dropped or failed one
 * clears it and says so.
 */
export interface PurchaseContext {
  wallet: string;
  packId: string;
  mint: string;
  /** The Buyer PDA's total before the purchase (0n when the wallet never bought). */
  coinsTotalBefore: bigint;
}

/** How long the shop waits before it leaves the purchase to the next open; a blockhash expires in about this time anyway. */
const CONFIRM_TIMEOUT_MS = 75_000;

export async function sendPurchase(rpc: SolanaRpc, signer: TransactionSendingSigner, instructions: Instruction[], context: PurchaseContext): Promise<{ signature: string; pending: PendingPurchase }> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signature = getBase58Decoder().decode(await signAndSendTransactionMessageWithSigners(message));
  const pending: PendingPurchase = {
    signature,
    lastValidBlockHeight: Number(blockhash.lastValidBlockHeight),
    wallet: context.wallet,
    packId: context.packId,
    mint: context.mint,
    coinsTotalBefore: Number(context.coinsTotalBefore),
    at: Date.now(),
  };
  writePendingPurchase(pending);
  const state = await confirmPurchase(rpc, pending);
  if (state === 'confirmed') return { signature, pending };
  if (state === 'pending') throw new PendingPurchaseError(pending);
  clearPendingPurchase(signature);
  throw new Error(state === 'failed' ? 'The purchase failed on chain; nothing was charged' : 'The payment did not reach the network in time; nothing was charged. Try again');
}

/**
 * Where `pending` stands right now: its signature status (`searchTransactionHistory` for a record
 * from an earlier session, past the recent-status cache), and without one the block height, with
 * the status read once more after the height has passed, so a transaction that landed in the last
 * valid block is not called dropped.
 */
export async function pendingStateOf(rpc: SolanaRpc, pending: PendingPurchase, searchTransactionHistory = false): Promise<PendingState> {
  const signature = pending.signature as Signature;
  const status = async (history: boolean) => (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: history }).send()).value[0] ?? null;
  let seen = await status(searchTransactionHistory);
  if (seen) return pendingState(seen, null, pending.lastValidBlockHeight);
  const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send().catch(() => null);
  if (height !== null && Number(height) > pending.lastValidBlockHeight) seen = await status(true);
  return pendingState(seen, height, pending.lastValidBlockHeight);
}

/** Poll like waveDuel.ts `confirm`: a failed read is not a failed transaction; the timeout leaves the purchase pending. */
async function confirmPurchase(rpc: SolanaRpc, pending: PendingPurchase, timeoutMs = CONFIRM_TIMEOUT_MS): Promise<PendingState> {
  const started = Date.now();
  let wait = 1500;
  for (;;) {
    try {
      const state = await pendingStateOf(rpc, pending);
      if (state !== 'pending') return state;
      wait = 1500;
    } catch {
      // Public RPCs rate-limit (429) and hiccup.
      wait = Math.min(wait * 2, 8000);
    }
    if (Date.now() - started > timeoutMs) return 'pending';
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** The coins a confirmed pending purchase gave (`pendingCoins`), read from the chain; null while it cannot be read. */
export async function pendingPurchaseCoins(rpc: SolanaRpc, pending: PendingPurchase): Promise<number | null> {
  const event = await fetchCoinsBought(rpc, pending.signature).catch(() => null);
  const buyer = event ? null : await fetchBuyer(rpc, address(pending.wallet)).catch(() => null);
  return pendingCoins(event, buyer?.coinsTotal ?? null, pending);
}
