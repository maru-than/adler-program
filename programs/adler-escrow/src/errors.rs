use anchor_lang::prelude::*;

/// All program errors. Some codes (`ArbiterNotInPool`, `InvalidAxis`,
/// `RevisionCapReached`, etc.) are unused in Phase 1 but defined upfront so
/// the IDL is stable across phases.
///
/// See `docs/v1-design.md` §7.
#[error_code]
pub enum EscrowError {
    // ── Carried over from v0.1 ───────────────────────────────────────────

    #[msg("Price must be greater than zero.")]
    InvalidPrice,
    #[msg("Brand pubkey on the instruction does not match the PDA's brand.")]
    BrandMismatch,
    #[msg("Creator pubkey on the instruction does not match the PDA's creator.")]
    CreatorMismatch,
    #[msg("Fee treasury pubkey does not match ProtocolConfig.fee_treasury.")]
    FeeTreasuryMismatch,
    #[msg("Arithmetic overflow.")]
    Overflow,

    // ── New in v1 ────────────────────────────────────────────────────────

    #[msg("Protocol is paused; settlement-mutating instructions are blocked.")]
    ProtocolPaused,
    #[msg("Signer is not a party to this contract.")]
    NotAParty,
    #[msg("Revision cap (2) reached; the next step is open_dispute.")]
    RevisionCapReached,
    #[msg("Contract is not in the required state for this instruction.")]
    WrongState,
    #[msg("Delivery deadline has not yet passed.")]
    DeliveryDeadlineNotReached,
    #[msg("Approval deadline has not yet passed.")]
    ApprovalDeadlineNotReached,
    #[msg("Refund grace window has not yet elapsed.")]
    RefundGraceActive,
    #[msg("Reputation axis must be between 1 and 5 inclusive.")]
    InvalidAxis,
    #[msg("Split creator_bps must be <= 10_000.")]
    InvalidBps,
    #[msg("Signer is not a member of the arbitration pool.")]
    ArbiterNotInPool,
    #[msg("contract_id arg does not match the PDA's contract_id.")]
    ContractIdMismatch,
    #[msg("Brand transferred the wrong fee amount.")]
    FeeMismatch,
    #[msg("Arbitration pool is full (max 16 arbiters).")]
    PoolFull,
    #[msg("Pubkey is already in the arbitration pool.")]
    DuplicateArbiter,
    #[msg("Cannot remove the last arbiter while disputes are open.")]
    LastArbiterWithDisputes,
    #[msg("Deadline argument is invalid (must be in the future).")]
    InvalidDeadline,
    #[msg("Singleton PDA is already initialized.")]
    AlreadyInitialized,
    #[msg("Reviewer cannot rate themselves.")]
    SelfRating,
    #[msg("Cannot mint reputation for a refund-resolved contract.")]
    NotRatable,
}
