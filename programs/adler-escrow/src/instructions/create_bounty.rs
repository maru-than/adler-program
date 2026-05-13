use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(bounty_id: [u8; 32])]
pub struct CreateBounty<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = poster,
        space = 8 + BountyEscrow::INIT_SPACE,
        seeds = [BOUNTY_ESCROW_SEED, poster.key().as_ref(), &bounty_id],
        bump,
    )]
    pub escrow: Account<'info, BountyEscrow>,

    #[account(mut)]
    pub poster: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<CreateBounty>,
    bounty_id: [u8; 32],
    amount_lamports: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, EscrowError::ProtocolPaused);
    require!(amount_lamports > 0, EscrowError::InvalidAmount);

    let fee_lamports = amount_lamports
        .checked_mul(config.fee_bps as u64)
        .ok_or(EscrowError::Overflow)?
        / 10_000;

    let now = Clock::get()?.unix_timestamp;
    let expires_at = now
        .checked_add(SUBMISSION_WINDOW_SECS)
        .ok_or(EscrowError::Overflow)?
        .checked_add(REVIEW_WINDOW_SECS)
        .ok_or(EscrowError::Overflow)?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.poster = ctx.accounts.poster.key();
    escrow.bounty_id = bounty_id;
    escrow.amount_lamports = amount_lamports;
    escrow.fee_lamports = fee_lamports;
    escrow.fee_treasury = config.fee_treasury;
    escrow.expires_at = expires_at;
    escrow.bump = ctx.bumps.escrow;

    let total = amount_lamports
        .checked_add(fee_lamports)
        .ok_or(EscrowError::Overflow)?;

    let cpi_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        Transfer {
            from: ctx.accounts.poster.to_account_info(),
            to: ctx.accounts.escrow.to_account_info(),
        },
    );
    system_program::transfer(cpi_ctx, total)?;

    Ok(())
}
