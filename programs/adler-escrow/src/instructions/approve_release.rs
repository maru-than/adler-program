use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::{EscrowAccount, EscrowState, ESCROW_SEED};

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct ApproveRelease<'info> {
    #[account(mut)]
    pub brand: Signer<'info>,

    /// CHECK: validated by `escrow.creator` constraint below.
    #[account(mut, address = escrow.creator @ EscrowError::CreatorMismatch)]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: validated by `escrow.fee_treasury` constraint below.
    #[account(mut, address = escrow.fee_treasury @ EscrowError::FeeTreasuryMismatch)]
    pub fee_treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, brand.key().as_ref(), contract_id.as_ref()],
        bump = escrow.bump,
        constraint = escrow.brand == brand.key() @ EscrowError::BrandMismatch,
        constraint = escrow.state == EscrowState::Funded as u8 @ EscrowError::NotFunded,
        // close = brand returns the rent-exempt lamports to the brand AFTER the
        // ix body runs; we move price+fee out manually below first.
        close = brand,
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

pub fn handler(ctx: Context<ApproveRelease>, _contract_id: [u8; 32]) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;

    // Atomic split: PDA → creator (price), PDA → fee_treasury (fee).
    // PDA balance after this MUST still be ≥ rent-exempt — we leave that for
    // the close handler to refund to the brand.
    let escrow_ai = escrow.to_account_info();
    let creator_ai = ctx.accounts.creator.to_account_info();
    let fee_ai = ctx.accounts.fee_treasury.to_account_info();

    **escrow_ai.try_borrow_mut_lamports()? = escrow_ai
        .lamports()
        .checked_sub(escrow.price_lamports)
        .ok_or(EscrowError::Overflow)?;
    **creator_ai.try_borrow_mut_lamports()? = creator_ai
        .lamports()
        .checked_add(escrow.price_lamports)
        .ok_or(EscrowError::Overflow)?;

    if escrow.fee_lamports > 0 {
        **escrow_ai.try_borrow_mut_lamports()? = escrow_ai
            .lamports()
            .checked_sub(escrow.fee_lamports)
            .ok_or(EscrowError::Overflow)?;
        **fee_ai.try_borrow_mut_lamports()? = fee_ai
            .lamports()
            .checked_add(escrow.fee_lamports)
            .ok_or(EscrowError::Overflow)?;
    }

    escrow.state = EscrowState::Settled as u8;

    Ok(())
}
