import { getStructEncoder, getU64Encoder, getU8Encoder, type Address, type Instruction } from '@solana/kit';
import { program, type SolanaRpc } from './waveDuel.ts';
import { COMPUTE_BUDGET_PROGRAM, setComputeUnitLimitIx } from './waveHall.ts';

/**
 * The compute budget a shop purchase is sent with: an explicit unit limit, so the transaction is
 * priced on what it needs rather than the 200k default, and a priority fee read from what recent
 * transactions on the program paid, so it lands under load. Both are cheap: at the cap the fee is
 * a few thousand lamports (`priorityFeeLamports`; the test holds it under 0.002 SOL).
 */
/**
 * Units a purchase may use. Measured in LiteSVM against the program at this commit (the token
 * test's harness, `computeUnitsConsumed()`): a first `buy_pack_token` in a PYUSD-like Token-2022
 * mint with the Seeker proof, the Buyer PDA created in the same instruction, is the worst case at
 * 26,975 CU; the same in an SPL mint 21,167, a later one 18,807, a SOL `buy_pack` with the proof
 * 14,736 and without 10,458. The limit is 1.3× the worst case and never under 60,000.
 */
export const BUY_PACK_MEASURED_CU = 26_975;
export const BUY_PACK_COMPUTE_UNITS = Math.max(60_000, Math.ceil((BUY_PACK_MEASURED_CU * 1.3) / 1_000) * 1_000);
/** Micro-lamports per unit: the floor on a quiet chain (or when the fee cannot be read), the cap under load. */
export const PRIORITY_FEE_FLOOR = 1_000n;
export const PRIORITY_FEE_CAP = 20_000n;
/** The most a purchase may pay in priority fee, in lamports: 0.002 SOL. */
export const MAX_PRIORITY_FEE_LAMPORTS = 2_000_000n;

/** ComputeBudget `SetComputeUnitPrice`: tag 3 then the price as u64 LE micro-lamports per unit. */
export function setComputeUnitPriceIx(microLamports: bigint): Instruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM,
    accounts: [],
    data: getStructEncoder([
      ['tag', getU8Encoder()],
      ['microLamports', getU64Encoder()],
    ]).encode({ tag: 3, microLamports }),
  };
}

/** The median of recent fees, clamped to [floor, cap]; the floor for none. */
export function clampedMedianFee(fees: readonly bigint[], floor = PRIORITY_FEE_FLOOR, cap = PRIORITY_FEE_CAP): bigint {
  if (fees.length === 0) return floor;
  const sorted = [...fees].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
  return median < floor ? floor : median > cap ? cap : median;
}

/** The priority fee in lamports for `units` at `price` micro-lamports each, rounded up as the runtime does. */
export const priorityFeeLamports = (units: number, price: bigint): bigint => (BigInt(units) * price + 999_999n) / 1_000_000n;

/** What transactions writing the program paid per unit lately, clamped; the floor when the RPC cannot say. */
export async function priorityFee(rpc: SolanaRpc, programAddress: Address = program()): Promise<bigint> {
  try {
    const fees = await rpc.getRecentPrioritizationFees([programAddress]).send();
    return clampedMedianFee(fees.map((f) => BigInt(f.prioritizationFee)));
  } catch {
    return PRIORITY_FEE_FLOOR;
  }
}

/** The two instructions every purchase starts with: the unit limit, then the price. */
export async function purchaseBudgetIxs(rpc: SolanaRpc): Promise<Instruction[]> {
  return [setComputeUnitLimitIx(BUY_PACK_COMPUTE_UNITS), setComputeUnitPriceIx(await priorityFee(rpc))];
}
