use anchor_lang::prelude::*;

use crate::state::*;

#[derive(Accounts)]
pub struct InitArbitrationPool<'info> {
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = admin,
        space = 8 + ArbitrationPool::INIT_SPACE,
        seeds = [ARBITRATION_POOL_SEED],
        bump,
    )]
    pub pool: Account<'info, ArbitrationPool>,

    #[account(mut)]
    pub admin: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<InitArbitrationPool>, quorum: u8) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    pool.admin = ctx.accounts.admin.key();
    pool.arbiters = vec![];
    // Quorum is reserved for post-v1 multi-sig arbitration. v1 enforces
    // single-arbiter resolution regardless of this value.
    pool.quorum = quorum.max(1);
    pool.disputed_count = 0;
    pool.bump = ctx.bumps.pool;

    // Cross-link: ProtocolConfig now points at the live pool address.
    ctx.accounts.config.arbitration_pool = pool.key();

    Ok(())
}
