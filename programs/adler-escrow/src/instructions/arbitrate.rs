use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::{
    ArbitrationOutcome, EscrowAccount, EscrowState, ESCROW_SEED,
};

/// Adler-controlled `arbitration_authority` resolves a Disputed contract.
/// Only callable when state == Disputed. Cannot touch non-disputed PDAs.
/// The authority pubkey is whatever was set on the PDA at fund time
/// (NOT a global program constant) — different product lines could route
/// to different arbitrators.
#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct Arbitrate<'info> {
    /// Must match escrow.arbitration_authority — checked below.
    pub arbitrator: Signer<'info>,

    /// CHECK: validated by `escrow.brand`. Receives rent + (refund/split share).
    #[account(mut, address = escrow.brand @ EscrowError::BrandMismatch)]
    pub brand: UncheckedAccount<'info>,

    /// CHECK: validated by `escrow.creator`. Receives release/split share.
    #[account(mut, address = escrow.creator @ EscrowError::CreatorMismatch)]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: validated by `escrow.fee_treasury`. Receives the fee on Release/Split.
    #[account(mut, address = escrow.fee_treasury @ EscrowError::FeeTreasuryMismatch)]
    pub fee_treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, brand.key().as_ref(), contract_id.as_ref()],
        bump = escrow.bump,
        constraint = escrow.state == EscrowState::Disputed as u8 @ EscrowError::NotDisputed,
        constraint = escrow.arbitration_authority == arbitrator.key() @ EscrowError::ArbitratorMismatch,
        close = brand,
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

pub fn handler(
    ctx: Context<Arbitrate>,
    _contract_id: [u8; 32],
    outcome: ArbitrationOutcome,
) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let escrow_ai = escrow.to_account_info();
    let creator_ai = ctx.accounts.creator.to_account_info();
    let fee_ai = ctx.accounts.fee_treasury.to_account_info();

    match outcome {
        ArbitrationOutcome::Release => {
            // Same payout as approve_release.
            move_lamports(&escrow_ai, &creator_ai, escrow.price_lamports)?;
            if escrow.fee_lamports > 0 {
                move_lamports(&escrow_ai, &fee_ai, escrow.fee_lamports)?;
            }
            escrow.state = EscrowState::Settled as u8;
        }
        ArbitrationOutcome::Refund => {
            // Same payout as brand_refund — close = brand returns everything.
            escrow.state = EscrowState::Refunded as u8;
        }
        ArbitrationOutcome::Split { num, denom } => {
            require!(
                denom > 0 && num <= denom,
                EscrowError::InvalidSplit
            );
            // creator_share = price * num / denom (checked math).
            let creator_share = (escrow.price_lamports as u128)
                .checked_mul(num as u128)
                .ok_or(EscrowError::Overflow)?
                .checked_div(denom as u128)
                .ok_or(EscrowError::Overflow)?;
            let creator_share: u64 = creator_share
                .try_into()
                .map_err(|_| error!(EscrowError::Overflow))?;
            // brand_share is whatever's left of price (close = brand handles this implicitly).
            move_lamports(&escrow_ai, &creator_ai, creator_share)?;
            // Fee always goes to treasury on Split — the marketplace did the work
            // of routing the contract regardless of the outcome.
            if escrow.fee_lamports > 0 {
                move_lamports(&escrow_ai, &fee_ai, escrow.fee_lamports)?;
            }
            escrow.state = EscrowState::Settled as u8;
        }
    }
    Ok(())
}

fn move_lamports<'info>(
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    **from.try_borrow_mut_lamports()? = from
        .lamports()
        .checked_sub(amount)
        .ok_or(EscrowError::Overflow)?;
    **to.try_borrow_mut_lamports()? = to
        .lamports()
        .checked_add(amount)
        .ok_or(EscrowError::Overflow)?;
    Ok(())
}
