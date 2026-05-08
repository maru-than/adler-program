use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
pub struct UpdateProtocolField<'info> {
    #[account(
        mut,
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
        has_one = admin,
    )]
    pub config: Account<'info, ProtocolConfig>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<UpdateProtocolField>, field: ConfigField) -> Result<()> {
    let config = &mut ctx.accounts.config;
    match field {
        ConfigField::Admin { value } => config.admin = value,
        ConfigField::FeeBps { value } => config.fee_bps = value,
        ConfigField::FeeTreasury { value } => config.fee_treasury = value,
        ConfigField::ApprovalWindowSecs { value } => {
            require!(value > 0, EscrowError::InvalidDeadline);
            config.approval_window_secs = value;
        }
        ConfigField::RefundGraceSecs { value } => {
            require!(value > 0, EscrowError::InvalidDeadline);
            config.refund_grace_secs = value;
        }
        ConfigField::ArbitrationPool { value } => config.arbitration_pool = value,
    }
    Ok(())
}
