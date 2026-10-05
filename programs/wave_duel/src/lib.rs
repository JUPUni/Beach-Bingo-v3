//! wave_duel: trustless Wave Rush escrows for Beach Bingo, in two shapes.
//!
//! **Room (1v1).** The host opens a room with a stake and a commitment (SHA-256 of a secret
//! seed). A guest joins with the same stake; at that moment the program fixes the round's entropy
//! from the guest's key and the latest slot hash, which nobody knew when the host committed.
//! Anyone may then settle by revealing the seed: the program checks it against the commitment,
//! replays the 30-ball round exactly as the players' own screens did (`bingo.rs`), and pays the
//! winner, the pot split on a tie. A host who will not reveal loses the pot to the guest after a
//! timeout.
//!
//! **Hall (2..=8 players, 1..=4 cards each).** The host opens a hall with a stake per card, a
//! number of seats and a commitment, and buys its own cards. Players join in any order, each
//! buying cards; the roster is the join order, the host first, and cards are numbered in that
//! order (the host holds cards 0..h−1, the second player the next ones, and so on), which is how
//! the engine's `buildRoom` numbers them. A guest locks the hall once it has two players (or the
//! join that fills it locks it): entropy is fixed from the roster and the latest slot hash and
//! sales close. Anyone settles by revealing the seed: every card is rebuilt, the drum drawn, and
//! the first ball on which any card is full ends the round; every card full on that ball takes an
//! equal share of the prize. A host who will not reveal after the timeout forfeits its own
//! deposit to the guests, pro rata to their cards; the guests get their deposits back.
//!
//! **Money.** SOL rounds hold lamports in the escrow account itself (`open_room`, `open_hall` and
//! their siblings, unchanged since the first deployment). Token rounds (`*_token`) hold stakes in
//! the escrow PDA's associated token account for a mint the admin registered (`MintEntry`), moved
//! by `transfer_checked` under the mint's own token program (SPL Token or Token-2022). Every round
//! snapshots its fee, treasury, mint and token program when it opens, so no config change can
//! move money in a round already running. A token payout that cannot be delivered (a frozen or
//! closed account, a memo requirement) is credited inside the escrow and claimed later
//! (`claim_credit*`); the vault and the state account close with the last claim. The Seeker
//! Genesis Token proved on chain (`prove_seeker_*`) lowers a round's fee to the Seeker tier, and
//! the coin shop (`buy_pack*`) sells coin packs for SOL or any registered mint, with the mint's
//! discount and the Seeker discount enforced here rather than in the client.
//!
//! A fee in basis points goes to the treasury named in the config. Nothing here is a game of
//! skill: it is a wager between people, so it ships behind a flag until the operator's licensing
//! allows it (docs/PRODUCTION.md).
#![allow(unexpected_cfgs)]
#![allow(deprecated)]
use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use anchor_lang::AccountsClose;
use anchor_spl::associated_token::{create_idempotent, get_associated_token_address_with_program_id, AssociatedToken, Create};
use anchor_spl::token_interface::{transfer_checked, Mint, TokenAccount, TokenInterface, TransferChecked};
use solana_sha256_hasher::hashv;

pub mod bingo;
pub mod fair;
pub mod token;

use token::{Payee, Vault};

declare_id!("6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH");

/// The room-code alphabet the game uses (no 0/O, 1/I/L).
pub const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const MIN_STAKE: u64 = 1_000_000; // 0.001 SOL
pub const MAX_STAKE: u64 = 100_000_000_000; // 100 SOL
pub const MAX_FEE_BPS: u16 = 1_000; // 10%
/// A host who does not reveal within this many slots after the guest joined (room) or the hall
/// locked (hall) has forfeited: the room's pot goes to the guest, the hall's host deposit to the guests.
pub const TIMEOUT_SLOTS: u64 = 3_000; // about 20 minutes at 400 ms
pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");
pub const MEMO_ID: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/// Seats in a hall: at least two players make a game; eight keeps settlement inside one
/// transaction's compute budget and account limit (the roster travels as remaining accounts).
pub const MIN_HALL_PLAYERS: u8 = 2;
pub const MAX_HALL_PLAYERS: u8 = bingo::MAX_PLAYERS as u8;
/// Cards per player in a hall: the engine's Wave Rush preset (`maxCardsPerPlayer: 4`).
pub const MAX_HALL_CARDS: u8 = bingo::MAX_CARDS_PER_PLAYER;
/// Coin packs in the shop and their default sizes (coins per pack); the admin can change them.
pub const PACKS: usize = 4;
pub const DEFAULT_PACK_COINS: [u32; PACKS] = [5_000, 15_000, 40_000, 100_000];
/// A registered mint's `max_stake` may not exceed this: the largest hall pot is 32 cards, and
/// `max_stake × 32` must fit a u64 whatever the decimals (5.7 × 10¹⁷ base units: 5.7 × 10¹¹
/// tokens at 6 decimals, 5.7 × 10⁸ at 9).
pub const MAX_MINT_STAKE: u64 = u64::MAX / 32;
/// `claim_credit*` index for the treasury's own credit (the fee that could not be delivered).
pub const TREASURY_CREDIT: u8 = u8::MAX;
/// The first deployment's `Config` was 68 bytes of fields; `migrate_config` grows it in place.
const LEGACY_CONFIG_LEN: usize = 8 + 32 + 32 + 2 + 1 + 1;

#[program]
pub mod wave_duel {
    use super::*;

    /* ---------- Config ---------- */

    pub fn init_config(ctx: Context<InitConfig>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, DuelError::FeeTooHigh);
        let admin = ctx.accounts.admin.key();
        let config = &mut ctx.accounts.config;
        config.admin = admin;
        config.treasury = ctx.accounts.treasury.key();
        config.fee_bps = fee_bps;
        config.paused = false;
        config.bump = ctx.bumps.config;
        config.pauser = admin;
        config.sgt_group = Pubkey::default();
        config.pack_coins = DEFAULT_PACK_COINS;
        config.seeker_discount_bps = 0;
        config.sol_pack_prices = [0; PACKS];
        config.sol_seeker_fee_bps = fee_bps;
        Ok(())
    }

    /// The admin sets everything: fee, pause, treasury (the account passed), the pauser key, the
    /// Seeker Genesis Token group, the pack sizes, the Seeker discount, SOL pack prices and the SOL
    /// Seeker fee tier. Rounds already open keep their snapshot.
    #[allow(clippy::too_many_arguments)]
    pub fn set_config(
        ctx: Context<SetConfig>,
        fee_bps: u16,
        paused: bool,
        pauser: Pubkey,
        sgt_group: Pubkey,
        pack_coins: [u32; PACKS],
        seeker_discount_bps: u16,
        sol_pack_prices: [u64; PACKS],
        sol_seeker_fee_bps: u16,
    ) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, DuelError::FeeTooHigh);
        require!(sol_seeker_fee_bps <= fee_bps, DuelError::FeeTooHigh);
        require!(seeker_discount_bps <= 10_000, DuelError::DiscountTooHigh);
        let config = &mut ctx.accounts.config;
        config.treasury = ctx.accounts.treasury.key();
        config.fee_bps = fee_bps;
        config.paused = paused;
        config.pauser = pauser;
        config.sgt_group = sgt_group;
        config.pack_coins = pack_coins;
        config.seeker_discount_bps = seeker_discount_bps;
        config.sol_pack_prices = sol_pack_prices;
        config.sol_seeker_fee_bps = sol_seeker_fee_bps;
        Ok(())
    }

    /// Grow a first-deployment `Config` (76 bytes) to the current layout, keeping admin, treasury,
    /// fee and pause and filling the new fields with the same defaults `init_config` uses. The
    /// admin pays the extra rent. Devnet's config was initialised before the token work, so this
    /// runs once there; a fresh deployment never needs it.
    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        let info = ctx.accounts.config.to_account_info();
        require_keys_eq!(*info.owner, crate::ID, DuelError::BadConfig);
        require!(info.data_len() == LEGACY_CONFIG_LEN, DuelError::AlreadyMigrated);
        let (admin, treasury, fee_bps, paused, bump) = {
            let data = info.try_borrow_data()?;
            require!(&data[..8] == Config::DISCRIMINATOR, DuelError::BadConfig);
            let admin = Pubkey::try_from(&data[8..40]).map_err(|_| DuelError::BadConfig)?;
            let treasury = Pubkey::try_from(&data[40..72]).map_err(|_| DuelError::BadConfig)?;
            (admin, treasury, u16::from_le_bytes([data[72], data[73]]), data[74] != 0, data[75])
        };
        require_keys_eq!(admin, ctx.accounts.admin.key(), DuelError::NotAdmin);
        let new_len = 8 + Config::INIT_SPACE;
        let needed = Rent::get()?.minimum_balance(new_len).saturating_sub(info.lamports());
        if needed > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer { from: ctx.accounts.admin.to_account_info(), to: info.clone() },
                ),
                needed,
            )?;
        }
        info.resize(new_len)?;
        let config = Config {
            admin,
            treasury,
            fee_bps,
            paused,
            bump,
            pauser: admin,
            sgt_group: Pubkey::default(),
            pack_coins: DEFAULT_PACK_COINS,
            seeker_discount_bps: 0,
            sol_pack_prices: [0; PACKS],
            sol_seeker_fee_bps: fee_bps,
        };
        let mut data = info.try_borrow_mut_data()?;
        let mut cursor: &mut [u8] = &mut data;
        config.try_serialize(&mut cursor)?;
        Ok(())
    }

    /// The pauser (or the admin) stops new rounds and purchases. Only `set_config` unpauses.
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let by = ctx.accounts.authority.key();
        require!(by == config.admin || by == config.pauser, DuelError::NotPauser);
        config.paused = true;
        emit!(Paused { by });
        Ok(())
    }

    /// Hand the admin role to another wallet (a multisig vault on mainnet). Only the admin may call
    /// it; the new admin need not sign, so the operator's tooling must confirm the address twice
    /// (there is no way back without the new key). The pauser is unchanged: `set_config` moves it.
    pub fn transfer_admin(ctx: Context<TransferAdmin>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let from = config.admin;
        let to = ctx.accounts.new_admin.key();
        require!(to != Pubkey::default() && to != from, DuelError::BadConfig);
        config.admin = to;
        emit!(AdminTransferred { from, to });
        Ok(())
    }

    /* ---------- Mint registry ---------- */

    /// Allow a mint for stakes and the shop. Reads the mint's extensions and refuses what an escrow
    /// cannot hold safely; requires the treasury's associated token account for the mint to exist.
    pub fn register_mint(
        ctx: Context<RegisterMint>,
        min_stake: u64,
        max_stake: u64,
        fee_bps: u16,
        seeker_fee_bps: u16,
        pack_prices: [u64; PACKS],
        discount_bps: u16,
    ) -> Result<()> {
        check_mint_terms(min_stake, max_stake, fee_bps, seeker_fee_bps, discount_bps)?;
        let facts = token::inspect_mint(&ctx.accounts.mint.to_account_info())?;
        require!(!facts.non_transferable, DuelError::MintNonTransferable);
        require!(!facts.flags.default_state_frozen, DuelError::MintDefaultFrozen);
        require!(facts.fee_bps_now == 0 && facts.fee_bps_next == 0, DuelError::MintHasTransferFee);
        require!(facts.flags.hook_program.is_none(), DuelError::MintHasTransferHook);
        let entry = &mut ctx.accounts.mint_entry;
        entry.mint = ctx.accounts.mint.key();
        entry.token_program = ctx.accounts.token_program.key();
        entry.decimals = facts.decimals;
        entry.min_stake = min_stake;
        entry.max_stake = max_stake;
        entry.fee_bps = fee_bps;
        entry.seeker_fee_bps = seeker_fee_bps;
        entry.enabled = true;
        entry.flags = facts.flags;
        entry.treasury_ata = ctx.accounts.treasury_ata.key();
        entry.pack_prices = pack_prices;
        entry.discount_bps = discount_bps;
        entry.bump = ctx.bumps.mint_entry;
        emit!(MintRegistered { mint: entry.mint, token_program: entry.token_program, decimals: entry.decimals, fee_bps, seeker_fee_bps });
        Ok(())
    }

    /// Update a registered mint's stakes, fees, prices, discount and `enabled`. Disabling blocks new
    /// rounds and purchases only; running rounds settle, time out, cancel and claim as before.
    #[allow(clippy::too_many_arguments)]
    pub fn set_mint(
        ctx: Context<SetMint>,
        min_stake: u64,
        max_stake: u64,
        fee_bps: u16,
        seeker_fee_bps: u16,
        pack_prices: [u64; PACKS],
        discount_bps: u16,
        enabled: bool,
    ) -> Result<()> {
        check_mint_terms(min_stake, max_stake, fee_bps, seeker_fee_bps, discount_bps)?;
        let entry = &mut ctx.accounts.mint_entry;
        entry.min_stake = min_stake;
        entry.max_stake = max_stake;
        entry.fee_bps = fee_bps;
        entry.seeker_fee_bps = seeker_fee_bps;
        entry.pack_prices = pack_prices;
        entry.discount_bps = discount_bps;
        entry.enabled = enabled;
        emit!(MintUpdated { mint: entry.mint, fee_bps, seeker_fee_bps, enabled });
        Ok(())
    }

    /* ---------- Rooms (SOL) ---------- */

    /// The host commits to a seed and puts up the stake.
    pub fn open_room(ctx: Context<OpenRoom>, code: [u8; 5], stake: u64, commitment: [u8; 32]) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        require!((MIN_STAKE..=MAX_STAKE).contains(&stake), DuelError::StakeOutOfRange);
        require!(code.iter().all(|c| CODE_ALPHABET.contains(c)), DuelError::BadCode);
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.host.to_account_info(), to: ctx.accounts.room.to_account_info() },
            ),
            stake,
        )?;
        let host = ctx.accounts.host.key();
        let snapshot = Snapshot { fee_bps: ctx.accounts.config.fee_bps, treasury: ctx.accounts.config.treasury, mint: Pubkey::default(), token_program: Pubkey::default() };
        let room = &mut ctx.accounts.room;
        room.open(host, stake, commitment, code, ctx.bumps.room, snapshot)?;
        emit!(RoomOpened { room: room.key(), host, code, stake, commitment });
        Ok(())
    }

    /// The guest matches the stake; the round's entropy is fixed here, after the commitment.
    pub fn join_room(ctx: Context<JoinRoom>) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        require!(ctx.accounts.room.is_sol(), DuelError::NotSolEscrow);
        require!(ctx.accounts.room.state == RoomState::Open as u8, DuelError::NotOpen);
        require_keys_neq!(ctx.accounts.guest.key(), ctx.accounts.room.host, DuelError::SameWallet);
        let stake = ctx.accounts.room.stake;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.guest.to_account_info(), to: ctx.accounts.room.to_account_info() },
            ),
            stake,
        )?;
        join(&mut ctx.accounts.room, ctx.accounts.guest.key(), &ctx.accounts.slot_hashes.to_account_info())
    }

    /// Before anyone joins, the host takes the stake back. `close` returns stake and rent together.
    pub fn cancel_room(ctx: Context<CancelRoom>) -> Result<()> {
        require!(ctx.accounts.room.is_sol(), DuelError::NotSolEscrow);
        Ok(())
    }

    /// Anyone reveals the host's seed; the program replays the round and pays.
    pub fn settle(ctx: Context<Settle>, server_seed: [u8; 32]) -> Result<()> {
        let room = &ctx.accounts.room;
        require!(room.is_sol(), DuelError::NotSolEscrow);
        require!(room.state == RoomState::Ready as u8, DuelError::NotReady);
        require!(hashv(&[&server_seed]).to_bytes() == room.commitment, DuelError::BadReveal);
        let outcome = bingo::play(&server_seed, &room.entropy);
        let (pot, fee, prize) = split(room.stake, room.fee_bps)?;
        let (host_share, guest_share, dust) = room_shares(prize, outcome.host_won, outcome.guest_won);
        let room_info = ctx.accounts.room.to_account_info();
        pay(&room_info, &ctx.accounts.host.to_account_info(), host_share)?;
        pay(&room_info, &ctx.accounts.guest.to_account_info(), guest_share)?;
        pay(&room_info, &ctx.accounts.treasury.to_account_info(), fee + dust)?;
        emit!(RoomSettled {
            room: ctx.accounts.room.key(),
            server_seed,
            win_ball: outcome.win_ball,
            host_won: outcome.host_won,
            guest_won: outcome.guest_won,
            pot,
            fee,
            mint: Pubkey::default(),
            seeker: room.seeker,
        });
        Ok(())
    }

    /// The host went quiet after the guest joined: the guest takes the pot.
    pub fn claim_timeout(ctx: Context<Settle>) -> Result<()> {
        let room = &ctx.accounts.room;
        require!(room.is_sol(), DuelError::NotSolEscrow);
        require!(room.state == RoomState::Ready as u8, DuelError::NotReady);
        require!(Clock::get()?.slot >= room.joined_slot + TIMEOUT_SLOTS, DuelError::TooEarly);
        let (pot, fee, prize) = split(room.stake, room.fee_bps)?;
        let room_info = ctx.accounts.room.to_account_info();
        pay(&room_info, &ctx.accounts.guest.to_account_info(), prize)?;
        pay(&room_info, &ctx.accounts.treasury.to_account_info(), fee)?;
        emit!(RoomTimedOut { room: ctx.accounts.room.key(), guest: room.guest, pot, fee, mint: Pubkey::default() });
        Ok(())
    }

    /* ---------- Rooms (tokens) ---------- */

    /// The host commits to a seed and stakes `stake` base units of a registered mint. The vault is
    /// the room PDA's associated token account, created here (idempotently) at the host's expense.
    pub fn open_room_token(ctx: Context<OpenRoomToken>, code: [u8; 5], stake: u64, commitment: [u8; 32]) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        let entry = &ctx.accounts.mint_entry;
        require!(entry.enabled, DuelError::MintDisabled);
        require!((entry.min_stake..=entry.max_stake).contains(&stake), DuelError::StakeOutOfRange);
        require!(code.iter().all(|c| CODE_ALPHABET.contains(c)), DuelError::BadCode);
        let mint_info = ctx.accounts.mint.to_account_info();
        token::require_mint_live(&mint_info)?;
        open_vault(
            &ctx.accounts.vault,
            &ctx.accounts.room.to_account_info(),
            &ctx.accounts.host.to_account_info(),
            &mint_info,
            &ctx.accounts.token_program,
            &ctx.accounts.associated_token_program,
            &ctx.accounts.system_program,
        )?;
        deposit_tokens(&ctx.accounts.host_ata.to_account_info(), &ctx.accounts.vault, &ctx.accounts.host.to_account_info(), &mint_info, &ctx.accounts.token_program, stake, ctx.accounts.mint.decimals)?;
        let host = ctx.accounts.host.key();
        let snapshot = Snapshot { fee_bps: entry.fee_bps, treasury: ctx.accounts.config.treasury, mint: entry.mint, token_program: entry.token_program };
        let room = &mut ctx.accounts.room;
        room.open(host, stake, commitment, code, ctx.bumps.room, snapshot)?;
        emit!(RoomOpened { room: room.key(), host, code, stake, commitment });
        Ok(())
    }

    /// The guest matches the stake from its token account; the round's entropy is fixed here.
    pub fn join_room_token(ctx: Context<JoinRoomToken>) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        require!(ctx.accounts.mint_entry.enabled, DuelError::MintDisabled);
        require!(ctx.accounts.room.state == RoomState::Open as u8, DuelError::NotOpen);
        require_keys_neq!(ctx.accounts.guest.key(), ctx.accounts.room.host, DuelError::SameWallet);
        let mint_info = ctx.accounts.mint.to_account_info();
        token::require_mint_live(&mint_info)?;
        deposit_tokens(&ctx.accounts.guest_ata.to_account_info(), &ctx.accounts.vault.to_account_info(), &ctx.accounts.guest.to_account_info(), &mint_info, &ctx.accounts.token_program, ctx.accounts.room.stake, ctx.accounts.mint.decimals)?;
        join(&mut ctx.accounts.room, ctx.accounts.guest.key(), &ctx.accounts.slot_hashes.to_account_info())
    }

    /// Before anyone joins, the host takes the stake back; the vault closes and the rent returns.
    pub fn cancel_room_token(ctx: Context<CancelRoomToken>) -> Result<()> {
        require!(ctx.accounts.room.state == RoomState::Open as u8, DuelError::NotOpen);
        token::require_mint_not_paused(&ctx.accounts.mint.to_account_info())?;
        let stake = ctx.accounts.room.stake;
        let a = &mut *ctx.accounts;
        finish_room(&mut a.room, &a.host, &a.mint, &a.vault, &a.token_program, &a.host_ata, &a.host_ata, &a.treasury_ata, stake, [stake, 0], 0)
    }

    /// Anyone reveals the host's seed; the program replays the round and pays in tokens. Recipients
    /// that cannot be paid are credited (`claim_credit`); the vault and the room close once nothing
    /// is owed.
    pub fn settle_token(ctx: Context<SettleToken>, server_seed: [u8; 32]) -> Result<()> {
        let room = &ctx.accounts.room;
        require!(room.state == RoomState::Ready as u8, DuelError::NotReady);
        require!(hashv(&[&server_seed]).to_bytes() == room.commitment, DuelError::BadReveal);
        token::require_mint_not_paused(&ctx.accounts.mint.to_account_info())?;
        let outcome = bingo::play(&server_seed, &room.entropy);
        let (pot, fee, prize) = split(room.stake, room.fee_bps)?;
        let (host_share, guest_share, dust) = room_shares(prize, outcome.host_won, outcome.guest_won);
        emit!(RoomSettled {
            room: room.key(),
            server_seed,
            win_ball: outcome.win_ball,
            host_won: outcome.host_won,
            guest_won: outcome.guest_won,
            pot,
            fee,
            mint: room.mint,
            seeker: room.seeker,
        });
        let a = &mut *ctx.accounts;
        finish_room(&mut a.room, &a.host, &a.mint, &a.vault, &a.token_program, &a.host_ata, &a.guest_ata, &a.treasury_ata, pot, [host_share, guest_share], fee + dust)
    }

    /// The host went quiet after the guest joined: the guest takes the pot, in tokens.
    pub fn claim_timeout_token(ctx: Context<SettleToken>) -> Result<()> {
        let room = &ctx.accounts.room;
        require!(room.state == RoomState::Ready as u8, DuelError::NotReady);
        require!(Clock::get()?.slot >= room.joined_slot + TIMEOUT_SLOTS, DuelError::TooEarly);
        token::require_mint_not_paused(&ctx.accounts.mint.to_account_info())?;
        let (pot, fee, prize) = split(room.stake, room.fee_bps)?;
        emit!(RoomTimedOut { room: room.key(), guest: room.guest, pot, fee, mint: room.mint });
        let a = &mut *ctx.accounts;
        finish_room(&mut a.room, &a.host, &a.mint, &a.vault, &a.token_program, &a.host_ata, &a.guest_ata, &a.treasury_ata, pot, [0, prize], fee)
    }

    /// Pay a credit left by a settlement, timeout or cancel: `index` 0 is the host, 1 the guest,
    /// `TREASURY_CREDIT` the treasury. Anyone may send it; the destination must be a token account
    /// of the creditor for the room's mint. The last claim sweeps any residue to the treasury,
    /// closes the vault and the room, the rent going to the host.
    pub fn claim_credit(ctx: Context<ClaimCredit>, index: u8) -> Result<()> {
        require!(ctx.accounts.room.state == RoomState::Settled as u8, DuelError::NotSettled);
        token::require_mint_not_paused(&ctx.accounts.mint.to_account_info())?;
        let a = &mut *ctx.accounts;
        let (creditor, owed) = match index {
            0 => (a.room.host, a.room.credits[0]),
            1 => (a.room.guest, a.room.credits[1]),
            TREASURY_CREDIT => (a.room.treasury, a.room.treasury_credit),
            _ => return err!(DuelError::BadCreditIndex),
        };
        require!(owed > 0, DuelError::NothingToClaim);
        let (host, code, bump) = (a.room.host, a.room.code, a.room.bump);
        let seeds: [&[u8]; 4] = [b"room", host.as_ref(), &code, std::slice::from_ref(&bump)];
        let vault = Vault { token_program: a.token_program.to_account_info(), mint: a.mint.to_account_info(), vault: a.vault.to_account_info(), authority: a.room.to_account_info(), seeds: &seeds, decimals: a.mint.decimals };
        let paid = token::pay_credit(&vault, &a.destination, &creditor, owed, &a.memo_program)?;
        emit!(CreditClaimed { escrow: a.room.key(), creditor, amount: paid });
        let room = &mut a.room;
        match index {
            TREASURY_CREDIT => room.treasury_credit = 0,
            i => room.credits[i as usize] = 0,
        }
        if room.credits.iter().all(|c| *c == 0) && room.treasury_credit == 0 {
            let mut treasury_credit = 0u64;
            sweep(&vault, &a.treasury_ata, room.treasury, &mut treasury_credit)?;
            if treasury_credit > 0 {
                room.treasury_credit = treasury_credit;
            } else {
                vault.close(&a.host.to_account_info())?;
                room.close(a.host.to_account_info())?;
            }
        }
        Ok(())
    }

    /// The host of an open room proves it holds a Seeker Genesis Token: the round's fee drops to
    /// the Seeker tier (the mint's `seeker_fee_bps`, or `sol_seeker_fee_bps` for SOL).
    pub fn prove_seeker_room(ctx: Context<ProveSeekerRoom>) -> Result<()> {
        require!(ctx.accounts.room.state == RoomState::Open as u8, DuelError::NotOpen);
        let fee = seeker_fee(&ctx.accounts.config, ctx.accounts.room.mint, ctx.accounts.mint_entry.as_deref())?;
        token::verify_sgt(&ctx.accounts.config.sgt_group, &ctx.accounts.sgt_token_account, &ctx.accounts.sgt_mint, &ctx.accounts.host.key())?;
        let room = &mut ctx.accounts.room;
        room.fee_bps = room.fee_bps.min(fee);
        room.seeker = true;
        emit!(SeekerProven { escrow: room.key(), host: room.host, fee_bps: room.fee_bps });
        Ok(())
    }

    /* ---------- Halls (SOL) ---------- */

    /// The host commits to a seed, names the table (stake per card, seats) and buys its own cards,
    /// which are cards 0..cards−1 of the round.
    pub fn open_hall(
        ctx: Context<OpenHall>,
        code: [u8; 5],
        stake_per_card: u64,
        max_players: u8,
        cards: u8,
        commitment: [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        require!((MIN_STAKE..=MAX_STAKE).contains(&stake_per_card), DuelError::StakeOutOfRange);
        check_table(code, max_players, cards)?;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.host.to_account_info(), to: ctx.accounts.hall.to_account_info() },
            ),
            deposit(stake_per_card, cards)?,
        )?;
        let host = ctx.accounts.host.key();
        let snapshot = Snapshot { fee_bps: ctx.accounts.config.fee_bps, treasury: ctx.accounts.config.treasury, mint: Pubkey::default(), token_program: Pubkey::default() };
        let hall = &mut ctx.accounts.hall;
        hall.open(host, stake_per_card, max_players, cards, commitment, code, ctx.bumps.hall, snapshot)?;
        emit!(HallOpened { hall: hall.key(), host, code, stake_per_card, max_players, cards, commitment });
        Ok(())
    }

    /// Any other wallet buys cards while the hall is open: it is appended to the roster, so its
    /// cards are the next numbers. The join that fills the last seat also locks the hall.
    pub fn join_hall(ctx: Context<JoinHall>, cards: u8) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        require!(ctx.accounts.hall.is_sol(), DuelError::NotSolEscrow);
        let player = ctx.accounts.player.key();
        ctx.accounts.hall.check_join(player, cards)?;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.player.to_account_info(), to: ctx.accounts.hall.to_account_info() },
            ),
            deposit(ctx.accounts.hall.stake_per_card, cards)?,
        )?;
        seat(&mut ctx.accounts.hall, player, cards, &ctx.accounts.slot_hashes.to_account_info())
    }

    /// A guest closes sales once the hall has two players: the round's entropy is fixed here.
    ///
    /// Why a guest and never the host: the entropy is `sha256(roster ‖ newest slot hash)`, and the
    /// slot hash is the only part nobody chose. The host knows the seed, so if it could pick the
    /// slot it could replay the round against each slot's hash as it appears and lock only on one
    /// it likes (a grinding attack: a fresh sample every 400 ms). A guest does not know the seed;
    /// whichever slot it picks it cannot tell a good outcome from a bad one, so its timing is
    /// harmless. (A host that also controls a guest wallet is the residual risk every public-beacon
    /// commit-reveal has; such a host is partly playing itself, and honest guests shrink the window
    /// by locking as soon as they are happy with the roster.) Mint-agnostic: SOL and token halls alike.
    pub fn lock_hall(ctx: Context<LockHall>) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        let hall = &ctx.accounts.hall;
        require!(hall.state == HallState::Open as u8, DuelError::HallNotOpen);
        require!(hall.player_count >= MIN_HALL_PLAYERS, DuelError::TooFewPlayers);
        let player = ctx.accounts.player.key();
        require_keys_neq!(player, hall.host, DuelError::HostCannotLock);
        require!(hall.players[1..hall.player_count as usize].contains(&player), DuelError::NotSeated);
        lock(&mut ctx.accounts.hall, &ctx.accounts.slot_hashes.to_account_info())
    }

    /// While the hall is open the host may call it off: every deposit goes back to its player
    /// (the roster as remaining accounts, in order) and `close` returns the rent to the host.
    pub fn cancel_hall(ctx: Context<CancelHall>) -> Result<()> {
        let hall = &ctx.accounts.hall;
        require!(hall.is_sol(), DuelError::NotSolEscrow);
        let players = roster(hall, ctx.remaining_accounts)?;
        let hall_info = ctx.accounts.hall.to_account_info();
        for (i, player) in players.iter().enumerate() {
            pay(&hall_info, player, deposit(hall.stake_per_card, hall.cards[i])?)?;
        }
        let (pot, _, _) = split_hall(hall.stake_per_card, hall.cards_sold, 0)?;
        emit!(HallCancelled { hall: hall.key(), host: hall.host, refunded: pot });
        Ok(())
    }

    /// Anyone reveals the host's seed; the program replays the hall and pays every winning card
    /// an equal share of the prize, each player receiving the sum of its cards' shares. The
    /// roster travels as remaining accounts in order; the treasury takes the fee and the dust
    /// (prize mod winning cards); `close` returns the rent to the host.
    pub fn settle_hall(ctx: Context<SettleHall>, server_seed: [u8; 32]) -> Result<()> {
        let hall = &ctx.accounts.hall;
        require!(hall.is_sol(), DuelError::NotSolEscrow);
        require!(hall.state == HallState::Locked as u8, DuelError::HallNotLocked);
        require!(hashv(&[&server_seed]).to_bytes() == hall.commitment, DuelError::BadReveal);
        let players = roster(hall, ctx.remaining_accounts)?;
        let seated = hall.player_count as usize;
        let outcome = bingo::play_hall(&server_seed, &hall.entropy, &hall.cards[..seated]);
        let (pot, fee, prize) = split_hall(hall.stake_per_card, hall.cards_sold, hall.fee_bps)?;
        // Every card's numbers are drawn by ball 30, so at least one card wins: no division by zero.
        let winning = outcome.winning_cards as u64;
        let share = prize / winning;
        let dust = prize - share * winning;
        let shares = outcome.shares(seated);
        let hall_info = ctx.accounts.hall.to_account_info();
        for (player, won) in players.iter().zip(shares.iter()) {
            pay(&hall_info, player, share * *won as u64)?;
        }
        pay(&hall_info, &ctx.accounts.treasury.to_account_info(), fee + dust)?;
        emit!(HallSettled {
            hall: hall.key(),
            server_seed,
            win_ball: outcome.win_ball,
            winning_cards: outcome.winning_cards,
            share,
            pot,
            fee,
            mint: Pubkey::default(),
            seeker: hall.seeker,
        });
        Ok(())
    }

    /// The host went quiet after the lock: the guests get their deposits back and split the
    /// host's deposit pro rata to their cards; no fee. The host, who saw the outcome first, would
    /// otherwise have a free re-roll of every round it dislikes (a refund-only timeout let it stay
    /// silent at no cost); the forfeit makes silence cost exactly what losing would. The dust of
    /// the split goes to the treasury.
    pub fn claim_timeout_hall(ctx: Context<SettleHall>) -> Result<()> {
        let hall = &ctx.accounts.hall;
        require!(hall.is_sol(), DuelError::NotSolEscrow);
        require!(hall.state == HallState::Locked as u8, DuelError::HallNotLocked);
        require!(Clock::get()?.slot >= hall.locked_slot + TIMEOUT_SLOTS, DuelError::TooEarly);
        let players = roster(hall, ctx.remaining_accounts)?;
        let (amounts, forfeited, dust) = forfeit_amounts(hall)?;
        let hall_info = ctx.accounts.hall.to_account_info();
        for (player, amount) in players.iter().zip(amounts.iter()) {
            pay(&hall_info, player, *amount)?;
        }
        pay(&hall_info, &ctx.accounts.treasury.to_account_info(), dust)?;
        let (pot, _, _) = split_hall(hall.stake_per_card, hall.cards_sold, 0)?;
        emit!(HallTimedOut { hall: hall.key(), host: hall.host, refunded: pot - forfeited, forfeited, mint: Pubkey::default() });
        Ok(())
    }

    /* ---------- Halls (tokens) ---------- */

    /// `open_hall` for a registered mint: the deposit is `cards × stake_per_card` base units, the
    /// vault the hall PDA's associated token account.
    pub fn open_hall_token(
        ctx: Context<OpenHallToken>,
        code: [u8; 5],
        stake_per_card: u64,
        max_players: u8,
        cards: u8,
        commitment: [u8; 32],
    ) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        let entry = &ctx.accounts.mint_entry;
        require!(entry.enabled, DuelError::MintDisabled);
        require!((entry.min_stake..=entry.max_stake).contains(&stake_per_card), DuelError::StakeOutOfRange);
        check_table(code, max_players, cards)?;
        let mint_info = ctx.accounts.mint.to_account_info();
        token::require_mint_live(&mint_info)?;
        open_vault(
            &ctx.accounts.vault,
            &ctx.accounts.hall.to_account_info(),
            &ctx.accounts.host.to_account_info(),
            &mint_info,
            &ctx.accounts.token_program,
            &ctx.accounts.associated_token_program,
            &ctx.accounts.system_program,
        )?;
        deposit_tokens(&ctx.accounts.host_ata.to_account_info(), &ctx.accounts.vault, &ctx.accounts.host.to_account_info(), &mint_info, &ctx.accounts.token_program, deposit(stake_per_card, cards)?, ctx.accounts.mint.decimals)?;
        let host = ctx.accounts.host.key();
        let snapshot = Snapshot { fee_bps: entry.fee_bps, treasury: ctx.accounts.config.treasury, mint: entry.mint, token_program: entry.token_program };
        let hall = &mut ctx.accounts.hall;
        hall.open(host, stake_per_card, max_players, cards, commitment, code, ctx.bumps.hall, snapshot)?;
        emit!(HallOpened { hall: hall.key(), host, code, stake_per_card, max_players, cards, commitment });
        Ok(())
    }

    /// `join_hall` for a token hall: the deposit comes from the player's token account.
    pub fn join_hall_token(ctx: Context<JoinHallToken>, cards: u8) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        require!(ctx.accounts.mint_entry.enabled, DuelError::MintDisabled);
        let player = ctx.accounts.player.key();
        ctx.accounts.hall.check_join(player, cards)?;
        let mint_info = ctx.accounts.mint.to_account_info();
        token::require_mint_live(&mint_info)?;
        let amount = deposit(ctx.accounts.hall.stake_per_card, cards)?;
        deposit_tokens(&ctx.accounts.player_ata.to_account_info(), &ctx.accounts.vault.to_account_info(), &ctx.accounts.player.to_account_info(), &mint_info, &ctx.accounts.token_program, amount, ctx.accounts.mint.decimals)?;
        seat(&mut ctx.accounts.hall, player, cards, &ctx.accounts.slot_hashes.to_account_info())
    }

    /// The host calls off an open token hall: every deposit goes back (the roster's token
    /// accounts as remaining accounts, in order); what cannot be paid is credited.
    pub fn cancel_hall_token<'info>(ctx: Context<'info, CancelHallToken<'info>>) -> Result<()> {
        require!(ctx.accounts.hall.state == HallState::Open as u8, DuelError::HallNotOpen);
        token::require_mint_not_paused(&ctx.accounts.mint.to_account_info())?;
        let hall = &ctx.accounts.hall;
        let seated = hall.player_count as usize;
        let mut amounts = Vec::with_capacity(seated);
        for i in 0..seated {
            amounts.push(deposit(hall.stake_per_card, hall.cards[i])?);
        }
        let (pot, _, _) = split_hall(hall.stake_per_card, hall.cards_sold, 0)?;
        emit!(HallCancelled { hall: hall.key(), host: hall.host, refunded: pot });
        let a = &mut *ctx.accounts;
        finish_hall(&mut a.hall, &a.host, &a.mint, &a.vault, &a.token_program, &a.treasury_ata, ctx.remaining_accounts, pot, &amounts, 0)
    }

    /// `settle_hall` for a token hall. Remaining accounts: one token account per roster entry, in
    /// roster order, each writable and owned by that player (its associated token account unless
    /// the player prefers another). Winners that cannot be paid are credited (`claim_credit_hall`).
    pub fn settle_hall_token<'info>(ctx: Context<'info, SettleHallToken<'info>>, server_seed: [u8; 32]) -> Result<()> {
        let hall = &ctx.accounts.hall;
        require!(hall.state == HallState::Locked as u8, DuelError::HallNotLocked);
        require!(hashv(&[&server_seed]).to_bytes() == hall.commitment, DuelError::BadReveal);
        token::require_mint_not_paused(&ctx.accounts.mint.to_account_info())?;
        let seated = hall.player_count as usize;
        let outcome = bingo::play_hall(&server_seed, &hall.entropy, &hall.cards[..seated]);
        let (pot, fee, prize) = split_hall(hall.stake_per_card, hall.cards_sold, hall.fee_bps)?;
        let winning = outcome.winning_cards as u64;
        let share = prize / winning;
        let dust = prize - share * winning;
        let amounts: Vec<u64> = outcome.shares(seated).iter().map(|won| share * *won as u64).collect();
        emit!(HallSettled {
            hall: hall.key(),
            server_seed,
            win_ball: outcome.win_ball,
            winning_cards: outcome.winning_cards,
            share,
            pot,
            fee,
            mint: hall.mint,
            seeker: hall.seeker,
        });
        let a = &mut *ctx.accounts;
        finish_hall(&mut a.hall, &a.host, &a.mint, &a.vault, &a.token_program, &a.treasury_ata, ctx.remaining_accounts, pot, &amounts, fee + dust)
    }

    /// `claim_timeout_hall` for a token hall: the same forfeit, in tokens.
    pub fn claim_timeout_hall_token<'info>(ctx: Context<'info, SettleHallToken<'info>>) -> Result<()> {
        let hall = &ctx.accounts.hall;
        require!(hall.state == HallState::Locked as u8, DuelError::HallNotLocked);
        require!(Clock::get()?.slot >= hall.locked_slot + TIMEOUT_SLOTS, DuelError::TooEarly);
        token::require_mint_not_paused(&ctx.accounts.mint.to_account_info())?;
        let (amounts, forfeited, dust) = forfeit_amounts(hall)?;
        let (pot, _, _) = split_hall(hall.stake_per_card, hall.cards_sold, 0)?;
        emit!(HallTimedOut { hall: hall.key(), host: hall.host, refunded: pot - forfeited, forfeited, mint: hall.mint });
        let a = &mut *ctx.accounts;
        finish_hall(&mut a.hall, &a.host, &a.mint, &a.vault, &a.token_program, &a.treasury_ata, ctx.remaining_accounts, pot, &amounts, dust)
    }

    /// `claim_credit` for a hall: `index` is the roster position (0 the host), or `TREASURY_CREDIT`.
    pub fn claim_credit_hall(ctx: Context<ClaimCreditHall>, index: u8) -> Result<()> {
        require!(ctx.accounts.hall.state == HallState::Settled as u8, DuelError::NotSettled);
        token::require_mint_not_paused(&ctx.accounts.mint.to_account_info())?;
        let a = &mut *ctx.accounts;
        let (creditor, owed) = if index == TREASURY_CREDIT {
            (a.hall.treasury, a.hall.treasury_credit)
        } else {
            require!((index as usize) < a.hall.player_count as usize, DuelError::BadCreditIndex);
            (a.hall.players[index as usize], a.hall.credits[index as usize])
        };
        require!(owed > 0, DuelError::NothingToClaim);
        let (host, code, bump) = (a.hall.host, a.hall.code, a.hall.bump);
        let seeds: [&[u8]; 4] = [b"hall", host.as_ref(), &code, std::slice::from_ref(&bump)];
        let vault = Vault { token_program: a.token_program.to_account_info(), mint: a.mint.to_account_info(), vault: a.vault.to_account_info(), authority: a.hall.to_account_info(), seeds: &seeds, decimals: a.mint.decimals };
        let paid = token::pay_credit(&vault, &a.destination, &creditor, owed, &a.memo_program)?;
        emit!(CreditClaimed { escrow: a.hall.key(), creditor, amount: paid });
        let hall = &mut a.hall;
        if index == TREASURY_CREDIT {
            hall.treasury_credit = 0;
        } else {
            hall.credits[index as usize] = 0;
        }
        if hall.credits.iter().all(|c| *c == 0) && hall.treasury_credit == 0 {
            let mut treasury_credit = 0u64;
            sweep(&vault, &a.treasury_ata, hall.treasury, &mut treasury_credit)?;
            if treasury_credit > 0 {
                hall.treasury_credit = treasury_credit;
            } else {
                vault.close(&a.host.to_account_info())?;
                hall.close(a.host.to_account_info())?;
            }
        }
        Ok(())
    }

    /// `prove_seeker_room` for a hall (the host, while the hall is open).
    pub fn prove_seeker_hall(ctx: Context<ProveSeekerHall>) -> Result<()> {
        require!(ctx.accounts.hall.state == HallState::Open as u8, DuelError::HallNotOpen);
        let fee = seeker_fee(&ctx.accounts.config, ctx.accounts.hall.mint, ctx.accounts.mint_entry.as_deref())?;
        token::verify_sgt(&ctx.accounts.config.sgt_group, &ctx.accounts.sgt_token_account, &ctx.accounts.sgt_mint, &ctx.accounts.host.key())?;
        let hall = &mut ctx.accounts.hall;
        hall.fee_bps = hall.fee_bps.min(fee);
        hall.seeker = true;
        emit!(SeekerProven { escrow: hall.key(), host: hall.host, fee_bps: hall.fee_bps });
        Ok(())
    }

    /* ---------- Coin shop ---------- */

    /// Buy coin pack `pack` (0..4) for SOL at `sol_pack_prices[pack]`, less the Seeker discount
    /// when the buyer passes its Seeker Genesis Token (both optional accounts, or neither). The
    /// price goes to the treasury; the buyer's `Buyer` PDA records the running totals. No refunds.
    pub fn buy_pack(ctx: Context<BuyPack>, pack: u8) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, DuelError::Paused);
        let (price, coins) = pack_terms(config, config.sol_pack_prices, pack)?;
        let seeker = seeker_buyer(config, ctx.accounts.sgt_token_account.as_ref(), ctx.accounts.sgt_mint.as_ref(), &ctx.accounts.wallet.key())?;
        let discount_bps = if seeker { config.seeker_discount_bps } else { 0 };
        let paid = discounted(price, discount_bps)?;
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.wallet.to_account_info(), to: ctx.accounts.treasury.to_account_info() },
            ),
            paid,
        )?;
        record_purchase(&mut ctx.accounts.buyer, ctx.accounts.wallet.key(), ctx.bumps.buyer, coins)?;
        emit!(CoinsBought { wallet: ctx.accounts.wallet.key(), mint: Pubkey::default(), pack, coins, paid, discount_bps, seeker });
        Ok(())
    }

    /// `buy_pack` paid in a registered mint: `pack_prices[pack]` less the mint's discount and the
    /// Seeker discount, by `transfer_checked` to the registered treasury account.
    pub fn buy_pack_token(ctx: Context<BuyPackToken>, pack: u8) -> Result<()> {
        let config = &ctx.accounts.config;
        let entry = &ctx.accounts.mint_entry;
        require!(!config.paused, DuelError::Paused);
        require!(entry.enabled, DuelError::MintDisabled);
        let (price, coins) = pack_terms(config, entry.pack_prices, pack)?;
        let seeker = seeker_buyer(config, ctx.accounts.sgt_token_account.as_ref(), ctx.accounts.sgt_mint.as_ref(), &ctx.accounts.wallet.key())?;
        let discount_bps = entry.discount_bps + if seeker { config.seeker_discount_bps } else { 0 };
        let paid = discounted(price, discount_bps)?;
        let mint_info = ctx.accounts.mint.to_account_info();
        token::require_mint_live(&mint_info)?;
        deposit_tokens(&ctx.accounts.wallet_ata.to_account_info(), &ctx.accounts.treasury_ata.to_account_info(), &ctx.accounts.wallet.to_account_info(), &mint_info, &ctx.accounts.token_program, paid, ctx.accounts.mint.decimals)?;
        record_purchase(&mut ctx.accounts.buyer, ctx.accounts.wallet.key(), ctx.bumps.buyer, coins)?;
        emit!(CoinsBought { wallet: ctx.accounts.wallet.key(), mint: entry.mint, pack, coins, paid, discount_bps, seeker });
        Ok(())
    }
}

/* ---------- Shared handler pieces ---------- */

/// What a round copies from the config and the registry when it opens.
struct Snapshot {
    fee_bps: u16,
    treasury: Pubkey,
    mint: Pubkey,
    token_program: Pubkey,
}

fn check_table(code: [u8; 5], max_players: u8, cards: u8) -> Result<()> {
    require!(code.iter().all(|c| CODE_ALPHABET.contains(c)), DuelError::BadCode);
    require!((MIN_HALL_PLAYERS..=MAX_HALL_PLAYERS).contains(&max_players), DuelError::PlayersOutOfRange);
    require!((1..=MAX_HALL_CARDS).contains(&cards), DuelError::CardsOutOfRange);
    Ok(())
}

fn check_mint_terms(min_stake: u64, max_stake: u64, fee_bps: u16, seeker_fee_bps: u16, discount_bps: u16) -> Result<()> {
    require!(min_stake >= 1 && min_stake <= max_stake && max_stake <= MAX_MINT_STAKE, DuelError::StakeBoundsInvalid);
    require!(fee_bps <= MAX_FEE_BPS, DuelError::FeeTooHigh);
    require!(seeker_fee_bps <= fee_bps, DuelError::FeeTooHigh);
    require!(discount_bps <= 10_000, DuelError::DiscountTooHigh);
    Ok(())
}

/// A room's prize split: winner takes all, a tie halves it with one unit of dust.
fn room_shares(prize: u64, host_won: bool, guest_won: bool) -> (u64, u64, u64) {
    match (host_won, guest_won) {
        (true, false) => (prize, 0, 0),
        (false, true) => (0, prize, 0),
        _ => (prize / 2, prize / 2, prize % 2),
    }
}

/// The guest's join: entropy from its key and the newest slot hash.
fn join(room: &mut Account<Room>, guest: Pubkey, slot_hashes: &AccountInfo) -> Result<()> {
    let slot_hash = latest_slot_hash(slot_hashes)?;
    let entropy = hashv(&[guest.as_ref(), &slot_hash]).to_bytes();
    let joined_slot = Clock::get()?.slot;
    room.guest = guest;
    room.joined_slot = joined_slot;
    room.entropy = entropy;
    room.state = RoomState::Ready as u8;
    emit!(RoomJoined { room: room.key(), guest, entropy, joined_slot });
    Ok(())
}

/// Append a player to the roster; the join that fills the hall locks it.
fn seat(hall: &mut Account<Hall>, player: Pubkey, cards: u8, slot_hashes: &AccountInfo) -> Result<()> {
    let seated = hall.player_count as usize;
    hall.players[seated] = player;
    hall.cards[seated] = cards;
    hall.player_count += 1;
    hall.cards_sold += cards as u16;
    emit!(HallJoined { hall: hall.key(), player, cards, player_count: hall.player_count, cards_sold: hall.cards_sold });
    if hall.player_count == hall.max_players {
        // The filling join is a guest's (the host cannot join its own hall), so the argument
        // on `lock_hall` for who may pick the locking slot holds here too.
        lock(hall, slot_hashes)?;
    }
    Ok(())
}

/// The hall timeout: each guest's own deposit plus its pro-rata share of the host's; the host
/// nothing; the split's dust to the treasury. Returns (amount per roster entry, forfeited, dust).
fn forfeit_amounts(hall: &Hall) -> Result<(Vec<u64>, u64, u64)> {
    let seated = hall.player_count as usize;
    let host_deposit = deposit(hall.stake_per_card, hall.cards[0])?;
    let guest_cards: u64 = hall.cards[1..seated].iter().map(|&c| c as u64).sum();
    let mut amounts = vec![0u64; seated];
    let mut distributed = 0u64;
    for i in 1..seated {
        let bonus = ((host_deposit as u128) * (hall.cards[i] as u128) / (guest_cards.max(1) as u128)) as u64;
        amounts[i] = deposit(hall.stake_per_card, hall.cards[i])?.checked_add(bonus).ok_or(DuelError::Overflow)?;
        distributed += bonus;
    }
    Ok((amounts, host_deposit, host_deposit - distributed))
}

/// The Seeker fee tier for a round: the registry's for a token round, the config's for SOL.
fn seeker_fee(config: &Config, mint: Pubkey, entry: Option<&MintEntry>) -> Result<u16> {
    if mint == Pubkey::default() {
        return Ok(config.sol_seeker_fee_bps);
    }
    let entry = entry.ok_or(DuelError::MintMismatch)?;
    require_keys_eq!(entry.mint, mint, DuelError::MintMismatch);
    Ok(entry.seeker_fee_bps)
}

/// A buyer is a Seeker when it passes both SGT accounts and they verify; passing one, or a pair
/// that fails the check, is an error rather than a silent full price.
fn seeker_buyer<'info>(config: &Config, token_account: Option<&InterfaceAccount<'info, TokenAccount>>, mint: Option<&InterfaceAccount<'info, Mint>>, wallet: &Pubkey) -> Result<bool> {
    match (token_account, mint) {
        (None, None) => Ok(false),
        (Some(account), Some(mint)) => {
            token::verify_sgt(&config.sgt_group, &account.to_account_info(), &mint.to_account_info(), wallet)?;
            Ok(true)
        }
        _ => err!(DuelError::NotSeeker),
    }
}

fn pack_terms(config: &Config, prices: [u64; PACKS], pack: u8) -> Result<(u64, u32)> {
    require!((pack as usize) < PACKS, DuelError::BadPack);
    let price = prices[pack as usize];
    require!(price > 0, DuelError::PackNotForSale);
    Ok((price, config.pack_coins[pack as usize]))
}

/// `price × (10_000 − discount) / 10_000`, never below one base unit so a pack is never free.
fn discounted(price: u64, discount_bps: u16) -> Result<u64> {
    require!(discount_bps < 10_000, DuelError::DiscountTooHigh);
    let paid = ((price as u128) * (10_000u128 - discount_bps as u128) / 10_000) as u64;
    Ok(paid.max(1))
}

fn record_purchase(buyer: &mut Account<Buyer>, wallet: Pubkey, bump: u8, coins: u32) -> Result<()> {
    if buyer.wallet == Pubkey::default() {
        buyer.wallet = wallet;
        buyer.bump = bump;
    }
    require_keys_eq!(buyer.wallet, wallet, DuelError::BuyerMismatch);
    buyer.coins_total = buyer.coins_total.checked_add(coins as u64).ok_or(DuelError::Overflow)?;
    buyer.purchases = buyer.purchases.checked_add(1).ok_or(DuelError::Overflow)?;
    buyer.last_slot = Clock::get()?.slot;
    Ok(())
}

/// Create the escrow's associated token account for the mint (idempotently; anyone may have
/// created it first, which changes nothing) after checking the address the client passed.
fn open_vault<'info>(
    vault: &AccountInfo<'info>,
    escrow: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    associated_token_program: &Program<'info, AssociatedToken>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    let expected = get_associated_token_address_with_program_id(escrow.key, mint.key, token_program.key);
    require_keys_eq!(*vault.key, expected, DuelError::BadVault);
    create_idempotent(CpiContext::new(
        associated_token_program.key(),
        Create {
            payer: payer.clone(),
            associated_token: vault.clone(),
            authority: escrow.clone(),
            mint: mint.clone(),
            system_program: system_program.to_account_info(),
            token_program: token_program.to_account_info(),
        },
    ))
}

/// A player's deposit: `transfer_checked` from its account into the vault, the player signing.
fn deposit_tokens<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    token_program: &Interface<'info, TokenInterface>,
    amount: u64,
    decimals: u8,
) -> Result<()> {
    transfer_checked(
        CpiContext::new(
            token_program.key(),
            TransferChecked { from: from.clone(), mint: mint.clone(), to: to.clone(), authority: authority.clone() },
        ),
        amount,
        decimals,
    )
}

/// Residue in the vault after every credit is paid goes to the treasury, or is credited to it.
fn sweep<'a, 'info>(vault: &Vault<'a, 'info>, treasury_account: &AccountInfo<'info>, treasury: Pubkey, treasury_credit: &mut u64) -> Result<()> {
    let residue = vault.amount()?;
    if residue == 0 {
        return Ok(());
    }
    let treasury_payee = Payee { account: treasury_account, owner: treasury, amount: 0 };
    token::distribute(vault, residue, &[], &mut [], &treasury_payee, treasury_credit)
}

/// Pay a token room out of its vault and close it, or leave it `Settled` with credits.
#[allow(clippy::too_many_arguments)]
fn finish_room<'info>(
    room: &mut Account<'info, Room>,
    host: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    vault_account: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    host_ata: &AccountInfo<'info>,
    guest_ata: &AccountInfo<'info>,
    treasury_ata: &AccountInfo<'info>,
    expected: u64,
    shares: [u64; 2],
    treasury_amount: u64,
) -> Result<()> {
    let (host_key, guest_key, code, bump, treasury_key) = (room.host, room.guest, room.code, room.bump, room.treasury);
    let seeds: [&[u8]; 4] = [b"room", host_key.as_ref(), &code, std::slice::from_ref(&bump)];
    let vault = Vault { token_program: token_program.to_account_info(), mint: mint.to_account_info(), vault: vault_account.to_account_info(), authority: room.to_account_info(), seeds: &seeds, decimals: mint.decimals };
    let payees = [
        Payee { account: host_ata, owner: host_key, amount: shares[0] },
        Payee { account: guest_ata, owner: guest_key, amount: shares[1] },
    ];
    let treasury = Payee { account: treasury_ata, owner: treasury_key, amount: treasury_amount };
    let mut credits = room.credits;
    let mut treasury_credit = room.treasury_credit;
    token::distribute(&vault, expected, &payees, &mut credits, &treasury, &mut treasury_credit)?;
    if credits.iter().all(|c| *c == 0) && treasury_credit == 0 {
        vault.close(host)?;
        room.close(host.clone())?;
    } else {
        room.credits = credits;
        room.treasury_credit = treasury_credit;
        room.state = RoomState::Settled as u8;
    }
    Ok(())
}

/// Pay a token hall out of its vault and close it, or leave it `Settled` with credits.
#[allow(clippy::too_many_arguments)]
fn finish_hall<'info>(
    hall: &mut Account<'info, Hall>,
    host: &AccountInfo<'info>,
    mint: &InterfaceAccount<'info, Mint>,
    vault_account: &InterfaceAccount<'info, TokenAccount>,
    token_program: &Interface<'info, TokenInterface>,
    treasury_ata: &AccountInfo<'info>,
    roster_accounts: &[AccountInfo<'info>],
    expected: u64,
    amounts: &[u64],
    treasury_amount: u64,
) -> Result<()> {
    let seated = hall.player_count as usize;
    require!(roster_accounts.len() == seated && amounts.len() == seated, DuelError::RosterMismatch);
    let (host_key, code, bump, treasury_key, players) = (hall.host, hall.code, hall.bump, hall.treasury, hall.players);
    let seeds: [&[u8]; 4] = [b"hall", host_key.as_ref(), &code, std::slice::from_ref(&bump)];
    let vault = Vault { token_program: token_program.to_account_info(), mint: mint.to_account_info(), vault: vault_account.to_account_info(), authority: hall.to_account_info(), seeds: &seeds, decimals: mint.decimals };
    let payees: Vec<Payee> = roster_accounts.iter().zip(amounts.iter()).enumerate().map(|(i, (account, amount))| Payee { account, owner: players[i], amount: *amount }).collect();
    let treasury = Payee { account: treasury_ata, owner: treasury_key, amount: treasury_amount };
    let mut credits = hall.credits;
    let mut treasury_credit = hall.treasury_credit;
    token::distribute(&vault, expected, &payees, &mut credits[..seated], &treasury, &mut treasury_credit)?;
    if credits.iter().all(|c| *c == 0) && treasury_credit == 0 {
        vault.close(host)?;
        hall.close(host.clone())?;
    } else {
        hall.credits = credits;
        hall.treasury_credit = treasury_credit;
        hall.state = HallState::Settled as u8;
    }
    Ok(())
}

/* ---------- Arithmetic and lamports ---------- */

/// Pot, fee and prize for a room's stake.
fn split(stake: u64, fee_bps: u16) -> Result<(u64, u64, u64)> {
    let pot = stake.checked_mul(2).ok_or(DuelError::Overflow)?;
    let fee = ((pot as u128) * (fee_bps as u128) / 10_000) as u64;
    Ok((pot, fee, pot - fee))
}

/// Pot, fee and prize for a hall: the pot is every card sold at the stake per card.
fn split_hall(stake_per_card: u64, cards_sold: u16, fee_bps: u16) -> Result<(u64, u64, u64)> {
    let pot = stake_per_card.checked_mul(cards_sold as u64).ok_or(DuelError::Overflow)?;
    let fee = ((pot as u128) * (fee_bps as u128) / 10_000) as u64;
    Ok((pot, fee, pot - fee))
}

/// What a player deposits for `cards` cards.
fn deposit(stake_per_card: u64, cards: u8) -> Result<u64> {
    stake_per_card.checked_mul(cards as u64).ok_or_else(|| error!(DuelError::Overflow))
}

/// Move lamports out of the room (owned by this program) to `to`.
fn pay(from: &AccountInfo, to: &AccountInfo, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? -= amount;
    **to.try_borrow_mut_lamports()? += amount;
    Ok(())
}

/// The newest entry of the SlotHashes sysvar: `u64 count`, then `(u64 slot, [u8; 32] hash)` newest first.
fn latest_slot_hash(account: &AccountInfo) -> Result<[u8; 32]> {
    let data = account.try_borrow_data()?;
    require!(data.len() >= 48, DuelError::SlotHashesEmpty);
    let count = u64::from_le_bytes(data[0..8].try_into().unwrap());
    require!(count > 0, DuelError::SlotHashesEmpty);
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&data[16..48]);
    Ok(hash)
}

/// Close sales: fix the hall's entropy as `sha256(player keys in roster order ‖ their card counts
/// ‖ newest slot hash)`. The roster is in the hash so that the same slot hash cannot serve a
/// hall whose seats were shuffled after the fact; the slot hash is what nobody chose.
fn lock(hall: &mut Account<Hall>, slot_hashes: &AccountInfo) -> Result<()> {
    let slot_hash = latest_slot_hash(slot_hashes)?;
    let seated = hall.player_count as usize;
    let entropy = {
        let mut parts: Vec<&[u8]> = Vec::with_capacity(seated + 2);
        for player in &hall.players[..seated] {
            parts.push(player.as_ref());
        }
        parts.push(&hall.cards[..seated]);
        parts.push(&slot_hash);
        hashv(&parts).to_bytes()
    };
    let locked_slot = Clock::get()?.slot;
    hall.entropy = entropy;
    hall.locked_slot = locked_slot;
    hall.state = HallState::Locked as u8;
    emit!(HallLocked { hall: hall.key(), entropy, locked_slot, player_count: hall.player_count, cards_sold: hall.cards_sold });
    Ok(())
}

/// The remaining accounts must be the hall's roster, in order, each writable (they are paid).
fn roster<'a, 'info>(hall: &Hall, accounts: &'a [AccountInfo<'info>]) -> Result<&'a [AccountInfo<'info>]> {
    let seated = hall.player_count as usize;
    require!(accounts.len() == seated, DuelError::RosterMismatch);
    for (account, expected) in accounts.iter().zip(hall.players.iter()) {
        require_keys_eq!(account.key(), *expected, DuelError::RosterMismatch);
        require!(account.is_writable, DuelError::RosterMismatch);
    }
    Ok(accounts)
}

/* ---------- State ---------- */

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RoomState {
    Open = 0,
    Ready = 1,
    /// Settled, timed out or cancelled with token credits outstanding; only `claim_credit` applies.
    Settled = 2,
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HallState {
    /// Selling: players join, the host may cancel.
    Open = 0,
    /// Entropy fixed, sales closed: waiting for the reveal (or the timeout).
    Locked = 1,
    /// Paid out as far as possible, token credits outstanding; only `claim_credit_hall` applies.
    Settled = 2,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
    pub bump: u8,
    /// May only set `paused = true` (`pause`); the admin does everything else.
    pub pauser: Pubkey,
    /// The Seeker Genesis Token group (metadata and group address); a mock group on devnet.
    pub sgt_group: Pubkey,
    /// Coins per shop pack.
    pub pack_coins: [u32; PACKS],
    /// Discount for a buyer that proves its Seeker Genesis Token, on top of the mint's.
    pub seeker_discount_bps: u16,
    /// Lamports per pack; 0 = not sold for SOL.
    pub sol_pack_prices: [u64; PACKS],
    /// The fee a SOL round pays once its host proved a Seeker Genesis Token.
    pub sol_seeker_fee_bps: u16,
}

/// What registration read from a mint's extensions, for the app and for audits.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace, Debug, PartialEq, Eq)]
pub struct MintFlags {
    pub has_freeze_authority: bool,
    pub permanent_delegate: bool,
    pub transfer_fee_config_present: bool,
    pub pausable: bool,
    pub default_state_frozen: bool,
    /// Always `None` once registered (a set hook is refused); kept for the record.
    pub hook_program: Option<Pubkey>,
}

/// A mint allowed for stakes and the shop. PDA `["mint", mint]`.
#[account]
#[derive(InitSpace)]
pub struct MintEntry {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub min_stake: u64,
    pub max_stake: u64,
    pub fee_bps: u16,
    /// The fee once the host proved a Seeker Genesis Token (≤ `fee_bps`).
    pub seeker_fee_bps: u16,
    pub enabled: bool,
    pub flags: MintFlags,
    /// The treasury's associated token account for the mint; fees and purchases land here.
    pub treasury_ata: Pubkey,
    /// Base units per shop pack; 0 = not sold in this mint.
    pub pack_prices: [u64; PACKS],
    /// The mint's own shop discount (SKR carries 2,000).
    pub discount_bps: u16,
    pub bump: u8,
}

/// A wallet's shop record. PDA `["buyer", wallet]`, created by the first purchase.
#[account]
#[derive(InitSpace)]
pub struct Buyer {
    pub wallet: Pubkey,
    pub coins_total: u64,
    pub purchases: u32,
    pub last_slot: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Room {
    pub host: Pubkey,
    pub guest: Pubkey,
    pub stake: u64,
    pub commitment: [u8; 32],
    pub code: [u8; 5],
    pub state: u8,
    pub created_slot: u64,
    pub joined_slot: u64,
    pub entropy: [u8; 32],
    pub bump: u8,
    /// Snapshot at open: the fee, the treasury, the mint (`Pubkey::default()` = SOL) and its program.
    pub fee_bps: u16,
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    /// The host proved a Seeker Genesis Token for this round.
    pub seeker: bool,
    /// Token payouts not yet delivered: host, guest.
    pub credits: [u64; 2],
    pub treasury_credit: u64,
}

impl Room {
    pub fn is_sol(&self) -> bool {
        self.mint == Pubkey::default()
    }

    fn open(&mut self, host: Pubkey, stake: u64, commitment: [u8; 32], code: [u8; 5], bump: u8, snapshot: Snapshot) -> Result<()> {
        self.host = host;
        self.guest = Pubkey::default();
        self.stake = stake;
        self.commitment = commitment;
        self.code = code;
        self.state = RoomState::Open as u8;
        self.created_slot = Clock::get()?.slot;
        self.joined_slot = 0;
        self.entropy = [0; 32];
        self.bump = bump;
        self.fee_bps = snapshot.fee_bps;
        self.treasury = snapshot.treasury;
        self.mint = snapshot.mint;
        self.token_program = snapshot.token_program;
        self.seeker = false;
        self.credits = [0; 2];
        self.treasury_credit = 0;
        Ok(())
    }
}

/// A multi-player Wave Rush escrow. PDA `["hall", host, code]`.
#[account]
#[derive(InitSpace)]
pub struct Hall {
    pub host: Pubkey,
    pub stake_per_card: u64,
    /// Seats, 2..=8; the join that fills the last one locks the hall.
    pub max_players: u8,
    pub commitment: [u8; 32],
    pub code: [u8; 5],
    /// `HallState`.
    pub state: u8,
    /// The roster in join order, the host first; `player_count` entries are in use.
    pub players: [Pubkey; bingo::MAX_PLAYERS],
    /// Cards each roster entry holds; card numbers are assigned in roster order.
    pub cards: [u8; bingo::MAX_PLAYERS],
    pub player_count: u8,
    pub cards_sold: u16,
    /// Client seed of the round (as lowercase hex), zero until locked.
    pub entropy: [u8; 32],
    pub locked_slot: u64,
    pub created_slot: u64,
    pub bump: u8,
    /// Snapshot at open: the fee, the treasury, the mint (`Pubkey::default()` = SOL) and its program.
    pub fee_bps: u16,
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    /// The host proved a Seeker Genesis Token for this round.
    pub seeker: bool,
    /// Token payouts not yet delivered, by roster position.
    pub credits: [u64; bingo::MAX_PLAYERS],
    pub treasury_credit: u64,
}

impl Hall {
    pub fn is_sol(&self) -> bool {
        self.mint == Pubkey::default()
    }

    #[allow(clippy::too_many_arguments)]
    fn open(&mut self, host: Pubkey, stake_per_card: u64, max_players: u8, cards: u8, commitment: [u8; 32], code: [u8; 5], bump: u8, snapshot: Snapshot) -> Result<()> {
        self.host = host;
        self.stake_per_card = stake_per_card;
        self.max_players = max_players;
        self.commitment = commitment;
        self.code = code;
        self.state = HallState::Open as u8;
        self.players = [Pubkey::default(); bingo::MAX_PLAYERS];
        self.players[0] = host;
        self.cards = [0; bingo::MAX_PLAYERS];
        self.cards[0] = cards;
        self.player_count = 1;
        self.cards_sold = cards as u16;
        self.entropy = [0; 32];
        self.locked_slot = 0;
        self.created_slot = Clock::get()?.slot;
        self.bump = bump;
        self.fee_bps = snapshot.fee_bps;
        self.treasury = snapshot.treasury;
        self.mint = snapshot.mint;
        self.token_program = snapshot.token_program;
        self.seeker = false;
        self.credits = [0; bingo::MAX_PLAYERS];
        self.treasury_credit = 0;
        Ok(())
    }

    /// May `player` buy `cards` now? One seat per wallet, host included.
    fn check_join(&self, player: Pubkey, cards: u8) -> Result<()> {
        require!(self.state == HallState::Open as u8, DuelError::HallNotOpen);
        require!(self.player_count < self.max_players, DuelError::HallFull);
        require!((1..=MAX_HALL_CARDS).contains(&cards), DuelError::CardsOutOfRange);
        require!(!self.players[..self.player_count as usize].contains(&player), DuelError::AlreadySeated);
        Ok(())
    }
}

/* ---------- Accounts ---------- */

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(init, payer = admin, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: any account may receive the fees.
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetConfig<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    /// CHECK: any account may receive the fees.
    pub treasury: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    /// CHECK: the first-deployment config, read and rewritten by hand (its layout predates this struct).
    #[account(mut, seeds = [b"config"], bump)]
    pub config: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// The pauser or the admin (checked in the handler).
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct TransferAdmin<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ DuelError::NotAdmin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    /// CHECK: the wallet that becomes admin; any address, including a multisig's vault PDA.
    pub new_admin: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RegisterMint<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = admin, space = 8 + MintEntry::INIT_SPACE, seeds = [b"mint", mint.key().as_ref()], bump)]
    pub mint_entry: Account<'info, MintEntry>,
    /// The treasury's associated token account for the mint, which must already exist.
    #[account(
        token::mint = mint,
        token::authority = config.treasury,
        token::token_program = token_program,
        address = get_associated_token_address_with_program_id(&config.treasury, &mint.key(), &token_program.key()) @ DuelError::BadTreasuryAccount,
    )]
    pub treasury_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetMint<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"mint", mint_entry.mint.as_ref()], bump = mint_entry.bump)]
    pub mint_entry: Account<'info, MintEntry>,
}

#[derive(Accounts)]
#[instruction(code: [u8; 5])]
pub struct OpenRoom<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = host, space = 8 + Room::INIT_SPACE, seeds = [b"room", host.key().as_ref(), &code], bump)]
    pub room: Account<'info, Room>,
    #[account(mut)]
    pub host: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinRoom<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"room", room.host.as_ref(), &room.code], bump = room.bump)]
    pub room: Account<'info, Room>,
    #[account(mut)]
    pub guest: Signer<'info>,
    /// CHECK: the SlotHashes sysvar, by address.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelRoom<'info> {
    #[account(
        mut,
        close = host,
        has_one = host,
        seeds = [b"room", room.host.as_ref(), &room.code],
        bump = room.bump,
        constraint = room.state == RoomState::Open as u8 @ DuelError::NotOpen,
    )]
    pub room: Account<'info, Room>,
    #[account(mut)]
    pub host: Signer<'info>,
}

/// Settlement and timeout: permissionless, the payer only pays the transaction fee. The treasury
/// is the one the room snapshotted when it opened, not the config's current one.
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, close = host, has_one = host, has_one = guest, has_one = treasury @ DuelError::TreasuryMismatch, seeds = [b"room", room.host.as_ref(), &room.code], bump = room.bump)]
    pub room: Account<'info, Room>,
    /// CHECK: matched to the room by has_one; paid, and receives the rent.
    #[account(mut)]
    pub host: UncheckedAccount<'info>,
    /// CHECK: matched to the room by has_one; paid.
    #[account(mut)]
    pub guest: UncheckedAccount<'info>,
    /// CHECK: matched to the room's snapshot by has_one; receives the fee.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub settler: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(code: [u8; 5])]
pub struct OpenRoomToken<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"mint", mint.key().as_ref()], bump = mint_entry.bump, has_one = mint, has_one = token_program)]
    pub mint_entry: Account<'info, MintEntry>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = host, space = 8 + Room::INIT_SPACE, seeds = [b"room", host.key().as_ref(), &code], bump)]
    pub room: Account<'info, Room>,
    /// CHECK: the room's associated token account for the mint; created here and checked by address.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = host, token::token_program = token_program)]
    pub host_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub host: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinRoomToken<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"mint", mint.key().as_ref()], bump = mint_entry.bump, has_one = mint)]
    pub mint_entry: Account<'info, MintEntry>,
    #[account(mut, seeds = [b"room", room.host.as_ref(), &room.code], bump = room.bump, has_one = mint @ DuelError::MintMismatch, has_one = token_program @ DuelError::BadTokenProgram)]
    pub room: Account<'info, Room>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = room, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = guest, token::token_program = token_program)]
    pub guest_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub guest: Signer<'info>,
    /// CHECK: the SlotHashes sysvar, by address.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelRoomToken<'info> {
    #[account(mut, has_one = host, seeds = [b"room", room.host.as_ref(), &room.code], bump = room.bump, has_one = mint @ DuelError::MintMismatch, has_one = token_program @ DuelError::BadTokenProgram)]
    pub room: Account<'info, Room>,
    #[account(mut)]
    pub host: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = room, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the host's token account for the mint, paid or credited (checked in `token::distribute`).
    #[account(mut)]
    pub host_ata: UncheckedAccount<'info>,
    /// CHECK: the treasury's associated token account, for any residue (checked in `token::distribute`).
    #[account(mut)]
    pub treasury_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Settlement and timeout of a token room: permissionless. The recipients are unchecked here on
/// purpose: a closed or frozen account must not fail the instruction, it is credited instead.
#[derive(Accounts)]
pub struct SettleToken<'info> {
    #[account(mut, has_one = host, seeds = [b"room", room.host.as_ref(), &room.code], bump = room.bump, has_one = mint @ DuelError::MintMismatch, has_one = token_program @ DuelError::BadTokenProgram)]
    pub room: Account<'info, Room>,
    /// CHECK: matched to the room by has_one; receives the rent when the room closes.
    #[account(mut)]
    pub host: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = room, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the host's token account (its ATA, or any it owns for the mint); paid or credited.
    #[account(mut)]
    pub host_ata: UncheckedAccount<'info>,
    /// CHECK: the guest's token account; paid or credited.
    #[account(mut)]
    pub guest_ata: UncheckedAccount<'info>,
    /// CHECK: the snapshotted treasury's associated token account; paid or credited.
    #[account(mut)]
    pub treasury_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub settler: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimCredit<'info> {
    #[account(mut, has_one = host, seeds = [b"room", room.host.as_ref(), &room.code], bump = room.bump, has_one = mint @ DuelError::MintMismatch, has_one = token_program @ DuelError::BadTokenProgram)]
    pub room: Account<'info, Room>,
    /// CHECK: matched to the room by has_one; receives the rent when the room closes.
    #[account(mut)]
    pub host: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = room, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: a token account of the creditor for the mint (checked in `token::pay_credit`).
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: the treasury's associated token account, for the final sweep.
    #[account(mut)]
    pub treasury_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: the Memo program, by address; used when the destination requires incoming memos.
    #[account(address = MEMO_ID)]
    pub memo_program: UncheckedAccount<'info>,
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProveSeekerRoom<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = host, seeds = [b"room", room.host.as_ref(), &room.code], bump = room.bump)]
    pub room: Account<'info, Room>,
    pub host: Signer<'info>,
    /// The room's mint entry (its Seeker fee tier); omitted (the program id in its place) for SOL.
    pub mint_entry: Option<Account<'info, MintEntry>>,
    /// CHECK: the host's Seeker Genesis Token account (checked in `token::verify_sgt`).
    pub sgt_token_account: UncheckedAccount<'info>,
    /// CHECK: its mint (checked in `token::verify_sgt`).
    pub sgt_mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(code: [u8; 5])]
pub struct OpenHall<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = host, space = 8 + Hall::INIT_SPACE, seeds = [b"hall", host.key().as_ref(), &code], bump)]
    pub hall: Account<'info, Hall>,
    #[account(mut)]
    pub host: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinHall<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"hall", hall.host.as_ref(), &hall.code], bump = hall.bump)]
    pub hall: Account<'info, Hall>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: the SlotHashes sysvar, by address; read when this join fills the hall.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct LockHall<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"hall", hall.host.as_ref(), &hall.code], bump = hall.bump)]
    pub hall: Account<'info, Hall>,
    /// A seated guest (checked in the handler against the roster).
    pub player: Signer<'info>,
    /// CHECK: the SlotHashes sysvar, by address.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
}

/// Remaining accounts: the roster in order, each writable.
#[derive(Accounts)]
pub struct CancelHall<'info> {
    #[account(
        mut,
        close = host,
        has_one = host,
        seeds = [b"hall", hall.host.as_ref(), &hall.code],
        bump = hall.bump,
        constraint = hall.state == HallState::Open as u8 @ DuelError::HallNotOpen,
    )]
    pub hall: Account<'info, Hall>,
    #[account(mut)]
    pub host: Signer<'info>,
}

/// Settlement and timeout of a hall: permissionless, the payer only pays the transaction fee.
/// Remaining accounts: the roster in order, each writable. The treasury is the hall's snapshot.
#[derive(Accounts)]
pub struct SettleHall<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, close = host, has_one = host, has_one = treasury @ DuelError::TreasuryMismatch, seeds = [b"hall", hall.host.as_ref(), &hall.code], bump = hall.bump)]
    pub hall: Account<'info, Hall>,
    /// CHECK: matched to the hall by has_one; receives the rent (and is paid as roster entry 0).
    #[account(mut)]
    pub host: UncheckedAccount<'info>,
    /// CHECK: matched to the hall's snapshot by has_one; receives the fee and the dust.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub settler: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(code: [u8; 5])]
pub struct OpenHallToken<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"mint", mint.key().as_ref()], bump = mint_entry.bump, has_one = mint, has_one = token_program)]
    pub mint_entry: Account<'info, MintEntry>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = host, space = 8 + Hall::INIT_SPACE, seeds = [b"hall", host.key().as_ref(), &code], bump)]
    pub hall: Box<Account<'info, Hall>>,
    /// CHECK: the hall's associated token account for the mint; created here and checked by address.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    #[account(mut, token::mint = mint, token::authority = host, token::token_program = token_program)]
    pub host_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub host: Signer<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinHallToken<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"mint", mint.key().as_ref()], bump = mint_entry.bump, has_one = mint)]
    pub mint_entry: Account<'info, MintEntry>,
    #[account(mut, seeds = [b"hall", hall.host.as_ref(), &hall.code], bump = hall.bump, has_one = mint @ DuelError::MintMismatch, has_one = token_program @ DuelError::BadTokenProgram)]
    pub hall: Box<Account<'info, Hall>>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = hall, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(mut, token::mint = mint, token::authority = player, token::token_program = token_program)]
    pub player_ata: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub player: Signer<'info>,
    /// CHECK: the SlotHashes sysvar, by address; read when this join fills the hall.
    #[account(address = SLOT_HASHES_ID)]
    pub slot_hashes: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Remaining accounts: one token account per roster entry, in order, writable, owned by that player.
#[derive(Accounts)]
pub struct CancelHallToken<'info> {
    #[account(mut, has_one = host, seeds = [b"hall", hall.host.as_ref(), &hall.code], bump = hall.bump, has_one = mint @ DuelError::MintMismatch, has_one = token_program @ DuelError::BadTokenProgram)]
    pub hall: Box<Account<'info, Hall>>,
    #[account(mut)]
    pub host: Signer<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = hall, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the treasury's associated token account, for any residue.
    #[account(mut)]
    pub treasury_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Settlement and timeout of a token hall: permissionless. Remaining accounts: one token account
/// per roster entry, in order, writable, owned by that player; paid or credited.
#[derive(Accounts)]
pub struct SettleHallToken<'info> {
    #[account(mut, has_one = host, seeds = [b"hall", hall.host.as_ref(), &hall.code], bump = hall.bump, has_one = mint @ DuelError::MintMismatch, has_one = token_program @ DuelError::BadTokenProgram)]
    pub hall: Box<Account<'info, Hall>>,
    /// CHECK: matched to the hall by has_one; receives the rent when the hall closes.
    #[account(mut)]
    pub host: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = hall, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: the snapshotted treasury's associated token account; paid or credited.
    #[account(mut)]
    pub treasury_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub settler: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimCreditHall<'info> {
    #[account(mut, has_one = host, seeds = [b"hall", hall.host.as_ref(), &hall.code], bump = hall.bump, has_one = mint @ DuelError::MintMismatch, has_one = token_program @ DuelError::BadTokenProgram)]
    pub hall: Box<Account<'info, Hall>>,
    /// CHECK: matched to the hall by has_one; receives the rent when the hall closes.
    #[account(mut)]
    pub host: UncheckedAccount<'info>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(mut, associated_token::mint = mint, associated_token::authority = hall, associated_token::token_program = token_program)]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: a token account of the creditor for the mint (checked in `token::pay_credit`).
    #[account(mut)]
    pub destination: UncheckedAccount<'info>,
    /// CHECK: the treasury's associated token account, for the final sweep.
    #[account(mut)]
    pub treasury_ata: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: the Memo program, by address.
    #[account(address = MEMO_ID)]
    pub memo_program: UncheckedAccount<'info>,
    pub payer: Signer<'info>,
}

#[derive(Accounts)]
pub struct ProveSeekerHall<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = host, seeds = [b"hall", hall.host.as_ref(), &hall.code], bump = hall.bump)]
    pub hall: Box<Account<'info, Hall>>,
    pub host: Signer<'info>,
    /// The hall's mint entry (its Seeker fee tier); omitted (the program id in its place) for SOL.
    pub mint_entry: Option<Account<'info, MintEntry>>,
    /// CHECK: the host's Seeker Genesis Token account (checked in `token::verify_sgt`).
    pub sgt_token_account: UncheckedAccount<'info>,
    /// CHECK: its mint (checked in `token::verify_sgt`).
    pub sgt_mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct BuyPack<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = treasury)]
    pub config: Account<'info, Config>,
    #[account(init_if_needed, payer = wallet, space = 8 + Buyer::INIT_SPACE, seeds = [b"buyer", wallet.key().as_ref()], bump)]
    pub buyer: Account<'info, Buyer>,
    #[account(mut)]
    pub wallet: Signer<'info>,
    /// CHECK: the config's treasury, by has_one.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// The buyer's Seeker Genesis Token account, with its mint, for the Seeker discount; both or neither.
    pub sgt_token_account: Option<InterfaceAccount<'info, TokenAccount>>,
    pub sgt_mint: Option<InterfaceAccount<'info, Mint>>,
}

#[derive(Accounts)]
pub struct BuyPackToken<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(seeds = [b"mint", mint.key().as_ref()], bump = mint_entry.bump, has_one = mint, has_one = token_program, has_one = treasury_ata)]
    pub mint_entry: Account<'info, MintEntry>,
    #[account(mint::token_program = token_program)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init_if_needed, payer = wallet, space = 8 + Buyer::INIT_SPACE, seeds = [b"buyer", wallet.key().as_ref()], bump)]
    pub buyer: Account<'info, Buyer>,
    #[account(mut)]
    pub wallet: Signer<'info>,
    #[account(mut, token::mint = mint, token::authority = wallet, token::token_program = token_program)]
    pub wallet_ata: InterfaceAccount<'info, TokenAccount>,
    /// The registered treasury account (by has_one on the entry).
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub treasury_ata: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// The buyer's Seeker Genesis Token account, with its mint, for the Seeker discount; both or neither.
    pub sgt_token_account: Option<InterfaceAccount<'info, TokenAccount>>,
    pub sgt_mint: Option<InterfaceAccount<'info, Mint>>,
}

/* ---------- Events ---------- */

#[event]
pub struct RoomOpened {
    pub room: Pubkey,
    pub host: Pubkey,
    pub code: [u8; 5],
    pub stake: u64,
    pub commitment: [u8; 32],
}

#[event]
pub struct RoomJoined {
    pub room: Pubkey,
    pub guest: Pubkey,
    pub entropy: [u8; 32],
    pub joined_slot: u64,
}

#[event]
pub struct RoomSettled {
    pub room: Pubkey,
    pub server_seed: [u8; 32],
    pub win_ball: u8,
    pub host_won: bool,
    pub guest_won: bool,
    pub pot: u64,
    pub fee: u64,
    /// `Pubkey::default()` for SOL.
    pub mint: Pubkey,
    /// The host proved a Seeker Genesis Token for this round.
    pub seeker: bool,
}

#[event]
pub struct RoomTimedOut {
    pub room: Pubkey,
    pub guest: Pubkey,
    pub pot: u64,
    pub fee: u64,
    pub mint: Pubkey,
}

#[event]
pub struct HallOpened {
    pub hall: Pubkey,
    pub host: Pubkey,
    pub code: [u8; 5],
    pub stake_per_card: u64,
    pub max_players: u8,
    pub cards: u8,
    pub commitment: [u8; 32],
}

#[event]
pub struct HallJoined {
    pub hall: Pubkey,
    pub player: Pubkey,
    pub cards: u8,
    pub player_count: u8,
    pub cards_sold: u16,
}

#[event]
pub struct HallLocked {
    pub hall: Pubkey,
    pub entropy: [u8; 32],
    pub locked_slot: u64,
    pub player_count: u8,
    pub cards_sold: u16,
}

#[event]
pub struct HallCancelled {
    pub hall: Pubkey,
    pub host: Pubkey,
    pub refunded: u64,
}

#[event]
pub struct HallSettled {
    pub hall: Pubkey,
    pub server_seed: [u8; 32],
    pub win_ball: u8,
    pub winning_cards: u16,
    /// Base units (lamports for SOL) paid per winning card.
    pub share: u64,
    pub pot: u64,
    pub fee: u64,
    pub mint: Pubkey,
    pub seeker: bool,
}

#[event]
pub struct HallTimedOut {
    pub hall: Pubkey,
    pub host: Pubkey,
    /// The guests' own deposits, returned.
    pub refunded: u64,
    /// The host's deposit, split among the guests.
    pub forfeited: u64,
    pub mint: Pubkey,
}

#[event]
pub struct MintRegistered {
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub fee_bps: u16,
    pub seeker_fee_bps: u16,
}

#[event]
pub struct MintUpdated {
    pub mint: Pubkey,
    pub fee_bps: u16,
    pub seeker_fee_bps: u16,
    pub enabled: bool,
}

#[event]
pub struct CreditClaimed {
    pub escrow: Pubkey,
    pub creditor: Pubkey,
    pub amount: u64,
}

#[event]
pub struct SeekerProven {
    pub escrow: Pubkey,
    pub host: Pubkey,
    pub fee_bps: u16,
}

#[event]
pub struct CoinsBought {
    pub wallet: Pubkey,
    /// `Pubkey::default()` for SOL.
    pub mint: Pubkey,
    pub pack: u8,
    pub coins: u32,
    pub paid: u64,
    pub discount_bps: u16,
    pub seeker: bool,
}

#[event]
pub struct Paused {
    pub by: Pubkey,
}

#[event]
pub struct AdminTransferred {
    pub from: Pubkey,
    pub to: Pubkey,
}

/* ---------- Errors ---------- */

#[error_code]
pub enum DuelError {
    #[msg("the escrow is paused")]
    Paused,
    #[msg("stake outside the allowed range")]
    StakeOutOfRange,
    #[msg("room code must use the game's alphabet")]
    BadCode,
    #[msg("the room is not open")]
    NotOpen,
    #[msg("the room is not ready to settle")]
    NotReady,
    #[msg("a wallet cannot play itself")]
    SameWallet,
    #[msg("the revealed seed does not match the commitment")]
    BadReveal,
    #[msg("the host still has time to reveal")]
    TooEarly,
    #[msg("fee above the maximum")]
    FeeTooHigh,
    #[msg("SlotHashes sysvar has no entries")]
    SlotHashesEmpty,
    // Hall errors follow the room's so that no existing code number moves.
    #[msg("the hall is not open")]
    HallNotOpen,
    #[msg("the hall is not locked")]
    HallNotLocked,
    #[msg("the hall is full")]
    HallFull,
    #[msg("a hall needs two players before it can lock")]
    TooFewPlayers,
    #[msg("this wallet already holds a seat in the hall")]
    AlreadySeated,
    #[msg("the host cannot lock the hall")]
    HostCannotLock,
    #[msg("only a seated guest may do this")]
    NotSeated,
    #[msg("the players passed do not match the hall's roster")]
    RosterMismatch,
    #[msg("cards per player must be 1 to 4")]
    CardsOutOfRange,
    #[msg("a hall seats 2 to 8 players")]
    PlayersOutOfRange,
    // Token, registry, shop and role errors follow, in the same spirit.
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("only the admin may do this")]
    NotAdmin,
    #[msg("only the pauser or the admin may pause")]
    NotPauser,
    #[msg("this is a SOL escrow; use the SOL instruction")]
    NotSolEscrow,
    #[msg("the treasury passed is not the one this round snapshotted")]
    TreasuryMismatch,
    #[msg("the mint is not the escrow's")]
    MintMismatch,
    #[msg("the token program is not the mint's")]
    BadTokenProgram,
    #[msg("the mint is disabled for new rounds")]
    MintDisabled,
    #[msg("a non-transferable mint cannot be staked")]
    MintNonTransferable,
    #[msg("a mint whose new accounts start frozen cannot be staked")]
    MintDefaultFrozen,
    #[msg("the mint charges a transfer fee")]
    MintHasTransferFee,
    #[msg("the mint has a transfer hook program")]
    MintHasTransferHook,
    #[msg("the mint is paused by its issuer")]
    MintPaused,
    #[msg("stake bounds invalid (1 <= min <= max <= u64::MAX / 32)")]
    StakeBoundsInvalid,
    #[msg("discount above the maximum")]
    DiscountTooHigh,
    #[msg("the vault is not the escrow's associated token account")]
    BadVault,
    #[msg("the treasury account passed is not the treasury's associated token account")]
    BadTreasuryAccount,
    #[msg("the vault still holds tokens")]
    VaultNotEmpty,
    #[msg("the escrow has no credits to claim")]
    NotSettled,
    #[msg("no such creditor")]
    BadCreditIndex,
    #[msg("nothing is owed to this creditor")]
    NothingToClaim,
    #[msg("the destination cannot receive this mint for this creditor")]
    NotPayable,
    #[msg("the Memo program account is wrong")]
    BadMemoProgram,
    #[msg("the Seeker Genesis Token group is not configured")]
    SeekerGroupUnset,
    #[msg("the accounts passed do not prove a Seeker Genesis Token")]
    NotSeeker,
    #[msg("no such pack")]
    BadPack,
    #[msg("this pack is not sold for this asset")]
    PackNotForSale,
    #[msg("the buyer record belongs to another wallet")]
    BuyerMismatch,
    #[msg("the config account is not a first-deployment config")]
    BadConfig,
    #[msg("the config already has the current layout")]
    AlreadyMigrated,
}
