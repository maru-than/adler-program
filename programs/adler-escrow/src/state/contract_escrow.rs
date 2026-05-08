use anchor_lang::prelude::*;

use super::enums::{Kind, State};

/// Per-contract escrow PDA. Holds `price + fee + rent` lamports until terminal.
///
/// Seeds: `[b"contract", brand.key().as_ref(), &contract_id]`.
/// See `docs/v1-design.md` §2.3.
#[account]
#[derive(InitSpace)]
pub struct ContractEscrow {
    pub kind: Kind,
    pub contract_id: [u8; 32],
    pub brand: Pubkey,
    /// `Pubkey::default()` while a Gig is unbound.
    pub creator: Pubkey,
    /// Snapshotted from `ProtocolConfig.fee_treasury` at fund time.
    pub fee_treasury: Pubkey,
    pub price_lamports: u64,
    /// `floor(price_lamports * config.fee_bps / 10_000)`, snapshotted at fund time.
    pub fee_lamports: u64,
    pub state: State,
    /// After this slot timestamp, brand can `brand_refund` (Bound only). For
    /// Service: `now + approval_window_secs` at fund. For Gig: brand-supplied.
    pub delivery_deadline: i64,
    /// Set on `submit_delivery`.
    pub delivered_at: Option<i64>,
    /// Set lazily on `submit_delivery`: `now + approval_window_secs`. Reset on
    /// each `submit_delivery` after a `request_revision`.
    pub approval_deadline: i64,
    /// Capped at 2 by `request_revision`.
    pub revisions_used: u8,
    /// Set on `open_dispute`; `Pubkey::default()` otherwise.
    pub dispute_filer: Pubkey,
    /// Set on `open_dispute`.
    pub dispute_opened_at: i64,
    pub bump: u8,
}

pub const CONTRACT_ESCROW_SEED: &[u8] = b"contract";
