use anchor_lang::prelude::*;

/// What kind of contract this escrow represents. See `docs/v1-design.md` §3.1.
///
/// `Service` contracts have the creator known at fund time (brand bought a
/// listed service). `Gig` contracts start unbound — brand pre-locks the
/// budget and the creator slot is filled later via `bind_creator`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Kind {
    Service,
    Gig,
}

/// Live state of a `ContractEscrow`. Terminal states (`Settled`, `Refunded`,
/// `Resolved`) are not represented — the PDA is closed in those cases and
/// `ContractRecord` carries the terminal outcome via `SettledOutcome`.
///
/// See `docs/v1-design.md` §3.2.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum State {
    /// Gig only — no creator bound yet.
    Funded,
    /// Creator known; awaiting delivery.
    Bound,
    /// Creator submitted; awaiting approval, revision, or dispute.
    Delivered,
    /// Either party filed; locked until `arbitrate` resolves.
    Disputed,
}

/// Arbitration outcome enum. Used by `arbitrate` (Phase 5) and stored on
/// `ContractRecord` via `SettledOutcome::Resolved(_)`. Defined upfront so the
/// IDL is stable across phases.
///
/// See `docs/v1-design.md` §3.3.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Outcome {
    Release,
    Refund,
    Split { creator_bps: u16 },
}

/// Terminal outcome stored on `ContractRecord`. `Refunded` is not represented:
/// `brand_refund` and `cancel_unbound_gig` produce no record at all (no rating
/// to be made for a refund). See `docs/v1-design.md` §3.4.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum SettledOutcome {
    /// Set by `approve_release` or `auto_release`.
    Settled,
    /// Set by `arbitrate`.
    Resolved(Outcome),
}
