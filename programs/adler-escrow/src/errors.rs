use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Price must be greater than zero.")]
    InvalidPrice,
    #[msg("Approval deadline must be in the future.")]
    InvalidDeadline,
    #[msg("Brand pubkey on the instruction does not match the PDA's brand.")]
    BrandMismatch,
    #[msg("Creator pubkey on the instruction does not match the PDA's creator.")]
    CreatorMismatch,
    #[msg("Fee treasury pubkey on the instruction does not match the PDA's fee_treasury.")]
    FeeTreasuryMismatch,
    #[msg("Arbitrator pubkey on the instruction does not match the PDA's arbitration_authority.")]
    ArbitratorMismatch,
    #[msg("Escrow is not in the Funded state.")]
    NotFunded,
    #[msg("Escrow is not in the Disputed state.")]
    NotDisputed,
    #[msg("approval_deadline has not yet passed.")]
    DeadlineNotReached,
    #[msg("Refund grace window has not yet elapsed.")]
    RefundGraceActive,
    #[msg("Split numerator/denominator is invalid (denom must be > 0 and num <= denom).")]
    InvalidSplit,
    #[msg("Arithmetic overflow.")]
    Overflow,
}
