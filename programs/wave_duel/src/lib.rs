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
//! equal share of the prize. A host who will not reveal refunds everyone after a timeout.
//!
//! Money: SOL only, held in the escrow account itself. A fee in basis points goes to the treasury
//! named in the config. Nothing here is a game of skill: it is a wager between people, so it
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
/// A host who does not reveal within this many slots after the guest joined (room) or the hall
/// locked (hall) has forfeited: the room's pot goes to the guest, the hall refunds everyone.
pub const TIMEOUT_SLOTS: u64 = 3_000; // about 20 minutes at 400 ms
pub const SLOT_HASHES_ID: Pubkey = pubkey!("SysvarS1otHashes111111111111111111111111111");
/// Seats in a hall: at least two players make a game; eight keeps settlement inside one
/// transaction's compute budget and account limit (the roster travels as remaining accounts).
pub const MIN_HALL_PLAYERS: u8 = 2;
pub const MAX_HALL_PLAYERS: u8 = bingo::MAX_PLAYERS as u8;
/// Cards per player in a hall: the engine's Wave Rush preset (`maxCardsPerPlayer: 4`).
pub const MAX_HALL_CARDS: u8 = bingo::MAX_CARDS_PER_PLAYER;

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

    /* ---------- Halls ---------- */

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
        require!(code.iter().all(|c| CODE_ALPHABET.contains(c)), DuelError::BadCode);
        require!((MIN_HALL_PLAYERS..=MAX_HALL_PLAYERS).contains(&max_players), DuelError::PlayersOutOfRange);
        require!((1..=MAX_HALL_CARDS).contains(&cards), DuelError::CardsOutOfRange);
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.host.to_account_info(), to: ctx.accounts.hall.to_account_info() },
            ),
            deposit(stake_per_card, cards),
        )?;
        let host = ctx.accounts.host.key();
        let hall = &mut ctx.accounts.hall;
        hall.host = host;
        hall.stake_per_card = stake_per_card;
        hall.max_players = max_players;
        hall.commitment = commitment;
        hall.code = code;
        hall.state = HallState::Open as u8;
        hall.players = [Pubkey::default(); bingo::MAX_PLAYERS];
        hall.players[0] = host;
        hall.cards = [0; bingo::MAX_PLAYERS];
        hall.cards[0] = cards;
        hall.player_count = 1;
        hall.cards_sold = cards as u16;
        hall.entropy = [0; 32];
        hall.locked_slot = 0;
        hall.created_slot = Clock::get()?.slot;
        hall.bump = ctx.bumps.hall;
        emit!(HallOpened { hall: hall.key(), host, code, stake_per_card, max_players, cards, commitment });
        Ok(())
    }

    /// Any other wallet buys cards while the hall is open: it is appended to the roster, so its
    /// cards are the next numbers. The join that fills the last seat also locks the hall.
    pub fn join_hall(ctx: Context<JoinHall>, cards: u8) -> Result<()> {
        require!(!ctx.accounts.config.paused, DuelError::Paused);
        require!(ctx.accounts.hall.state == HallState::Open as u8, DuelError::HallNotOpen);
        require!(ctx.accounts.hall.player_count < ctx.accounts.hall.max_players, DuelError::HallFull);
        require!((1..=MAX_HALL_CARDS).contains(&cards), DuelError::CardsOutOfRange);
        let player = ctx.accounts.player.key();
        let seated = ctx.accounts.hall.player_count as usize;
        // One seat per wallet, host included: a player's cards are one block of card numbers.
        require!(!ctx.accounts.hall.players[..seated].contains(&player), DuelError::AlreadySeated);
        transfer(
            CpiContext::new(
                ctx.accounts.system_program.key(),
                Transfer { from: ctx.accounts.player.to_account_info(), to: ctx.accounts.hall.to_account_info() },
            ),
            deposit(ctx.accounts.hall.stake_per_card, cards),
        )?;
        let hall = &mut ctx.accounts.hall;
        hall.players[seated] = player;
        hall.cards[seated] = cards;
        hall.player_count += 1;
        hall.cards_sold += cards as u16;
        emit!(HallJoined { hall: hall.key(), player, cards, player_count: hall.player_count, cards_sold: hall.cards_sold });
        if hall.player_count == hall.max_players {
            // The filling join is a guest's (the host cannot join its own hall), so the argument
            // on `lock_hall` for who may pick the locking slot holds here too.
            lock(&mut ctx.accounts.hall, &ctx.accounts.slot_hashes.to_account_info())?;
        }
        Ok(())
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
    /// by locking as soon as they are happy with the roster.)
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
        let players = roster(hall, ctx.remaining_accounts)?;
        let hall_info = ctx.accounts.hall.to_account_info();
        for (i, player) in players.iter().enumerate() {
            pay(&hall_info, player, deposit(hall.stake_per_card, hall.cards[i]))?;
        }
        let (pot, _, _) = split_hall(hall.stake_per_card, hall.cards_sold, 0);
        emit!(HallCancelled { hall: hall.key(), host: hall.host, refunded: pot });
        Ok(())
    }

    /// Anyone reveals the host's seed; the program replays the hall and pays every winning card
    /// an equal share of the prize, each player receiving the sum of its cards' shares. The
    /// roster travels as remaining accounts in order; the treasury takes the fee and the dust
    /// (prize mod winning cards); `close` returns the rent to the host.
    pub fn settle_hall(ctx: Context<SettleHall>, server_seed: [u8; 32]) -> Result<()> {
        let hall = &ctx.accounts.hall;
        require!(hall.state == HallState::Locked as u8, DuelError::HallNotLocked);
        require!(hashv(&[&server_seed]).to_bytes() == hall.commitment, DuelError::BadReveal);
        let players = roster(hall, ctx.remaining_accounts)?;
        let seated = hall.player_count as usize;
        let outcome = bingo::play_hall(&server_seed, &hall.entropy, &hall.cards[..seated]);
        let (pot, fee, prize) = split_hall(hall.stake_per_card, hall.cards_sold, ctx.accounts.config.fee_bps);
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
        });
        Ok(())
    }

    /// The host went quiet after the lock: every deposit goes back to its player, no fee.
    ///
    /// A refund rather than a forfeit, because a hall has no single counterparty to award the
    /// host's stake to and the guests lost nothing but time. The host has therefore no financial
    /// reason to reveal a round it lost; the app treats a timed-out hall as the host's failure
    /// (docs/FAIRNESS.md), and a forfeit split between the guests is the change to make if that
    /// proves too weak.
    pub fn claim_timeout_hall(ctx: Context<SettleHall>) -> Result<()> {
        let hall = &ctx.accounts.hall;
        require!(hall.state == HallState::Locked as u8, DuelError::HallNotLocked);
        require!(Clock::get()?.slot >= hall.locked_slot + TIMEOUT_SLOTS, DuelError::TooEarly);
        let players = roster(hall, ctx.remaining_accounts)?;
        let hall_info = ctx.accounts.hall.to_account_info();
        for (i, player) in players.iter().enumerate() {
            pay(&hall_info, player, deposit(hall.stake_per_card, hall.cards[i]))?;
        }
        let (pot, _, _) = split_hall(hall.stake_per_card, hall.cards_sold, 0);
        emit!(HallTimedOut { hall: hall.key(), host: hall.host, refunded: pot });
        Ok(())
    }
}

/// Pot, fee and prize for a room's stake.
fn split(stake: u64, fee_bps: u16) -> (u64, u64, u64) {
    let pot = stake.checked_mul(2).expect("stake bounded");
    let fee = ((pot as u128) * (fee_bps as u128) / 10_000) as u64;
    (pot, fee, pot - fee)
}

/// Pot, fee and prize for a hall: the pot is every card sold at the stake per card.
fn split_hall(stake_per_card: u64, cards_sold: u16, fee_bps: u16) -> (u64, u64, u64) {
    let pot = stake_per_card.checked_mul(cards_sold as u64).expect("stake and cards bounded");
    let fee = ((pot as u128) * (fee_bps as u128) / 10_000) as u64;
    (pot, fee, pot - fee)
}

/// What a player deposits for `cards` cards (both factors are bounded, so this cannot overflow).
fn deposit(stake_per_card: u64, cards: u8) -> u64 {
    stake_per_card * cards as u64
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

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum RoomState {
    Open = 0,
    Ready = 1,
}

#[repr(u8)]
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HallState {
    /// Selling: players join, the host may cancel.
    Open = 0,
    /// Entropy fixed, sales closed: waiting for the reveal (or the timeout).
    Locked = 1,
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
/// Remaining accounts: the roster in order, each writable.
#[derive(Accounts)]
pub struct SettleHall<'info> {
    #[account(seeds = [b"config"], bump = config.bump, has_one = treasury)]
    pub config: Account<'info, Config>,
    #[account(mut, close = host, has_one = host, seeds = [b"hall", hall.host.as_ref(), &hall.code], bump = hall.bump)]
    pub hall: Account<'info, Hall>,
    /// CHECK: matched to the hall by has_one; receives the rent (and is paid as roster entry 0).
    #[account(mut)]
    pub host: UncheckedAccount<'info>,
    /// CHECK: matched to the config by has_one; receives the fee and the dust.
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
    /// Lamports paid per winning card.
    pub share: u64,
    pub pot: u64,
    pub fee: u64,
}

#[event]
pub struct HallTimedOut {
    pub hall: Pubkey,
    pub host: Pubkey,
    pub refunded: u64,
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
}
