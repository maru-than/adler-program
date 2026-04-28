use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::ArbitrationOutcome;

declare_id!("3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD");

/// Adler escrow — brand-funded marketplace settlement on Solana.
///
/// Per-contract PDA holds `price + fee` lamports until one of:
///   - brand calls approve_release            → split price→creator, fee→treasury
///   - anyone calls auto_release after deadline → same split, permissionless
///   - brand calls brand_refund after grace   → refund all to brand
///   - either party calls open_dispute        → state=Disputed; only arbitrate() unlocks
///
/// PDA seeds: [b"escrow", brand.key().as_ref(), &contract_id_32]
/// arbitration_authority is per-PDA (set at fund time), not a global program key.
#[program]
pub mod adler_escrow {
    use super::*;

    pub fn fund_escrow(
        ctx: Context<FundEscrow>,
        contract_id: [u8; 32],
        price_lamports: u64,
        fee_lamports: u64,
        approval_deadline: i64,
    ) -> Result<()> {
        instructions::fund_escrow::handler(
            ctx,
            contract_id,
            price_lamports,
            fee_lamports,
            approval_deadline,
        )
    }

    pub fn approve_release(
        ctx: Context<ApproveRelease>,
        contract_id: [u8; 32],
    ) -> Result<()> {
        instructions::approve_release::handler(ctx, contract_id)
    }

    pub fn auto_release(
        ctx: Context<AutoRelease>,
        contract_id: [u8; 32],
    ) -> Result<()> {
        instructions::auto_release::handler(ctx, contract_id)
    }

    pub fn brand_refund(
        ctx: Context<BrandRefund>,
        contract_id: [u8; 32],
    ) -> Result<()> {
        instructions::brand_refund::handler(ctx, contract_id)
    }

    pub fn open_dispute(
        ctx: Context<OpenDispute>,
        contract_id: [u8; 32],
    ) -> Result<()> {
        instructions::open_dispute::handler(ctx, contract_id)
    }

    pub fn arbitrate(
        ctx: Context<Arbitrate>,
        contract_id: [u8; 32],
        outcome: ArbitrationOutcome,
    ) -> Result<()> {
        instructions::arbitrate::handler(ctx, contract_id, outcome)
    }
}
