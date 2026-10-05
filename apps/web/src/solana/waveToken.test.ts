import { existsSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { FailedTransactionMetadata, LiteSVM } from 'litesvm';
import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPair,
  getAddressEncoder,
  getAddressFromPublicKey,
  createNoopSigner,
  getBase58Decoder,
  getStructEncoder,
  getU32Encoder,
  getU64Encoder,
  lamports,
  none,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  some,
  type Address,
  type Instruction,
} from '@solana/kit';
import {
  AccountState,
  getCreateAssociatedTokenIdempotentInstruction,
  getFreezeAccountInstruction,
  getInitializeDefaultAccountStateInstruction,
  getInitializeGroupMemberPointerInstruction,
  getInitializeGroupPointerInstruction,
  getInitializeMetadataPointerInstruction,
  getInitializeMint2Instruction,
  getInitializeNonTransferableMintInstruction,
  getInitializePausableConfigInstruction,
  getInitializePermanentDelegateInstruction,
  getInitializeTokenGroupInstruction,
  getInitializeTokenGroupMemberInstruction,
  getInitializeTransferFeeConfigInstruction,
  getInitializeTransferHookInstruction,
  getMintSize,
  getMintToInstruction,
  getPauseInstruction,
  getResumeInstruction,
  getThawAccountInstruction,
  getTransferCheckedInstruction,
  type ExtensionArgs,
} from '@solana-program/token-2022';
import { commitSeed, createServerSeed, rooms } from '@beach-bingo/engine';
import { buildRoom } from '../rooms/live/protocol.ts';
import {
  configAddress,
  configureProgram,
  decodeConfig,
  decodeRoom,
  initConfigIx,
  joinRoomIx,
  openRoomIx,
  pauseIx,
  roomAddress,
  setConfigIx,
  settleIx,
  SYSTEM_PROGRAM,
  TIMEOUT_SLOTS,
  type ConfigAccount,
  type ConfigTerms,
  type RoomAccount,
} from './waveDuel.ts';
import { decodeHall, hallAddress, hallRoster, splitHallPot, type HallAccount } from './waveHall.ts';
import {
  ataAddress,
  cancelRoomTokenIx,
  claimCreditIx,
  claimTimeoutHallTokenIx,
  claimTimeoutTokenIx,
  decodeMintEntry,
  forfeitAmounts,
  joinHallTokenIx,
  joinRoomTokenIx,
  mintEntryAddress,
  openHallTokenIx,
  openRoomTokenIx,
  proRata,
  proveSeekerHallIx,
  proveSeekerRoomIx,
  registerMintIx,
  SETTLE_HALL_TOKEN_COMPUTE_UNITS,
  setMintIx,
  settleHallTokenIx,
  settleHallTokenIxs,
  settleTokenIx,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  TREASURY_CREDIT,
  vaultAddress,
  type MintEntryAccount,
  type MintTerms,
} from './waveToken.ts';
import { buyerAddress, buyPackIx, buyPackTokenIx, decodeBuyer, packPrice } from './shop.ts';

/**
 * The program's token paths, run in LiteSVM from the compiled .so against mints built with
 * `@solana-program/token-2022`: a USDC-like SPL Token mint (freeze authority), a PYUSD-like
 * Token-2022 mint (permanent delegate, zero transfer fee, empty transfer hook, metadata pointer),
 * an SKR-like SPL mint, a pausable mint, the mints registration must refuse, and a mock Seeker
 * Genesis Token group. Every payout is checked to the base unit against the engine's own replay.
 *
 * Build the program first: `cd programs/wave_duel && cargo build-sbf`. Without the .so the suite
 * is skipped, so the rest of the tests run on a machine without the Solana toolchain.
 */
const SO = new URL('../../../../programs/wave_duel/target/deploy/wave_duel.so', import.meta.url).pathname;
const PROGRAM = '6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH' as Address;
const SOL = 1_000_000_000n;
const STAKE = 5_000_000n; // 5 units of a 6-decimal token
const FEE_BPS = 500;
const SLOT_HASH = new Uint8Array(32).fill(9);
const UNIT = 1_000_000n;

interface Wallet {
  keyPair: CryptoKeyPair;
  address: Address;
}

interface MintSpec {
  program: Address;
  decimals: number;
  freezeAuthority?: Address;
  /** For `getMintSize`: the extensions the account must have room for at `InitializeMint2`. */
  extensions?: ExtensionArgs[];
  /** Extensions Token-2022 adds by reallocating the mint later (groups, members): rent is pre-funded for them. */
  later?: ExtensionArgs[];
  /** Extension initialisers that must run before `InitializeMint2`. */
  before?: (mint: Address) => Instruction[];
  /** Initialisers that run after it (token groups and members). */
  after?: (mint: Address) => Instruction[];
}

const meta = (addr: Address, role: AccountRole) => ({ address: addr, role });
/** Codama builders want a signer object where an account must sign; the key pairs sign the transaction itself. */
const signer = (w: Wallet) => createNoopSigner(w.address);
const terms = (feeBps: number, seekerFeeBps: number, discountBps = 0, packPrices: bigint[] = [0n, 0n, 0n, 0n]): MintTerms => ({
  minStake: UNIT,
  maxStake: 1_000n * UNIT,
  feeBps,
  seekerFeeBps,
  packPrices,
  discountBps,
});

describe.skipIf(!existsSync(SO))('wave_duel tokens on LiteSVM', () => {
  let svm: LiteSVM;
  let admin: Wallet;
  let treasury: Wallet;
  let pauser: Wallet;
  let freezer: Wallet;
  let delegate: Wallet;
  let host: Wallet;
  let guests: Wallet[];
  let stranger: Wallet;
  let usdc: Address;
  let pyusd: Address;
  let skr: Address;
  let pausable: Address;
  let sgtGroup: Address;
  let sgtMint: Address;
  let otherGroupMint: Address;

  const wallet = async (): Promise<Wallet> => {
    const keyPair = await generateKeyPair();
    return { keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
  };
  const balance = (w: Wallet): bigint => svm.getBalance(w.address) ?? 0n;
  const run = async (payer: Wallet, ixs: Instruction[], others: Wallet[] = []) => {
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: svm.latestBlockhash(), lastValidBlockHeight: 1_000_000n }, m),
      (m) => appendTransactionMessageInstructions(ixs, m),
    );
    const tx = await signTransaction([payer.keyPair, ...others.map((w) => w.keyPair)], compileTransaction(message));
    const result = svm.sendTransaction(tx);
    svm.expireBlockhash();
    return result;
  };
  const ok = async (payer: Wallet, ixs: Instruction[], others: Wallet[] = []) => {
    const result = await run(payer, ixs, others);
    if (result instanceof FailedTransactionMetadata) throw new Error(`${JSON.stringify(result.err())}\n${result.meta().logs().join('\n')}`);
    return result;
  };
  const fails = async (payer: Wallet, ixs: Instruction[], code: string, others: Wallet[] = []) => {
    const result = await run(payer, ixs, others);
    expect(result).toBeInstanceOf(FailedTransactionMetadata);
    expect((result as FailedTransactionMetadata).meta().logs().join('\n')).toContain(code);
  };
  const exists = (addr: Address): boolean => svm.getAccount(addr).exists;
  /** An account that must exist: its bytes and lamports. */
  const must = (addr: Address) => {
    const account = svm.getAccount(addr);
    if (!account.exists) throw new Error(`no account at ${addr}`);
    return account;
  };
  /** A token account's balance (base units), or null when the account does not exist. */
  const tokens = (addr: Address): bigint | null => {
    const account = svm.getAccount(addr);
    if (!account.exists) return null;
    return new DataView(account.data.buffer, account.data.byteOffset, account.data.byteLength).getBigUint64(64, true);
  };
  const config = async (): Promise<ConfigAccount> => decodeConfig(new Uint8Array(must(await configAddress()).data))!;
  const configTerms = (c: ConfigAccount): ConfigTerms => ({
    feeBps: c.feeBps,
    paused: c.paused,
    pauser: c.pauser,
    sgtGroup: c.sgtGroup,
    packCoins: c.packCoins,
    seekerDiscountBps: c.seekerDiscountBps,
    solPackPrices: c.solPackPrices,
    solSeekerFeeBps: c.solSeekerFeeBps,
  });
  const setConfig = async (changes: Partial<ConfigTerms>, treasuryAddr = treasury.address) => ok(admin, [await setConfigIx(admin.address, treasuryAddr, { ...configTerms(await config()), ...changes })]);
  const entry = async (mint: Address): Promise<MintEntryAccount> => {
    const addr = await mintEntryAddress(mint);
    return decodeMintEntry(addr, new Uint8Array(must(addr).data))!;
  };
  const readRoom = async (hostWallet: Wallet, code: string): Promise<RoomAccount | null> => {
    const pda = await roomAddress(hostWallet.address, code);
    const account = svm.getAccount(pda);
    return account.exists ? decodeRoom(pda, new Uint8Array(account.data), BigInt(account.lamports)) : null;
  };
  const readHall = async (hostWallet: Wallet, code: string): Promise<HallAccount | null> => {
    const pda = await hallAddress(hostWallet.address, code);
    const account = svm.getAccount(pda);
    return account.exists ? decodeHall(pda, new Uint8Array(account.data), BigInt(account.lamports)) : null;
  };
  const createAccountIx = (payer: Address, newAccount: Address, rent: bigint, space: bigint, owner: Address): Instruction => ({
    programAddress: SYSTEM_PROGRAM,
    accounts: [meta(payer, AccountRole.WRITABLE_SIGNER), meta(newAccount, AccountRole.WRITABLE_SIGNER)],
    data: getStructEncoder([
      ['ix', getU32Encoder()],
      ['lamports', getU64Encoder()],
      ['space', getU64Encoder()],
      ['owner', getAddressEncoder()],
    ]).encode({ ix: 0, lamports: rent, space, owner }),
  });
  /** A mint with the admin as mint authority, built the way the report prescribes (extensions first, then InitializeMint2). */
  const createMint = async (spec: MintSpec): Promise<Address> => {
    const kp = await wallet();
    const mint = kp.address;
    const space = BigInt(spec.program === TOKEN_PROGRAM ? 82 : getMintSize(spec.extensions ?? []));
    const finalSpace = BigInt(spec.program === TOKEN_PROGRAM ? 82 : getMintSize([...(spec.extensions ?? []), ...(spec.later ?? [])]));
    const ixs = [
      createAccountIx(admin.address, mint, svm.minimumBalanceForRentExemption(finalSpace), space, spec.program),
      ...(spec.before?.(mint) ?? []),
      getInitializeMint2Instruction({ mint, decimals: spec.decimals, mintAuthority: admin.address, freezeAuthority: spec.freezeAuthority ?? null }, { programAddress: spec.program }),
      ...(spec.after?.(mint) ?? []),
    ];
    await ok(admin, ixs, [kp]);
    return mint;
  };
  /** Create `owner`'s ATA for `mint` (idempotently) and mint `amount` into it. */
  const fund = async (owner: Address, mint: Address, program: Address, amount: bigint): Promise<Address> => {
    const ata = await ataAddress(owner, mint, program);
    const ixs: Instruction[] = [getCreateAssociatedTokenIdempotentInstruction({ payer: signer(admin), ata, owner, mint, tokenProgram: program })];
    if (amount > 0n) ixs.push(getMintToInstruction({ mint, token: ata, mintAuthority: signer(admin), amount }, { programAddress: program }));
    await ok(admin, ixs);
    return ata;
  };
  const programOf = (mint: Address): Address => (mint === usdc || mint === skr ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM);
  /** The engine's answer for a room: the winners (0 host, 1 guest). */
  const engineWinners = (room: RoomAccount, serverSeed: string): number[] => {
    const state = buildRoom(
      rooms.ROOM_PRESETS.waveRush,
      room.commitment,
      serverSeed,
      [
        { id: 'host', name: 'Host', cards: 1 },
        { id: 'guest', name: 'Guest', cards: 1 },
      ],
      room.entropy,
    );
    while (state.phase === 'drawing') rooms.drawNext(state);
    return state.wins[0]!.winners.map((w) => (w.playerId === 'host' ? 0 : 1));
  };
  const engineHall = (hall: HallAccount, serverSeed: string) => {
    const state = buildRoom(rooms.ROOM_PRESETS.waveRush, hall.commitment, serverSeed, hallRoster(hall), hall.entropy);
    while (state.phase === 'drawing') rooms.drawNext(state);
    const win = state.wins[0]!;
    return { winningCards: win.winners.length, shares: hall.seats.map((s) => win.winners.filter((w) => w.playerId === s.player).length) };
  };
  /** What a room's settlement pays each side, from the engine's replay and the room's snapshot. */
  const roomPayout = (room: RoomAccount, seed: string) => {
    const pot = room.stake * 2n;
    const fee = (pot * BigInt(room.feeBps)) / 10_000n;
    const prize = pot - fee;
    const winners = engineWinners(room, seed);
    if (winners.length === 2) return { host: prize / 2n, guest: prize / 2n, treasury: fee + (prize % 2n), pot };
    return winners[0] === 0 ? { host: prize, guest: 0n, treasury: fee, pot } : { host: 0n, guest: prize, treasury: fee, pot };
  };
  /** Open and join a token room; the players' ATAs must be funded. */
  const openAndJoin = async (mint: Address, code: string, stake = STAKE) => {
    const seed = createServerSeed();
    await ok(host, [await openRoomTokenIx(host.address, code, stake, commitSeed(seed), await entry(mint))]);
    let room = (await readRoom(host, code))!;
    await ok(guests[0]!, [await joinRoomTokenIx(guests[0]!.address, room)]);
    room = (await readRoom(host, code))!;
    return { seed, room };
  };

  beforeAll(async () => {
    svm = new LiteSVM();
    svm.addProgramFromFile(PROGRAM, SO);
    configureProgram(PROGRAM);
    svm.setSlotHashes([{ slot: svm.getClock().slot, hash: getBase58Decoder().decode(SLOT_HASH) }]);
    [admin, treasury, pauser, freezer, delegate, host, stranger, ...guests] = await Promise.all(Array.from({ length: 14 }, wallet));
    for (const w of [admin, treasury, pauser, freezer, delegate, host, stranger, ...guests]) svm.airdrop(w.address, lamports(100n * SOL));
    await ok(admin, [await initConfigIx(admin.address, treasury.address, FEE_BPS)]);

    const zeroFee = { epoch: 0n, maximumFee: 0n, transferFeeBasisPoints: 0 };
    usdc = await createMint({ program: TOKEN_PROGRAM, decimals: 6, freezeAuthority: freezer.address });
    skr = await createMint({ program: TOKEN_PROGRAM, decimals: 6 });
    pyusd = await createMint({
      program: TOKEN_2022_PROGRAM,
      decimals: 6,
      freezeAuthority: freezer.address,
      extensions: [
        { __kind: 'PermanentDelegate', delegate: delegate.address },
        { __kind: 'TransferFeeConfig', transferFeeConfigAuthority: admin.address, withdrawWithheldAuthority: admin.address, withheldAmount: 0n, olderTransferFee: zeroFee, newerTransferFee: zeroFee },
        { __kind: 'TransferHook', authority: admin.address, programId: SYSTEM_PROGRAM },
        { __kind: 'MetadataPointer', authority: some(admin.address), metadataAddress: none() },
      ],
      before: (mint) => [
        getInitializePermanentDelegateInstruction({ mint, delegate: delegate.address }),
        getInitializeTransferFeeConfigInstruction({ mint, transferFeeConfigAuthority: admin.address, withdrawWithheldAuthority: admin.address, transferFeeBasisPoints: 0, maximumFee: 0n }),
        getInitializeTransferHookInstruction({ mint, authority: admin.address, programId: null }),
        getInitializeMetadataPointerInstruction({ mint, authority: admin.address, metadataAddress: mint }),
      ],
    });
    pausable = await createMint({
      program: TOKEN_2022_PROGRAM,
      decimals: 6,
      extensions: [{ __kind: 'PausableConfig', authority: some(admin.address), paused: false }],
      before: (mint) => [getInitializePausableConfigInstruction({ mint, authority: admin.address })],
    });
    // A mock Seeker Genesis Token: a Token-2022 group, and member mints whose metadata pointer and
    // group membership both name it (the shape the real SGT has, docs.solanamobile.com).
    const group = async (): Promise<Address> =>
      createMint({
        program: TOKEN_2022_PROGRAM,
        decimals: 0,
        extensions: [{ __kind: 'GroupPointer', authority: some(admin.address), groupAddress: none() }],
        later: [{ __kind: 'TokenGroup', updateAuthority: some(admin.address), mint: admin.address, size: 0n, maxSize: 10n }],
        before: (mint) => [getInitializeGroupPointerInstruction({ mint, authority: admin.address, groupAddress: mint })],
        after: (mint) => [getInitializeTokenGroupInstruction({ group: mint, mint, mintAuthority: signer(admin), updateAuthority: admin.address, maxSize: 10n })],
      });
    const member = async (of: Address): Promise<Address> =>
      createMint({
        program: TOKEN_2022_PROGRAM,
        decimals: 0,
        extensions: [
          { __kind: 'GroupMemberPointer', authority: some(admin.address), memberAddress: none() },
          { __kind: 'MetadataPointer', authority: some(admin.address), metadataAddress: none() },
        ],
        later: [{ __kind: 'TokenGroupMember', mint: admin.address, group: of, memberNumber: 0n }],
        before: (mint) => [
          getInitializeGroupMemberPointerInstruction({ mint, authority: admin.address, memberAddress: mint }),
          getInitializeMetadataPointerInstruction({ mint, authority: admin.address, metadataAddress: of }),
        ],
        after: (mint) => [getInitializeTokenGroupMemberInstruction({ member: mint, memberMint: mint, memberMintAuthority: signer(admin), group: of, groupUpdateAuthority: signer(admin) })],
      });
    sgtGroup = await group();
    const otherGroup = await group();
    sgtMint = await member(sgtGroup);
    otherGroupMint = await member(otherGroup);
    await fund(host.address, sgtMint, TOKEN_2022_PROGRAM, 1n);
    await fund(host.address, otherGroupMint, TOKEN_2022_PROGRAM, 1n);

    // Every player holds 1,000 units of each stake mint; the treasury's ATAs exist (registration needs them).
    for (const mint of [usdc, pyusd, skr, pausable]) {
      for (const w of [host, ...guests, delegate]) await fund(w.address, mint, programOf(mint), 1_000n * UNIT);
      await fund(treasury.address, mint, programOf(mint), 0n);
    }
  });

  it('registers a USDC-like SPL mint and a PYUSD-like Token-2022 mint, reading their extensions', async () => {
    await ok(admin, [await registerMintIx(admin.address, treasury.address, usdc, TOKEN_PROGRAM, terms(FEE_BPS, 300))]);
    const u = await entry(usdc);
    expect(u).toMatchObject({
      mint: usdc,
      tokenProgram: TOKEN_PROGRAM,
      decimals: 6,
      minStake: UNIT,
      maxStake: 1_000n * UNIT,
      feeBps: FEE_BPS,
      seekerFeeBps: 300,
      enabled: true,
      treasuryAta: await ataAddress(treasury.address, usdc, TOKEN_PROGRAM),
      discountBps: 0,
    });
    expect(u.flags).toEqual({ hasFreezeAuthority: true, permanentDelegate: false, transferFeeConfigPresent: false, pausable: false, defaultStateFrozen: false, hookProgram: null });

    await ok(admin, [await registerMintIx(admin.address, treasury.address, pyusd, TOKEN_2022_PROGRAM, terms(FEE_BPS, 300))]);
    const p = await entry(pyusd);
    expect(p.tokenProgram).toBe(TOKEN_2022_PROGRAM);
    expect(p.flags).toEqual({ hasFreezeAuthority: true, permanentDelegate: true, transferFeeConfigPresent: true, pausable: false, defaultStateFrozen: false, hookProgram: null });

    // SKR-like: the main token, cheapest tier, a 20 % shop discount; the pausable mint for the pause test.
    await ok(admin, [await registerMintIx(admin.address, treasury.address, skr, TOKEN_PROGRAM, terms(250, 200, 2_000, [10n * UNIT, 25n * UNIT, 0n, 0n]))]);
    expect((await entry(skr)).discountBps).toBe(2_000);
    await ok(admin, [await registerMintIx(admin.address, treasury.address, pausable, TOKEN_2022_PROGRAM, terms(FEE_BPS, FEE_BPS))]);
    expect((await entry(pausable)).flags.pausable).toBe(true);

    // Twice is refused (init), and so are terms the program cannot honour.
    await fails(admin, [await registerMintIx(admin.address, treasury.address, usdc, TOKEN_PROGRAM, terms(FEE_BPS, 300))], 'already in use');
    await fails(admin, [await setMintIx(admin.address, usdc, { ...terms(FEE_BPS, 300), seekerFeeBps: 600 }, true)], 'FeeTooHigh');
    await fails(admin, [await setMintIx(admin.address, usdc, { ...terms(FEE_BPS, 300), maxStake: 2n ** 64n - 1n }, true)], 'StakeBoundsInvalid');
    await fails(stranger, [await setMintIx(stranger.address, usdc, terms(FEE_BPS, 300), true)], 'ConstraintHasOne');
  });

  it('refuses a non-transferable mint, a default-frozen one, a non-zero fee, an active hook, and a missing treasury account', async () => {
    const register = async (mint: Address, program: Address) => {
      await fund(treasury.address, mint, program, 0n).catch(() => undefined);
      return registerMintIx(admin.address, treasury.address, mint, program, terms(FEE_BPS, 300));
    };
    const nonTransferable = await createMint({
      program: TOKEN_2022_PROGRAM,
      decimals: 6,
      extensions: [{ __kind: 'NonTransferable' }],
      before: (mint) => [getInitializeNonTransferableMintInstruction({ mint })],
    });
    await fails(admin, [await register(nonTransferable, TOKEN_2022_PROGRAM)], 'MintNonTransferable');

    const defaultFrozen = await createMint({
      program: TOKEN_2022_PROGRAM,
      decimals: 6,
      freezeAuthority: freezer.address,
      extensions: [{ __kind: 'DefaultAccountState', state: AccountState.Frozen }],
      before: (mint) => [getInitializeDefaultAccountStateInstruction({ mint, state: AccountState.Frozen })],
    });
    await fails(admin, [await register(defaultFrozen, TOKEN_2022_PROGRAM)], 'MintDefaultFrozen');

    const fee = { epoch: 0n, maximumFee: 1_000_000n, transferFeeBasisPoints: 100 };
    const feeMint = await createMint({
      program: TOKEN_2022_PROGRAM,
      decimals: 6,
      extensions: [{ __kind: 'TransferFeeConfig', transferFeeConfigAuthority: admin.address, withdrawWithheldAuthority: admin.address, withheldAmount: 0n, olderTransferFee: fee, newerTransferFee: fee }],
      before: (mint) => [getInitializeTransferFeeConfigInstruction({ mint, transferFeeConfigAuthority: admin.address, withdrawWithheldAuthority: admin.address, transferFeeBasisPoints: 100, maximumFee: 1_000_000n })],
    });
    await fails(admin, [await register(feeMint, TOKEN_2022_PROGRAM)], 'MintHasTransferFee');

    const hookMint = await createMint({
      program: TOKEN_2022_PROGRAM,
      decimals: 6,
      extensions: [{ __kind: 'TransferHook', authority: admin.address, programId: stranger.address }],
      before: (mint) => [getInitializeTransferHookInstruction({ mint, authority: admin.address, programId: stranger.address })],
    });
    await fails(admin, [await register(hookMint, TOKEN_2022_PROGRAM)], 'MintHasTransferHook');

    // A fine mint whose treasury account nobody created yet.
    const plain = await createMint({ program: TOKEN_PROGRAM, decimals: 9 });
    await fails(admin, [await registerMintIx(admin.address, treasury.address, plain, TOKEN_PROGRAM, terms(FEE_BPS, 300))], 'AccountNotInitialized');
  });

  it('plays a USDC room: open, join, settle, and every account holds what the engine replay says', async () => {
    const code = 'TKRMA';
    const u = await entry(usdc);
    const hostAta = await ataAddress(host.address, usdc, TOKEN_PROGRAM);
    const guestAta = await ataAddress(guests[0]!.address, usdc, TOKEN_PROGRAM);
    const treasuryAta = u.treasuryAta;
    await fails(host, [await openRoomTokenIx(host.address, code, UNIT / 2n, commitSeed(createServerSeed()), u)], 'StakeOutOfRange');
    await fails(host, [await openRoomTokenIx(host.address, code, 1_001n * UNIT, commitSeed(createServerSeed()), u)], 'StakeOutOfRange');

    const hostTokensBefore = tokens(hostAta)!;
    const hostSolBefore = balance(host);
    const { seed, room } = await openAndJoin(usdc, code);
    const vault = await vaultAddress(room.address, usdc, TOKEN_PROGRAM);
    expect(room).toMatchObject({ state: 'ready', stake: STAKE, mint: usdc, tokenProgram: TOKEN_PROGRAM, feeBps: FEE_BPS, treasury: treasury.address, seeker: false, credits: [0n, 0n], treasuryCredit: 0n });
    expect(tokens(vault)).toBe(2n * STAKE);
    expect(hostTokensBefore - tokens(hostAta)!).toBe(STAKE);
    const vaultRent = BigInt(must(vault).lamports);
    // The SOL instructions refuse a token room, so its rent can never be paid out as if it were a pot.
    await fails(stranger, [await settleIx(room, treasury.address, stranger.address, seed)], 'NotSolEscrow');
    await fails(stranger, [await settleTokenIx(room, stranger.address, 'ab'.repeat(32))], 'BadReveal');
    await fails(stranger, [await claimTimeoutTokenIx(room, stranger.address)], 'TooEarly');

    const before = { host: tokens(hostAta)!, guest: tokens(guestAta)!, treasury: tokens(treasuryAta)!, hostSol: balance(host) };
    const result = await ok(stranger, [await settleTokenIx(room, stranger.address, seed)]);
    console.log(`settle_token (USDC-like, SPL Token): ${result.computeUnitsConsumed()} CU`);
    expect(await readRoom(host, code)).toBeNull();
    expect(exists(vault)).toBe(false);
    const expected = roomPayout(room, seed);
    expect({ host: tokens(hostAta)! - before.host, guest: tokens(guestAta)! - before.guest, treasury: tokens(treasuryAta)! - before.treasury }).toEqual({
      host: expected.host,
      guest: expected.guest,
      treasury: expected.treasury,
    });
    // The host paid the room's and the vault's rent and gets both back on close.
    expect(balance(host) - before.hostSol).toBe(room.lamports + vaultRent);
    expect(hostSolBefore - balance(host)).toBe(5_000n); // the open's transaction fee; both rents came back
  });

  it('cancels a token room before a join, returning the stake, the vault rent and the room rent', async () => {
    const code = 'TKCAN';
    const hostAta = await ataAddress(host.address, pyusd, TOKEN_2022_PROGRAM);
    const before = { tokens: tokens(hostAta)!, sol: balance(host) };
    await ok(host, [await openRoomTokenIx(host.address, code, STAKE, commitSeed(createServerSeed()), await entry(pyusd))]);
    const room = (await readRoom(host, code))!;
    const vault = await vaultAddress(room.address, pyusd, TOKEN_2022_PROGRAM);
    expect(tokens(vault)).toBe(STAKE);
    await fails(stranger, [await cancelRoomTokenIx({ ...room, host: stranger.address })], 'ConstraintHasOne');
    await ok(host, [await cancelRoomTokenIx(room)]);
    expect(await readRoom(host, code)).toBeNull();
    expect(exists(vault)).toBe(false);
    expect(tokens(hostAta)).toBe(before.tokens);
    expect(before.sol - balance(host)).toBe(2n * 5_000n); // two transaction fees, nothing else
  });

  it('seats a PYUSD-like hall of three (2/1/3 cards), settles it to the base unit, and the forfeit on timeout pays the guests', async () => {
    const code = 'TKHA3';
    const seed = createServerSeed();
    const p = await entry(pyusd);
    const seats = [host, guests[0]!, guests[1]!];
    const counts = [2, 1, 3];
    await ok(host, [await openHallTokenIx(host.address, code, STAKE, 4, 2, commitSeed(seed), p)]);
    let hall = (await readHall(host, code))!;
    expect(hall).toMatchObject({ state: 'open', mint: pyusd, tokenProgram: TOKEN_2022_PROGRAM, feeBps: FEE_BPS, cardsSold: 2 });
    await ok(guests[0]!, [await joinHallTokenIx(guests[0]!.address, hall, 1)]);
    await ok(guests[1]!, [await joinHallTokenIx(guests[1]!.address, hall, 3)]);
    hall = (await readHall(host, code))!;
    const vault = await vaultAddress(hall.address, pyusd, TOKEN_2022_PROGRAM);
    expect(tokens(vault)).toBe(6n * STAKE);
    await fails(guests[0]!, [await joinHallTokenIx(guests[0]!.address, hall, 1)], 'AlreadySeated');
    // A guest locks (the SOL lock instruction is mint-agnostic).
    const { lockHallIx } = await import('./waveHall.ts');
    await ok(guests[1]!, [await lockHallIx(guests[1]!.address, hall.address)]);
    hall = (await readHall(host, code))!;
    expect(hall.state).toBe('locked');
    const atas = await Promise.all(seats.map((w) => ataAddress(w.address, pyusd, TOKEN_2022_PROGRAM)));
    const before = atas.map((a) => tokens(a)!);
    const treasuryBefore = tokens(p.treasuryAta)!;
    const hostSolBefore = balance(host);
    const vaultRent = BigInt(must(vault).lamports);
    const swapped = { ...hall, seats: [hall.seats[1]!, hall.seats[0]!, hall.seats[2]!] };
    await fails(stranger, [await settleHallTokenIx(swapped, stranger.address, seed)], 'RosterMismatch');

    const result = await ok(stranger, [await settleHallTokenIx(hall, stranger.address, seed)]);
    console.log(`settle_hall_token, 6 cards (PYUSD-like, Token-2022): ${result.computeUnitsConsumed()} CU`);
    expect(await readHall(host, code)).toBeNull();
    expect(exists(vault)).toBe(false);
    const expected = engineHall(hall, seed);
    const split = splitHallPot(STAKE, hall.cardsSold, FEE_BPS, expected.winningCards);
    expect(atas.map((a, i) => tokens(a)! - before[i]!)).toEqual(expected.shares.map((n) => split.share * BigInt(n)));
    expect(tokens(p.treasuryAta)! - treasuryBefore).toBe(split.fee + split.dust);
    expect(balance(host) - hostSolBefore).toBe(hall.lamports + vaultRent);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(hall.cardsSold);

    // The same table again, but the host never reveals: the guests get their deposits back and
    // split the host's two cards 1:3, the dust (if any) to the treasury, no fee.
    const code2 = 'TKHAT';
    await ok(host, [await openHallTokenIx(host.address, code2, STAKE, 4, 2, commitSeed(createServerSeed()), p)]);
    let hall2 = (await readHall(host, code2))!;
    await ok(guests[0]!, [await joinHallTokenIx(guests[0]!.address, hall2, 1)]);
    await ok(guests[1]!, [await joinHallTokenIx(guests[1]!.address, hall2, 3)]);
    await ok(guests[1]!, [await lockHallIx(guests[1]!.address, hall2.address)]);
    hall2 = (await readHall(host, code2))!;
    await fails(stranger, [await claimTimeoutHallTokenIx(hall2, stranger.address)], 'TooEarly');
    svm.warpToSlot(hall2.lockedSlot + TIMEOUT_SLOTS + 1n);
    const before2 = atas.map((a) => tokens(a)!);
    const treasuryBefore2 = tokens(p.treasuryAta)!;
    await ok(stranger, [await claimTimeoutHallTokenIx(hall2, stranger.address)]);
    expect(await readHall(host, code2)).toBeNull();
    const forfeit = forfeitAmounts(hall2);
    expect(forfeit.amounts).toEqual([0n, STAKE + (2n * STAKE * 1n) / 4n, 3n * STAKE + (2n * STAKE * 3n) / 4n]);
    expect(atas.map((a, i) => tokens(a)! - before2[i]!)).toEqual(forfeit.amounts);
    expect(tokens(p.treasuryAta)! - treasuryBefore2).toBe(forfeit.dust);
  });

  it('settles an 8 x 4 PYUSD-like hall inside the compute limit', async () => {
    const code = 'TKH88';
    const seed = createServerSeed();
    const p = await entry(pyusd);
    await ok(host, [await openHallTokenIx(host.address, code, STAKE, 8, 4, commitSeed(seed), p)]);
    let hall = (await readHall(host, code))!;
    for (let i = 0; i < 7; i++) {
      await ok(guests[i]!, [await joinHallTokenIx(guests[i]!.address, hall, 4)]);
      hall = (await readHall(host, code))!;
    }
    expect(hall.state).toBe('locked');
    expect(hall.cardsSold).toBe(32);
    const seats = [host, ...guests.slice(0, 7)];
    const atas = await Promise.all(seats.map((w) => ataAddress(w.address, pyusd, TOKEN_2022_PROGRAM)));
    const before = atas.map((a) => tokens(a)!);
    const treasuryBefore = tokens(p.treasuryAta)!;
    const result = await ok(stranger, await settleHallTokenIxs(hall, stranger.address, seed));
    const cu = Number(result.computeUnitsConsumed());
    console.log(`settle_hall_token, 32 cards (PYUSD-like, Token-2022, 8 payouts + close): ${cu} CU; limit ${SETTLE_HALL_TOKEN_COMPUTE_UNITS}`);
    expect(cu * 1.5).toBeLessThanOrEqual(SETTLE_HALL_TOKEN_COMPUTE_UNITS);
    expect(await readHall(host, code)).toBeNull();
    const expected = engineHall(hall, seed);
    const split = splitHallPot(STAKE, 32, FEE_BPS, expected.winningCards);
    expect(atas.map((a, i) => tokens(a)! - before[i]!)).toEqual(expected.shares.map((n) => split.share * BigInt(n)));
    expect(tokens(p.treasuryAta)! - treasuryBefore).toBe(split.fee + split.dust);
  });

  it('credits a frozen recipient, pays the rest, and claim_credit pays it later, closing vault and room with the rent to the host', async () => {
    const code = 'TKFRZ';
    const hostAta = await ataAddress(host.address, usdc, TOKEN_PROGRAM);
    const guestAta = await ataAddress(guests[0]!.address, usdc, TOKEN_PROGRAM);
    const treasuryAta = (await entry(usdc)).treasuryAta;
    const { seed, room } = await openAndJoin(usdc, code);
    const vault = await vaultAddress(room.address, usdc, TOKEN_PROGRAM);
    const vaultRent = BigInt(must(vault).lamports);
    // Both players' accounts are frozen by the issuer before the reveal, so whoever wins is credited.
    for (const ata of [hostAta, guestAta]) await ok(freezer, [getFreezeAccountInstruction({ account: ata, mint: usdc, owner: signer(freezer) }, { programAddress: TOKEN_PROGRAM })]);
    const before = { host: tokens(hostAta)!, guest: tokens(guestAta)!, treasury: tokens(treasuryAta)!, hostSol: balance(host) };
    await ok(stranger, [await settleTokenIx(room, stranger.address, seed)]);
    const expected = roomPayout(room, seed);
    let settled = (await readRoom(host, code))!;
    expect(settled.settled).toBe(true);
    expect(settled.state).toBe('ready');
    expect(settled.credits).toEqual([expected.host, expected.guest]);
    expect(settled.treasuryCredit).toBe(0n);
    expect(tokens(treasuryAta)! - before.treasury).toBe(expected.treasury);
    expect(tokens(vault)).toBe(expected.host + expected.guest);
    expect(tokens(hostAta)).toBe(before.host);
    expect(tokens(guestAta)).toBe(before.guest);
    // Nothing else works on a settled room, and a creditor owed nothing cannot claim.
    await fails(stranger, [await settleTokenIx(settled, stranger.address, seed)], 'NotReady');
    await fails(stranger, [await claimCreditIx(settled, TREASURY_CREDIT, stranger.address)], 'NothingToClaim');
    // Still frozen: the claim is refused, nothing moves.
    const creditors = [0, 1].filter((i) => settled.credits[i]! > 0n);
    await fails(stranger, [await claimCreditIx(settled, creditors[0]!, stranger.address)], 'NotPayable');
    for (const ata of [hostAta, guestAta]) await ok(freezer, [getThawAccountInstruction({ account: ata, mint: usdc, owner: signer(freezer) }, { programAddress: TOKEN_PROGRAM })]);
    for (const i of creditors) {
      await ok(stranger, [await claimCreditIx(settled, i, stranger.address)]);
      settled = (await readRoom(host, code)) ?? settled;
    }
    expect(await readRoom(host, code)).toBeNull();
    expect(exists(vault)).toBe(false);
    expect(tokens(hostAta)! - before.host).toBe(expected.host);
    expect(tokens(guestAta)! - before.guest).toBe(expected.guest);
    expect(balance(host) - before.hostSol).toBe(room.lamports + vaultRent);
  });

  it('pays pro rata, without reverting, when a permanent delegate emptied part of the vault', async () => {
    const code = 'TKDEG';
    const p = await entry(pyusd);
    const hostAta = await ataAddress(host.address, pyusd, TOKEN_2022_PROGRAM);
    const guestAta = await ataAddress(guests[0]!.address, pyusd, TOKEN_2022_PROGRAM);
    const delegateAta = await ataAddress(delegate.address, pyusd, TOKEN_2022_PROGRAM);
    const { seed, room } = await openAndJoin(pyusd, code);
    const vault = await vaultAddress(room.address, pyusd, TOKEN_2022_PROGRAM);
    // The issuer's permanent delegate moves 40 % of the pot out of the vault; nobody signed for the escrow.
    const seized = (2n * STAKE * 4n) / 10n;
    await ok(delegate, [getTransferCheckedInstruction({ source: vault, mint: pyusd, destination: delegateAta, authority: signer(delegate), amount: seized, decimals: 6 }, { programAddress: TOKEN_2022_PROGRAM })]);
    const available = tokens(vault)!;
    expect(available).toBe(2n * STAKE - seized);
    const before = { host: tokens(hostAta)!, guest: tokens(guestAta)!, treasury: tokens(p.treasuryAta)! };
    await ok(stranger, [await settleTokenIx(room, stranger.address, seed)]);
    expect(await readRoom(host, code)).toBeNull();
    expect(exists(vault)).toBe(false);
    const nominal = roomPayout(room, seed);
    const hostPaid = proRata(nominal.host, available, nominal.pot);
    const guestPaid = proRata(nominal.guest, available, nominal.pot);
    expect(tokens(hostAta)! - before.host).toBe(hostPaid);
    expect(tokens(guestAta)! - before.guest).toBe(guestPaid);
    // The treasury takes what is left: its scaled fee plus the rounding.
    expect(tokens(p.treasuryAta)! - before.treasury).toBe(available - hostPaid - guestPaid);
  });

  it('set_config after a join changes nothing for that round, in tokens and in SOL', async () => {
    const hostAta = await ataAddress(host.address, usdc, TOKEN_PROGRAM);
    const guestAta = await ataAddress(guests[0]!.address, usdc, TOKEN_PROGRAM);
    const oldTreasuryAta = (await entry(usdc)).treasuryAta;
    const { seed, room } = await openAndJoin(usdc, 'TKSNP');
    const solSeed = createServerSeed();
    await ok(host, [await openRoomIx(host.address, 'SASNP', 10_000_000n, commitSeed(solSeed))]);
    await ok(guests[0]!, [await joinRoomIx(guests[0]!.address, (await readRoom(host, 'SASNP'))!.address)]);
    const solRoom = (await readRoom(host, 'SASNP'))!;

    // The admin doubles the fee and moves the treasury to a stranger: open rounds keep their snapshot.
    await setConfig({ feeBps: 1_000 }, stranger.address);
    await fund(stranger.address, usdc, TOKEN_PROGRAM, 0n);
    expect((await readRoom(host, 'TKSNP'))!).toMatchObject({ feeBps: FEE_BPS, treasury: treasury.address });

    const before = { host: tokens(hostAta)!, guest: tokens(guestAta)!, treasury: tokens(oldTreasuryAta)! };
    await ok(stranger, [await settleTokenIx(room, stranger.address, seed)]);
    const expected = roomPayout(room, seed); // room.feeBps is the snapshot: 500, not 1,000
    expect({ host: tokens(hostAta)! - before.host, guest: tokens(guestAta)! - before.guest, treasury: tokens(oldTreasuryAta)! - before.treasury }).toEqual({
      host: expected.host,
      guest: expected.guest,
      treasury: expected.treasury,
    });

    await fails(stranger, [await settleIx(solRoom, stranger.address, stranger.address, solSeed)], 'TreasuryMismatch');
    const solBefore = { host: balance(host), guest: balance(guests[0]!), treasury: balance(treasury) };
    await ok(stranger, [await settleIx(solRoom, solRoom.treasury, stranger.address, solSeed)]);
    const pot = 20_000_000n;
    const fee = (pot * BigInt(FEE_BPS)) / 10_000n;
    const prize = pot - fee;
    const winners = engineWinners(solRoom, solSeed);
    const gained = { host: balance(host) - solBefore.host - (solRoom.lamports - pot), guest: balance(guests[0]!) - solBefore.guest, treasury: balance(treasury) - solBefore.treasury };
    if (winners.length === 2) expect(gained).toEqual({ host: prize / 2n, guest: prize / 2n, treasury: fee + (prize % 2n) });
    else if (winners[0] === 0) expect(gained).toEqual({ host: prize, guest: 0n, treasury: fee });
    else expect(gained).toEqual({ host: 0n, guest: prize, treasury: fee });
    await setConfig({ feeBps: FEE_BPS }, treasury.address);
  });

  it('a disabled mint blocks opens and joins but not settlement', async () => {
    const { seed, room } = await openAndJoin(usdc, 'TKDSB');
    const u = await entry(usdc);
    await ok(admin, [await setMintIx(admin.address, usdc, terms(FEE_BPS, 300), false)]);
    expect((await entry(usdc)).enabled).toBe(false);
    await fails(host, [await openRoomTokenIx(host.address, 'TKDS2', STAKE, commitSeed(createServerSeed()), u)], 'MintDisabled');
    await ok(stranger, [await settleTokenIx(room, stranger.address, seed)]);
    expect(await readRoom(host, 'TKDSB')).toBeNull();
    await ok(admin, [await setMintIx(admin.address, usdc, terms(FEE_BPS, 300), true)]);
  });

  it('the pauser can pause and cannot unpause; paused blocks opens and purchases, not settlement', async () => {
    const { seed, room } = await openAndJoin(usdc, 'TKPAU');
    await setConfig({ pauser: pauser.address, solPackPrices: [SOL / 10n, 0n, 0n, 0n] });
    await fails(stranger, [await pauseIx(stranger.address)], 'NotPauser');
    await ok(pauser, [await pauseIx(pauser.address)]);
    expect((await config()).paused).toBe(true);
    await fails(host, [await openRoomTokenIx(host.address, 'TKPA2', STAKE, commitSeed(createServerSeed()), await entry(usdc))], 'Paused');
    await fails(host, [await openRoomIx(host.address, 'SAPA2', 10_000_000n, commitSeed(createServerSeed()))], 'Paused');
    await fails(host, [await buyPackIx(host.address, treasury.address, 0)], 'Paused');
    // Only the admin's set_config unpauses: the pauser's own set_config is refused.
    await fails(pauser, [await setConfigIx(pauser.address, treasury.address, { ...configTerms(await config()), paused: false })], 'ConstraintHasOne');
    await ok(stranger, [await settleTokenIx(room, stranger.address, seed)]);
    expect(await readRoom(host, 'TKPAU')).toBeNull();
    await setConfig({ paused: false });
    expect((await config()).paused).toBe(false);
  });

  it('prove_seeker with a mock SGT group lowers the fee; a wrong group, or no token, is refused', async () => {
    await setConfig({ sgtGroup, solSeekerFeeBps: 250 });
    const sgtAccount = await ataAddress(host.address, sgtMint, TOKEN_2022_PROGRAM);
    const wrongAccount = await ataAddress(host.address, otherGroupMint, TOKEN_2022_PROGRAM);
    const u = await entry(usdc);
    await ok(host, [await openRoomTokenIx(host.address, 'TKSGT', STAKE, commitSeed(createServerSeed()), u)]);
    let room = (await readRoom(host, 'TKSGT'))!;
    await fails(host, [await proveSeekerRoomIx(room, { tokenAccount: wrongAccount, mint: otherGroupMint })], 'NotSeeker');
    await fails(host, [await proveSeekerRoomIx(room, { tokenAccount: sgtAccount, mint: usdc })], 'NotSeeker');
    // A guest holding no token cannot prove the host's room, nor can the host prove with a guest's account.
    await fails(guests[0]!, [await proveSeekerRoomIx({ ...room, host: guests[0]!.address }, { tokenAccount: sgtAccount, mint: sgtMint })], 'ConstraintHasOne');
    await ok(host, [await proveSeekerRoomIx(room, { tokenAccount: sgtAccount, mint: sgtMint })]);
    room = (await readRoom(host, 'TKSGT'))!;
    expect(room.feeBps).toBe(300);
    expect(room.seeker).toBe(true);
    // The round then settles at the Seeker tier; the event carries the flag.
    const seed = createServerSeed();
    await ok(host, [await cancelRoomTokenIx(room)]);
    await ok(host, [await openRoomTokenIx(host.address, 'TKSG2', STAKE, commitSeed(seed), u)]);
    room = (await readRoom(host, 'TKSG2'))!;
    await ok(host, [await proveSeekerRoomIx(room, { tokenAccount: sgtAccount, mint: sgtMint })]);
    await ok(guests[0]!, [await joinRoomTokenIx(guests[0]!.address, room)]);
    room = (await readRoom(host, 'TKSG2'))!;
    expect(room.feeBps).toBe(300);
    const treasuryBefore = tokens(u.treasuryAta)!;
    const result = await ok(stranger, [await settleTokenIx(room, stranger.address, seed)]);
    expect(tokens(u.treasuryAta)! - treasuryBefore).toBe(roomPayout(room, seed).treasury);
    expect(result.logs().some((l) => l.startsWith('Program data: '))).toBe(true);

    // SOL rooms use the config's Seeker tier; a hall proves the same way.
    await ok(host, [await openRoomIx(host.address, 'SASGT', 10_000_000n, commitSeed(createServerSeed()))]);
    let solRoom = (await readRoom(host, 'SASGT'))!;
    await ok(host, [await proveSeekerRoomIx(solRoom, { tokenAccount: sgtAccount, mint: sgtMint })]);
    solRoom = (await readRoom(host, 'SASGT'))!;
    expect(solRoom).toMatchObject({ feeBps: 250, seeker: true, mint: null });
    await ok(host, [await openHallTokenIx(host.address, 'TKSGH', STAKE, 3, 1, commitSeed(createServerSeed()), u)]);
    let hall = (await readHall(host, 'TKSGH'))!;
    await fails(host, [await proveSeekerHallIx(hall, { tokenAccount: wrongAccount, mint: otherGroupMint })], 'NotSeeker');
    await ok(host, [await proveSeekerHallIx(hall, { tokenAccount: sgtAccount, mint: sgtMint })]);
    hall = (await readHall(host, 'TKSGH'))!;
    expect(hall).toMatchObject({ feeBps: 300, seeker: true });
  });

  it('buy_pack in SOL and in SKR applies the discounts and keeps the Buyer totals', async () => {
    const solPrice = SOL / 10n;
    await setConfig({ solPackPrices: [solPrice, 0n, 0n, 0n], seekerDiscountBps: 1_000, sgtGroup });
    const c = await config();
    const sgtAccount = await ataAddress(host.address, sgtMint, TOKEN_2022_PROGRAM);
    const buyer = await buyerAddress(host.address);
    const readBuyer = () => decodeBuyer(buyer, new Uint8Array(must(buyer).data))!;

    let before = balance(treasury);
    await ok(host, [await buyPackIx(host.address, treasury.address, 0)]);
    expect(balance(treasury) - before).toBe(solPrice);
    expect(readBuyer()).toMatchObject({ wallet: host.address, coinsTotal: BigInt(c.packCoins[0]!), purchases: 1 });
    await fails(host, [await buyPackIx(host.address, treasury.address, 1)], 'PackNotForSale');
    await fails(host, [await buyPackIx(host.address, treasury.address, 4)], 'BadPack');
    await fails(host, [await buyPackIx(host.address, stranger.address, 0)], 'ConstraintHasOne');

    // The Seeker discount needs the on-chain proof; a wrong token pays nothing and fails.
    before = balance(treasury);
    await fails(host, [await buyPackIx(host.address, treasury.address, 0, { tokenAccount: await ataAddress(host.address, otherGroupMint, TOKEN_2022_PROGRAM), mint: otherGroupMint })], 'NotSeeker');
    await ok(host, [await buyPackIx(host.address, treasury.address, 0, { tokenAccount: sgtAccount, mint: sgtMint })]);
    expect(balance(treasury) - before).toBe(packPrice(solPrice, 1_000));
    expect(readBuyer()).toMatchObject({ coinsTotal: 2n * BigInt(c.packCoins[0]!), purchases: 2 });

    // SKR: pack 1 at 25 units, 20 % off, 30 % off with the Seeker proof.
    const s = await entry(skr);
    const hostAta = await ataAddress(host.address, skr, TOKEN_PROGRAM);
    let tokensBefore = { host: tokens(hostAta)!, treasury: tokens(s.treasuryAta)! };
    await ok(host, [await buyPackTokenIx(host.address, s, 1, null, treasury.address)]);
    expect(tokensBefore.host - tokens(hostAta)!).toBe(packPrice(25n * UNIT, 2_000));
    expect(tokens(s.treasuryAta)! - tokensBefore.treasury).toBe(packPrice(25n * UNIT, 2_000));
    tokensBefore = { host: tokens(hostAta)!, treasury: tokens(s.treasuryAta)! };
    await ok(host, [await buyPackTokenIx(host.address, s, 1, { tokenAccount: sgtAccount, mint: sgtMint }, treasury.address)]);
    expect(tokensBefore.host - tokens(hostAta)!).toBe(packPrice(25n * UNIT, 3_000));
    await fails(host, [await buyPackTokenIx(host.address, s, 2, null, treasury.address)], 'PackNotForSale');
    await fails(host, [await buyPackTokenIx(host.address, await entry(usdc), 0, null, treasury.address)], 'PackNotForSale');
    expect(readBuyer()).toMatchObject({ coinsTotal: 2n * BigInt(c.packCoins[0]!) + 2n * BigInt(c.packCoins[1]!), purchases: 4 });
    // Another wallet's record is its own, and a wallet cannot pay into someone else's.
    await ok(guests[0]!, [await buyPackIx(guests[0]!.address, treasury.address, 0)]);
    const other = await buyerAddress(guests[0]!.address);
    expect(decodeBuyer(other, new Uint8Array(must(other).data))).toMatchObject({ wallet: guests[0]!.address, purchases: 1 });
  });

  it('a paused mint fails cleanly and settles once resumed', async () => {
    const { seed, room } = await openAndJoin(pausable, 'TKPMT');
    await ok(admin, [getPauseInstruction({ mint: pausable, authority: signer(admin) })]);
    await fails(stranger, [await settleTokenIx(room, stranger.address, seed)], 'MintPaused');
    await fails(host, [await openRoomTokenIx(host.address, 'TKPM2', STAKE, commitSeed(createServerSeed()), await entry(pausable))], 'MintPaused');
    expect((await readRoom(host, 'TKPMT'))!.state).toBe('ready');
    await ok(admin, [getResumeInstruction({ mint: pausable, authority: signer(admin) })]);
    await ok(stranger, [await settleTokenIx(room, stranger.address, seed)]);
    expect(await readRoom(host, 'TKPMT')).toBeNull();
  });

  it('gives the guest the pot, in tokens, when the host never reveals', async () => {
    const guestAta = await ataAddress(guests[0]!.address, usdc, TOKEN_PROGRAM);
    const treasuryAta = (await entry(usdc)).treasuryAta;
    const { room } = await openAndJoin(usdc, 'TKTMX');
    svm.warpToSlot(room.joinedSlot + TIMEOUT_SLOTS + 1n);
    const before = { guest: tokens(guestAta)!, treasury: tokens(treasuryAta)! };
    await ok(guests[0]!, [await claimTimeoutTokenIx(room, guests[0]!.address)]);
    const pot = 2n * STAKE;
    const fee = (pot * BigInt(FEE_BPS)) / 10_000n;
    expect(tokens(guestAta)! - before.guest).toBe(pot - fee);
    expect(tokens(treasuryAta)! - before.treasury).toBe(fee);
    expect(await readRoom(host, 'TKTMX')).toBeNull();
  });
});
