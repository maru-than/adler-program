use anchor_lang::prelude::*;

/// Per-bounty escrow PDA. Holds `amount + fee + rent` lamports until
/// terminal (settle or refund — both close the PDA).
///
/// Seeds: `[b"bounty_v2", poster.key().as_ref(), &bounty_id]`.
#[account]
#[derive(InitSpace)]
pub struct BountyEscrow {
    pub poster: Pubkey,
    pub bounty_id: [u8; 32],
    /// Amount paid out to the winner on settle (or refunded to poster).
    pub amount_lamports: u64,
    /// `floor(amount_lamports * config.fee_bps / 10_000)`, snapshotted at
    /// create time. Sent to fee_treasury on settle. Returned to poster on
    /// refund.
    pub fee_lamports: u64,
    /// Snapshotted from `ProtocolConfig.fee_treasury` at create time.
    pub fee_treasury: Pubkey,
    /// `now + SUBMISSION_WINDOW_SECS + REVIEW_WINDOW_SECS` at create.
    /// After this slot timestamp, `refund_bounty` can be called by anyone.
    pub expires_at: i64,
    pub bump: u8,
}

// Seed bumped from v0.1's b"bounty" so the new layout doesn't collide with
// any legacy BountyEscrow PDAs still alive on devnet.
pub const BOUNTY_ESCROW_SEED: &[u8] = b"bounty_v2";

/// Fixed 30-day submission window. Hardcoded rather than a per-bounty arg
/// since the off-chain layer never exposes a choice — every bounty runs on
/// the same clock.
pub const SUBMISSION_WINDOW_SECS: i64 = 30 * 24 * 60 * 60;

/// Review window after submissions close. Fixed; not a config field.
/// During `[submission_ends_at, expires_at)` the poster can still settle
/// manually; after `expires_at` only refund is allowed.
pub const REVIEW_WINDOW_SECS: i64 = 90 * 24 * 60 * 60;
