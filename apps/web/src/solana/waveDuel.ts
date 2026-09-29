import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  fixDecoderSize,
  fixEncoderSize,
  getAddressDecoder,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getBooleanDecoder,
  getBytesDecoder,
  getBytesEncoder,
  getProgramDerivedAddress,
  getStructDecoder,
  getStructEncoder,
  getU16Decoder,
  getU16Encoder,
  getU64Decoder,
  getU64Encoder,
  getU8Decoder,
  getUtf8Encoder,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signAndSendTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type Rpc,
  type SolanaRpcApi,
  type TransactionSendingSigner,
} from '@solana/kit';
import { sha256Hex } from '@beach-bingo/engine';
import { CLUSTER } from './config.ts';

/** The app's RPC (client.ts) or a test's; nothing here touches the wallet layer at import time. */
export type SolanaRpc = Rpc<SolanaRpcApi>;

/**
 * Client for the `wave_duel` program (programs/wave_duel): a trustless 1v1 Wave Rush escrow.
 * Instruction and account layouts are hand-encoded from the program's source, so this file
 * and `lib.rs` must move together. Anchor discriminators: sha256("global:<ix>")[..8] and
 * sha256("account:<Struct>")[..8].
 */
let programId: Address | null = import.meta.env.VITE_WAVE_DUEL_PROGRAM ? address(import.meta.env.VITE_WAVE_DUEL_PROGRAM) : null;
/** Tests and tools point the client at a program the build did not know. */
export function configureProgram(id: Address | null): void {
  programId = id;
}
export const SLOT_HASHES = address('SysvarS1otHashes111111111111111111111111111');
export const SYSTEM_PROGRAM = address('11111111111111111111111111111111');
export const LAMPORTS_PER_SOL = 1_000_000_000;
/** The program's bounds (lib.rs MIN_STAKE / MAX_STAKE). */
export const MIN_STAKE = 1_000_000n;
export const MAX_STAKE = 100_000_000_000n;
/** Stake presets for the lobby, in lamports. */
export const STAKE_PRESETS = [10_000_000n, 25_000_000n, 50_000_000n, 100_000_000n, 250_000_000n] as const;
/** lib.rs TIMEOUT_SLOTS: the host forfeits after this many slots without a reveal. */
export const TIMEOUT_SLOTS = 3_000n;

export const enabled = (): boolean => programId !== null;

const utf8 = getUtf8Encoder();
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));
export const bytesToHex = (bytes: ArrayLike<number>): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const discriminator = (name: string): Uint8Array => hexBytes(sha256Hex(name).slice(0, 16));

const DISC = {
  initConfig: discriminator('global:init_config'),
  setConfig: discriminator('global:set_config'),
  openRoom: discriminator('global:open_room'),
  joinRoom: discriminator('global:join_room'),
  cancelRoom: discriminator('global:cancel_room'),
  settle: discriminator('global:settle'),
  claimTimeout: discriminator('global:claim_timeout'),
  configAccount: discriminator('account:Config'),
  roomAccount: discriminator('account:Room'),
};

/* ---------- Addresses ---------- */

export function program(): Address {
  if (!programId) throw new Error('wave_duel program is not configured (VITE_WAVE_DUEL_PROGRAM)');
  return programId;
}

export async function configAddress(): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress: program(), seeds: [utf8.encode('config')] });
  return pda;
}

export async function roomAddress(host: Address, code: string): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: program(),
    seeds: [utf8.encode('room'), getAddressEncoder().encode(host), utf8.encode(code)],
  });
  return pda;
}

/* ---------- Accounts ---------- */

export type RoomState = 'open' | 'ready';

export interface RoomAccount {
  address: Address;
  host: Address;
  guest: Address | null;
  stake: bigint;
  commitment: string;
  code: string;
  state: RoomState;
  createdSlot: bigint;
  joinedSlot: bigint;
  entropy: string;
  lamports: bigint;
}

export interface ConfigAccount {
  admin: Address;
  treasury: Address;
  feeBps: number;
  paused: boolean;
}

const roomDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['host', getAddressDecoder()],
  ['guest', getAddressDecoder()],
  ['stake', getU64Decoder()],
  ['commitment', fixDecoderSize(getBytesDecoder(), 32)],
  ['code', fixDecoderSize(getBytesDecoder(), 5)],
  ['state', getU8Decoder()],
  ['createdSlot', getU64Decoder()],
  ['joinedSlot', getU64Decoder()],
  ['entropy', fixDecoderSize(getBytesDecoder(), 32)],
  ['bump', getU8Decoder()],
]);

const configDecoder = getStructDecoder([
  ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
  ['admin', getAddressDecoder()],
  ['treasury', getAddressDecoder()],
  ['feeBps', getU16Decoder()],
  ['paused', getBooleanDecoder()],
  ['bump', getU8Decoder()],
]);

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const NO_GUEST = '11111111111111111111111111111111';

async function accountBytes(rpc: SolanaRpc, addr: Address): Promise<{ data: Uint8Array; lamports: bigint } | null> {
  const { value } = await rpc.getAccountInfo(addr, { encoding: 'base64' }).send();
  if (!value) return null;
  return { data: getBase64Encoder().encode(value.data[0]) as Uint8Array, lamports: BigInt(value.lamports) };
}

/** Decode a Room account's bytes (as fetched from any source). */
export function decodeRoom(addr: Address, data: Uint8Array, lamports: bigint): RoomAccount | null {
  const r = roomDecoder.decode(data);
  if (!same(r.discriminator as Uint8Array, DISC.roomAccount)) return null;
  return {
    address: addr,
    host: r.host,
    guest: r.guest === NO_GUEST ? null : r.guest,
    stake: r.stake,
    commitment: bytesToHex(r.commitment),
    code: new TextDecoder().decode(r.code),
    state: r.state === 1 ? 'ready' : 'open',
    createdSlot: r.createdSlot,
    joinedSlot: r.joinedSlot,
    entropy: bytesToHex(r.entropy),
    lamports,
  };
}

export function decodeConfig(data: Uint8Array): ConfigAccount | null {
  const c = configDecoder.decode(data);
  if (!same(c.discriminator as Uint8Array, DISC.configAccount)) return null;
  return { admin: c.admin, treasury: c.treasury, feeBps: c.feeBps, paused: c.paused };
}

export async function fetchRoom(rpc: SolanaRpc, addr: Address): Promise<RoomAccount | null> {
  const found = await accountBytes(rpc, addr);
  return found ? decodeRoom(addr, found.data, found.lamports) : null;
}

export async function fetchConfig(rpc: SolanaRpc): Promise<ConfigAccount | null> {
  const found = await accountBytes(rpc, await configAddress());
  return found ? decodeConfig(found.data) : null;
}

export async function currentSlot(rpc: SolanaRpc): Promise<bigint> {
  return await rpc.getSlot({ commitment: 'confirmed' }).send();
}

/* ---------- Instructions ---------- */

const meta = (addr: Address, role: AccountRole) => ({ address: addr, role });

export async function initConfigIx(admin: Address, treasury: Address, feeBps: number): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['feeBps', getU16Encoder()],
  ]).encode({ d: DISC.initConfig, feeBps });
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.WRITABLE),
      meta(admin, AccountRole.WRITABLE_SIGNER),
      meta(treasury, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    data,
  };
}

export async function openRoomIx(host: Address, code: string, stake: bigint, commitmentHex: string): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['code', fixEncoderSize(getBytesEncoder(), 5)],
    ['stake', getU64Encoder()],
    ['commitment', fixEncoderSize(getBytesEncoder(), 32)],
  ]).encode({ d: DISC.openRoom, code: utf8.encode(code), stake, commitment: hexBytes(commitmentHex) });
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(await roomAddress(host, code), AccountRole.WRITABLE),
      meta(host, AccountRole.WRITABLE_SIGNER),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    data,
  };
}

export async function joinRoomIx(guest: Address, room: Address): Promise<Instruction> {
  return {
    programAddress: program(),
    accounts: [
      meta(await configAddress(), AccountRole.READONLY),
      meta(room, AccountRole.WRITABLE),
      meta(guest, AccountRole.WRITABLE_SIGNER),
      meta(SLOT_HASHES, AccountRole.READONLY),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    data: DISC.joinRoom,
  };
}

export async function cancelRoomIx(host: Address, room: Address): Promise<Instruction> {
  return {
    programAddress: program(),
    accounts: [meta(room, AccountRole.WRITABLE), meta(host, AccountRole.WRITABLE_SIGNER)],
    data: DISC.cancelRoom,
  };
}

async function settleAccounts(room: RoomAccount, treasury: Address, settler: Address) {
  if (!room.guest) throw new Error('room has no guest');
  return [
    meta(await configAddress(), AccountRole.READONLY),
    meta(room.address, AccountRole.WRITABLE),
    meta(room.host, AccountRole.WRITABLE),
    meta(room.guest, AccountRole.WRITABLE),
    meta(treasury, AccountRole.WRITABLE),
    meta(settler, AccountRole.READONLY_SIGNER),
  ];
}

export async function settleIx(room: RoomAccount, treasury: Address, settler: Address, serverSeedHex: string): Promise<Instruction> {
  const data = getStructEncoder([
    ['d', fixEncoderSize(getBytesEncoder(), 8)],
    ['seed', fixEncoderSize(getBytesEncoder(), 32)],
  ]).encode({ d: DISC.settle, seed: hexBytes(serverSeedHex) });
  return { programAddress: program(), accounts: await settleAccounts(room, treasury, settler), data };
}

export async function claimTimeoutIx(room: RoomAccount, treasury: Address, settler: Address): Promise<Instruction> {
  return { programAddress: program(), accounts: await settleAccounts(room, treasury, settler), data: DISC.claimTimeout };
}

/* ---------- Sending ---------- */

export interface Sent {
  signature: string;
  explorer: string;
}

export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${CLUSTER === 'devnet' ? '?cluster=devnet' : ''}`;
}

/** Sign with the wallet and send; resolves once the transaction is confirmed or throws with its error. */
export async function send(rpc: SolanaRpc, signer: TransactionSendingSigner, instructions: Instruction[]): Promise<Sent> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signatureBytes = await signAndSendTransactionMessageWithSigners(message);
  const signature = getBase58Decoder().decode(signatureBytes);
  await confirm(rpc, signature);
  return { signature, explorer: explorerUrl(signature) };
}

async function confirm(rpc: SolanaRpc, signature: string, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  for (;;) {
    const { value } = await rpc.getSignatureStatuses([signature as never]).send();
    const status = value[0];
    if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')) return;
    if (Date.now() - started > timeoutMs) throw new Error('transaction not confirmed in time');
    await new Promise((r) => setTimeout(r, 1200));
  }
}

export const formatSol = (lamports: bigint): string => `${(Number(lamports) / LAMPORTS_PER_SOL).toLocaleString('en-US', { maximumFractionDigits: 4 })} SOL`;
