use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
pub struct RemoveArbiter<'info> {
    #[account(
        mut,
        seeds = [ARBITRATION_POOL_SEED],
        bump = pool.bump,
        has_one = admin,
    )]
    pub pool: Account<'info, ArbitrationPool>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<RemoveArbiter>, arbiter: Pubkey) -> Result<()> {
    let pool = &mut ctx.accounts.pool;

    let pos = pool
        .arbiters
        .iter()
        .position(|p| p == &arbiter)
        .ok_or(EscrowError::ArbiterNotInPool)?;

    // If disputes are open, refuse to drain the pool to empty — otherwise the
    // open contracts become unresolvable.
    if pool.disputed_count > 0 && pool.arbiters.len() == 1 {
        return Err(EscrowError::LastArbiterWithDisputes.into());
    }

    pool.arbiters.swap_remove(pos);
    Ok(())
}
