use anchor_lang::prelude::*;

use super::enums::{Kind, SettledOutcome};

/// Settled-contract record. Initialized by the closing instruction
/// (`approve_release`, `auto_release`, `arbitrate`) immediately before
/// `ContractEscrow` is closed; `mint_reputation` reads it to verify the
/// contract was settled.
///
/// `brand_refund` and `cancel_unbound_gig` do **not** write a record — those
/// paths produce no `ReputationCard` (no rating to be made for a refund).
///
/// Seeds: `[b"record", brand.key().as_ref(), &contract_id]`.
/// See `docs/v1-design.md` §2.4.
#[account]
#[derive(InitSpace)]
pub struct ContractRecord {
    pub kind: Kind,
    pub brand: Pubkey,
    pub creator: Pubkey,
    pub price_lamports: u64,
    pub fee_lamports: u64,
    pub outcome: SettledOutcome,
    pub settled_at: i64,
    pub bump: u8,
}

pub const CONTRACT_RECORD_SEED: &[u8] = b"record";
