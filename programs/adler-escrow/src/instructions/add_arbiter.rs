use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
pub struct AddArbiter<'info> {
    #[account(
        mut,
        seeds = [ARBITRATION_POOL_SEED],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, ArbitrationPool>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AddArbiter>, arbiter: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.arbiters.len() < 16, EscrowError::PoolFull);
    require!(
        !pool.arbiters.contains(&arbiter),
        EscrowError::DuplicateArbiter
    );
    pool.arbiters.push(arbiter);
    Ok(())
}
