use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(bounty_id: [u8; 32])]
pub struct RefundBounty<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [BOUNTY_ESCROW_SEED, poster.key().as_ref(), &bounty_id],
        bump = escrow.bump,
        has_one = poster,
        constraint = escrow.bounty_id == bounty_id @ EscrowError::BountyIdMismatch,
        close = poster,
    )]
    pub escrow: Account<'info, BountyEscrow>,

    /// CHECK: lamport recipient — the original poster. Validated by
    /// `has_one = poster` on escrow. Not a signer: anyone can call refund
    /// after expiry (e.g. the off-chain `expireBounties` Cloud Function).
    #[account(mut)]
    pub poster: AccountInfo<'info>,

    /// Pays the tx fees. Doesn't have to be the poster.
    #[account(mut)]
    pub caller: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<RefundBounty>, _bounty_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);

    let now = Clock::get()?.unix_timestamp;
    require!(
        now >= ctx.accounts.escrow.expires_at,
        EscrowError::RefundBeforeExpiry
    );

    // `close = poster` returns the full PDA balance (amount + fee + rent)
    // to the poster. No fee is taken on refunds.
    Ok(())
}
