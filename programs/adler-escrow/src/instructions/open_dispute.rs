use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct OpenDispute<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CONTRACT_ESCROW_SEED, escrow.brand.as_ref(), &contract_id],
        bump = escrow.bump,
        constraint = escrow.contract_id == contract_id @ EscrowError::ContractIdMismatch,
    )]
    pub escrow: Account<'info, ContractEscrow>,

    #[account(
        mut,
        seeds = [ARBITRATION_POOL_SEED],
        bump = pool.bump,
    )]
    pub pool: Account<'info, ArbitrationPool>,

    pub signer: Signer<'info>,
}

pub fn handler(ctx: Context<OpenDispute>, _contract_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);

    let signer_key = ctx.accounts.signer.key();
    let escrow = &mut ctx.accounts.escrow;

    require!(
        signer_key == escrow.brand || signer_key == escrow.creator,
        EscrowError::NotAParty
    );
    require!(
        escrow.state == State::Bound || escrow.state == State::Delivered,
        EscrowError::WrongState
    );

    let now = Clock::get()?.unix_timestamp;
    escrow.state = State::Disputed;
    escrow.dispute_filer = signer_key;
    escrow.dispute_opened_at = now;

    let pool = &mut ctx.accounts.pool;
    pool.disputed_count = pool
        .disputed_count
        .checked_add(1)
        .ok_or(EscrowError::Overflow)?;

    Ok(())
}
