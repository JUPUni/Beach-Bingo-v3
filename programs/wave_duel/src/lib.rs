//! wave_duel: a trustless 1v1 Wave Rush escrow for Beach Bingo.
//!
//! The host opens a room with a stake and a commitment (SHA-256 of a secret seed). A guest
//! joins with the same stake; at that moment the program fixes the round's entropy from the
//! guest's key and the latest slot hash, which nobody knew when the host committed. Anyone may
//! then settle by revealing the seed: the program checks it against the commitment, replays the
//! 30-ball round exactly as the players' own screens did (`bingo.rs`), and pays the winner, the
//! pot split on a tie. A host who will not reveal loses the pot to the guest after a timeout.
//!
//! Money: SOL only, held in the room account itself. A fee in basis points goes to the treasury
//! named in the config. Nothing here is a game of skill: it is a wager between two people, so it
//! ships behind a flag until the operator's licensing allows it (docs/PRODUCTION.md).
#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;
use anchor_lang::system_program::{transfer, Transfer};

pub mod bingo;
pub mod fair;

declare_id!("6fvQTYJPaP6cTKxoF2Sp2zbKWRkhd2kwEMksnYEJnxaH");

/// The room-code alphabet the game uses (no 0/O, 1/I/L).
pub const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
pub const MIN_STAKE: u64 = 1_000_000; // 0.001 SOL
pub const MAX_STAKE: u64 = 100_000_000_000; // 100 SOL
pub const MAX_FEE_BPS: u16 = 1_000; // 10%
/// A host who does not reveal within this many slots after the guest joined forfeits the pot.
pub const TIMEOUT_SLOTS: u64 = 3_000; // about 20 minutes at 400 ms
pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");

#[program]
pub mod wave_duel {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, DuelError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = ctx.accounts.treasury.key();
        config.fee_bps = fee_bps;
        config.paused = false;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn set_config(ctx: Context<SetConfig>, fee_bps: u16, paused: bool) -> Result<()> {
        require!(fee_bps <= MAX_FEE_BPS, DuelError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.treasury = ctx.accounts.treasury.key();
        config.fee_bps = fee_bps;
        config.paused = paused;
        Ok(())
    }

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
        let room = &mut ctx.accounts.room;
        room.host = host;
        room.guest = Pubkey::default();
        room.stake = stake;
        room.commitment = commitment;
        room.code = code;
        room.state = RoomState::Open as u8;
        room.created_slot = Clock::get()?.slot;
        room.joined_slot = 0;
        room.entropy = [0; 32];
        room.bump = ctx.bumps.room;
        emit!(RoomOpened { room: room.key(), host, code, stake, commitment });
        Ok(())
    }

    /// The guest matches the stake; the round's entropy is fixed here, after the commitment.
    pub fn join_room(ctx: Context<JoinRoom>) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
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
        let slot_hash = latest_slot_hash(&ctx.accounts.slot_hashes.to_account_info())?;
        let guest = ctx.accounts.guest.key();
        let entropy = hashv(&[guest.as_ref(), &slot_hash]).to_bytes();
        let joined_slot = Clock::get()?.slot;
        let room = &mut ctx.accounts.room;
        room.guest = guest;
        room.joined_slot = joined_slot;
        room.entropy = entropy;
        room.state = RoomState::Ready as u8;
        emit!(RoomJoined { room: room.key(), guest, entropy, joined_slot });
        Ok(())
    }

    /// Before anyone joins, the host takes the stake back. `close` returns stake and rent together.
    pub fn cancel_room(_ctx: Context<CancelRoom>) -> Result<()> {
        Ok(())
    }

    /// Anyone reveals the host's seed; the program replays the round and pays.
    pub fn settle(ctx: Context<Settle>, server_seed: [u8; 32]) -> Result<()> {
        let room = &ctx.accounts.room;
        require!(room.state == RoomState::Ready as u8, DuelError::NotReady);
        require!(hashv(&[&server_seed]).to_bytes() == room.commitment, DuelError::BadReveal);
        let outcome = bingo::play(&server_seed, &room.entropy);
        let (pot, fee, prize) = split(room.stake, ctx.accounts.config.fee_bps);
        let (host_share, guest_share, dust) = match (outcome.host_won, outcome.guest_won) {
            (true, false) => (prize, 0, 0),
            (false, true) => (0, prize, 0),
            _ => (prize / 2, prize / 2, prize % 2),
        };
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
        });
        Ok(())
    }

    /// The host went quiet after the guest joined: the guest takes the pot.
    pub fn claim_timeout(ctx: Context<Settle>) -> Result<()> {
        let room = &ctx.accounts.room;
        require!(room.state == RoomState::Ready as u8, DuelError::NotReady);
        require!(Clock::get()?.slot >= room.joined_slot + TIMEOUT_SLOTS, DuelError::TooEarly);
        let (pot, fee, prize) = split(room.stake, ctx.accounts.config.fee_bps);
        let room_info = ctx.accounts.room.to_account_info();
        pay(&room_info, &ctx.accounts.guest.to_account_info(), prize)?;
        pay(&room_info, &ctx.accounts.treasury.to_account_info(), fee)?;
        emit!(RoomTimedOut { room: ctx.accounts.room.key(), guest: room.guest, pot, fee });
        Ok(())
    }
}

/// Pot, fee and prize for a room's stake.
fn split(stake: u64, fee_bps: u16) -> (u64, u64, u64) {
    let pot = stake.checked_mul(2).expect("stake bounded");
    let fee = ((pot as u128) * (fee_bps as u128) / 10_000) as u64;
    (pot, fee, pot - fee)
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

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RoomState {
    Open = 0,
    Ready = 1,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub paused: bool,
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
}

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

/// Settlement and timeout: permissionless, the payer only pays the transaction fee.
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = treasury)]
    pub config: Account<'info, Config>,
    #[account(mut, close = host, has_one = host, has_one = guest, seeds = [b"room", room.host.as_ref(), &room.code], bump = room.bump)]
    pub room: Account<'info, Room>,
    /// CHECK: matched to the room by has_one; paid, and receives the rent.
    #[account(mut)]
    pub host: UncheckedAccount<'info>,
    /// CHECK: matched to the room by has_one; paid.
    #[account(mut)]
    pub guest: UncheckedAccount<'info>,
    /// CHECK: matched to the config by has_one; receives the fee.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    pub settler: Signer<'info>,
}

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
}

#[event]
pub struct RoomTimedOut {
    pub room: Pubkey,
    pub guest: Pubkey,
    pub pot: u64,
    pub fee: u64,
}

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
}
