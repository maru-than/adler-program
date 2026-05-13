use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::ConfigField;

declare_id!("BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr");

/// Adler bounty escrow — single-program bounty marketplace settlement.
///
/// Each bounty escrows the poster's SOL into a PDA. Poster signs
/// `settle_manual_bounty(winner)` to release funds. Anyone can call
/// `refund_bounty` after `expires_at` (= create_time + 30-day submission
/// window + 90-day review window). Everything else — name, description,
/// media, status, submissions — lives off-chain in Firestore; the chain
/// only holds what's needed to verifiably maintain custody.
#[program]
pub mod adler_escrow {
    use super::*;

    // ── Admin ────────────────────────────────────────────────────────────

    pub fn init_protocol(
        ctx: Context<InitProtocol>,
        admin: Pubkey,
        fee_treasury: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::init_protocol::handler(ctx, admin, fee_treasury, fee_bps)
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

    // ── Bounty path ──────────────────────────────────────────────────────

    pub fn create_bounty(
        ctx: Context<CreateBounty>,
        bounty_id: [u8; 32],
        amount_lamports: u64,
    ) -> Result<()> {
        instructions::create_bounty::handler(ctx, bounty_id, amount_lamports)
    }

    pub fn settle_manual_bounty(
        ctx: Context<SettleManualBounty>,
        bounty_id: [u8; 32],
    ) -> Result<()> {
        instructions::settle_manual_bounty::handler(ctx, bounty_id)
    }

    pub fn refund_bounty(
        ctx: Context<RefundBounty>,
        bounty_id: [u8; 32],
    ) -> Result<()> {
        instructions::refund_bounty::handler(ctx, bounty_id)
    }

    /// Poster-initiated cancel — refunds the escrow before `expires_at`.
    /// Off-chain layer (Firestore rules) gates this on the bounty having
    /// zero submissions; on-chain only enforces that the caller is the
    /// poster and the bounty hasn't refund-unlocked yet.
    pub fn cancel_bounty(
        ctx: Context<CancelBounty>,
        bounty_id: [u8; 32],
    ) -> Result<()> {
        instructions::cancel_bounty::handler(ctx, bounty_id)
    }
}
