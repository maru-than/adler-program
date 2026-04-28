use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::{EscrowAccount, EscrowState, ESCROW_SEED};

/// Permissionless auto-release. Same effect as `approve_release` — splits
/// price → creator, fee → fee_treasury — but callable by ANYONE once
/// `now >= approval_deadline`. Whoever calls pays gas; the brand still gets
/// rent back via `close = brand`.
///
/// In production this is invoked by a Supabase Edge Function on a 10-min cron
/// (see adler-website/supabase/functions/auto-release/) using a hot wallet
/// loaded with a few SOL just for gas.
#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct AutoRelease<'info> {
    /// Whoever pays the gas. Doesn't have to be brand or creator.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// CHECK: validated by `escrow.brand` — needed to receive the rent refund.
    #[account(mut, address = escrow.brand @ EscrowError::BrandMismatch)]
    pub brand: UncheckedAccount<'info>,

    /// CHECK: validated by `escrow.creator`.
    #[account(mut, address = escrow.creator @ EscrowError::CreatorMismatch)]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: validated by `escrow.fee_treasury`.
    #[account(mut, address = escrow.fee_treasury @ EscrowError::FeeTreasuryMismatch)]
    pub fee_treasury: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, brand.key().as_ref(), contract_id.as_ref()],
        bump = escrow.bump,
        constraint = escrow.state == EscrowState::Funded as u8 @ EscrowError::NotFunded,
        close = brand,
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

pub fn handler(ctx: Context<AutoRelease>, _contract_id: [u8; 32]) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= escrow.approval_deadline, EscrowError::DeadlineNotReached);

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
