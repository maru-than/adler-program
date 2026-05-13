use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero.")]
    InvalidAmount,
    #[msg("Protocol is paused.")]
    ProtocolPaused,
    #[msg("Bounty has expired; only refund is allowed.")]
    BountyExpired,
    #[msg("Bounty has not yet expired; refund is not allowed.")]
    RefundBeforeExpiry,
    #[msg("bounty_id arg does not match the PDA's bounty_id.")]
    BountyIdMismatch,
    #[msg("Poster pubkey on the instruction does not match the PDA's poster.")]
    PosterMismatch,
    #[msg("Fee treasury pubkey does not match ProtocolConfig.fee_treasury.")]
    FeeTreasuryMismatch,
    #[msg("Arithmetic overflow.")]
    Overflow,
    #[msg("Singleton PDA is already initialized.")]
    AlreadyInitialized,
}
