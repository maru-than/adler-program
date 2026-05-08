use anchor_lang::prelude::*;

use crate::errors::EscrowError;
use crate::state::*;

#[derive(Accounts)]
#[instruction(contract_id: [u8; 32])]
pub struct Arbitrate<'info> {
    #[account(
        seeds = [PROTOCOL_CONFIG_SEED],
        bump = config.bump,
    )]
    pub config: Account<'info, ProtocolConfig>,

    #[account(
        mut,
        seeds = [ARBITRATION_POOL_SEED],
        bump = pool.bump,
    )]
    pub pool: Account<'info, ArbitrationPool>,

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
        payer = arbiter,
        space = 8 + ContractRecord::INIT_SPACE,
        seeds = [CONTRACT_RECORD_SEED, brand.key().as_ref(), &contract_id],
        bump,
    )]
    pub record: Account<'info, ContractRecord>,

    /// CHECK: lamport recipient on close. Validated by `has_one = brand` on escrow.
    #[account(mut)]
    pub brand: AccountInfo<'info>,

    /// CHECK: validated by `has_one = creator` on escrow.
    #[account(mut)]
    pub creator: AccountInfo<'info>,

    /// CHECK: validated by `has_one = fee_treasury` on escrow + checked vs config.
    #[account(mut)]
    pub fee_treasury: AccountInfo<'info>,

    #[account(mut)]
    pub arbiter: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn handler(
    ctx: Context<Arbitrate>,
    _contract_id: [u8; 32],
    outcome: Outcome,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);
    require!(
        ctx.accounts.fee_treasury.key() == ctx.accounts.config.fee_treasury,
        EscrowError::FeeTreasuryMismatch
    );
    require!(
        ctx.accounts.escrow.state == State::Disputed,
        EscrowError::WrongState
    );

    // Signer must be in the arbitration pool.
    let arbiter_key = ctx.accounts.arbiter.key();
    require!(
        ctx.accounts.pool.arbiters.contains(&arbiter_key),
        EscrowError::ArbiterNotInPool
    );

    // Validate Split before any lamport movement.
    if let Outcome::Split { creator_bps } = outcome {
        require!(creator_bps <= 10_000, EscrowError::InvalidBps);
    }

    let price = ctx.accounts.escrow.price_lamports;
    let fee = ctx.accounts.escrow.fee_lamports;

    // Lamport movements per outcome. Anchor's `close = brand` runs at end of
    // ix and moves whatever's left to brand — so partial moves first, close
    // last.
    {
        let escrow_ai = ctx.accounts.escrow.to_account_info();
        let creator_ai = ctx.accounts.creator.to_account_info();
        let treasury_ai = ctx.accounts.fee_treasury.to_account_info();

        match outcome {
            Outcome::Release => {
                **escrow_ai.try_borrow_mut_lamports()? -= price;
                **creator_ai.try_borrow_mut_lamports()? += price;
                **escrow_ai.try_borrow_mut_lamports()? -= fee;
                **treasury_ai.try_borrow_mut_lamports()? += fee;
                // Residual = rent → brand on close.
            }
            Outcome::Refund => {
                // Everything stays in the PDA until close moves it to brand:
                // price + fee + rent → brand. The marketplace forgoes its fee
                // because no service was rendered (matches `brand_refund`).
            }
            Outcome::Split { creator_bps } => {
                let creator_share = price
                    .checked_mul(creator_bps as u64)
                    .ok_or(EscrowError::Overflow)?
                    / 10_000;

                if creator_share > 0 {
                    **escrow_ai.try_borrow_mut_lamports()? -= creator_share;
                    **creator_ai.try_borrow_mut_lamports()? += creator_share;
                }
                // Fee always to treasury — marketplace did the work of routing
                // the contract regardless of which party ended up with the price.
                **escrow_ai.try_borrow_mut_lamports()? -= fee;
                **treasury_ai.try_borrow_mut_lamports()? += fee;
                // Residual = (price - creator_share) + rent → brand on close.
            }
        }
    }

    // Persist the settlement record.
    let now = Clock::get()?.unix_timestamp;
    let record = &mut ctx.accounts.record;
    record.kind = ctx.accounts.escrow.kind;
    record.brand = ctx.accounts.escrow.brand;
    record.creator = ctx.accounts.escrow.creator;
    record.price_lamports = price;
    record.fee_lamports = fee;
    record.outcome = SettledOutcome::Resolved(outcome);
    record.settled_at = now;
    record.bump = ctx.bumps.record;

    // Decrement disputed_count.
    let pool = &mut ctx.accounts.pool;
    pool.disputed_count = pool.disputed_count.saturating_sub(1);

    Ok(())
}
