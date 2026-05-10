use anchor_lang::prelude::*;

/// Singleton protocol policy. Stores tunable fields and the kill switch.
/// Seeds: `[b"config"]`.
#[account]
#[derive(InitSpace)]
pub struct ProtocolConfig {
    /// Pubkey allowed to call `update_protocol_field` and `set_paused`.
    pub admin: Pubkey,
    /// Custodial verifier keypair held by the off-chain Cloud Function.
    /// Required signer for `settle_auto_bounty`. Set at init; rotatable via
    /// `update_protocol_field`.
    pub verifier_pubkey: Pubkey,
    /// Protocol fee in basis points (default 50 = 0.5 %).
    pub fee_bps: u16,
    /// Lamport sink for protocol fees. Snapshotted onto every bounty at
    /// create time.
    pub fee_treasury: Pubkey,
    /// Kill switch. When `true`, settlement-mutating ix early-return with
    /// `ProtocolPaused`.
    pub paused: bool,
    pub bump: u8,
}

/// Single-field update enum for `update_protocol_field`. Per-field typing
/// keeps audit logs precise.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum ConfigField {
    Admin { value: Pubkey },
    VerifierPubkey { value: Pubkey },
    FeeBps { value: u16 },
    FeeTreasury { value: Pubkey },
}

pub const PROTOCOL_CONFIG_SEED: &[u8] = b"config";
