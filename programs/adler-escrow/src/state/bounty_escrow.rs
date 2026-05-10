use anchor_lang::prelude::*;

/// Per-bounty escrow PDA. Holds `amount + fee + rent` lamports until
/// terminal (settle or refund — both close the PDA).
///
/// Seeds: `[b"bounty", poster.key().as_ref(), &bounty_id]`.
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
    /// 0 = Manual (poster signs settle), 1 = Auto (verifier_pubkey signs).
    pub mode: u8,
    /// `now + BOUNTY_EXPIRY_SECS` at create. After this slot timestamp,
    /// `refund_bounty` can be called by anyone.
    pub expires_at: i64,
    pub bump: u8,
}

pub const BOUNTY_ESCROW_SEED: &[u8] = b"bounty";

/// 30 days. Fixed; not a config field for v1.
pub const BOUNTY_EXPIRY_SECS: i64 = 2_592_000;

pub const MODE_MANUAL: u8 = 0;
pub const MODE_AUTO: u8 = 1;
