# adler-escrow

> Package manager: **pnpm** (use `pnpm install`, not npm).

Solana program (Anchor) backing the [Adler](../adler-website) UGC marketplace.
On-chain settlement for brand → creator contracts: per-contract escrow,
delivery + revision lifecycle, multi-arbiter dispute resolution, and on-chain
reputation minted as a side-effect of settlement.

**v1.0 program (devnet):** [`BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr`](https://explorer.solana.com/address/BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr?cluster=devnet)

**Status:** program-complete (18 instructions, 76 tests pass on localnet,
smoke test passes on devnet). External audit + multisig upgrade authority are
the gating requirements before mainnet — see [`TODO.md`](TODO.md).

For the full architectural walkthrough, see [`docs/v1-design.md`](docs/v1-design.md).
For the hackathon submission writeup, see [`docs/submission.md`](docs/submission.md).

## What this program does

One PDA per contract. Money flows through the program, never through Adler.

The 18 instructions cluster into six groups:

| Group | Instructions |
|---|---|
| **Admin** | `init_protocol`, `update_protocol_field`, `set_paused` |
| **Arbitration pool** | `init_arbitration_pool`, `add_arbiter`, `remove_arbiter` |
| **Service path** | `fund_service` |
| **Gig path** | `fund_gig`, `bind_creator`, `cancel_unbound_gig` |
| **Lifecycle** | `submit_delivery`, `request_revision`, `approve_release`, `auto_release`, `brand_refund` |
| **Disputes** | `open_dispute`, `arbitrate` |
| **Reputation** | `mint_reputation` |

Five PDAs hold protocol state: `ProtocolConfig` (singleton, runtime-tunable
policy), `ArbitrationPool` (singleton, up to 16 arbiters), `ContractEscrow`
(per contract; closed at terminal), `ContractRecord` (per settled contract;
immutable, read by `mint_reputation`), and `ReputationCard` (per
(subject, contract); immutable).

## Quickstart

Toolchain pinned in [`docs/toolchain.md`](docs/toolchain.md): Anchor 0.31.1,
Solana CLI 3.1.x, Rust stable (1.79+), Node 20+.

```bash
# Install deps
npm install

# Build + run the full test suite (validator boots automatically)
anchor test
# → 76 passing in ~3 minutes

# Deploy to devnet (idempotent)
solana config set --url devnet
solana airdrop 5
scripts/deploy-devnet.sh

# Bootstrap on first deploy only
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=$HOME/.config/solana/id.json \
ADLER_DEVNET_TREASURY=<base58 pubkey> \
npx ts-node --compiler-options '{"module":"commonjs"}' scripts/bootstrap-devnet.ts

# Push IDL + types into the sibling adler-website repo
scripts/sync-idl.sh

# Smoke test against live devnet (requires bootstrapped state)
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=$HOME/.config/solana/id.json \
npx ts-node --compiler-options '{"module":"commonjs"}' tests/devnet-smoke.ts
```

After deploy, the IDL is at `target/idl/adler_escrow.json` and on-chain at
`6qCpi4JQYj924CkoFWkD8M5RXUbnV61oLPcLLWVhhuEB` (devnet); `anchor idl fetch`
will retrieve it.

## Devnet program IDs

| Version | Program ID | Status |
|---|---|---|
| **v1.0** | `BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr` | [Explorer](https://explorer.solana.com/address/BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr?cluster=devnet) — current |
| **v0.1** | `3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD` | [Explorer](https://explorer.solana.com/address/3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD?cluster=devnet) — superseded; preserved as the museum reference. v0.1 source at git tag `v0.1`. |

Upgrade authority for v1.0 is `DfTwUKsEJjpTwTC4hHDPQDMtSfxH3iKibbVQnHp1Ff8z`
(single key on devnet; rotates to a Squads multisig before mainnet).

## Repository layout

```
programs/adler-escrow/src/
  lib.rs                    declare_id! + #[program] dispatch (18 ix)
  errors.rs                 24-code v1 error set
  state/
    enums.rs                Kind, State, Outcome, SettledOutcome
    contract_id.rs          sha256 derive() + parity test vectors
    protocol_config.rs      ProtocolConfig + ConfigField
    arbitration_pool.rs     ArbitrationPool (max 16 arbiters)
    contract_escrow.rs      ContractEscrow (per-contract vault)
    contract_record.rs      ContractRecord (settled snapshot)
    reputation_card.rs      ReputationCard (per-subject)
  instructions/
    [18 files, one per ix — admin / arbitration / service / gig / lifecycle / disputes / reputation]

tests/
  helpers/setup.ts          PDAs + airdrop + ensureProtocolInitialized + ensureArbitrationPoolInitialized + withShrunkenWindows
  *.test.ts                 14 test files, 76 cases
  devnet-smoke.ts           one-shot live-cluster smoke

scripts/
  deploy-devnet.sh          build + deploy + idl init|upgrade (idempotent)
  sync-idl.sh               push IDL + types to ../adler-website
  bootstrap-devnet.ts       init ProtocolConfig + ArbitrationPool (idempotent)
  run-tests.sh              anchor-test wrapper (validator + preload + mocha)

docs/
  v1-design.md              full PDA + ix + lamport-flow spec
  approval-deadline.md      72 h / 24 h policy + rationale
  toolchain.md              pinned versions + setup notes
  build-vs-buy.md           why custom Anchor over Streamflow / Squads / Helio
  submission.md             hackathon writeup (read first)
```

## Why custom Anchor (and not Streamflow / Squads / Helio)

Spike summary; full notes in [`docs/build-vs-buy.md`](docs/build-vs-buy.md):

- **Streamflow** is linear vesting — wrong primitive for "0% then 100% on
  approval."
- **Squads** would force Adler to co-sign every settlement — violates
  non-custody.
- **Helio / Sphere / Crossmint** are payment processors that take custody
  and charge subscription-style fees on top of network fees.

Custom Anchor is ~1500 LoC and exactly fits PRODUCT.md §6. External audit is
out of scope for the hackathon; gating requirement for mainnet.

## Sibling repos

- [`../adler-website`](https://github.com/maru-than/adler-website) — Next.js
  desktop client. Consumes this program via `lib/anchor/idl.ts` (synced
  from `target/idl/adler_escrow.json` by `scripts/sync-idl.sh`).
- `../adler-app` — Firebase Cloud Functions. Houses
  `onChainStateWatcher`, `autoReleaseSweeper`, `arbiterSync`. Cross-repo
  work tracked in [`TODO.md`](TODO.md) under **Settlement flows**.

## License

Licensed under the [Apache License, Version 2.0](LICENSE).
