import { address, getAddressDecoder, getAddressEncoder, getBase64Encoder, getProgramDerivedAddress, getUtf8Decoder, getUtf8Encoder, type Address, type Base58EncodedBytes, type GetAccountInfoApi, type GetMultipleAccountsApi, type GetProgramAccountsApi, type Rpc } from '@solana/kit';
import { sha256Hex } from '@beach-bingo/engine';

/**
 * The Seeker ID: the `.skr` name Solana Mobile issues with every Seeker, registered in AllDomains'
 * Alt Name Service (ANS) on mainnet only, whatever cluster the rest of the app targets. This file
 * ports the handful of reads the lookup needs (the SDK, `@onsol/tldparser-kit`, pins another
 * major of `@solana/kit`), the way Solana Mobile's own `seeker-domains` recipe does it:
 *
 * - every name is an ANS account found by a chain of PDAs seeded with `sha256("ALT Name Service" + name)`:
 *   the root (`hash("ANS")`), the `.skr` parent under it, `alice` under that;
 * - the name account is a 200-byte header: `parent` at 8, `owner` at 40, `expires_at` (u64 LE seconds,
 *   0 = never) at 104; the label itself lives in a separate reverse-lookup account seeded with the
 *   name account's base58 string, class = the TLD house, text from byte 200;
 * - a wallet's names come from `getProgramAccounts` filtered on parent + owner; its chosen main
 *   name from the TLD house program's `MainDomain` PDA, honoured only while the wallet still owns it.
 *
 * Nothing here is a proof of anything: names are transferable and anyone can push one onto any
 * wallet, so the name is shown beside the address and the deals hang on the Seeker Genesis Token.
 * Not-found is `null`; a rejected promise means the RPC failed.
 */
export const ANS_PROGRAM = address('ALTNSZ46uaAUU7XUV6awvdorLGqAsPwa9shm7h4uP2FK');
export const TLD_HOUSE_PROGRAM = address('TLDHkysf5pCnKsVA4gXpNvmy7psXLPEu4LAdDJthT9S');
/** `hash("ANS")` with no class and no parent: deriving it again is the self-check of the hashing and seed order. */
export const ANS_ROOT = address('3mX9b4AZaQehNoQGfckVcmgmA6bkBoFcbLj9RMmMyNcU');
export const SKR_TLD = '.skr';
const HASH_PREFIX = 'ALT Name Service';
const HEADER_SIZE = 200;
const PARENT_OFFSET = 8;
const OWNER_OFFSET = 40;
const EXPIRES_AT_OFFSET = 104;
/** Anchor's discriminator of the TLD house program's `MainDomain` account. */
const MAIN_DOMAIN_DISCRIMINATOR = Uint8Array.from([109, 239, 227, 199, 98, 226, 66, 175]);
/** `getMultipleAccounts` takes at most 100 addresses; one request per 100 names, in sequence, so a wallet loaded with names cannot size a burst against the RPC quota. */
const REVERSE_BATCH = 100;
/** Names kept in the result: the first few sorted, enough to show; a wallet can hold thousands. */
const MAX_NAMES = 10;

/** The three reads the lookup makes, so any cluster's RPC (mainnet has no airdrop) fits. */
export type SkrRpc = Rpc<GetAccountInfoApi & GetMultipleAccountsApi & GetProgramAccountsApi>;

export interface SeekerId {
  /** The name shown: the wallet's main `.skr` name when it set one, else the first of its names sorted. */
  name: string;
  /** True when `name` is the wallet's own choice (its `MainDomain`), the stronger claim. */
  main: boolean;
  /** Every live `.skr` name the wallet owns, sorted, at most `MAX_NAMES`. */
  names: string[];
}

const addressDecoder = getAddressDecoder();
const addressEncoder = getAddressEncoder();
const utf8Decoder = getUtf8Decoder();
const utf8Encoder = getUtf8Encoder();
const base64 = getBase64Encoder();
const ZERO_32 = new Uint8Array(32);

const utf8 = (text: string): Uint8Array => new Uint8Array(utf8Encoder.encode(text));
const addressBytes = (value: Address): Uint8Array => new Uint8Array(addressEncoder.encode(value));
const hexBytes = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16)));
/** ANS hashes names with a fixed prefix; the engine's SHA-256 keeps a second hashing library out of the bundle. */
export const hashName = (name: string): Uint8Array => hexBytes(sha256Hex(HASH_PREFIX + name));

async function pda(programAddress: Address, seeds: Uint8Array[]): Promise<Address> {
  const [derived] = await getProgramDerivedAddress({ programAddress, seeds });
  return derived;
}

/** An ANS name account: `[hash(name), class or zeros, parent or zeros]` on the ANS program. */
export const nameAccount = (name: string, parent?: Address, nameClass?: Address): Promise<Address> =>
  pda(ANS_PROGRAM, [hashName(name), nameClass ? addressBytes(nameClass) : ZERO_32, parent ? addressBytes(parent) : ZERO_32]);

/** The `.skr` parent name account (under the root) and the TLD house that classes its reverse records; both constant, derived once. */
let skrAccounts: Promise<{ parent: Address; tldHouse: Address }> | null = null;
export function skrTld(): Promise<{ parent: Address; tldHouse: Address }> {
  skrAccounts ??= Promise.all([nameAccount(SKR_TLD, ANS_ROOT), pda(TLD_HOUSE_PROGRAM, [utf8('tld_house'), utf8(SKR_TLD)])]).then(([parent, tldHouse]) => ({ parent, tldHouse }));
  return skrAccounts;
}

/** The reverse-lookup account of a name account: seeded with its base58 string, classed by the TLD house. */
export const reverseAccount = (name: Address, tldHouse: Address): Promise<Address> => nameAccount(name, undefined, tldHouse);

/** The wallet's `MainDomain` record on the TLD house program (`["main_domain", wallet]`). */
export const mainDomainAccount = (owner: Address): Promise<Address> => pda(TLD_HOUSE_PROGRAM, [utf8('main_domain'), addressBytes(owner)]);

const bytesOf = (data: readonly [string, string] | string[]): Uint8Array => new Uint8Array(base64.encode(data[0]!));

async function accountData(rpc: SkrRpc, account: Address): Promise<Uint8Array | null> {
  const { value } = await rpc.getAccountInfo(account, { encoding: 'base64' }).send();
  return value ? bytesOf(value.data) : null;
}

/** The header fields the lookup reads from a name account, or null when the data is not one. */
export function parseNameHeader(data: Uint8Array): { parent: Address; owner: Address; expiresAt: bigint } | null {
  if (data.length < HEADER_SIZE) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    parent: addressDecoder.decode(data.subarray(PARENT_OFFSET, PARENT_OFFSET + 32)),
    owner: addressDecoder.decode(data.subarray(OWNER_OFFSET, OWNER_OFFSET + 32)),
    expiresAt: view.getBigUint64(EXPIRES_AT_OFFSET, true),
  };
}

/** `expires_at` 0 is a name that never expires (what Seeker-issued names carry); a past value is unregistered, no grace. */
export const live = (expiresAt: bigint, now = Date.now()): boolean => expiresAt === 0n || Number(expiresAt) * 1000 >= now;

/** The label a reverse-lookup account carries (the bytes after the header, NUL-terminated), or null. */
export function parseReverseLabel(data: Uint8Array): string | null {
  if (data.length <= HEADER_SIZE) return null;
  const label = utf8Decoder.decode(data.subarray(HEADER_SIZE)).replace(/\0[\s\S]*$/, '').trim();
  return label || null;
}

/** A `MainDomain` account: discriminator, the name account, then Borsh strings `tld` and `domain`; null when it is not one. */
export function parseMainDomain(data: Uint8Array): { nameAccount: Address; tld: string; domain: string } | null {
  if (data.length < 48 || !MAIN_DOMAIN_DISCRIMINATOR.every((b, i) => data[i] === b)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const str = (at: number): [string, number] | null => {
    if (at + 4 > data.length) return null;
    const len = view.getUint32(at, true);
    if (at + 4 + len > data.length) return null;
    return [utf8Decoder.decode(data.subarray(at + 4, at + 4 + len)), at + 4 + len];
  };
  const tld = str(40);
  const domain = tld && str(tld[1]);
  return tld && domain ? { nameAccount: addressDecoder.decode(data.subarray(8, 40)), tld: tld[0], domain: domain[0] } : null;
}

/** Every live `.skr` name `owner` holds in a name account, sorted (`"alice.skr"`), at most `limit`. */
export async function skrNames(rpc: SkrRpc, owner: Address, limit = MAX_NAMES): Promise<string[]> {
  const { parent, tldHouse } = await skrTld();
  const accounts = await rpc
    .getProgramAccounts(ANS_PROGRAM, {
      encoding: 'base64',
      // Just the expiry: enough to drop expired names here, without a 200-byte header per name.
      dataSlice: { offset: EXPIRES_AT_OFFSET, length: 8 },
      filters: [
        { memcmp: { offset: BigInt(PARENT_OFFSET), bytes: parent as string as Base58EncodedBytes, encoding: 'base58' } },
        { memcmp: { offset: BigInt(OWNER_OFFSET), bytes: owner as string as Base58EncodedBytes, encoding: 'base58' } },
      ],
    })
    .send();
  const now = Date.now();
  const held = accounts.filter(({ account }) => {
    const slice = bytesOf(account.data);
    return slice.length >= 8 && live(new DataView(slice.buffer, slice.byteOffset, 8).getBigUint64(0, true), now);
  });
  const reverse = await Promise.all(held.map(({ pubkey }) => reverseAccount(pubkey, tldHouse)));
  const names: string[] = [];
  for (let i = 0; i < reverse.length; i += REVERSE_BATCH) {
    const { value } = await rpc.getMultipleAccounts(reverse.slice(i, i + REVERSE_BATCH), { encoding: 'base64' }).send();
    for (const entry of value) {
      const label = entry ? parseReverseLabel(bytesOf(entry.data)) : null;
      if (label) names.push(`${label}${SKR_TLD}`);
    }
  }
  return names.sort().slice(0, limit);
}

/** The `.skr` name `owner` chose as its main domain, honoured only while it still owns the name account and the name is live; else null. */
export async function mainSkrName(rpc: SkrRpc, owner: Address): Promise<string | null> {
  const record = await accountData(rpc, await mainDomainAccount(owner));
  const main = record && parseMainDomain(record);
  if (!main || main.tld !== SKR_TLD || !main.domain) return null;
  const header = await accountData(rpc, main.nameAccount).then((d) => d && parseNameHeader(d));
  // A tokenized name records its NFT record as owner; `.skr` names are not tokenized today, so that case reads as not owned.
  return header && header.owner === owner && live(header.expiresAt) ? `${main.domain}${SKR_TLD}` : null;
}

/**
 * The wallet's Seeker ID: its main `.skr` name when it set one it still owns, else the first of its
 * `.skr` names sorted (sorting is what keeps the label from changing between calls), else null.
 * The two reads run together; a failure of either is the caller's to handle (it rejects).
 */
export async function resolveSeekerId(rpc: SkrRpc, owner: Address): Promise<SeekerId | null> {
  const [main, names] = await Promise.all([mainSkrName(rpc, owner), skrNames(rpc, owner)]);
  if (main) return { name: main, main: true, names: names.includes(main) ? names : [main, ...names].slice(0, MAX_NAMES) };
  return names.length ? { name: names[0]!, main: false, names } : null;
}

/** "alice.skr" or "alice" → "alice"; null when the text cannot be a `.skr` label (ANS labels are lowercase a-z, 0-9 and hyphens). */
export function normalizeSkrLabel(input: string): string | null {
  const label = input.trim().toLowerCase().replace(/\.skr$/, '');
  return /^[a-z0-9-]{1,63}$/.test(label) ? label : null;
}
