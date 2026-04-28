# adler-escrow

Solana program (Anchor) backing the [Adler](https://github.com/maru-than/adler-website) UGC marketplace. Brand-funded escrow with creator-approved release, 72h auto-release fallback, and dispute arbitration.

## What this program does

One PDA per contract. Money flows through the program, never through Adler.

| Instruction | Signer | Effect |
|---|---|---|
| `fund_escrow` | brand | Init PDA, transfer `price + fee` lamports in, set state=Funded |
| `approve_release` | brand | Atomic: PDA → creator (`price`), PDA → fee_treasury (`fee`), close PDA |
| `auto_release` | anyone | Same as approve, but only callable when `now >= approval_deadline` |
| `brand_refund` | brand | Reclaim escrow if creator missed delivery + 24h grace |
| `open_dispute` | brand or creator | Flip Funded → Disputed |
| `arbitrate` | arbitration_authority | `release` / `refund` / `split(num, denom)` — only on Disputed PDAs |

PDA seeds: `[b"escrow", brand.key().as_ref(), &contract_id]`. The `arbitration_authority` is stored per-PDA at fund time (not a global program constant) so different Adler product lines could use different arbitrators.

## Quickstart

Prereqs: `rustup`, `solana-cli` 2.x+, `avm` + `anchor-cli` 0.31. Toolchain notes in [toolchain.md](docs/toolchain.md).

```bash
# Build
anchor build

# Test (LiteSVM-backed, ~2s per test)
anchor test --skip-deploy

# Deploy to devnet
solana config set --url devnet
solana airdrop 5                                          # ~3 SOL needed for buffer
anchor deploy --provider.cluster devnet
```

After deploy, the IDL is at `target/idl/adler_escrow.json` — copy into `adler-website/lib/anchor/idl.ts`.

## Devnet program ID

`3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD`

- [Solana Explorer (program)](https://explorer.solana.com/address/3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD?cluster=devnet)
- [Initial deploy tx](https://explorer.solana.com/tx/3Q7DadWVvKVjkwd9GaHkFyKpmL8PHdjAoPYTPYrht4t7qNe6rEWC9x68NqCmonbjvwax8xGyzFS5MeNii8rYiZnP?cluster=devnet)
- IDL on-chain at `AP5ZczRDa1RcfAzkhj8qsySumPKFJ3Bm4YkEYqkvzZJL` — fetchable via `anchor idl fetch 3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD --provider.cluster devnet`
- Upgrade authority: `DfTwUKsEJjpTwTC4hHDPQDMtSfxH3iKibbVQnHp1Ff8z` (still upgradable; will become a multisig before mainnet)

## Repository layout

```
programs/adler-escrow/
  src/
    lib.rs                  # entry: declare_id! + #[program] dispatch
    state.rs                # EscrowAccount + EscrowState enum
    errors.rs               # custom error codes
    instructions/
      fund_escrow.rs
      approve_release.rs
      auto_release.rs
      brand_refund.rs
      open_dispute.rs
      arbitrate.rs
tests/
  adler-escrow.ts           # full happy + negative paths
```

## Why custom Anchor (and not Streamflow / Squads / Helio)

Spike summary, full notes in [docs/build-vs-buy.md](docs/build-vs-buy.md):

- **Streamflow** is linear vesting — wrong primitive for "0% then 100% on approval."
- **Squads** would force Adler to co-sign every settlement — violates self-custody.
- **Helio / Sphere / Crossmint** are payment processors that take custody.

Custom Anchor is ~250 LoC and exactly fits PRODUCT.md §6. Audited pre-mainnet (out of scope for this hackathon).

## Sibling repo

The Adler workspace + landing live at https://github.com/maru-than/adler-website. This program is consumed via `lib/anchor/idl.ts` and `lib/escrow/anchor.ts` over there.

## License

TBD pre-launch.
