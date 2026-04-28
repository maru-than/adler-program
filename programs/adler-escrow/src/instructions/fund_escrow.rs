use anchor_lang::prelude::*;
use anchor_lang::system_program;

use crate::errors::EscrowError;
use crate::state::{EscrowAccount, EscrowState, ESCROW_SEED, REFUND_GRACE_SECONDS};

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct FundEscrow<'info> {
    #[account(mut)]
    pub brand: Signer<'info>,

    /// CHECK: pubkey only — the creator never signs fund_escrow. Stored on the
    /// PDA so future ixs verify against it.
    pub creator: UncheckedAccount<'info>,

    /// CHECK: pubkey only — same reasoning as creator.
    pub fee_treasury: UncheckedAccount<'info>,

    /// CHECK: pubkey only — the arbitrator only signs `arbitrate`, never `fund_escrow`.
    pub arbitration_authority: UncheckedAccount<'info>,

    #[account(
        init,
        payer = brand,
        space = 8 + EscrowAccount::INIT_SPACE,
        seeds = [ESCROW_SEED, brand.key().as_ref(), contract_id.as_ref()],
        bump
    )]
    pub escrow: Account<'info, EscrowAccount>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<FundEscrow>,
    contract_id: [u8; 32],
    price_lamports: u64,
    fee_lamports: u64,
    approval_deadline: i64,
) -> Result<()> {
    require!(price_lamports > 0, EscrowError::InvalidPrice);
    let now = Clock::get()?.unix_timestamp;
    require!(approval_deadline > now, EscrowError::InvalidDeadline);

    let total = price_lamports
        .checked_add(fee_lamports)
        .ok_or(EscrowError::Overflow)?;

    // Transfer the held amount from brand → escrow PDA via the system program.
    // The PDA's lamport balance after this = rent-exempt minimum + price + fee.
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.brand.to_account_info(),
                to: ctx.accounts.escrow.to_account_info(),
            },
        ),
        total,
    )?;

    let escrow = &mut ctx.accounts.escrow;
    escrow.contract_id = contract_id;
    escrow.brand = ctx.accounts.brand.key();
    escrow.creator = ctx.accounts.creator.key();
    escrow.fee_treasury = ctx.accounts.fee_treasury.key();
    escrow.arbitration_authority = ctx.accounts.arbitration_authority.key();
    escrow.price_lamports = price_lamports;
    escrow.fee_lamports = fee_lamports;
    escrow.approval_deadline = approval_deadline;
    escrow.refund_after = approval_deadline
        .checked_add(REFUND_GRACE_SECONDS)
        .ok_or(EscrowError::Overflow)?;
    escrow.state = EscrowState::Funded as u8;
    escrow.bump = ctx.bumps.escrow;

    Ok(())
}
