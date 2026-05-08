use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct SubmitDelivery<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CONTRACT_ESCROW_SEED, escrow.brand.as_ref(), &contract_id],
        bump = escrow.bump,
        has_one = creator,
        constraint = escrow.contract_id == contract_id @ EscrowError::ContractIdMismatch,
    )]
    pub escrow: Account<'info, ContractEscrow>,

    pub creator: Signer<'info>,
}

pub fn handler(ctx: Context<SubmitDelivery>, _contract_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);

    let approval_window = ctx.accounts.config.approval_window_secs;
    let escrow = &mut ctx.accounts.escrow;
    require!(escrow.state == State::Bound, EscrowError::WrongState);

    let now = Clock::get()?.unix_timestamp;
    escrow.state = State::Delivered;
    escrow.delivered_at = Some(now);
    escrow.approval_deadline = now
        .checked_add(approval_window)
        .ok_or(EscrowError::Overflow)?;

    Ok(())
}
