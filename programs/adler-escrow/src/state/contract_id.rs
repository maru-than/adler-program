use anchor_lang::solana_program::hash::hashv;

/// Deterministic 32-byte derivation of the on-chain `contract_id` from the
/// off-chain identifier (Firestore order id or gig id).
///
/// The TypeScript side at `../adler-website/lib/anchor/pda.ts` computes the
/// same digest in `lib/anchor/pda.test.ts`. Drift between the two
/// implementations causes silent PDA mismatch — the parity test on the web
/// side is the CI gate that catches it.
///
/// See `docs/v1-design.md` §4.
pub fn derive(off_chain_id: &str) -> [u8; 32] {
    hashv(&[off_chain_id.as_bytes()]).to_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic() {
        assert_eq!(derive("test-order-001"), derive("test-order-001"));
    }

    #[test]
    fn derive_differs_per_input() {
        assert_ne!(derive("test-order-001"), derive("test-order-002"));
    }

    #[test]
    fn derive_returns_32_bytes() {
        assert_eq!(derive("test-order-001").len(), 32);
    }

    #[test]
    fn empty_input_still_returns_32_bytes() {
        assert_eq!(derive("").len(), 32);
    }
}
