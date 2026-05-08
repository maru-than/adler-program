use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
pub struct InitProtocol<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + ProtocolConfig::INIT_SPACE,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<InitProtocol>,
    admin: Pubkey,
    fee_treasury: Pubkey,
    fee_bps: u16,
    approval_window_secs: i64,
    refund_grace_secs: i64,
) -> Result<()> {
    require!(approval_window_secs > 0, EscrowError::InvalidDeadline);
    require!(refund_grace_secs > 0, EscrowError::InvalidDeadline);

    let config = &mut ctx.accounts.config;
    config.admin = admin;
    config.fee_bps = fee_bps;
    config.fee_treasury = fee_treasury;
    config.approval_window_secs = approval_window_secs;
    config.refund_grace_secs = refund_grace_secs;
    // Set in Phase 5 by init_arbitration_pool.
    config.arbitration_pool = Pubkey::default();
    config.paused = false;
    config.bump = ctx.bumps.config;
    Ok(())
}
