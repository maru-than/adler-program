# Adler Escrow v1.0 — Hackathon Submission

**Program (devnet):** [`BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr`](https://explorer.solana.com/address/BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr?cluster=devnet)
**IDL (devnet):** `6qCpi4JQYj924CkoFWkD8M5RXUbnV61oLPcLLWVhhuEB` (fetch via `anchor idl fetch`)
**Source of truth:** [`docs/v1-design.md`](./v1-design.md)

---

## What is Adler?

Adler is a Solana-native marketplace for short-form user-generated content.
Brands either buy listed creator services off the shelf or post **gigs**
(custom briefs that creators apply to). The differentiator is the
settlement model: every contract is funded into a per-contract on-chain
escrow at match time, and funds release atomically on creator delivery +
brand approval. Reputation is minted on-chain as a side-effect of every
settled contract.

Full product context: [`PRODUCT.md`](../PRODUCT.md).

This repo is the on-chain settlement layer. The web client (Next.js +
Privy + Firestore) lives at `../adler-website` and is currently in
Phase 1.D-E of the integration plan.

---

## What's on-chain

**18 instructions, 5 account types, 24 errors.** Full surface walkthrough
in [`docs/v1-design.md`](./v1-design.md); short summary below.

### Account model (PDAs)

| PDA | Seeds | Lifecycle |
|---|---|---|
| `ProtocolConfig` | `[b"config"]` | Singleton; init once, mutated by admin ix |
| `ArbitrationPool` | `[b"arb_pool"]` | Singleton; init once, admin manages arbiters |
| `ContractEscrow` | `[b"contract", brand, contract_id]` | Per contract; init at fund, closed at terminal |
| `ContractRecord` | `[b"record", brand, contract_id]` | Written by closing ix; immutable |
| `ReputationCard` | `[b"rep", subject, contract_id]` | Per (subject, contract); immutable |

### Instruction surface

```
Admin                 — init_protocol, update_protocol_field, set_paused
Arbitration pool      — init_arbitration_pool, add_arbiter, remove_arbiter
Service path          — fund_service
Gig path              — fund_gig, bind_creator, cancel_unbound_gig
Lifecycle             — submit_delivery, request_revision,
                        approve_release, auto_release, brand_refund
Disputes              — open_dispute, arbitrate
Reputation            — mint_reputation
```

### State machine

```
Service path:
  Bound ──submit_delivery──▶ Delivered ──approve_release──▶ ◯ Settled
                                  │
                                  ├──auto_release (after deadline)──▶ ◯ Settled
                                  │
                                  ├──request_revision──▶ Bound (max 2)
                                  │
                                  └──open_dispute──▶ Disputed ──arbitrate──▶ ◯ Resolved

Gig path:
  Funded ──bind_creator──▶ Bound ──[same as service from Bound]──▶
     │
     └──cancel_unbound_gig──▶ ◯ Refunded (no record)

Brand reclaim:
  Bound ──brand_refund (after delivery_deadline + grace)──▶ ◯ Refunded
```

`◯` = terminal. `ContractEscrow` is closed. `ContractRecord` is written for
`Settled` and `Resolved` outcomes; not for `Refunded`.

### Lamport flow per terminal

| Outcome | creator gets | brand gets | treasury gets |
|---|---|---|---|
| `approve_release` / `auto_release` | `price` | `rent` | `fee` |
| `arbitrate(Release)` | `price` | `rent` | `fee` |
| `arbitrate(Refund)` | 0 | `price + fee + rent` | 0 |
| `arbitrate(Split{n})` | `floor(price * n / 10_000)` | `price - that + rent` | `fee` |
| `brand_refund` / `cancel_unbound_gig` | 0 | `price + fee + rent` | 0 |

**Invariant:** for every row, `creator + brand + treasury == price + fee + rent`.

---

## Test coverage

**76 cases passing on localnet** in ~3 minutes. Run:

```bash
anchor test
# (uses scripts/run-tests.sh under the hood — see docs/toolchain.md
# for why we don't use Anchor's default test runner)
```

Coverage by module:

| Module | Cases | Notes |
|---|---|---|
| `protocol_config` | 6 | init defaults + double-init + admin gate + pause + update + invalid-deadline |
| `arbitration_pool` | 8 | init + add/remove + duplicate + non-admin + cross-link |
| `fund_service` | 4 | happy + InvalidPrice + Paused + double-fund |
| `fund_gig` | 4 | happy + InvalidPrice + InvalidDeadline + Paused |
| `bind_creator` | 5 | happy + idempotent + different-creator + non-brand + after-delivery |
| `cancel_unbound_gig` | 3 | happy + after-bind + non-brand |
| `submit_delivery` | 3 | happy + non-creator + double-delivery |
| `request_revision` | 6 | happy + full-cycle + cap + deadline-reset + Bound + non-brand |
| `approve_release` | 4 | happy + Bound + non-brand + wrong-treasury |
| `auto_release` | 3 | happy (post-deadline) + Bound (v0.1 bug fix) + too-early |
| `brand_refund` | 4 | happy + before-grace + Delivered + non-brand |
| `open_dispute` | 6 | brand + creator + third-party + Funded + locks-deliver + locks-approve |
| `arbitrate` | 8 | Release + Refund + Split{0,5000} + InvalidBps + non-pool + WrongState + Split-invariant for {2500, 7500} |
| `mint_reputation` | 10 | both directions + 3 settled outcomes + 6 negatives |
| `flow: service happy path` | 1 | end-to-end fund → deliver → approve |
| `flow: gig happy path` | 1 | end-to-end fund_gig → bind → deliver → approve |

### Devnet smoke test

[`tests/devnet-smoke.ts`](../tests/devnet-smoke.ts) — one-shot script that
runs the full service flow against the deployed devnet program and asserts
lamport movements. Required before each redeploy promotion.

```bash
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=$HOME/.config/solana/id.json \
npx ts-node --compiler-options '{"module":"commonjs"}' tests/devnet-smoke.ts
```

---

## Security review (audit pass)

External audit is **out of scope for the hackathon submission per
[`TODO.md`](../TODO.md) → Mainnet** and is the gating requirement before
any mainnet lamport flows. This section captures the internal audit pass
done at the end of Phase 7.

### Re-entrancy

Solana's runtime executes one CPI at a time per top-level transaction;
cross-program re-entrancy is prevented by the loader (a program cannot
call itself recursively). Within a single ix, lamport mutations happen on
already-borrowed accounts via `try_borrow_mut_lamports` — no second
mutable borrow path. **Re-entrancy is structurally impossible.**

### Overflow

All arithmetic on `u64` lamports uses `checked_mul` / `checked_add` /
`checked_sub` and surfaces `EscrowError::Overflow` on wrap. The release
profile in `Cargo.toml` sets `overflow-checks = true` so even unchecked
ops would panic deterministically.

Worst-case bounds:
- `price * fee_bps`: max 1e16 (at price = 10_000 SOL, fee_bps = 1000).
  `u64::MAX = 1.8e19`. Safety margin: 3 orders of magnitude.
- `price * creator_bps`: same bound. Same margin.
- `now + window_secs`: i64 timestamp + window. Max meaningful sum well
  under i64::MAX.

### Lamport flow

Every terminal ix moves lamports through one of two patterns:

**Pattern A (full close):** `close = brand` moves the entire PDA balance
to brand. Used by `brand_refund`, `cancel_unbound_gig`, `arbitrate(Refund)`.
No partial movement; rent calculation is implicit. **Safe.**

**Pattern B (partial transfer + close):** `**escrow.lamports -= X` followed
by `**recipient.lamports += X` for each recipient (creator, treasury), then
`close = brand` moves the residual. Used by `approve_release`,
`auto_release`, `arbitrate(Release)`, `arbitrate(Split)`.

Pattern B's safety relies on the lamport invariant `pre_balance >= price +
fee` at the moment partial transfers run. The PDA was funded with `price +
fee + rent` and only mutated by ix that maintain this invariant — verified
by inspection of every code path.

### Signer authority

Every settlement ix has exactly one or two valid signers, encoded via
Anchor account constraints:

- `has_one = brand` / `has_one = creator` / `has_one = fee_treasury` —
  enforces that the supplied accounts match what was snapshotted at fund
  time. Stored snapshot is the source of truth; arg can't override.
- Custom `require!(signer == brand || signer == creator, NotAParty)` for
  `open_dispute` (only ix where two unrelated signers are valid).
- `require!(pool.arbiters.contains(&signer), ArbiterNotInPool)` for
  `arbitrate`.
- Admin ix gate via `has_one = admin` against `ProtocolConfig` /
  `ArbitrationPool`.

`auto_release` is intentionally permissionless (any signer); rent still
returns to brand because `close = brand` is hardcoded.

### Time

`Clock::get()?.unix_timestamp` is the only time source. Slot timestamps
can drift from wall-clock by minutes under network stress; deadlines are
coarse (24h+) so this is non-issue.

### State machine

Every ix that mutates state explicitly checks the precondition state.
`auto_release` gates on `Delivered` (not `Funded`) — fixes v0.1's bug where
auto-release could fire on never-delivered contracts and pay creators for
nothing.

### Pause switch

`set_paused(true)` blocks every settlement-mutating ix
(`fund_service`, `fund_gig`, `bind_creator`, `cancel_unbound_gig`,
`submit_delivery`, `request_revision`, `approve_release`, `auto_release`,
`brand_refund`, `open_dispute`, `arbitrate`) with `ProtocolPaused`.

Admin ix and `mint_reputation` are intentionally **not** blocked: admins
need to act in an emergency, and reputation minting on already-settled
contracts is a closed transaction — there's no risk to pausing it.

### PDA validation

PDA seeds embed `brand` (the funder) → an attacker cannot swap an
unrelated brand into an instruction without the PDA mismatch failing the
bump check. `has_one` constraints further enforce that supplied account
pubkeys match the snapshot.

### Admin compromise scenarios

`config.admin` can mutate fees, treasury, deadlines, and the pause flag.
On devnet this is a single key (`DfTwUKsEJjpTwTC4hHDPQDMtSfxH3iKibbVQnHp1Ff8z`).
**Mainnet rotation to a Squads multisig is the gating requirement before
mainnet deploy** (see `TODO.md` → Mainnet).

`update_protocol_field` is per-field-typed-enum so audit logs show exactly
what changed — no opaque batch updates.

### What's NOT covered

- **Rust `proptest` for Split math** is deferred to the external audit.
  Currently we have a JS-side property check at two bps values
  (`{2500, 7500}`); a real `proptest` over u64 random space lives in the
  Phase 7 follow-up.
- **MEV / front-running** is not a concern for this design — every
  settlement ix has a deterministic outcome regardless of execution order.
- **Re-entrancy via arbitrary CPI** is not applicable — this program does
  not invoke arbitrary user-supplied programs; only `system_program::transfer`.

---

## What's not done (post-hackathon)

| | Item |
|---|---|
| 1 | **External audit** — gating requirement for mainnet lamport flows. |
| 2 | **Multisig upgrade authority** — rotate to a 2-of-3 Squads. |
| 3 | **Mainnet deploy + bootstrap** — flip the cluster gate after audit + multisig. |
| 4 | **Web integration** — `lib/anchor/*` + `lib/escrow/*` wrappers in `../adler-website` (Phase 1.D); flow swap from `transferSolWithFee.ts` to real ix (Phase 1.E). |
| 5 | **Cloud Functions** — `onChainStateWatcher`, `autoReleaseSweeper`, `arbiterSync` in `../adler-app` (Phase 1.F + Phase 2 + Phase 5 cross-cuts). |
| 6 | **Devnet treasury keypair** — currently a random pubkey from an early test run. Replace via `update_protocol_field`. |

Tracked in [`TODO.md`](../TODO.md).

---

## How to demo

```bash
# 1. Run the test suite locally
anchor test
# → 76 passing in ~3 minutes

# 2. Run the smoke against live devnet
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=$HOME/.config/solana/id.json \
npx ts-node --compiler-options '{"module":"commonjs"}' tests/devnet-smoke.ts
# → prints Explorer URLs for each tx
```

Each test name in the suite tells the story it's verifying — read the
output of `anchor test` for the lifecycle walkthrough.

---

## Repo

| Path | Contents |
|---|---|
| `programs/adler-escrow/src/state/` | 5 PDA structs + 4 enums + `contract_id` deriver |
| `programs/adler-escrow/src/instructions/` | 18 ix handlers, one file each |
| `programs/adler-escrow/src/errors.rs` | 24-code v1 error set |
| `programs/adler-escrow/src/lib.rs` | `#[program]` dispatch |
| `tests/*.test.ts` | 14 test files, 76 cases |
| `tests/helpers/setup.ts` | shared PDAs + fixtures + `withShrunkenWindows` |
| `tests/devnet-smoke.ts` | one-shot live-cluster smoke |
| `scripts/deploy-devnet.sh` | idempotent build + deploy + IDL init|upgrade |
| `scripts/sync-idl.sh` | push IDL + types into `../adler-website` |
| `scripts/bootstrap-devnet.ts` | init `ProtocolConfig` + `ArbitrationPool` |
| `scripts/run-tests.sh` | `anchor test` workaround for Solana 3.x deploy race |
| `docs/v1-design.md` | full PDA + ix + lamport-flow spec |
| `docs/approval-deadline.md` | 72 h / 24 h policy + rationale |
| `docs/toolchain.md` | pinned versions + setup |
| `docs/build-vs-buy.md` | rationale for custom Anchor over Streamflow / Squads / Helio |

---

*Built for the [Solana Colosseum Breakout Hackathon](https://www.colosseum.com/breakout).*
