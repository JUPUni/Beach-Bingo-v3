import {
  AccountRole,
  fixDecoderSize,
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Encoder,
  getBooleanDecoder,
  getBytesDecoder,
  getBytesEncoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getStructEncoder,
  getU16Decoder,
  getU32Decoder,
  getU64Decoder,
  getU8Decoder,
  getU8Encoder,
  getUtf8Encoder,
  type Address,
  type Instruction,
} from '@solana/kit';
import { sha256Hex } from '@beach-bingo/engine';
import { configAddress, NO_KEY, program, same, SYSTEM_PROGRAM, type ConfigAccount, type SolanaRpc } from './waveDuel.ts';
import { ataAddress, type MintEntryAccount, type SeekerProof } from './waveToken.ts';

/**
 * The coin shop of the `wave_duel` program: `buy_pack(pack)` pays `sol_pack_prices[pack]` lamports
 * to the treasury, `buy_pack_token(pack)` pays `pack_prices[pack]` base units of a registered mint
 * to its treasury account, both less the discounts the program enforces (the mint's `discount_bps`,
 * plus `seeker_discount_bps` when the buyer passes a Seeker Genesis Token). A `Buyer` PDA per
 * wallet keeps the running totals: the app credits coins from the confirmed transaction and a
 * "restore purchases" credits the difference between `coinsTotal` and what the device already gave.
 * No refunds, no sell-back, no transfers.
 */
const utf8 = getUtf8Encoder();
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const discriminator = (name: string): Uint8Array => hexBytes(sha256Hex(name).slice(0, 16));

const DISC = {
  buyPack: discriminator('global:buy_pack'),
  buyPackToken: discriminator('global:buy_pack_token'),
  buyerAccount: discriminator('account:Buyer'),
  coinsBoughtEvent: discriminator('event:CoinsBought'),
};

export interface BuyerAccount {
  address: Address;
  wallet: Address;
  coinsTotal: bigint;
  purchases: number;
  lastSlot: bigint;
}

const buyerDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['wallet', getAddressDecoder()],
  ['coinsTotal', getU64Decoder()],
  ['purchases', getU32Decoder()],
  ['lastSlot', getU64Decoder()],
  ['bump', getU8Decoder()],
]);

export async function buyerAddress(wallet: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program(), seeds: [utf8.encode('buyer'), getAddressEncoder().encode(wallet)] });
  return pda;
}

export function decodeBuyer(addr: Address, data: Uint8Array): BuyerAccount | null {
  const b = buyerDecoder.decode(data);
  if (!same(b.discriminator as Uint8Array, DISC.buyerAccount)) return null;
  return { address: addr, wallet: b.wallet, coinsTotal: b.coinsTotal, purchases: b.purchases, lastSlot: b.lastSlot };
}

export async function fetchBuyer(rpc: SolanaRpc, wallet: Address): Promise<BuyerAccount | null> {
  const addr = await buyerAddress(wallet);
  const { value } = await rpc.getAccountInfo(addr, { encoding: 'base64' }).send();
  if (!value) return null;
  return decodeBuyer(addr, getBase64Encoder().encode(value.data[0]) as Uint8Array);
}

/** The program's price: `price × (10_000 − discount) / 10_000`, floor, never below one base unit. */
export function packPrice(price: bigint, discountBps: number): bigint {
  const paid = (price * BigInt(10_000 - discountBps)) / 10_000n;
  return paid > 0n ? paid : 1n;
}

/** What a buyer pays for `pack` in SOL, or null when the pack is not sold for SOL. */
export function solPackPrice(config: ConfigAccount, pack: number, seeker: boolean): bigint | null {
  const price = config.solPackPrices[pack];
  if (!price) return null;
  return packPrice(price, seeker ? config.seekerDiscountBps : 0);
}

/** What a buyer pays for `pack` in a registered mint, or null when the pack is not sold in it. */
export function tokenPackPrice(config: ConfigAccount, entry: MintEntryAccount, pack: number, seeker: boolean): bigint | null {
  const price = entry.packPrices[pack];
  if (!price) return null;
  return packPrice(price, entry.discountBps + (seeker ? config.seekerDiscountBps : 0));
}

/* ---------- The CoinsBought event, read back from a confirmed purchase ---------- */

export interface CoinsBoughtEvent {
  wallet: Address;
  /** null for a SOL purchase. */
  mint: Address | null;
  pack: number;
  coins: number;
  /** Base units (lamports for SOL) the treasury received. */
  paid: bigint;
  discountBps: number;
  seeker: boolean;
}

const coinsBoughtDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['wallet', getAddressDecoder()],
  ['mint', getAddressDecoder()],
  ['pack', getU8Decoder()],
  ['coins', getU32Decoder()],
  ['paid', getU64Decoder()],
  ['discountBps', getU16Decoder()],
  ['seeker', getBooleanDecoder()],
]);

/** Anchor events travel as `Program data: <base64>` log lines; this finds the shop's among a transaction's logs. */
export function decodeCoinsBought(logs: readonly string[]): CoinsBoughtEvent | null {
  for (const line of logs) {
    if (!line.startsWith('Program data: ')) continue;
    let bytes: Uint8Array;
    try {
      bytes = getBase64Encoder().encode(line.slice('Program data: '.length)) as Uint8Array;
    } catch {
      continue;
    }
    if (bytes.length < 8 || !same(bytes.subarray(0, 8), DISC.coinsBoughtEvent)) continue;
    const e = coinsBoughtDecoder.decode(bytes);
    return { wallet: e.wallet, mint: e.mint === NO_KEY ? null : e.mint, pack: e.pack, coins: e.coins, paid: e.paid, discountBps: e.discountBps, seeker: e.seeker };
  }
  return null;
}

/** The `CoinsBought` event of a confirmed purchase, or null when the transaction cannot be read (yet). */
export async function fetchCoinsBought(rpc: SolanaRpc, signature: string): Promise<CoinsBoughtEvent | null> {
  const tx = await rpc.getTransaction(signature as never, { commitment: 'confirmed', maxSupportedTransactionVersion: 0, encoding: 'json' }).send();
  const logs = tx?.meta?.logMessages;
  return logs ? decodeCoinsBought(logs) : null;
}

const meta = (addr: Address, role: AccountRole) => ({ address: addr, role });
const packData = (d: Uint8Array, pack: number) =>
  getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['pack', getU8Encoder()],
  ]).encode({ d, pack });

/** Anchor optional accounts: the program id stands for "none". Both SGT accounts or neither. */
const seekerMetas = (proof: SeekerProof | null) =>
  proof ? [meta(proof.tokenAccount, AccountRole.READONLY), meta(proof.mint, AccountRole.READONLY)] : [meta(program(), AccountRole.READONLY), meta(program(), AccountRole.READONLY)];

export async function buyPackIx(wallet: Address, treasury: Address, pack: number, proof: SeekerProof | null = null): Promise<Instruction> {
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(await buyerAddress(wallet), AccountRole.WRITABLE),
      meta(wallet, AccountRole.WRITABLE_SIGNER),
      meta(treasury, AccountRole.WRITABLE),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
      ...seekerMetas(proof),
    ],
    data: packData(DISC.buyPack, pack),
  };
}

export async function buyPackTokenIx(wallet: Address, entry: MintEntryAccount, pack: number, proof: SeekerProof | null = null): Promise<Instruction> {
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(entry.address, AccountRole.READONLY),
      meta(entry.mint, AccountRole.READONLY),
      meta(await buyerAddress(wallet), AccountRole.WRITABLE),
      meta(wallet, AccountRole.WRITABLE_SIGNER),
      meta(await ataAddress(wallet, entry.mint, entry.tokenProgram), AccountRole.WRITABLE),
      meta(entry.treasuryAta, AccountRole.WRITABLE),
      meta(entry.tokenProgram, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
      ...seekerMetas(proof),
    ],
    data: packData(DISC.buyPackToken, pack),
  };
}
