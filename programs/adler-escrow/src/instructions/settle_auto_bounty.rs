use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(bounty_id: [u8; 32])]
pub struct SettleAutoBounty<'info> {
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
        has_one = fee_treasury,
        constraint = escrow.bounty_id == bounty_id @ EscrowError::BountyIdMismatch,
        constraint = escrow.mode == MODE_AUTO @ EscrowError::NotAutoMode,
        close = poster,
    )]
    pub escrow: Account<'info, BountyEscrow>,

    /// CHECK: lamport recipient for residual rent. Validated by `has_one`.
    #[account(mut)]
    pub poster: AccountInfo<'info>,

    /// Custodial verifier keypair held by the Cloud Function. Must equal
    /// `config.verifier_pubkey`.
    pub verifier: Signer<'info>,

    /// CHECK: lamport recipient (winner). The verifier supplies the
    /// submitter's pubkey after Gemini Vision passes the photo against the
    /// bounty prompt.
    #[account(mut)]
    pub winner: AccountInfo<'info>,

    /// CHECK: validated by `has_one = fee_treasury` on escrow.
    #[account(mut)]
    pub fee_treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SettleAutoBounty>, _bounty_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);
    require!(
        ctx.accounts.verifier.key() == ctx.accounts.config.verifier_pubkey,
        EscrowError::WrongVerifier
    );

    let amount = ctx.accounts.escrow.amount_lamports;
    let fee = ctx.accounts.escrow.fee_lamports;

    let now = Clock::get()?.unix_timestamp;
    require!(now < ctx.accounts.escrow.expires_at, EscrowError::BountyExpired);

    let escrow_ai = ctx.accounts.escrow.to_account_info();
    let winner_ai = ctx.accounts.winner.to_account_info();
    let treasury_ai = ctx.accounts.fee_treasury.to_account_info();

    **escrow_ai.try_borrow_mut_lamports()? -= amount;
    **winner_ai.try_borrow_mut_lamports()? += amount;

    if fee > 0 {
        **escrow_ai.try_borrow_mut_lamports()? -= fee;
        **treasury_ai.try_borrow_mut_lamports()? += fee;
    }

    Ok(())
}
