use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

use instructions::*;
use state::ConfigField;

declare_id!("BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr");

/// Adler bounty escrow — single-program bounty marketplace settlement.
///
/// Each bounty escrows the poster's SOL into a PDA. Manual mode: poster
/// signs `settle_manual_bounty(winner)`. Auto mode: a custodial verifier
/// keypair (held by the off-chain Cloud Function) signs
/// `settle_auto_bounty(winner)` after Gemini Vision verifies the photo.
/// Anyone can call `refund_bounty` after `expires_at` (poster + 30 days).
#[program]
pub mod adler_escrow {
    use super::*;

    // ── Admin ────────────────────────────────────────────────────────────

    pub fn init_protocol(
        ctx: Context<InitProtocol>,
        admin: Pubkey,
        verifier_pubkey: Pubkey,
        fee_treasury: Pubkey,
        fee_bps: u16,
    ) -> Result<()> {
        instructions::init_protocol::handler(ctx, admin, verifier_pubkey, fee_treasury, fee_bps)
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
        mode: u8,
    ) -> Result<()> {
        instructions::create_bounty::handler(ctx, bounty_id, amount_lamports, mode)
    }

    pub fn settle_manual_bounty(
        ctx: Context<SettleManualBounty>,
        bounty_id: [u8; 32],
    ) -> Result<()> {
        instructions::settle_manual_bounty::handler(ctx, bounty_id)
    }

    pub fn settle_auto_bounty(
        ctx: Context<SettleAutoBounty>,
        bounty_id: [u8; 32],
    ) -> Result<()> {
        instructions::settle_auto_bounty::handler(ctx, bounty_id)
    }

    pub fn refund_bounty(
        ctx: Context<RefundBounty>,
        bounty_id: [u8; 32],
    ) -> Result<()> {
        instructions::refund_bounty::handler(ctx, bounty_id)
    }
}
