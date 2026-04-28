use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::{EscrowAccount, EscrowState, ESCROW_SEED};

/// Either party flips Funded → Disputed. Funds stay locked; only `arbitrate`
/// can release them after this point.
#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct OpenDispute<'info> {
    /// Either the brand or the creator. Verified in the handler.
    pub party: Signer<'info>,

    /// CHECK: validated by `escrow.brand` — needed for the seed lookup.
    pub brand: UncheckedAccount<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, brand.key().as_ref(), contract_id.as_ref()],
        bump = escrow.bump,
        constraint = escrow.brand == brand.key() @ EscrowError::BrandMismatch,
        constraint = escrow.state == EscrowState::Funded as u8 @ EscrowError::NotFunded,
    )]
    pub escrow: Account<'info, EscrowAccount>,
}

pub fn handler(ctx: Context<OpenDispute>, _contract_id: [u8; 32]) -> Result<()> {
    let escrow = &mut ctx.accounts.escrow;
    let signer = ctx.accounts.party.key();
    require!(
        signer == escrow.brand || signer == escrow.creator,
        EscrowError::BrandMismatch
    );
    escrow.state = EscrowState::Disputed as u8;
    Ok(())
}
