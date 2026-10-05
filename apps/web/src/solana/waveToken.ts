import {
  AccountRole,
  address,
  fixDecoderSize,
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getArrayDecoder,
  getArrayEncoder,
  getBase64Encoder,
  getBooleanDecoder,
  getBooleanEncoder,
  getBytesDecoder,
  getBytesEncoder,
  getOptionDecoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getStructEncoder,
  getU16Decoder,
  getU16Encoder,
  getU64Decoder,
  getU64Encoder,
  getU8Decoder,
  getU8Encoder,
  getUtf8Encoder,
  type Address,
  type Instruction,
} from '@solana/kit';
import { ASSOCIATED_TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { sha256Hex } from '@beach-bingo/engine';
import { configAddress, NO_KEY, PACKS, program, same, SLOT_HASHES, SYSTEM_PROGRAM, type RoomAccount, type SolanaRpc } from './waveDuel.ts';
import { hallAddress, setComputeUnitLimitIx, type HallAccount } from './waveHall.ts';

/**
 * The token side of the `wave_duel` client: the mint registry (`MintEntry`), rooms and halls staked
 * in a registered SPL Token or Token-2022 mint, the credit claims that finish a settlement whose
 * recipient could not be paid, and the on-chain Seeker Genesis Token proof. Rooms and halls staked in
 * SOL stay in `waveDuel.ts` / `waveHall.ts`; this file shares their PDAs, decoders and sending.
 * Layouts are hand-encoded from `programs/wave_duel/src/lib.rs`, so the two move together.
 *
 * Token accounts: a vault is the Room/Hall PDA's associated token account for the mint (the host pays
 * its rent and gets it back when the escrow closes); deposits come out of the player's own token
 * account (its ATA, normally); payouts go to the accounts the settler passes, one per roster entry
 * in roster order, each owned by that player, which `rosterTokenAccounts` builds from the ATAs. A
 * recipient that cannot be paid (closed, frozen, memo-required) is credited and claims later.
 */
export const TOKEN_PROGRAM = address('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM = TOKEN_2022_PROGRAM_ADDRESS;
export const ASSOCIATED_TOKEN_PROGRAM = ASSOCIATED_TOKEN_PROGRAM_ADDRESS;
export const MEMO_PROGRAM = address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
/** `claim_credit*` index for the treasury's own credit (lib.rs TREASURY_CREDIT). */
export const TREASURY_CREDIT = 255;
/** lib.rs MAX_MINT_STAKE: `max_stake × 32` must fit a u64. */
export const MAX_MINT_STAKE = (2n ** 64n - 1n) / 32n;
/**
 * Compute units a token hall settlement is sent with. Measured in LiteSVM (waveToken.test.ts prints
 * it and asserts the 1.5× headroom): an 8 × 4 PYUSD-like Token-2022 hall, eight `transfer_checked`
 * payouts, the treasury's and the vault close included, settles in 118–124k CU depending on the
 * cards drawn (the SOL hall replays in 98k; a USDC-like room settles in 28k, a six-card Token-2022
 * hall in 50k). The limit keeps a 1.5× margin over the worst case seen, so a priority fee is priced
 * on the real need and a heavy draw never fails.
 */
export const SETTLE_HALL_TOKEN_COMPUTE_UNITS = 250_000;

const utf8 = getUtf8Encoder();
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
const discriminator = (name: string): Uint8Array => hexBytes(sha256Hex(name).slice(0, 16));

const DISC = {
  registerMint: discriminator('global:register_mint'),
  setMint: discriminator('global:set_mint'),
  openRoomToken: discriminator('global:open_room_token'),
  joinRoomToken: discriminator('global:join_room_token'),
  cancelRoomToken: discriminator('global:cancel_room_token'),
  settleToken: discriminator('global:settle_token'),
  claimTimeoutToken: discriminator('global:claim_timeout_token'),
  claimCredit: discriminator('global:claim_credit'),
  proveSeekerRoom: discriminator('global:prove_seeker_room'),
  openHallToken: discriminator('global:open_hall_token'),
  joinHallToken: discriminator('global:join_hall_token'),
  cancelHallToken: discriminator('global:cancel_hall_token'),
  settleHallToken: discriminator('global:settle_hall_token'),
  claimTimeoutHallToken: discriminator('global:claim_timeout_hall_token'),
  claimCreditHall: discriminator('global:claim_credit_hall'),
  proveSeekerHall: discriminator('global:prove_seeker_hall'),
  mintEntryAccount: discriminator('account:MintEntry'),
};

/* ---------- Addresses ---------- */

/** The associated token account of `owner` for `mint` under `tokenProgram` (SPL Token or Token-2022). */
export async function ataAddress(owner: Address, mint: Address, tokenProgram: Address): Promise<Address> {
  const enc = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [enc.encode(owner), enc.encode(tokenProgram), enc.encode(mint)],
  });
  return pda;
}

/** A Room or Hall's vault: its own associated token account for the mint. */
export const vaultAddress = (escrow: Address, mint: Address, tokenProgram: Address): Promise<Address> => ataAddress(escrow, mint, tokenProgram);

export async function mintEntryAddress(mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program(), seeds: [utf8.encode('mint'), getAddressEncoder().encode(mint)] });
  return pda;
}

/* ---------- Accounts ---------- */

export interface MintFlags {
  hasFreezeAuthority: boolean;
  permanentDelegate: boolean;
  transferFeeConfigPresent: boolean;
  pausable: boolean;
  defaultStateFrozen: boolean;
  /** Always null once registered (a set hook is refused). */
  hookProgram: Address | null;
}

export interface MintEntryAccount {
  address: Address;
  mint: Address;
  tokenProgram: Address;
  decimals: number;
  minStake: bigint;
  maxStake: bigint;
  feeBps: number;
  seekerFeeBps: number;
  enabled: boolean;
  flags: MintFlags;
  treasuryAta: Address;
  /** Base units per shop pack; 0 = not sold in this mint. */
  packPrices: bigint[];
  discountBps: number;
}

/** What `register_mint` / `set_mint` take. */
export interface MintTerms {
  minStake: bigint;
  maxStake: bigint;
  feeBps: number;
  seekerFeeBps: number;
  packPrices: bigint[];
  discountBps: number;
}

const mintEntryDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['mint', getAddressDecoder()],
  ['tokenProgram', getAddressDecoder()],
  ['decimals', getU8Decoder()],
  ['minStake', getU64Decoder()],
  ['maxStake', getU64Decoder()],
  ['feeBps', getU16Decoder()],
  ['seekerFeeBps', getU16Decoder()],
  ['enabled', getBooleanDecoder()],
  ['hasFreezeAuthority', getBooleanDecoder()],
  ['permanentDelegate', getBooleanDecoder()],
  ['transferFeeConfigPresent', getBooleanDecoder()],
  ['pausable', getBooleanDecoder()],
  ['defaultStateFrozen', getBooleanDecoder()],
  ['hookProgram', getOptionDecoder(getAddressDecoder(), { prefix: getU8Decoder() })],
  ['treasuryAta', getAddressDecoder()],
  ['packPrices', getArrayDecoder(getU64Decoder(), { size: PACKS })],
  ['discountBps', getU16Decoder()],
  ['bump', getU8Decoder()],
]);

export function decodeMintEntry(addr: Address, data: Uint8Array): MintEntryAccount | null {
  const m = mintEntryDecoder.decode(data);
  if (!same(m.discriminator as Uint8Array, DISC.mintEntryAccount)) return null;
  return {
    address: addr,
    mint: m.mint,
    tokenProgram: m.tokenProgram,
    decimals: m.decimals,
    minStake: m.minStake,
    maxStake: m.maxStake,
    feeBps: m.feeBps,
    seekerFeeBps: m.seekerFeeBps,
    enabled: m.enabled,
    flags: {
      hasFreezeAuthority: m.hasFreezeAuthority,
      permanentDelegate: m.permanentDelegate,
      transferFeeConfigPresent: m.transferFeeConfigPresent,
      pausable: m.pausable,
      defaultStateFrozen: m.defaultStateFrozen,
      hookProgram: m.hookProgram.__option === 'Some' ? m.hookProgram.value : null,
    },
    treasuryAta: m.treasuryAta,
    packPrices: [...m.packPrices],
    discountBps: m.discountBps,
  };
}

export async function fetchMintEntry(rpc: SolanaRpc, mint: Address): Promise<MintEntryAccount | null> {
  const addr = await mintEntryAddress(mint);
  const { value } = await rpc.getAccountInfo(addr, { encoding: 'base64' }).send();
  if (!value) return null;
  return decodeMintEntry(addr, getBase64Encoder().encode(value.data[0]) as Uint8Array);
}

/** Every registered mint: the program's accounts of the `MintEntry` size, filtered by discriminator. */
export async function fetchMintEntries(rpc: SolanaRpc): Promise<MintEntryAccount[]> {
  const accounts = await rpc
    .getProgramAccounts(program(), { encoding: 'base64', filters: [{ memcmp: { offset: 0n, bytes: base58(DISC.mintEntryAccount) as never, encoding: 'base58' } }] })
    .send();
  const out: MintEntryAccount[] = [];
  for (const { pubkey, account } of accounts) {
    const entry = decodeMintEntry(pubkey, getBase64Encoder().encode(account.data[0]) as Uint8Array);
    if (entry) out.push(entry);
  }
  return out;
}

const base58 = (bytes: Uint8Array): string => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
};

/* ---------- Instructions: registry ---------- */

const meta = (addr: Address, role: AccountRole) => ({ address: addr, role });
const termsEncoder = [
  ['minStake', getU64Encoder()],
  ['maxStake', getU64Encoder()],
  ['feeBps', getU16Encoder()],
  ['seekerFeeBps', getU16Encoder()],
  ['packPrices', getArrayEncoder(getU64Encoder(), { size: PACKS })],
  ['discountBps', getU16Encoder()],
] as const;

/** The admin allows a mint; the treasury's ATA for it must already exist. */
export async function registerMintIx(admin: Address, treasury: Address, mint: Address, tokenProgram: Address, terms: MintTerms): Promise<Instruction> {
  const data = getStructEncoder([['d', fixEncoderSize(getBytesEncoder(), 8)], ...termsEncoder]).encode({ d: DISC.registerMint, ...terms });
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(admin, AccountRole.WRITABLE_SIGNER),
      meta(mint, AccountRole.READONLY),
      meta(await mintEntryAddress(mint), AccountRole.WRITABLE),
      meta(await ataAddress(treasury, mint, tokenProgram), AccountRole.READONLY),
      meta(tokenProgram, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    data,
  };
}

export async function setMintIx(admin: Address, mint: Address, terms: MintTerms, enabled: boolean): Promise<Instruction> {
  const data = getStructEncoder([['d', fixEncoderSize(getBytesEncoder(), 8)], ...termsEncoder, ['enabled', getBooleanEncoder()]]).encode({ d: DISC.setMint, ...terms, enabled });
  return {
    programAddress: program(),
    accounts: [meta(await configAddress(), AccountRole.READONLY), meta(admin, AccountRole.READONLY_SIGNER), meta(await mintEntryAddress(mint), AccountRole.WRITABLE)],
    data,
  };
}

/* ---------- Instructions: token rooms ---------- */

/** The mint a room or hall is staked in, from its snapshot. */
const mintOf = (escrow: { mint: Address | null; tokenProgram: Address | null }) => {
  if (!escrow.mint || !escrow.tokenProgram) throw new Error('this escrow is staked in SOL; use the SOL instructions');
  return { mint: escrow.mint, tokenProgram: escrow.tokenProgram };
};

export async function openRoomTokenIx(host: Address, code: string, stake: bigint, commitmentHex: string, entry: MintEntryAccount): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['code', fixEncoderSize(getBytesEncoder(), 5)],
    ['stake', getU64Encoder()],
    ['commitment', fixEncoderSize(getBytesEncoder(), 32)],
  ]).encode({ d: DISC.openRoomToken, code: utf8.encode(code), stake, commitment: hexBytes(commitmentHex) });
  const room = await roomPda(host, code);
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(entry.address, AccountRole.READONLY),
      meta(entry.mint, AccountRole.READONLY),
      meta(room, AccountRole.WRITABLE),
      meta(await vaultAddress(room, entry.mint, entry.tokenProgram), AccountRole.WRITABLE),
      meta(await ataAddress(host, entry.mint, entry.tokenProgram), AccountRole.WRITABLE),
      meta(host, AccountRole.WRITABLE_SIGNER),
      meta(entry.tokenProgram, AccountRole.READONLY),
      meta(ASSOCIATED_TOKEN_PROGRAM, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    data,
  };
}

async function roomPda(host: Address, code: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program(), seeds: [utf8.encode('room'), getAddressEncoder().encode(host), utf8.encode(code)] });
  return pda;
}

export async function joinRoomTokenIx(guest: Address, room: RoomAccount): Promise<Instruction> {
  const { mint, tokenProgram } = mintOf(room);
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(await mintEntryAddress(mint), AccountRole.READONLY),
      meta(room.address, AccountRole.WRITABLE),
      meta(mint, AccountRole.READONLY),
      meta(await vaultAddress(room.address, mint, tokenProgram), AccountRole.WRITABLE),
      meta(await ataAddress(guest, mint, tokenProgram), AccountRole.WRITABLE),
      meta(guest, AccountRole.WRITABLE_SIGNER),
      meta(SLOT_HASHES, AccountRole.READONLY),
      meta(tokenProgram, AccountRole.READONLY),
    ],
    data: DISC.joinRoomToken,
  };
}

export async function cancelRoomTokenIx(room: RoomAccount): Promise<Instruction> {
  const { mint, tokenProgram } = mintOf(room);
  return {
    programAddress: program(),
    accounts: [
      meta(room.address, AccountRole.WRITABLE),
      meta(room.host, AccountRole.WRITABLE_SIGNER),
      meta(mint, AccountRole.READONLY),
      meta(await vaultAddress(room.address, mint, tokenProgram), AccountRole.WRITABLE),
      meta(await ataAddress(room.host, mint, tokenProgram), AccountRole.WRITABLE),
      meta(await ataAddress(room.treasury, mint, tokenProgram), AccountRole.WRITABLE),
      meta(tokenProgram, AccountRole.READONLY),
    ],
    data: DISC.cancelRoomToken,
  };
}

async function settleTokenAccounts(room: RoomAccount, settler: Address) {
  if (!room.guest) throw new Error('room has no guest');
  const { mint, tokenProgram } = mintOf(room);
  return [
    meta(room.address, AccountRole.WRITABLE),
    meta(room.host, AccountRole.WRITABLE),
    meta(mint, AccountRole.READONLY),
    meta(await vaultAddress(room.address, mint, tokenProgram), AccountRole.WRITABLE),
    meta(await ataAddress(room.host, mint, tokenProgram), AccountRole.WRITABLE),
    meta(await ataAddress(room.guest, mint, tokenProgram), AccountRole.WRITABLE),
    meta(await ataAddress(room.treasury, mint, tokenProgram), AccountRole.WRITABLE),
    meta(tokenProgram, AccountRole.READONLY),
    meta(settler, AccountRole.READONLY_SIGNER),
  ];
}

/** Anyone reveals the seed; the program replays the round and pays in tokens (the snapshot's treasury takes the fee). */
export async function settleTokenIx(room: RoomAccount, settler: Address, serverSeedHex: string): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['seed', fixEncoderSize(getBytesEncoder(), 32)],
  ]).encode({ d: DISC.settleToken, seed: hexBytes(serverSeedHex) });
  return { programAddress: program(), accounts: await settleTokenAccounts(room, settler), data };
}

export async function claimTimeoutTokenIx(room: RoomAccount, settler: Address): Promise<Instruction> {
  return { programAddress: program(), accounts: await settleTokenAccounts(room, settler), data: DISC.claimTimeoutToken };
}

/**
 * Pay a credit the settlement could not deliver: `index` 0 the host, 1 the guest, `TREASURY_CREDIT`
 * the treasury; `destination` any token account of the creditor for the mint (its ATA by default).
 */
export async function claimCreditIx(room: RoomAccount, index: number, payer: Address, destination?: Address): Promise<Instruction> {
  const { mint, tokenProgram } = mintOf(room);
  const creditor = index === TREASURY_CREDIT ? room.treasury : index === 0 ? room.host : room.guest;
  if (!creditor) throw new Error('no such creditor');
  return {
    programAddress: program(),
    accounts: [
      meta(room.address, AccountRole.WRITABLE),
      meta(room.host, AccountRole.WRITABLE),
      meta(mint, AccountRole.READONLY),
      meta(await vaultAddress(room.address, mint, tokenProgram), AccountRole.WRITABLE),
      meta(destination ?? (await ataAddress(creditor, mint, tokenProgram)), AccountRole.WRITABLE),
      meta(await ataAddress(room.treasury, mint, tokenProgram), AccountRole.WRITABLE),
      meta(tokenProgram, AccountRole.READONLY),
      meta(MEMO_PROGRAM, AccountRole.READONLY),
      meta(payer, AccountRole.READONLY_SIGNER),
    ],
    data: getStructEncoder([
      ['d', fixEncoderSize(getBytesEncoder(), 8)],
      ['index', getU8Encoder()],
    ]).encode({ d: DISC.claimCredit, index }),
  };
}

/** The Seeker Genesis Token the host passes: its token account and the SGT mint it holds. */
export interface SeekerProof {
  tokenAccount: Address;
  mint: Address;
}

/** The host of an open room proves its Seeker Genesis Token: the fee drops to the Seeker tier. */
export async function proveSeekerRoomIx(room: RoomAccount, proof: SeekerProof): Promise<Instruction> {
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(room.address, AccountRole.WRITABLE),
      meta(room.host, AccountRole.READONLY_SIGNER),
      // Anchor optional account: the program id stands for "none" (a SOL room).
      meta(room.mint ? await mintEntryAddress(room.mint) : program(), AccountRole.READONLY),
      meta(proof.tokenAccount, AccountRole.READONLY),
      meta(proof.mint, AccountRole.READONLY),
    ],
    data: DISC.proveSeekerRoom,
  };
}

/* ---------- Instructions: token halls ---------- */

export async function openHallTokenIx(
  host: Address,
  code: string,
  stakePerCard: bigint,
  maxPlayers: number,
  cards: number,
  commitmentHex: string,
  entry: MintEntryAccount,
): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['code', fixEncoderSize(getBytesEncoder(), 5)],
    ['stakePerCard', getU64Encoder()],
    ['maxPlayers', getU8Encoder()],
    ['cards', getU8Encoder()],
    ['commitment', fixEncoderSize(getBytesEncoder(), 32)],
  ]).encode({ d: DISC.openHallToken, code: utf8.encode(code), stakePerCard, maxPlayers, cards, commitment: hexBytes(commitmentHex) });
  const hall = await hallAddress(host, code);
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(entry.address, AccountRole.READONLY),
      meta(entry.mint, AccountRole.READONLY),
      meta(hall, AccountRole.WRITABLE),
      meta(await vaultAddress(hall, entry.mint, entry.tokenProgram), AccountRole.WRITABLE),
      meta(await ataAddress(host, entry.mint, entry.tokenProgram), AccountRole.WRITABLE),
      meta(host, AccountRole.WRITABLE_SIGNER),
      meta(entry.tokenProgram, AccountRole.READONLY),
      meta(ASSOCIATED_TOKEN_PROGRAM, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    data,
  };
}

export async function joinHallTokenIx(player: Address, hall: HallAccount, cards: number): Promise<Instruction> {
  const { mint, tokenProgram } = mintOf(hall);
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(await mintEntryAddress(mint), AccountRole.READONLY),
      meta(hall.address, AccountRole.WRITABLE),
      meta(mint, AccountRole.READONLY),
      meta(await vaultAddress(hall.address, mint, tokenProgram), AccountRole.WRITABLE),
      meta(await ataAddress(player, mint, tokenProgram), AccountRole.WRITABLE),
      meta(player, AccountRole.WRITABLE_SIGNER),
      meta(SLOT_HASHES, AccountRole.READONLY),
      meta(tokenProgram, AccountRole.READONLY),
    ],
    data: getStructEncoder([
      ['d', fixEncoderSize(getBytesEncoder(), 8)],
      ['cards', getU8Encoder()],
    ]).encode({ d: DISC.joinHallToken, cards }),
  };
}

/**
 * The roster's token accounts as remaining accounts: one per seat in seat order, writable, the
 * seat's associated token account for the hall's mint (any account the player owns for the mint
 * would do; the program checks owner and mint, and credits a seat whose ATA cannot be paid).
 */
export async function rosterTokenAccounts(hall: HallAccount): Promise<{ address: Address; role: AccountRole }[]> {
  const { mint, tokenProgram } = mintOf(hall);
  return Promise.all(hall.seats.map(async (s) => meta(await ataAddress(s.player, mint, tokenProgram), AccountRole.WRITABLE)));
}

export async function cancelHallTokenIx(hall: HallAccount): Promise<Instruction> {
  const { mint, tokenProgram } = mintOf(hall);
  return {
    programAddress: program(),
    accounts: [
      meta(hall.address, AccountRole.WRITABLE),
      meta(hall.host, AccountRole.WRITABLE_SIGNER),
      meta(mint, AccountRole.READONLY),
      meta(await vaultAddress(hall.address, mint, tokenProgram), AccountRole.WRITABLE),
      meta(await ataAddress(hall.treasury, mint, tokenProgram), AccountRole.WRITABLE),
      meta(tokenProgram, AccountRole.READONLY),
      ...(await rosterTokenAccounts(hall)),
    ],
    data: DISC.cancelHallToken,
  };
}

async function settleHallTokenAccounts(hall: HallAccount, settler: Address) {
  const { mint, tokenProgram } = mintOf(hall);
  return [
    meta(hall.address, AccountRole.WRITABLE),
    meta(hall.host, AccountRole.WRITABLE),
    meta(mint, AccountRole.READONLY),
    meta(await vaultAddress(hall.address, mint, tokenProgram), AccountRole.WRITABLE),
    meta(await ataAddress(hall.treasury, mint, tokenProgram), AccountRole.WRITABLE),
    meta(tokenProgram, AccountRole.READONLY),
    meta(settler, AccountRole.READONLY_SIGNER),
    ...(await rosterTokenAccounts(hall)),
  ];
}

export async function settleHallTokenIx(hall: HallAccount, settler: Address, serverSeedHex: string): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['seed', fixEncoderSize(getBytesEncoder(), 32)],
  ]).encode({ d: DISC.settleHallToken, seed: hexBytes(serverSeedHex) });
  return { programAddress: program(), accounts: await settleHallTokenAccounts(hall, settler), data };
}

/** The settlement transaction's instructions: the compute request, then the reveal. */
export async function settleHallTokenIxs(hall: HallAccount, settler: Address, serverSeedHex: string): Promise<Instruction[]> {
  return [setComputeUnitLimitIx(SETTLE_HALL_TOKEN_COMPUTE_UNITS), await settleHallTokenIx(hall, settler, serverSeedHex)];
}

export async function claimTimeoutHallTokenIx(hall: HallAccount, settler: Address): Promise<Instruction> {
  return { programAddress: program(), accounts: await settleHallTokenAccounts(hall, settler), data: DISC.claimTimeoutHallToken };
}

/** Pay a seat's credit (`index` its seat, or `TREASURY_CREDIT`) to `destination` (the seat's ATA by default). */
export async function claimCreditHallIx(hall: HallAccount, index: number, payer: Address, destination?: Address): Promise<Instruction> {
  const { mint, tokenProgram } = mintOf(hall);
  const creditor = index === TREASURY_CREDIT ? hall.treasury : hall.seats[index]?.player;
  if (!creditor) throw new Error('no such creditor');
  return {
    programAddress: program(),
    accounts: [
      meta(hall.address, AccountRole.WRITABLE),
      meta(hall.host, AccountRole.WRITABLE),
      meta(mint, AccountRole.READONLY),
      meta(await vaultAddress(hall.address, mint, tokenProgram), AccountRole.WRITABLE),
      meta(destination ?? (await ataAddress(creditor, mint, tokenProgram)), AccountRole.WRITABLE),
      meta(await ataAddress(hall.treasury, mint, tokenProgram), AccountRole.WRITABLE),
      meta(tokenProgram, AccountRole.READONLY),
      meta(MEMO_PROGRAM, AccountRole.READONLY),
      meta(payer, AccountRole.READONLY_SIGNER),
    ],
    data: getStructEncoder([
      ['d', fixEncoderSize(getBytesEncoder(), 8)],
      ['index', getU8Encoder()],
    ]).encode({ d: DISC.claimCreditHall, index }),
  };
}

export async function proveSeekerHallIx(hall: HallAccount, proof: SeekerProof): Promise<Instruction> {
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(hall.address, AccountRole.WRITABLE),
      meta(hall.host, AccountRole.READONLY_SIGNER),
      meta(hall.mint ? await mintEntryAddress(hall.mint) : program(), AccountRole.READONLY),
      meta(proof.tokenAccount, AccountRole.READONLY),
      meta(proof.mint, AccountRole.READONLY),
    ],
    data: DISC.proveSeekerHall,
  };
}

/* ---------- Arithmetic the program uses, for clients that predict payouts ---------- */

/** The hall timeout: each guest's deposit plus `host deposit × its cards / guest cards` (floor); the host nothing; the remainder to the treasury. */
export function forfeitAmounts(hall: HallAccount): { amounts: bigint[]; forfeited: bigint; dust: bigint } {
  const hostDeposit = hall.stakePerCard * BigInt(hall.seats[0]?.cards ?? 0);
  const guestCards = hall.seats.slice(1).reduce((n, s) => n + BigInt(s.cards), 0n);
  let distributed = 0n;
  const amounts = hall.seats.map((s, i) => {
    if (i === 0) return 0n;
    const bonus = (hostDeposit * BigInt(s.cards)) / (guestCards > 0n ? guestCards : 1n);
    distributed += bonus;
    return hall.stakePerCard * BigInt(s.cards) + bonus;
  });
  return { amounts, forfeited: hostDeposit, dust: hostDeposit - distributed };
}

/** `amount × available / expected`: what a payout becomes when the vault is short (a permanent delegate moved funds). */
export const proRata = (amount: bigint, available: bigint, expected: bigint): bigint => (amount * available) / expected;

export { NO_KEY };
