use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::{EscrowAccount, EscrowState, ESCROW_SEED};

/// Brand reclaims escrow if the creator missed delivery + grace.
/// `now >= refund_after` (= approval_deadline + REFUND_GRACE_SECONDS).
/// Returns price + fee + rent to brand. The fee_treasury gets nothing because
/// no service was rendered.
#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct BrandRefund<'info> {
    #[account(mut)]
    pub brand: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, brand.key().as_ref(), contract_id.as_ref()],
        bump = escrow.bump,
        constraint = escrow.brand == brand.key() @ EscrowError::BrandMismatch,
        constraint = escrow.state == EscrowState::Funded as u8 @ EscrowError::NotFunded,
        close = brand,
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

pub fn handler(ctx: Context<BrandRefund>, _contract_id: [u8; 32]) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let now = Clock::get()?.unix_timestamp;
    require!(now >= escrow.refund_after, EscrowError::RefundGraceActive);

    // No explicit lamport moves — `close = brand` returns ALL of the PDA's
    // lamports (price + fee + rent) to the brand. State flag is for future
    // observability only since the account closes immediately.
    escrow.state = EscrowState::Refunded as u8;
    Ok(())
}
