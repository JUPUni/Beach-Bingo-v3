//! The token side of the escrow: what the program reads from a mint before it trusts it, the test
//! a recipient's token account must pass to be paid, the transfers and the close signed by the
//! escrow PDA, and `distribute`, which pays a settlement from whatever the vault holds and credits
//! what it cannot pay. Everything here is shared by rooms and halls.
//!
//! Policy, from the security review (docs/plans/2026-10-05-tokens-design.md §4):
//! - A deposit (open, join, buy) refuses a mint whose transfer fee is non-zero (current or
//!   scheduled), whose transfer hook names a program, or which is paused. The extension *set* of a
//!   mint is fixed at its creation; only these values can move, so registration flags are stable.
//! - A payout re-checks only the pause (the fee, if an issuer ever set one, is withheld from the
//!   recipient, not the vault; a hook makes the transfer CPI fail cleanly, and the round can be
//!   retried once the client passes the hook's accounts, which this version does not do).
//! - A recipient is paid when its account is a token account of the right mint, owned by the right
//!   wallet, Initialized (not frozen) and not requiring incoming memos. CPI Guard does not restrict
//!   receiving, so a guarded account is paid. Anything else is credited inside the escrow and
//!   claimed later with a fresh account (`claim_credit`).
//! - A vault holding less than the expected pot (a permanent delegate moved funds) pays pro rata;
//!   a vault holding more (a donation) sends the surplus to the treasury.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token_2022_extensions::transfer_fee::{harvest_withheld_tokens_to_mint, HarvestWithheldTokensToMint};
use anchor_spl::token_interface::{close_account, transfer_checked, CloseAccount, TransferChecked};
use spl_token_2022_interface::extension::default_account_state::DefaultAccountState;
use spl_token_2022_interface::extension::memo_transfer::MemoTransfer;
use spl_token_2022_interface::extension::metadata_pointer::MetadataPointer;
use spl_token_2022_interface::extension::non_transferable::NonTransferable;
use spl_token_2022_interface::extension::pausable::PausableConfig;
use spl_token_2022_interface::extension::permanent_delegate::PermanentDelegate;
use spl_token_2022_interface::extension::transfer_fee::{TransferFeeAmount, TransferFeeConfig};
use spl_token_2022_interface::extension::transfer_hook::TransferHook;
use spl_token_2022_interface::extension::{BaseStateWithExtensions, StateWithExtensions};
use spl_token_2022_interface::state::{Account as TokenState, AccountState, Mint as MintState};
use spl_token_group_interface::state::TokenGroupMember;

use crate::{DuelError, MintFlags, MEMO_ID};

/// What `register_mint` records and what every deposit re-checks.
pub struct MintFacts {
    pub flags: MintFlags,
    pub decimals: u8,
    /// The fee in force and the scheduled one (`older` / `newer` in the extension).
    pub fee_bps_now: u16,
    pub fee_bps_next: u16,
    pub paused: bool,
    pub non_transferable: bool,
}

/// Read a mint's base state and the extensions the escrow cares about. Works for a legacy SPL
/// Token mint (82 bytes, no TLV) and for Token-2022.
pub fn inspect_mint(info: &AccountInfo) -> Result<MintFacts> {
    let data = info.try_borrow_data()?;
    let mint = StateWithExtensions::<MintState>::unpack(&data)?;
    let mut facts = MintFacts {
        flags: MintFlags { has_freeze_authority: mint.base.freeze_authority.is_some(), ..Default::default() },
        decimals: mint.base.decimals,
        fee_bps_now: 0,
        fee_bps_next: 0,
        paused: false,
        non_transferable: false,
    };
    if let Ok(fee) = mint.get_extension::<TransferFeeConfig>() {
        facts.flags.transfer_fee_config_present = true;
        facts.fee_bps_now = u16::from(fee.older_transfer_fee.transfer_fee_basis_points);
        facts.fee_bps_next = u16::from(fee.newer_transfer_fee.transfer_fee_basis_points);
    }
    if let Ok(hook) = mint.get_extension::<TransferHook>() {
        facts.flags.hook_program = Option::<Pubkey>::from(hook.program_id);
    }
    if let Ok(pausable) = mint.get_extension::<PausableConfig>() {
        facts.flags.pausable = true;
        facts.paused = bool::from(pausable.paused);
    }
    if let Ok(state) = mint.get_extension::<DefaultAccountState>() {
        facts.flags.default_state_frozen = state.state == AccountState::Frozen as u8;
    }
    if let Ok(delegate) = mint.get_extension::<PermanentDelegate>() {
        facts.flags.permanent_delegate = Option::<Pubkey>::from(delegate.delegate).is_some();
    }
    if mint.get_extension::<NonTransferable>().is_ok() {
        facts.non_transferable = true;
    }
    Ok(facts)
}

/// A deposit or a purchase: the mint must still be what registration accepted.
pub fn require_mint_live(info: &AccountInfo) -> Result<()> {
    let facts = inspect_mint(info)?;
    require!(facts.fee_bps_now == 0 && facts.fee_bps_next == 0, DuelError::MintHasTransferFee);
    require!(facts.flags.hook_program.is_none(), DuelError::MintHasTransferHook);
    require!(!facts.paused, DuelError::MintPaused);
    Ok(())
}

/// A payout: a paused mint fails here, before any transfer, with a clear error.
pub fn require_mint_not_paused(info: &AccountInfo) -> Result<()> {
    let data = info.try_borrow_data()?;
    let mint = StateWithExtensions::<MintState>::unpack(&data)?;
    if let Ok(pausable) = mint.get_extension::<PausableConfig>() {
        require!(!bool::from(pausable.paused), DuelError::MintPaused);
    }
    Ok(())
}

/// Solana Mobile's Seeker Genesis Token check, on chain: a Token-2022 account of `holder` with a
/// balance, whose mint's MetadataPointer and TokenGroupMember both name the configured group.
pub fn verify_sgt(group: &Pubkey, token_account: &AccountInfo, mint: &AccountInfo, holder: &Pubkey) -> Result<()> {
    require!(*group != Pubkey::default(), DuelError::SeekerGroupUnset);
    require_keys_eq!(*mint.owner, spl_token_2022_interface::ID, DuelError::NotSeeker);
    require_keys_eq!(*token_account.owner, spl_token_2022_interface::ID, DuelError::NotSeeker);
    {
        let data = token_account.try_borrow_data()?;
        let account = StateWithExtensions::<TokenState>::unpack(&data)?;
        require_keys_eq!(account.base.owner, *holder, DuelError::NotSeeker);
        require_keys_eq!(account.base.mint, *mint.key, DuelError::NotSeeker);
        require!(account.base.amount >= 1, DuelError::NotSeeker);
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<MintState>::unpack(&data)?;
    let pointer = state.get_extension::<MetadataPointer>().map_err(|_| error!(DuelError::NotSeeker))?;
    require!(Option::<Pubkey>::from(pointer.metadata_address) == Some(*group), DuelError::NotSeeker);
    let member = state.get_extension::<TokenGroupMember>().map_err(|_| error!(DuelError::NotSeeker))?;
    require!(member.group.as_ref() == group.as_ref(), DuelError::NotSeeker);
    Ok(())
}

/// Can `account` receive a payout right now? See the module notes for the rule.
pub fn payable(account: &AccountInfo, token_program: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> bool {
    if account.owner != token_program {
        return false;
    }
    let data = match account.try_borrow_data() {
        Ok(data) => data,
        Err(_) => return false,
    };
    let state = match StateWithExtensions::<TokenState>::unpack(&data) {
        Ok(state) => state,
        Err(_) => return false,
    };
    if state.base.mint != *mint || state.base.owner != *owner || state.base.state != AccountState::Initialized {
        return false;
    }
    if let Ok(memo) = state.get_extension::<MemoTransfer>() {
        if bool::from(memo.require_incoming_transfer_memos) {
            return false;
        }
    }
    true
}

/// Whether a (payable) account requires a memo before an incoming transfer.
pub fn requires_memo(account: &AccountInfo) -> bool {
    let data = match account.try_borrow_data() {
        Ok(data) => data,
        Err(_) => return false,
    };
    match StateWithExtensions::<TokenState>::unpack(&data) {
        Ok(state) => state.get_extension::<MemoTransfer>().map(|m| bool::from(m.require_incoming_transfer_memos)).unwrap_or(false),
        Err(_) => false,
    }
}

/// A token account's balance and, for Token-2022, its withheld transfer fees.
pub fn balances(account: &AccountInfo) -> Result<(u64, u64)> {
    let data = account.try_borrow_data()?;
    let state = StateWithExtensions::<TokenState>::unpack(&data)?;
    let withheld = state.get_extension::<TransferFeeAmount>().map(|w| u64::from(w.withheld_amount)).unwrap_or(0);
    Ok((state.base.amount, withheld))
}

/// A memo right before a transfer, for recipients that require one. The Memo program checks that
/// every account it is given signed, so it is given none.
pub fn memo(memo_program: &AccountInfo) -> Result<()> {
    require_keys_eq!(*memo_program.key, MEMO_ID, DuelError::BadMemoProgram);
    let ix = Instruction { program_id: MEMO_ID, accounts: vec![], data: b"beach bingo: wave_duel credit".to_vec() };
    invoke(&ix, &[memo_program.clone()]).map_err(Into::into)
}

/// The escrow's vault and what signs for it.
pub struct Vault<'a, 'info> {
    pub token_program: AccountInfo<'info>,
    pub mint: AccountInfo<'info>,
    pub vault: AccountInfo<'info>,
    /// The Room or Hall PDA.
    pub authority: AccountInfo<'info>,
    pub seeds: &'a [&'a [u8]],
    pub decimals: u8,
}

impl<'a, 'info> Vault<'a, 'info> {
    pub fn amount(&self) -> Result<u64> {
        Ok(balances(&self.vault)?.0)
    }

    /// `transfer_checked` out of the vault, the PDA signing.
    pub fn pay(&self, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        transfer_checked(
            CpiContext::new_with_signer(
                *self.token_program.key,
                TransferChecked { from: self.vault.clone(), mint: self.mint.clone(), to: to.clone(), authority: self.authority.clone() },
                &[self.seeds],
            ),
            amount,
            self.decimals,
        )
    }

    /// Close the empty vault to `destination` (the host, who paid its rent). Withheld fees, which
    /// the deposit checks should make impossible, are harvested to the mint first because
    /// Token-2022 refuses to close an account that holds any.
    pub fn close(&self, destination: &AccountInfo<'info>) -> Result<()> {
        let (amount, withheld) = balances(&self.vault)?;
        require!(amount == 0, DuelError::VaultNotEmpty);
        if withheld > 0 {
            harvest_withheld_tokens_to_mint(
                CpiContext::new(*self.token_program.key, HarvestWithheldTokensToMint { token_program_id: self.token_program.clone(), mint: self.mint.clone() }),
                vec![self.vault.clone()],
            )?;
        }
        close_account(CpiContext::new_with_signer(
            *self.token_program.key,
            CloseAccount { account: self.vault.clone(), destination: destination.clone(), authority: self.authority.clone() },
            &[self.seeds],
        ))
    }
}

/// One payout: the account offered for it, the wallet it must belong to, the nominal amount.
pub struct Payee<'a, 'info> {
    pub account: &'a AccountInfo<'info>,
    pub owner: Pubkey,
    pub amount: u64,
}

/// `amount × available / expected`, the pro-rata share when the vault is short.
fn scaled(amount: u64, available: u64, expected: u64) -> u64 {
    ((amount as u128) * (available as u128) / (expected as u128)) as u64
}

/// Pay a settlement from what the vault holds. The nominal amounts of `payees` and `treasury`
/// sum to `expected`; below it every payout is scaled pro rata and the treasury absorbs the
/// rounding, above it the treasury takes the surplus. A payee whose account passes `payable` is
/// paid; one whose account is its associated token account but cannot be paid is credited in
/// `credits[i]` (the account must be the ATA, so a settler cannot force a credit on a player by
/// passing a stranger's account); anything else is a roster mismatch and the instruction fails,
/// which only costs the settler a retry.
pub fn distribute<'a, 'info>(
    vault: &Vault<'a, 'info>,
    expected: u64,
    payees: &[Payee<'a, 'info>],
    credits: &mut [u64],
    treasury: &Payee<'a, 'info>,
    treasury_credit: &mut u64,
) -> Result<()> {
    require!(payees.len() <= credits.len(), DuelError::RosterMismatch);
    let token_program = vault.token_program.key;
    let mint = vault.mint.key;
    let available = vault.amount()?;
    let short = available < expected;
    let mut paid_or_credited: u64 = 0;
    for (i, payee) in payees.iter().enumerate() {
        let amount = if short { scaled(payee.amount, available, expected) } else { payee.amount };
        paid_or_credited = paid_or_credited.checked_add(amount).ok_or(DuelError::Overflow)?;
        if payee.owner == Pubkey::default() {
            // No such player (a room cancelled before its guest joined): nothing to check or pay.
            require!(amount == 0, DuelError::RosterMismatch);
            continue;
        }
        // Every seat's account is checked, paid or not, so the roster convention holds throughout.
        require!(payee.account.is_writable, DuelError::RosterMismatch);
        if payable(payee.account, token_program, mint, &payee.owner) {
            vault.pay(payee.account, amount)?;
        } else {
            let ata = get_associated_token_address_with_program_id(&payee.owner, mint, token_program);
            require_keys_eq!(*payee.account.key, ata, DuelError::RosterMismatch);
            if amount > 0 {
                credits[i] = credits[i].checked_add(amount).ok_or(DuelError::Overflow)?;
            }
        }
    }
    // The treasury takes the rest: its fee and the dust, a surplus, or the pro-rata remainder.
    let to_treasury = available.checked_sub(paid_or_credited).ok_or(DuelError::Overflow)?;
    if to_treasury > 0 {
        require!(treasury.account.is_writable, DuelError::BadTreasuryAccount);
        if payable(treasury.account, token_program, mint, &treasury.owner) {
            vault.pay(treasury.account, to_treasury)?;
        } else {
            let ata = get_associated_token_address_with_program_id(&treasury.owner, mint, token_program);
            require_keys_eq!(*treasury.account.key, ata, DuelError::BadTreasuryAccount);
            *treasury_credit = treasury_credit.checked_add(to_treasury).ok_or(DuelError::Overflow)?;
        }
    }
    Ok(())
}

/// A credit is paid to any token account of the creditor for the escrow's mint that is
/// Initialized; a memo is sent first when the account requires one.
pub fn pay_credit<'a, 'info>(vault: &Vault<'a, 'info>, destination: &AccountInfo<'info>, owner: &Pubkey, amount: u64, memo_program: &AccountInfo<'info>) -> Result<u64> {
    let token_program = vault.token_program.key;
    let mint = vault.mint.key;
    require!(destination.is_writable, DuelError::NotPayable);
    let accepts = payable(destination, token_program, mint, owner) || {
        // The same test minus the memo rule: a memo is sent below.
        destination.owner == token_program && {
            let data = destination.try_borrow_data()?;
            match StateWithExtensions::<TokenState>::unpack(&data) {
                Ok(state) => state.base.mint == *mint && state.base.owner == *owner && state.base.state == AccountState::Initialized,
                Err(_) => false,
            }
        }
    };
    require!(accepts, DuelError::NotPayable);
    let paying = amount.min(vault.amount()?);
    if paying == 0 {
        return Ok(0);
    }
    if requires_memo(destination) {
        memo(memo_program)?;
    }
    vault.pay(destination, paying)?;
    Ok(paying)
}
