use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

/// Poster-initiated cancel + refund. Returns `amount + fee + rent` to the
/// poster and closes the escrow PDA. No expiry gate (in contrast to
/// `refund_bounty`).
///
/// On-chain we cannot see Firestore submissions, so this instruction
/// trusts the off-chain layer (Firestore rules) to forbid cancellation
/// once a submission has been recorded. If a poster races a submission
/// in flight, the chain wins — the cancel lands and the submitter is
/// rejected by `enforceSubmissionCap` because the bounty is no longer
/// `open`.
#[derive(Accounts)]
#[instruction(bounty_id: [u8; 32])]
pub struct CancelBounty<'info> {
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

    #[account(mut)]
    pub poster: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CancelBounty>, _bounty_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);

    // No expiry gate — the poster can cancel at any time before the
    // refund-unlock timestamp. After `expires_at` the standard refund
    // path applies (anyone can call `refund_bounty`).
    let now = Clock::get()?.unix_timestamp;
    require!(
        now < ctx.accounts.escrow.expires_at,
        EscrowError::BountyExpired
    );

    Ok(())
}
