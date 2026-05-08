use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct ApproveRelease<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [CONTRACT_ESCROW_SEED, brand.key().as_ref(), &contract_id],
        bump = escrow.bump,
        has_one = brand,
        has_one = creator,
        has_one = fee_treasury,
        constraint = escrow.contract_id == contract_id @ EscrowError::ContractIdMismatch,
        close = brand,
    )]
    pub escrow: Account<'info, ContractEscrow>,

    #[account(
        init,
        payer = brand,
        space = 8 + ContractRecord::INIT_SPACE,
        seeds = [CONTRACT_RECORD_SEED, brand.key().as_ref(), &contract_id],
        bump,
    )]
    pub record: Account<'info, ContractRecord>,

    #[account(mut)]
    pub brand: Signer<'info>,

    /// CHECK: validated by `has_one = creator` on escrow.
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    /// CHECK: validated by `has_one = fee_treasury` on escrow + checked vs
    /// `config.fee_treasury` below (defense-in-depth against a stale snapshot).
    #[account(mut)]
    pub fee_treasury: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<ApproveRelease>, _contract_id: [u8; 32]) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);
    require!(
        ctx.accounts.fee_treasury.key() == ctx.accounts.config.fee_treasury,
        EscrowError::FeeTreasuryMismatch
    );
    require!(
        ctx.accounts.escrow.state == State::Delivered,
        EscrowError::WrongState
    );

    let price = ctx.accounts.escrow.price_lamports;
    let fee = ctx.accounts.escrow.fee_lamports;

    // PDA → creator (price), PDA → treasury (fee). Anchor's `close = brand`
    // moves the residual (= rent) to brand at end of ix. Order matters: do
    // partial transfers first, close last.
    {
        let escrow_ai = ctx.accounts.escrow.to_account_info();
        let creator_ai = ctx.accounts.creator.to_account_info();
        let treasury_ai = ctx.accounts.fee_treasury.to_account_info();

        **escrow_ai.try_borrow_mut_lamports()? -= price;
        **creator_ai.try_borrow_mut_lamports()? += price;

        **escrow_ai.try_borrow_mut_lamports()? -= fee;
        **treasury_ai.try_borrow_mut_lamports()? += fee;
    }

    // Persist the settlement record before close. ContractRecord seeds
    // mirror the escrow's `(brand, contract_id)` so reputation indexers can
    // find both via getProgramAccounts.
    let now = Clock::get()?.unix_timestamp;
    let record = &mut ctx.accounts.record;
    record.kind = ctx.accounts.escrow.kind;
    record.brand = ctx.accounts.escrow.brand;
    record.creator = ctx.accounts.escrow.creator;
    record.price_lamports = price;
    record.fee_lamports = fee;
    record.outcome = SettledOutcome::Settled;
    record.settled_at = now;
    record.bump = ctx.bumps.record;

    Ok(())
}
