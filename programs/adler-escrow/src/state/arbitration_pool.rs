use anchor_lang::prelude::*;

/// Singleton pool of arbiters allowed to call `arbitrate`. Mirrors Firestore
/// `roles/{uid}.role == "arbiter"` — the `arbiterSync` Cloud Function is the
/// upstream writer.
///
/// Seeds: `[b"arb_pool"]`. See `docs/v1-design.md` §2.2.
#[account]
#[derive(InitSpace)]
pub struct ArbitrationPool {
    /// Admin pubkey allowed to add/remove arbiters. Initially copies
    /// `ProtocolConfig.admin`.
    pub admin: Pubkey,
    /// Up to 16 entries. `add_arbiter` rejects past this cap with `PoolFull`.
    #[max_len(16)]
    pub arbiters: Vec<Pubkey>,
    /// Quorum is 1 in v1 (single-arbiter resolution). Field is reserved for
    /// post-v1 multi-sig arbitration; not enforced by `arbitrate` yet.
    pub quorum: u8,
    /// Number of contracts currently in the `Disputed` state. Maintained by
    /// `open_dispute` (++) and `arbitrate` (--). The `remove_arbiter`
    /// last-arbiter guard reads this to keep open disputes resolvable.
    pub disputed_count: u32,
    pub bump: u8,
}

pub const ARBITRATION_POOL_SEED: &[u8] = b"arb_pool";
