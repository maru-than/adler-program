use anchor_lang::prelude::*;

/// Per-contract escrow PDA. Seeds: [b"escrow", brand.key().as_ref(), &contract_id]
///
/// Held SOL = price_lamports + fee_lamports + rent. On settlement the rent goes
/// back to the brand (PDA close), the price to the creator, the fee to the
/// fee_treasury — atomically in one transaction.
#[account]
#[derive(InitSpace)]
pub struct EscrowAccount {
    pub contract_id: [u8; 32],
    pub brand: Pubkey,
    pub creator: Pubkey,
    pub fee_treasury: Pubkey,
    /// Pubkey allowed to call `arbitrate` when state == Disputed. Stored
    /// per-PDA at fund time (NOT a global program constant) so different
    /// product lines can use different arbitrators later.
    pub arbitration_authority: Pubkey,
    pub price_lamports: u64,
    pub fee_lamports: u64,
    /// Unix timestamp after which `auto_release` becomes callable by anyone.
    pub approval_deadline: i64,
    /// Unix timestamp after which `brand_refund` becomes callable.
    /// Set to approval_deadline + REFUND_GRACE_SECONDS at fund time.
    pub refund_after: i64,
    pub state: u8,
    pub bump: u8,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EscrowState {
    Funded = 0,
    Settled = 1,
    Refunded = 2,
    Disputed = 3,
}

impl EscrowState {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(EscrowState::Funded),
            1 => Some(EscrowState::Settled),
            2 => Some(EscrowState::Refunded),
            3 => Some(EscrowState::Disputed),
            _ => None,
        }
    }
}

/// Outcome enum for `arbitrate`. Split is parameterized by numerator/denominator
/// so an arbitrator can do e.g. 60/40 (Split { num: 60, denom: 100 }).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArbitrationOutcome {
    /// Full release: price → creator, fee → treasury (same as approve_release).
    Release,
    /// Full refund: everything → brand.
    Refund,
    /// Split: (num/denom) of price → creator, rest → brand. Fee always
    /// goes to the treasury regardless of split (Adler is not a charity).
    Split { num: u64, denom: u64 },
}

/// PDA seed prefix.
pub const ESCROW_SEED: &[u8] = b"escrow";

/// Refund grace window: brand can claim their funds back this long after the
/// approval_deadline if the creator never delivered. PRODUCT.md §11.
pub const REFUND_GRACE_SECONDS: i64 = 24 * 60 * 60;
