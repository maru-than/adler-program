use anchor_lang::prelude::*;

/// Singleton protocol policy. Stores tunable fields and the kill switch.
/// Seeds: `[b"config"]`. See `docs/v1-design.md` §2.1.
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    /// Pubkey allowed to call `update_protocol_field` and `set_paused`.
    pub admin: Pubkey,
    /// Protocol fee in basis points (default 50 = 0.5 %).
    pub fee_bps: u16,
    /// Lamport sink for protocol fees. Snapshotted onto every contract at fund time.
    pub fee_treasury: Pubkey,
    /// Default 72 × 3600 = 259_200. Pinned in `docs/approval-deadline.md`.
    pub approval_window_secs: i64,
    /// Default 24 × 3600 = 86_400. Pinned in `docs/approval-deadline.md`.
    pub refund_grace_secs: i64,
    /// Set by `init_arbitration_pool` (Phase 5). `Pubkey::default()` until then.
    pub arbitration_pool: Pubkey,
    /// Kill switch. When `true`, settlement-mutating ix early-return with
    /// `ProtocolPaused`. Reads, `mint_reputation`, and admin ix continue to work.
    pub paused: bool,
    pub bump: u8,
}

/// Single-field update enum for `update_protocol_field`. Per-field typing
/// makes audit logs precise — the ix args show exactly what changed. Struct
/// variants (named `value`) keep the TS-binding shape unambiguous across
/// Anchor versions: `{ admin: { value: pubkey } }`, `{ feeBps: { value: 100 } }`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum ConfigField {
    Admin { value: Pubkey },
    FeeBps { value: u16 },
    FeeTreasury { value: Pubkey },
    ApprovalWindowSecs { value: i64 },
    RefundGraceSecs { value: i64 },
    ArbitrationPool { value: Pubkey },
}

pub const PROTOCOL_CONFIG_SEED: &[u8] = b"config";
