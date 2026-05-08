use anchor_lang::prelude::*;

/// Per-(subject, contract_id) reputation entry. Immutable after mint.
///
/// Seeds: `[b"rep", subject.key().as_ref(), &contract_id]`. The subject-keyed
/// seed lets indexers compute "all reputation for user X" via
/// `getProgramAccounts(filter: subject==X)` without joining back to the
/// contract record.
///
/// See `docs/v1-design.md` §2.5.
#[account]
#[derive(InitSpace)]
pub struct ReputationCard {
    /// The `ContractRecord` PDA — frozen pointer to which contract this
    /// reputation came from.
    pub record: Pubkey,
    /// Whichever counterparty rated.
    pub reviewer: Pubkey,
    /// The other counterparty (`reviewer != subject` enforced).
    pub subject: Pubkey,
    /// scope / communication / timeliness / quality, each 1..=5. Whitepaper §7.
    pub axes: [u8; 4],
    /// sha256 of the off-chain comment (the comment lives in Firestore;
    /// length-bounded by the web schema).
    pub comment_hash: [u8; 32],
    /// Snapshot of `record.price_lamports` for amount-weighted aggregates:
    /// `Σ(meanOfAxes × amountSol) / Σ(amountSol)`.
    pub amount_lamports: u64,
    pub timestamp: i64,
    pub bump: u8,
}

pub const REPUTATION_SEED: &[u8] = b"rep";
