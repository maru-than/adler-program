use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, Transfer};

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct FundService<'info> {
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

    /// CHECK: snapshotted onto escrow.creator. Validated by `has_one = creator`
    /// constraints on subsequent ix.
    pub creator: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<FundService>,
    contract_id: [u8; 32],
    price_lamports: u64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(!config.paused, EscrowError::ProtocolPaused);
    require!(price_lamports > 0, EscrowError::InvalidPrice);

    let fee_lamports = price_lamports
        .checked_mul(config.fee_bps as u64)
        .ok_or(EscrowError::Overflow)?
        / 10_000;

    let now = Clock::get()?.unix_timestamp;
    let delivery_deadline = now
        .checked_add(config.approval_window_secs)
        .ok_or(EscrowError::Overflow)?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.kind = Kind::Service;
    escrow.contract_id = contract_id;
    escrow.brand = ctx.accounts.brand.key();
    escrow.creator = ctx.accounts.creator.key();
    escrow.fee_treasury = config.fee_treasury;
    escrow.price_lamports = price_lamports;
    escrow.fee_lamports = fee_lamports;
    escrow.state = State::Bound;
    escrow.delivery_deadline = delivery_deadline;
    escrow.delivered_at = None;
    // Set lazily on submit_delivery.
    escrow.approval_deadline = 0;
    escrow.revisions_used = 0;
    escrow.dispute_filer = Pubkey::default();
    escrow.dispute_opened_at = 0;
    escrow.bump = ctx.bumps.escrow;

    // Transfer price + fee from brand → escrow PDA. Rent for the PDA was
    // already paid by `init`; this is the contractual amount on top.
    let total = price_lamports
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
