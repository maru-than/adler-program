use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::{ConfigField, Outcome};

// v1.0 program ID. v0.1 (`3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD`) is
// preserved on devnet as the museum reference; see docs/v1-design.md §9.
declare_id!("BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr");

/// Adler escrow v1.0 — marketplace settlement on Solana.
///
/// Phase 1 surface: protocol config singleton + service path
/// (fund → submit → approve). Gigs, disputes, reputation come in later phases
/// (see `TODO.md`). Architecture spine: `docs/v1-design.md`.
#[program]
pub mod adler_escrow {
    use super::*;

    // ── Admin ────────────────────────────────────────────────────────────

    pub fn init_protocol(
        ctx: Context<InitProtocol>,
        admin: Pubkey,
        fee_treasury: Pubkey,
        fee_bps: u16,
        approval_window_secs: i64,
        refund_grace_secs: i64,
    ) -> Result<()> {
        instructions::init_protocol::handler(
            ctx,
            admin,
            fee_treasury,
            fee_bps,
            approval_window_secs,
            refund_grace_secs,
        )
    }

    pub fn update_protocol_field(
        ctx: Context<UpdateProtocolField>,
        field: ConfigField,
    ) -> Result<()> {
        instructions::update_protocol_field::handler(ctx, field)
    }

    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        instructions::set_paused::handler(ctx, paused)
    }

    // ── Service path ─────────────────────────────────────────────────────

    pub fn fund_service(
        ctx: Context<FundService>,
        contract_id: [u8; 32],
        price_lamports: u64,
    ) -> Result<()> {
        instructions::fund_service::handler(ctx, contract_id, price_lamports)
    }

    pub fn submit_delivery(
        ctx: Context<SubmitDelivery>,
        contract_id: [u8; 32],
    ) -> Result<()> {
        instructions::submit_delivery::handler(ctx, contract_id)
    }

    pub fn request_revision(
        ctx: Context<RequestRevision>,
        contract_id: [u8; 32],
    ) -> Result<()> {
        instructions::request_revision::handler(ctx, contract_id)
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

    // ── Gig path ─────────────────────────────────────────────────────────

    pub fn fund_gig(
        ctx: Context<FundGig>,
        contract_id: [u8; 32],
        budget_lamports: u64,
        delivery_deadline: i64,
    ) -> Result<()> {
        instructions::fund_gig::handler(ctx, contract_id, budget_lamports, delivery_deadline)
    }

    pub fn bind_creator(
        ctx: Context<BindCreator>,
        contract_id: [u8; 32],
    ) -> Result<()> {
        instructions::bind_creator::handler(ctx, contract_id)
    }

    pub fn cancel_unbound_gig(
        ctx: Context<CancelUnboundGig>,
        contract_id: [u8; 32],
    ) -> Result<()> {
        instructions::cancel_unbound_gig::handler(ctx, contract_id)
    }

    // ── Arbitration pool ─────────────────────────────────────────────────

    pub fn init_arbitration_pool(
        ctx: Context<InitArbitrationPool>,
        quorum: u8,
    ) -> Result<()> {
        instructions::init_arbitration_pool::handler(ctx, quorum)
    }

    pub fn add_arbiter(ctx: Context<AddArbiter>, arbiter: Pubkey) -> Result<()> {
        instructions::add_arbiter::handler(ctx, arbiter)
    }

    pub fn remove_arbiter(ctx: Context<RemoveArbiter>, arbiter: Pubkey) -> Result<()> {
        instructions::remove_arbiter::handler(ctx, arbiter)
    }

    // ── Disputes ─────────────────────────────────────────────────────────

    pub fn open_dispute(
        ctx: Context<OpenDispute>,
        contract_id: [u8; 32],
    ) -> Result<()> {
        instructions::open_dispute::handler(ctx, contract_id)
    }

    pub fn arbitrate(
        ctx: Context<Arbitrate>,
        contract_id: [u8; 32],
        outcome: Outcome,
    ) -> Result<()> {
        instructions::arbitrate::handler(ctx, contract_id, outcome)
    }

    // ── Reputation ───────────────────────────────────────────────────────

    pub fn mint_reputation(
        ctx: Context<MintReputation>,
        contract_id: [u8; 32],
        axes: [u8; 4],
        comment_hash: [u8; 32],
    ) -> Result<()> {
        instructions::mint_reputation::handler(ctx, contract_id, axes, comment_hash)
    }
}
