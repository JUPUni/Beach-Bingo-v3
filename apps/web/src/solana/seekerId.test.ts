import { address, getAddressEncoder, getBase64Decoder, getBase64Encoder, getUtf8Encoder, type Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { ANS_ROOT, mainDomainAccount, nameAccount, normalizeSkrLabel, parseMainDomain, parseNameHeader, parseReverseLabel, resolveSeekerId, reverseAccount, skrNames, skrTld, type SkrRpc } from './seekerId.ts';

/**
 * Fixtures read from mainnet on 2026-10-05: the name account of `poseid0n.skr`, its reverse-lookup
 * account, and a `MainDomain` record of another wallet. Deriving the same addresses from the
 * constants is the proof the hashing and seed order are right; every wrong derivation fails the
 * same silent way, as an account that does not exist.
 */
const OWNER = address('2jwg9eSLbot3NKSY29GZZTgNWFSLnz55zJhVW2jEGxnv');
const NAME_ACCOUNT = address('11ZCBsSzWBBLgda6cmcut3ZWA3nbyXPAmN3GLDAeyiK');
const NAME_DATA =
  'REhYLA+nZ/PQkRssJac6RUW3MEbYZkOSyaLiM38ITowKt0gsuxZTuhnb5vCZkF8OIbObVNDKxTvmnsjZOr4d1/Pzgms3n4pLAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFIT8WgAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const REVERSE_ACCOUNT = address('3gngQk166dbFPD7UdM6j32pvD2iFJWT53fHjwVoZ2UGg');
const REVERSE_DATA =
  'REhYLA+nZ/MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADLNyGaxO//RCF0Rl1kGc3U+b+1pe+kjdy1basUzfH67Ms3IZrE7/9EIXRGXWQZzdT5v7Wl76SN3LVtqxTN8frsAAAAAAAAAAFIT8WgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABwb3NlaWQwbg==';
const MAIN_DOMAIN_DATA =
  'be/jx2LiQq/xXqHBOJOwf+qRcPj9J+OCGqlQKBwlReGIaGjPz9VbMQQAAAAuc2tyBwAAAHJsampqcmwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
const SKR_PARENT = 'F3A8kuikEiu6k2399oSJ1PWfcJYDHqpwoQ2e8psSDNuF';
const TLD_HOUSE = '4RKP4BEMu5sXBfXSH7xN2owtQrnAJvhhwtBBmj9JEYkA';

const b64 = getBase64Encoder();
const toB64 = getBase64Decoder();
const bytes = (data: string): Uint8Array => new Uint8Array(b64.encode(data));
const addr = (a: Address): Uint8Array => new Uint8Array(getAddressEncoder().encode(a));
const utf8 = (t: string): Uint8Array => new Uint8Array(getUtf8Encoder().encode(t));

/** A 200-byte ANS name header with the fields the lookup reads. */
function header(owner: Address, parent: Address, expiresAt: bigint): Uint8Array {
  const out = new Uint8Array(200);
  out.set(addr(parent), 8);
  out.set(addr(owner), 40);
  new DataView(out.buffer).setBigUint64(104, expiresAt, true);
  return out;
}
const reverse = (label: string): Uint8Array => Uint8Array.from([...new Uint8Array(200), ...utf8(label)]);
function mainDomain(name: Address, tld: string, domain: string): Uint8Array {
  const t = utf8(tld);
  const d = utf8(domain);
  const out = new Uint8Array(48 + t.length + d.length);
  out.set([109, 239, 227, 199, 98, 226, 66, 175], 0);
  out.set(addr(name), 8);
  const view = new DataView(out.buffer);
  view.setUint32(40, t.length, true);
  out.set(t, 44);
  view.setUint32(44 + t.length, d.length, true);
  out.set(d, 48 + t.length);
  return out;
}

/** An RPC of plain accounts: `getProgramAccounts` answers with every account whose header matches the two memcmp filters. */
function fakeRpc(accounts: Record<string, Uint8Array>): SkrRpc {
  const info = (data: Uint8Array) => ({ data: [toB64.decode(data), 'base64'] as [string, string] });
  const send = <T>(value: T) => ({ send: async () => value });
  return {
    getAccountInfo: (a: Address) => send({ value: accounts[a] ? info(accounts[a]) : null }),
    getMultipleAccounts: (list: Address[]) => send({ value: list.map((a) => (accounts[a] ? info(accounts[a]) : null)) }),
    getProgramAccounts: (_program: Address, opts: { dataSlice?: { offset: number; length: number }; filters: { memcmp: { offset: bigint; bytes: string } }[] }) =>
      send(
        Object.entries(accounts)
          .filter(([, data]) => data.length === 200 && opts.filters.every((f) => address(f.memcmp.bytes) === parseNameHeader(data)![f.memcmp.offset === 8n ? 'parent' : 'owner']))
          .map(([pubkey, data]) => ({ pubkey: address(pubkey), account: info(opts.dataSlice ? data.subarray(opts.dataSlice.offset, opts.dataSlice.offset + opts.dataSlice.length) : data) })),
      ),
  } as unknown as SkrRpc;
}

describe('ANS derivations', () => {
  it('reach the root, the .skr parent, the TLD house, a reverse record and a MainDomain from the constants', async () => {
    expect(await nameAccount('ANS')).toBe(ANS_ROOT);
    const { parent, tldHouse } = await skrTld();
    expect(parent).toBe(SKR_PARENT);
    expect(tldHouse).toBe(TLD_HOUSE);
    expect(await reverseAccount(NAME_ACCOUNT, tldHouse)).toBe(REVERSE_ACCOUNT);
    expect(await mainDomainAccount(OWNER)).toBe('4wTLK6q2kcyAPLNthnzuTug777RZBvqDYHVhTi2X3BAt');
  });

  it('parses the mainnet accounts: the header, the label and a MainDomain record', () => {
    expect(parseNameHeader(bytes(NAME_DATA))).toEqual({ parent: SKR_PARENT, owner: OWNER, expiresAt: 0n });
    expect(parseReverseLabel(bytes(REVERSE_DATA))).toBe('poseid0n');
    expect(parseMainDomain(bytes(MAIN_DOMAIN_DATA))).toEqual({ nameAccount: 'HFCwzFPot228XfpGJ5aLRN2YvaTDSqbgSRqoVje5zg56', tld: '.skr', domain: 'rljjjrl' });
    expect(parseNameHeader(new Uint8Array(10))).toBeNull();
    expect(parseReverseLabel(new Uint8Array(200))).toBeNull();
    expect(parseMainDomain(bytes(NAME_DATA))).toBeNull();
  });
});

describe('the Seeker ID', () => {
  const parent = address(SKR_PARENT);
  const tldHouse = address(TLD_HOUSE);
  const other = address('CY9rqL9f4GhppkhCc6Bdok2ivB9Rrc2AUxteFCEADowS');
  const zed = address('12FCJg8M12JAFceNZcjqscaQRtj3QQWJ1wdFn2kaobY');
  const gone = address('12uX8c8aEx58Jq9fEHnPSH517eeoqHq3FMPCwQNcMbt');

  it('is the one .skr name a Seeker wallet holds, from the real accounts', async () => {
    const rpc = fakeRpc({ [NAME_ACCOUNT]: bytes(NAME_DATA), [REVERSE_ACCOUNT]: bytes(REVERSE_DATA) });
    expect(await resolveSeekerId(rpc, OWNER)).toEqual({ name: 'poseid0n.skr', main: false, names: ['poseid0n.skr'] });
    expect(await resolveSeekerId(rpc, other)).toBeNull();
  });

  it('sorts several names, drops expired ones and names of other owners', async () => {
    const rpc = fakeRpc({
      [NAME_ACCOUNT]: header(OWNER, parent, 0n),
      [await reverseAccount(NAME_ACCOUNT, tldHouse)]: reverse('zed'),
      [zed]: header(OWNER, parent, BigInt(Math.floor(Date.now() / 1000) + 86_400)),
      [await reverseAccount(zed, tldHouse)]: reverse('amy'),
      [gone]: header(OWNER, parent, 1n),
      [await reverseAccount(gone, tldHouse)]: reverse('aaa'),
      [other]: header(other, parent, 0n),
      [await reverseAccount(other, tldHouse)]: reverse('aab'),
    });
    expect(await skrNames(rpc, OWNER)).toEqual(['amy.skr', 'zed.skr']);
    expect((await resolveSeekerId(rpc, OWNER))?.name).toBe('amy.skr');
  });

  it('prefers the main domain the wallet chose while it still owns it, and ignores a stale or foreign one', async () => {
    const held = {
      [NAME_ACCOUNT]: header(OWNER, parent, 0n),
      [await reverseAccount(NAME_ACCOUNT, tldHouse)]: reverse('zed'),
      [zed]: header(OWNER, parent, 0n),
      [await reverseAccount(zed, tldHouse)]: reverse('amy'),
    };
    const main = await mainDomainAccount(OWNER);
    expect(await resolveSeekerId(fakeRpc({ ...held, [main]: mainDomain(NAME_ACCOUNT, '.skr', 'zed') }), OWNER)).toEqual({ name: 'zed.skr', main: true, names: ['amy.skr', 'zed.skr'] });
    // The main record points at a name this wallet no longer owns: back to the sorted first.
    expect(await resolveSeekerId(fakeRpc({ ...held, [main]: mainDomain(other, '.skr', 'sold'), [other]: header(other, parent, 0n) }), OWNER)).toEqual({ name: 'amy.skr', main: false, names: ['amy.skr', 'zed.skr'] });
    // A main domain under another TLD says nothing about the Seeker ID.
    expect((await resolveSeekerId(fakeRpc({ ...held, [main]: mainDomain(NAME_ACCOUNT, '.abc', 'zed') }), OWNER))?.main).toBe(false);
    // A main name the lookup of owned names missed (a provider without getProgramAccounts) still shows.
    expect(await resolveSeekerId(fakeRpc({ [main]: mainDomain(NAME_ACCOUNT, '.skr', 'zed'), [NAME_ACCOUNT]: header(OWNER, parent, 0n) }), OWNER)).toEqual({ name: 'zed.skr', main: true, names: ['zed.skr'] });
  });

  it('normalizes typed labels', () => {
    expect(normalizeSkrLabel(' Alice.SKR ')).toBe('alice');
    expect(normalizeSkrLabel('alice')).toBe('alice');
    expect(normalizeSkrLabel('a.alice.skr')).toBeNull();
    expect(normalizeSkrLabel('')).toBeNull();
  });
});
