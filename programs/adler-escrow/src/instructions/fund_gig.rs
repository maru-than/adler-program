use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct FundGig<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        init,
        payer = brand,
        space = 8 + ContractEscrow::INIT_SPACE,
        seeds = [CONTRACT_ESCROW_SEED, brand.key().as_ref(), &contract_id],
        bump,
    )]
    pub escrow: Account<'info, ContractEscrow>,

    #[account(mut)]
    pub brand: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<FundGig>,
    contract_id: [u8; 32],
    budget_lamports: u64,
    delivery_deadline: i64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, EscrowError::ProtocolPaused);
    require!(budget_lamports > 0, EscrowError::InvalidPrice);

    let now = Clock::get()?.unix_timestamp;
    require!(delivery_deadline > now, EscrowError::InvalidDeadline);

    let fee_lamports = budget_lamports
        .checked_mul(config.fee_bps as u64)
        .ok_or(EscrowError::Overflow)?
        / 10_000;

    let escrow = &mut ctx.accounts.escrow;
    escrow.kind = Kind::Gig;
    escrow.contract_id = contract_id;
    escrow.brand = ctx.accounts.brand.key();
    // Creator slot empty until `bind_creator` fills it.
    escrow.creator = Pubkey::default();
    escrow.fee_treasury = config.fee_treasury;
    escrow.price_lamports = budget_lamports;
    escrow.fee_lamports = fee_lamports;
    escrow.state = State::Funded;
    escrow.delivery_deadline = delivery_deadline;
    escrow.delivered_at = None;
    escrow.approval_deadline = 0;
    escrow.revisions_used = 0;
    escrow.dispute_filer = Pubkey::default();
    escrow.dispute_opened_at = 0;
    escrow.bump = ctx.bumps.escrow;

    let total = budget_lamports
        .checked_add(fee_lamports)
        .ok_or(EscrowError::Overflow)?;

    let cpi_ctx = CpiContext::new(
        ctx.accounts.system_program.to_account_info(),
        Transfer {
            from: ctx.accounts.brand.to_account_info(),
            to: ctx.accounts.escrow.to_account_info(),
        },
    );
    system_program::transfer(cpi_ctx, total)?;

    Ok(())
}
