# Adler Escrow — TODO

`[X]` shipped · `[+]` in progress · `[ ]` not started

This file is the source of truth for the on-chain side of Adler. The web
client lives in [`../adler-website`](../adler-website) and tracks its own
work in [`../adler-website/TODO.md`](../adler-website/TODO.md) — items there
that depend on this program ship are cross-referenced from the **Web
integration** + **Settlement flows** groups below.

## Versioning

| Version | Status | Devnet program ID |
|---|---|---|
| **v0.1** | Deployed, tested, **superseded** | `3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD` |
| **v1.0** | Phases 0–7 complete (18 ix, 76 localnet tests + devnet smoke pass; submission docs written). Cross-repo (web + cloud) work outstanding. | `BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr` |

v0.1 is a single-purpose buyer→seller escrow with one global arbiter pubkey
per PDA. It works and is deployed, but it does not cover Adler's gig path,
multi-arbiter pool, on-chain reputation, or runtime-tunable policy — all of
which the web client + whitepaper assume. **v1.0 is the hackathon submission
target.** Account layouts change, so v1.0 deploys to a fresh program ID; v0.1
is preserved for reference only.

## Group taxonomy (canonical)

These are the **only** group labels allowed in this file. Stable across
sessions so any agent reading it knows the schema. Use them verbatim.

- **Do not invent new groups.** If an item doesn't fit, expand the closest
  group's scope.
- **Empty groups may be omitted** from the active list below — the
  taxonomy here is the source of truth for what exists.
- **Order is fixed** (program → tests → devnet → integration → flows →
  mainnet → ops): keep group sections below in this order.

| Group | Scope |
|---|---|
| **Program** | Anchor program source: `lib.rs`, `state.rs`, `errors.rs`, instruction handlers, PDA layout, account validation |
| **Tests** | Anchor + LiteSVM test suite, happy + negative paths, property tests, devnet smoke |
| **Devnet** | Devnet deploy, IDL upload, program ID pinning, upgrade authority, treasury keypair |
| **Web integration** | IDL → `adler-website/lib/anchor/idl.ts`, anchor wrapper in `lib/anchor/program.ts`, retiring `transferSolWithFee.ts`, cluster gating |
| **Settlement flows** | User-facing flows that call the program: fund / bind / deliver / revise / approve / auto-release / refund / dispute / arbitrate / mint reputation |
| **Mainnet** | Audit, multisig upgrade authority, treasury rotation, mainnet deploy, IDL pin, cluster cutover |
| **Ops** | README, toolchain docs, build-vs-buy notes, design docs, license, hackathon submission writeup |

---

## Program

### v0.1 baseline (`programs/adler-escrow/src/`)
- [X] Anchor scaffold — workspace + `Cargo.toml` + `Anchor.toml`, Anchor 0.31 + Solana 2.x
- [X] `EscrowAccount` PDA — brand / creator / fee_treasury / arbitration_authority / price + fee lamports / approval_deadline / refund_after / state / bump
- [X] `EscrowState` enum — `Funded` → `Settled` | `Refunded` | `Disputed`, transitions enforced in handlers
- [X] `ArbitrationOutcome` enum — `Release` | `Refund` | `Split { num, denom }` (fee always to treasury regardless of split)
- [X] `EscrowError` codes — 12 variants covering price / deadline / state / pubkey-mismatch / split / overflow
- [X] PDA seeds — `[b"escrow", brand.key().as_ref(), &contract_id]`; `contract_id` is a 32-byte client-supplied id
- [X] `fund_escrow` — brand inits PDA, transfers `price + fee` lamports in, sets `state = Funded`, stores arbitration_authority + deadlines
- [X] `approve_release` — brand-only; atomic PDA → creator (`price`), PDA → fee_treasury (`fee`); closes PDA returning rent to brand
- [X] `auto_release` — permissionless after `approval_deadline`; same lamport split as `approve_release`
- [X] `brand_refund` — brand-only after `approval_deadline + REFUND_GRACE_SECONDS` (24 h); refunds price + fee + rent to brand
- [X] `open_dispute` — brand or creator; flips `Funded → Disputed`; only `arbitrate` unlocks
- [X] `arbitrate` — arbitration_authority-only; `Release` / `Refund` / `Split` outcomes; `Split` enforces `denom > 0 && num <= denom`

### v1.0 redesign — marketplace-aware settlement
v1.0 is the architecture the web client + whitepaper describe. Account
layouts change, so v1.0 ships at a new program ID; v0.1 stays as a reference.

#### Global state

- [X] **`ProtocolConfig` PDA** — seeds `[b"config"]`. Fields: `admin`, `fee_bps: u16` (default 50 = 0.5 %), `fee_treasury`, `approval_window_secs: i64` (default 72 × 3600), `refund_grace_secs: i64` (default 24 × 3600), `arbitration_pool: Pubkey`, `paused: bool`. Replaces the per-PDA `arbitration_authority` and the `REFUND_GRACE_SECONDS` const so policy can be tuned without a redeploy.
- [X] **`init_protocol(admin, fee_treasury, fee_bps, approval_window_secs, refund_grace_secs)`** — one-shot; admin pubkey is an arg (not the signer) so mainnet can pass a Squads multisig.
- [X] **`update_protocol_field`** — admin-signer; sets a single field (typed enum, struct variants for predictable TS shape).
- [X] **`set_paused(bool)`** — admin-signer kill switch; when `paused == true`, all settlement-mutating ixs early-return with `ProtocolPaused`.

#### Arbitration pool

- [X] **`ArbitrationPool` PDA** — seeds `[b"arb_pool"]`. Fields: `admin`, `arbiters: Vec<Pubkey>` (capped at 16 via `#[max_len(16)]`), `quorum: u8` (1 for v1, reserved field), `disputed_count: u32`.
- [X] **`init_arbitration_pool(quorum)`** — admin-signer (must match `ProtocolConfig.admin`); also writes `config.arbitration_pool` to the pool PDA address.
- [X] **`add_arbiter(pubkey)`** / **`remove_arbiter(pubkey)`** — admin-signer; rejects duplicates with `DuplicateArbiter`, rejects unknown removes with `ArbiterNotInPool`. Last-arbiter-with-disputes guard implemented but not integration-tested (orchestration cost too high; covered by code inspection).

#### Contract escrow

- [X] **`ContractEscrow` PDA** — seeds `[b"contract", brand.key().as_ref(), &contract_id]`. Holds `price + fee + rent` lamports until terminal. Fields per `docs/v1-design.md` §2.3.
- [X] **`ContractRecord` PDA** *(addition to original spec)* — seeds `[b"record", brand.key().as_ref(), &contract_id]`. Written by closing ix (`approve_release`/`auto_release`/`arbitrate`) immediately before `ContractEscrow` is closed; `mint_reputation` reads it to verify settlement. `brand_refund` and `cancel_unbound_gig` produce no record (no rating after a refund). See `docs/v1-design.md` §2.4.
- [X] **`State` enum** — `Funded` (gig only) → `Bound` → `Delivered` → terminal (closed). Terminal states (`Settled`, `Refunded`, `Resolved`) live on `ContractRecord` via `SettledOutcome`. Fixes v0.1's `auto_release`-on-`Funded` bug.
- [X] **`Kind` enum** — `Service` (creator known at fund time, starts in `Bound`) | `Gig` (creator slotted on `bind_creator`, starts in `Funded`).
- [X] **`Outcome` enum** — `Release` | `Refund` | `Split { creator_bps: u16 }`. Replaces v0.1's `{num, denom}` shape; bps matches the rest of the protocol and removes the `denom == 0` footgun.
- [X] **`contract_id` derivation pinned** — `sha256(off_chain_id)` in `state::contract_id::derive()`. The TS-side parity test in `lib/anchor/pda.test.ts` is the CI gate (Phase 1.D, deferred).

#### Service path

- [X] **`fund_service(contract_id, price_lamports)`** — brand-signer; reads `ProtocolConfig`, computes `fee_lamports`, transfers `price + fee` from brand → PDA, sets `delivery_deadline = now + config.approval_window`, state = `Bound`. Replaces v0.1's `fund_escrow`.

#### Gig path (new in v1)

- [X] **`fund_gig(contract_id, budget_lamports, delivery_deadline)`** — brand-signer; same lamport math as `fund_service` but `creator = Pubkey::default()`, brand-supplied deadline (must be `> now`), state = `Funded`.
- [X] **`bind_creator(contract_id, creator: Pubkey)`** — brand-signer; `Funded → Bound`. Idempotent only when re-binding the same creator (rejects re-bind to a different creator with `CreatorMismatch`).
- [X] **`cancel_unbound_gig(contract_id)`** — brand-signer; `Funded → close`, full refund to brand. No `ContractRecord` written.

#### Lifecycle

- [X] **`submit_delivery(contract_id)`** — creator-signer; `Bound → Delivered`, sets `delivered_at = now`, `approval_deadline = now + config.approval_window`.
- [X] **`request_revision(contract_id)`** — brand-signer; `Delivered → Bound`, increments `revisions_used`, rejects at cap (`REVISION_CAP = 2`) with `RevisionCapReached`. `approval_deadline` resets lazily on the next `submit_delivery`.
- [X] **`approve_release(contract_id)`** — brand-signer on `Delivered`; atomic PDA → creator (`price`), PDA → fee_treasury (`fee`); closes PDA returning rent to brand; writes `ContractRecord(outcome=Settled)`.
- [X] **`auto_release(contract_id)`** — permissionless after `approval_deadline` on `Delivered`. Caller pays gas + the `ContractRecord` rent (~0.002 SOL). Cannot fire on `Bound` (creator never delivered) — that path is `brand_refund`. **Fixes v0.1's auto-release-on-Funded bug.**
- [X] **`brand_refund(contract_id)`** — brand-signer on `Bound` after `delivery_deadline + config.refund_grace`. Closes PDA, full refund to brand (including fee — no service rendered, no fee earned). No `ContractRecord` written.

#### Disputes

- [X] **`open_dispute(contract_id)`** — brand or creator; `Bound | Delivered → Disputed`, records `dispute_filer + dispute_opened_at`, increments `ArbitrationPool.disputed_count`. Third-party signer fails with dedicated `NotAParty` error code.
- [X] **`arbitrate(contract_id, outcome)`** — signer must be in `ArbitrationPool.arbiters`; `Disputed → close`, writes `ContractRecord(outcome=Resolved(arg))`, decrements `disputed_count`. Lamport movement per outcome documented in `docs/v1-design.md` §6.3.

#### Reputation (new in v1)

- [X] **`ReputationCard` PDA** — seeds `[b"rep", subject.key().as_ref(), &contract_id]`. Fields: `record: Pubkey` (the `ContractRecord` PDA — frozen pointer back to the contract), `reviewer`, `subject`, `axes: [u8; 4]`, `comment_hash: [u8; 32]`, `amount_lamports` (snapshotted from `ContractRecord.price_lamports`), `timestamp`, `bump`. One PDA per `(subject, contract_id)` — both directions (brand→creator, creator→brand) get separate cards.
- [X] **`mint_reputation(contract_id, axes, comment_hash)`** — signer must be `record.brand` or `record.creator`; subject is the counterparty. Gated on `Settled` or `Resolved(Release)` or `Resolved(Split{*})`; `Resolved(Refund)` fails `NotRatable`. Axis 1..=5 (`InvalidAxis`); `reviewer != subject` (`SelfRating`). Deterministic PDA prevents double-mint.

#### Errors

- [X] **`EscrowError` v1 expansion** — full 24-code set defined upfront so the IDL is stable across phases. Some codes (`ArbiterNotInPool`, `InvalidAxis`, `RevisionCapReached`, etc.) are unused in Phases 1–3 but pre-declared for Phases 4–6.
- [X] **Re-entrancy / overflow audit pass** — written up in `docs/submission.md` § "Security review". External audit remains gating for mainnet.
- [ ] **`get_contract` view** — read-only helper for indexers. Deferred: standard `program.account.contractEscrow.fetch(pda)` covers the use case; revisit if indexers actually want a CPI-callable helper.

## Tests

### v0.1 baseline (`tests/adler-escrow.ts`)
- [X] Anchor + LiteSVM test runner wired (~350 LoC)
- [X] 7 cases pass on `solana-test-validator` — covers happy `fund → approve_release`, `fund → auto_release after deadline`, `fund → brand_refund after grace`, `fund → open_dispute → arbitrate(Release)`, plus the obvious negative paths (wrong brand, deadline-not-reached, arbiter mismatch)

### v1.0 coverage
Each instruction needs one happy + one negative for every gating condition.
File layout: one `*.test.ts` per instruction, plus `flow.test.ts` for
multi-step product scenarios.

- [X] **Protocol config** — init + double-init + admin-only update + pause toggle + invalid-deadline rejection (6 cases).
- [ ] **Arbitration pool** — `add_arbiter` rejects duplicates; `remove_arbiter` rejects when `disputed_count > 0` and the target is the last arbiter; cap of 16 enforced. **Phase 5.**
- [X] **Service flow** — `fund_service → submit_delivery → approve_release` happy + flow test; `InvalidPrice` + `ProtocolPaused` + double-fund + non-brand approve + non-creator delivery + Bound-state approve + wrong-treasury rejection.
- [X] **Gig flow** — `fund_gig → bind_creator → submit_delivery → approve_release` happy; `bind_creator` to different creator fails; `cancel_unbound_gig` after bind fails; `cancel_unbound_gig` happy refunds full lamports.
- [X] **Revisions** — full 3-deliveries / 2-revisions cycle; third `request_revision` fails `RevisionCapReached`; `approval_deadline` advances on each re-submission.
- [X] **Auto-release** — fires on `Delivered` past `approval_deadline` (uses `withShrunkenApprovalWindow` helper); rejected before deadline; rejected on `Bound` (closes v0.1 bug); gas paid by arbitrary caller.
- [X] **Brand refund** — `Bound` past `delivery_deadline + grace` happy (uses `withShrunkenWindows` helper); before grace fails `RefundGraceActive`; rejects on `Delivered`; non-brand signer fails.
- [X] **Disputes** — brand on `Bound` happy; creator on `Delivered` happy; third party fails `NotAParty`; `Funded` (gig pre-bind) fails `WrongState`; locks `submit_delivery` and `approve_release`.
- [X] **Arbitration** — `Release` / `Refund` / `Split{0|5000}` all balance correctly; `Split{10_001}` fails `InvalidBps`; non-pool signer fails `ArbiterNotInPool`; non-`Disputed` state fails `WrongState`.
- [X] **Reputation** — both directions happy after `Settled` / `Resolved(Release)` / `Resolved(Split)`; `Resolved(Refund)` fails `NotRatable`; double-mint fails on PDA collision; self-rate fails `SelfRating`; non-party fails `NotAParty`; axis 0 + axis 6 fail `InvalidAxis`.
- [X] **Split math invariant (JS-side)** — `creator + brand_residual + fee == price + fee` for `bps ∈ {2500, 7500}` end-to-end on chain. *Full Rust `proptest` (random bps over u64 price space) deferred to external audit.*
- [X] **Devnet smoke** — `tests/devnet-smoke.ts` runs the full service flow against the live devnet program; passing as of Phase 7 commit. Includes a treasury rent-exempt seed step (Solana 3.x quirk).

Total tests passing on localnet: **76** (run via `scripts/run-tests.sh`; `anchor test`'s auto-deploy was racing the test boot on this Anchor 0.31 / Solana 3.x toolchain).

## Devnet

### v0.1 deployment
- [X] Devnet deploy at `3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD`
- [X] Program ID pinned in `Anchor.toml` (`[programs.localnet]` + `[programs.devnet]`) and `declare_id!` in `lib.rs`
- [X] IDL on-chain at `AP5ZczRDa1RcfAzkhj8qsySumPKFJ3Bm4YkEYqkvzZJL` (fetchable via `anchor idl fetch`)
- [X] Upgrade authority — `DfTwUKsEJjpTwTC4hHDPQDMtSfxH3iKibbVQnHp1Ff8z` (single key, devnet only; mainnet rotates to multisig)

### v1.0 deployment
- [X] **Fresh program ID** `BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr`. Pinned in `Anchor.toml` and `declare_id!`. Keypair at `target/deploy/adler_escrow-keypair.json` (gitignored). Web-side pinning (`lib/constants/escrow.ts`) is Phase 1.D.
- [X] **`scripts/deploy-devnet.sh`** — idempotent build + deploy + IDL init|upgrade.
- [X] **`scripts/sync-idl.sh`** — pushes IDL + generated TS types into `../adler-website/lib/anchor/`. To run when web work begins.
- [X] **`scripts/bootstrap-devnet.ts`** — initializes both `ProtocolConfig` and `ArbitrationPool`; idempotent; reads existing state back when already initialized.
- [X] **Devnet program live** — Phase 1 deploy + Phase 7 upgrade. ProtocolConfig at `FYt8EXXHtMKCay5QrsgVSxiQABU5TvpBWJMRdyUFfaT1`, ArbitrationPool initialized, IDL fetchable at `6qCpi4JQYj924CkoFWkD8M5RXUbnV61oLPcLLWVhhuEB`.
- [ ] **Devnet treasury keypair** — currently a random pubkey (`FqqUK5h…wVxD`) generated by the test helper before cluster was switched to localnet. Replace via `update_protocol_field` with a controllable keypair; pin in `tests/fixtures/treasury.devnet.json` (gitignored — pubkey only in README).
- [ ] **Auto-release fee-payer keypair** — Phase 2 ix is live but the sweeper Cloud Function (and its dedicated keypair) lives in `../adler-app`. Pair with that work.

## Web integration

The web client today uses `lib/solana/transferSolWithFee.ts` to do a direct
99.5 / 0.5 split-transfer with no escrow. All items below replace that path
with real program calls. Tracked web-side in
[`../adler-website/TODO.md`](../adler-website/TODO.md) under **Wallet &
settlement** + **Disputes**.

- [ ] **IDL surface** — `adler-website/lib/anchor/idl.ts` (default-exports the JSON for type inference) + `adler-website/lib/anchor/program.ts` (builds a typed `Program<AdlerEscrow>` from the Privy-injected wallet adapter)
- [ ] **Anchor wrapper** — `adler-website/lib/escrow/*.ts`: one file per ix (`fundService`, `fundGig`, `bindCreator`, `cancelUnboundGig`, `submitDelivery`, `requestRevision`, `approveRelease`, `autoRelease`, `brandRefund`, `openDispute`, `arbitrate`, `mintReputation`). Each takes UI-friendly args (SOL, not lamports) and handles PDA derivation internally.
- [ ] **`contract_id` parity test** — `lib/anchor/pda.test.ts` asserts the TS digest matches the Rust fixture for a known set of order ids. CI gate on the web side.
- [ ] **Cluster gating** — `lib/constants/escrow.ts` selects the v1.0 program ID by `NEXT_PUBLIC_SOLANA_NETWORK`. Hard-coded devnet until mainnet ships.
- [ ] **Retire `lib/solana/transferSolWithFee.ts`** — delete the helper + its tests once `fundService` is live in production. No fallback path.

## Settlement flows

Each item is a user-facing flow that today writes Firestore-only and needs
to be re-routed through the program. The Firestore docs stay (audit log,
denormalized for queries) but become **shadows** of the on-chain state, not
sources of truth for SOL movement. Web writes Firestore *after* on-chain
confirmation, never before.

- [ ] **Service buy / fund** — replace `paymentService.payForListing` (services) with `fundService`. On confirmation persist `escrowPda`, `contractId32`, `txSignature`, and `delivery_deadline` onto the order doc.
- [ ] **Gig fund + bind** — `/gigs/new` submission calls `fundGig`, persisting `escrowPda` + `delivery_deadline` onto the gig doc; `/applicants` award action calls `bindCreator`. Cancellation before award calls `cancelUnboundGig`.
- [ ] **Submit delivery** — `DeliverableDialog` calls `submitDelivery` before posting the `deliverable` thread message. If the on-chain call fails, the message is never posted.
- [ ] **Request revision** — `RevisionRequestDialog` calls `requestRevision`; the third click reroutes to the dispute path with the cap-reached error surfaced as the rationale.
- [ ] **Approve / release** — buyer's `delivered → complete` action calls `approveRelease`; release signature appended to the order doc.
- [ ] **Brand refund** — `/spend` and the order thread surface a "Reclaim escrow" CTA when `now > delivery_deadline + refund_grace_secs` and the creator never delivered; calls `brandRefund`, transitions the order to `failed` with the refund tx pinned.
- [ ] **Open dispute on-chain** — `DisputeDialog` calls `openDispute` first, only writing the Firestore `/disputes/{orderId}` doc after on-chain confirmation. Keeps the two stores in lockstep.
- [ ] **Arbitrate on-chain** — `OutcomeDecisionDialog` calls `arbitrate(outcome)`; map `release_to_creator → Release`, `refund_to_brand → Refund`, `split → Split { creator_bps }`. Drops the "Settlement pending the on-chain escrow program" badge from `DisputeOutcomesSection` on profiles.
- [ ] **Reputation mint** — `RatingDialog` calls `mintReputation` after the off-chain comment is sha256'd; on confirmation the Firestore review doc is written with the on-chain PDA + tx pinned. Aggregate readers prefer on-chain PDAs and fall back to Firestore mirrors only for paginated UI.
- [ ] **Auto-release sweeper** — Cloud Function in `../adler-app/functions/` (Firebase, not Supabase — README to be corrected). Scheduled every 15 min; scans `/orders` for `status == delivered && now > approval_deadline`; calls `auto_release` from the fee-payer keypair. Pairs with `notifyOrderStateChanged` so both parties get the auto-release notification.
- [ ] **On-chain state watcher** — Cloud Function consumes a Helius webhook (or the Solana logs subscription via the existing RPC proxy) and writes `orders.status` / `gigs.status` / `disputes.status` server-side from the program's emitted events. Removes the trust gap in the current client-driven `markOrderPaid(txSignature)` flow.
- [ ] **Arbiter sync** — Cloud Function listens on `roles/{uid}` writes and calls `add_arbiter` / `remove_arbiter` against `ArbitrationPool`. The web admin path doesn't touch the program directly.
- [ ] **Approval deadline policy** — `docs/approval-deadline.md` pins the canonical default (72 h delivery → approve auto-release; 24 h refund grace) and the rationale (matches whitepaper §6 + marketing copy). `init_protocol` reads from this doc; web copy references it.
- [ ] **Insufficient-balance precheck** — web buy flows compare against `price + fee + rent + tx fee` (rent ≈ 0.00203 SOL for `ContractEscrow`'s `INIT_SPACE`); surface a friendly error before the RPC round-trip.

## Mainnet

- [ ] **External audit** — scope: re-entrancy, lamport accounting in `close = brand`, signer constraints on each handler, arithmetic overflow in `Split` math, deadline edge cases (slot timestamp == approval_deadline), `ProtocolConfig` admin authority changes, PDA-init race conditions. Out of scope for the hackathon submission per README; required before any mainnet lamport flows.
- [ ] **Multisig upgrade authority** — rotate `DfTwUKsEJjpTwTC4hHDPQDMtSfxH3iKibbVQnHp1Ff8z` to a 2-of-3 (or 3-of-5) Squads multisig before mainnet deploy. Single-key upgrade authority on a contract holding user funds is a foot-gun.
- [ ] **Mainnet treasury** — confirm `44B9k33cVU85tEYAxDbE51byadgvdfVjmZk57HDc3iS3` is hardware-wallet-controlled; document the rotation procedure (the `update_protocol_field` ix supports it without a redeploy).
- [ ] **Mainnet deploy** — `solana config set --url mainnet-beta && anchor deploy --provider.cluster mainnet`. Pin the program ID in `Anchor.toml` `[programs.mainnet]` and `MAINNET_PROGRAM_ID` on the web side.
- [ ] **Mainnet bootstrap** — run `init_protocol` + `init_arbitration_pool` with the audited defaults; verify singletons are correctly populated before opening any user-facing buy flow.
- [ ] **Cluster cutover** — flip the web client's cluster gate from devnet to mainnet (Q3 2026 per marketing copy). Closed beta runs on devnet so real lamports are never at risk pre-audit.
- [ ] **IDL upgrade in CI** — every mainnet deploy runs `anchor idl upgrade --provider.cluster mainnet` immediately afterwards. Captured in the deploy runbook.

## Ops

- [X] **README** v1 refresh — 18-ix surface, both v0.1/v1.0 program IDs, Solana 3.x version, repo layout updated for the new module split.
- [X] **`docs/v1-design.md`** — full PDA + ix + lamport-flow spec.
- [X] **`docs/approval-deadline.md`** — 72 h / 24 h policy pinned with rationale.
- [X] **`docs/toolchain.md`** — Anchor 0.31.1 / Solana 3.1.x / Rust stable / Node 20 pin + the `anchor test` quirk explanation.
- [X] **`docs/build-vs-buy.md`** — Streamflow / Squads / Helio / Sphere / Crossmint spike rationale.
- [X] **`docs/submission.md`** — hackathon writeup with security-review section.
- [X] **License** — Apache-2.0 (`LICENSE` + README updated).
- [ ] **Loom screencast** — 5-min walkthrough of `anchor test` + devnet smoke. Optional but expected by hackathon submission format.
