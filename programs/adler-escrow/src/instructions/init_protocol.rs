use anchor_lang::prelude::*;

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
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.admin = admin;
    config.fee_bps = fee_bps;
    config.fee_treasury = fee_treasury;
    config.paused = false;
    config.bump = ctx.bumps.config;
    Ok(())
}
