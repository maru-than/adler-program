use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct CancelUnboundGig<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CONTRACT_ESCROW_SEED, brand.key().as_ref(), &contract_id],
        bump = escrow.bump,
        has_one = brand,
        constraint = escrow.contract_id == contract_id @ EscrowError::ContractIdMismatch,
        close = brand,
    )]
    pub escrow: Account<'info, ContractEscrow>,

    #[account(mut)]
    pub brand: Signer<'info>,
}

pub fn handler(ctx: Context<CancelUnboundGig>, _contract_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);
    require!(
        ctx.accounts.escrow.state == State::Funded,
        EscrowError::WrongState
    );

    // `close = brand` returns the full balance (budget + fee + rent) to brand.
    // No `ContractRecord` written: cancellation produces no rating.
    Ok(())
}
