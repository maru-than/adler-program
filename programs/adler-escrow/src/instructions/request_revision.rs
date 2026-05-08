use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

/// Cap on consecutive revisions per contract. Whitepaper §6.
pub const REVISION_CAP: u8 = 2;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct RequestRevision<'info> {
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
    )]
    pub escrow: Account<'info, ContractEscrow>,

    pub brand: Signer<'info>,
}

pub fn handler(ctx: Context<RequestRevision>, _contract_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);

    let escrow = &mut ctx.accounts.escrow;
    require!(escrow.state == State::Delivered, EscrowError::WrongState);
    require!(
        escrow.revisions_used < REVISION_CAP,
        EscrowError::RevisionCapReached
    );

    escrow.state = State::Bound;
    escrow.revisions_used = escrow
        .revisions_used
        .checked_add(1)
        .ok_or(EscrowError::Overflow)?;
    // approval_deadline is reset lazily by the next submit_delivery — leaving
    // the stale value here is fine because it's only checked when
    // state==Delivered.

    Ok(())
}
