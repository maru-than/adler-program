use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(bounty_id: [u8; 32])]
pub struct SettleManualBounty<'info> {
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
        constraint = escrow.mode == MODE_MANUAL @ EscrowError::NotManualMode,
        close = poster,
    )]
    pub escrow: Account<'info, BountyEscrow>,

    #[account(mut)]
    pub poster: Signer<'info>,

    /// CHECK: lamport recipient (winner). Poster picks the winner off-chain
    /// and supplies the pubkey; this is by definition trusted in manual mode.
    #[account(mut)]
    pub winner: AccountInfo<'info>,

    /// CHECK: validated by `has_one = fee_treasury` on escrow.
    #[account(mut)]
    pub fee_treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<SettleManualBounty>, _bounty_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);

    let amount = ctx.accounts.escrow.amount_lamports;
    let fee = ctx.accounts.escrow.fee_lamports;

    let now = Clock::get()?.unix_timestamp;
    require!(now < ctx.accounts.escrow.expires_at, EscrowError::BountyExpired);

    // PDA → winner (amount), PDA → treasury (fee). `close = poster` returns
    // the residual rent to poster at end of ix.
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
