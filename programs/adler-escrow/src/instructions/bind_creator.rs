use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct BindCreator<'info> {
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

    #[account(mut)]
    pub brand: Signer<'info>,

    /// CHECK: snapshotted onto escrow.creator. Validated by `has_one = creator`
    /// on subsequent settlement ix.
    pub creator: AccountInfo<'info>,
}

pub fn handler(ctx: Context<BindCreator>, _contract_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);

    let escrow = &mut ctx.accounts.escrow;
    let new_creator = ctx.accounts.creator.key();

    match escrow.state {
        State::Funded => {
            escrow.creator = new_creator;
            escrow.state = State::Bound;
        }
        State::Bound => {
            // Idempotent only when re-binding the same creator. Re-binding to
            // a different creator is rejected — the brand awarded the gig and
            // shouldn't be able to silently swap who's bound.
            require!(
                escrow.creator == new_creator,
                EscrowError::CreatorMismatch
            );
        }
        _ => {
            return Err(EscrowError::WrongState.into());
        }
    }

    Ok(())
}
