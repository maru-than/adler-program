# Adler Escrow — TODO

`[X]` done · `[+]` in progress · `[ ]` not started

This file is the source of truth for what's left on the on-chain side
of Adler. Companion file: `../adler-website/TODO.md` covers the web
client (which is fully `[X]` apart from items that depend on this
program shipping).

## Group taxonomy (canonical)

These are the **only** group labels allowed in this file. Stable
across sessions so any agent reading it knows the schema. Use them
verbatim.

- **Do not invent new groups.** If an item doesn't fit, expand the
  closest group's scope.
- **Empty groups may be omitted** from the active list below — the
  taxonomy here is the source of truth for what exists.
- **Order is fixed** (program → tests → devnet → integration →
  flows → mainnet → ops): keep group sections below in this order.

| Group | Scope |
|---|---|
| **Program** | Anchor program source: `lib.rs`, `state.rs`, `errors.rs`, instruction handlers, PDA layout |
| **Tests** | LiteSVM + local-validator test suite, happy + negative paths, fuzz / property tests |
| **Devnet** | Devnet deploy, IDL fetch, program ID pin, upgrade authority |
| **Web integration** | IDL → `adler-website/lib/anchor/idl.ts`, anchor RPC helpers in `lib/escrow/anchor.ts`, retiring `transferSolWithFee.ts` |
| **Settlement flows** | User-facing flows that call the program: fund on buy, approve / release on order completion, brand refund on missed delivery, open dispute, arbitrate, auto-release |
| **Mainnet** | Audit, multisig upgrade authority, mainnet deploy, IDL pin, treasury rotation |
| **Ops** | Toolchain docs, build-vs-buy notes, license, hackathon submission |

---

## Program

- [X] Anchor scaffold (`programs/adler-escrow/`, workspace + Cargo.toml + Anchor.toml)
- [X] `EscrowAccount` state — per-contract PDA with brand / creator / fee_treasury / arbitration_authority / amounts / deadlines / state
- [X] `EscrowState` enum — `Funded` (0) → `Settled` (1) | `Refunded` (2) | `Disputed` (3); transitions enforced in handlers
- [X] `ArbitrationOutcome` enum — `Release`, `Refund`, `Split { num, denom }` (fee always to treasury regardless of split)
- [X] `EscrowError` codes (12 variants covering price / deadline / state / pubkey-mismatch / split / overflow)
- [X] PDA seed convention: `[b"escrow", brand.key().as_ref(), &contract_id]`; `contract_id` is a 32-byte client-supplied id (whitepaper §6 maps this to the Firestore `orderId` digest)
- [X] `fund_escrow` — brand inits PDA, transfers `price + fee` lamports in, sets state=Funded, stores arbitration_authority + deadlines
- [X] `approve_release` — brand-only; atomic PDA → creator (`price`), PDA → fee_treasury (`fee`); closes PDA returning rent to brand
- [X] `auto_release` — permissionless after `approval_deadline`; same lamport split as `approve_release`
- [X] `brand_refund` — brand-only after `approval_deadline + REFUND_GRACE_SECONDS` (24h grace); refunds price + fee back to brand if creator never delivered
- [X] `open_dispute` — brand or creator; flips Funded → Disputed; only `arbitrate` unlocks
- [X] `arbitrate` — arbitration_authority-only; `Release` / `Refund` / `Split` outcomes; `Split` enforces `denom > 0 && num <= denom`
- [ ] **Re-entrancy / overflow audit pass** — the lamport math uses `checked_add` / `checked_sub` already, but a second pass before audit is cheap insurance. Specifically: confirm `price + fee + rent` cannot wrap u64 even at the documented `priceSol <= 10000` ceiling, and that the close-PDA semantics don't leave dust if rent rounds.
- [ ] **Helper view function** — `get_escrow(contract_id)` read-only helper so the web client can fetch state without manually computing the PDA. Optional, since `findProgramAddressSync` works client-side, but a single source of truth is nicer for indexers.

## Tests

- [X] LiteSVM test runner wired (`tests/adler-escrow.ts`, ~350 LoC)
- [X] 7 cases pass on `solana-test-validator` — covers happy `fund → approve_release`, `fund → auto_release after deadline`, `fund → brand_refund after grace`, `fund → open_dispute → arbitrate(Release)`, plus the obvious negative paths (wrong brand, deadline-not-reached, etc.)
- [ ] **Negative-path coverage gaps** — explicitly: arbitrate on a non-Disputed PDA, double-fund (re-init same PDA), approve_release as creator (not brand), auto_release before deadline, split with `denom == 0`, split with `num > denom`. Some of these are implicitly covered by signer constraints; verify each error path resolves to the intended `EscrowError` variant.
- [ ] **Property test for Split math** — for any (num, denom, price) within u64 bounds, `creator_share + brand_share == price` and neither is negative. `proptest` crate; runs in `cargo test`.
- [ ] **Devnet integration smoke** — a one-shot script (`tests/devnet-smoke.ts`) that runs the happy path against the deployed devnet program, reads the resulting `EscrowAccount` back, and confirms lamports moved. Useful before each redeploy.

## Devnet

- [X] Devnet deploy at `3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD`
- [X] Program ID pinned in `Anchor.toml` (`[programs.localnet]` and `[programs.devnet]`) and `declare_id!` in `lib.rs`
- [X] IDL on-chain at `AP5ZczRDa1RcfAzkhj8qsySumPKFJ3Bm4YkEYqkvzZJL` (fetchable via `anchor idl fetch`)
- [X] Upgrade authority: `DfTwUKsEJjpTwTC4hHDPQDMtSfxH3iKibbVQnHp1Ff8z` (single key for devnet; mainnet rotates to multisig)
- [ ] **IDL drift check on every redeploy** — every `anchor deploy` to devnet must be followed by `anchor idl upgrade` so the on-chain IDL matches the binary. A stale IDL on-chain breaks `anchor idl fetch` for downstream consumers. Add a one-line wrapper script (`scripts/deploy-devnet.sh`) that does both.
- [ ] **Devnet treasury wallet** — the fee_treasury pubkey passed into `fund_escrow` is currently hard-coded in tests. Pin a dedicated devnet treasury keypair (different from the mainnet `44B9k33cVU85tEYAxDbE51byadgvdfVjmZk57HDc3iS3`) and document it in README so devnet smoke flows are predictable.

## Web integration

The web client today uses `lib/solana/transferSolWithFee.ts` to do an
interim split-transfer (99.5% buyer→seller, 0.5% buyer→treasury, no
escrow). All items below replace that path with real program calls.

- [ ] **Copy IDL** — `target/idl/adler_escrow.json` → `adler-website/lib/anchor/idl.ts`. Default-export the JSON so the type bindings are inferred. Re-run on every program redeploy. (`scripts/sync-idl.sh` over here that targets the sibling repo path is the cleanest move.)
- [ ] **Anchor helper module** — `adler-website/lib/escrow/anchor.ts`: thin wrapper that builds an `AnchorProvider` from the Privy-injected wallet adapter, returns a typed `Program<AdlerEscrow>` instance, and exposes high-level fns: `fundEscrow`, `approveRelease`, `autoRelease`, `brandRefund`, `openDispute`, `arbitrate`. Each fn takes UI-friendly args (SOL, not lamports) and handles the PDA derivation internally.
- [ ] **Contract-id digest** — pick a deterministic 32-byte derivation from `orderId` (Firestore doc id). Suggestion: `sha256(orderId)`. Document it once and use it everywhere — drift here means the web client can't find PDAs the program created. Add a unit test that the same `orderId` yields the same `contract_id` on Rust + TS sides.
- [ ] **Retire `transferSolWithFee.ts`** — once `fundEscrow` ships and is wired into the buy flow, delete the old helper + its tests. Don't leave it as a fallback; dual-path payment is a foot-gun.
- [ ] **Cluster gating** — `lib/escrow/cluster.ts` (or a constant in `lib/constants/featureGates.ts`) picks devnet vs mainnet program ID. Until mainnet ships, hard-code devnet.

## Settlement flows

Each item is a user-facing flow that today writes Firestore-only and
needs to be re-routed through the program. The Firestore docs stay
(audit log, denormalized for queries) but become **shadows** of the
on-chain state, not sources of truth for SOL movement.

- [ ] **Buy / fund** — replace `paymentService.payForListing` (services + gigs) with `fundEscrow`. Brand → PDA atomic; on confirmation, write the `/orders/{id}` doc with `txSignature` and `escrowPda` fields. The order's `status` enum stays (`pending`/`paid`/`delivered`/`complete`) but each transition now mirrors a program state.
- [ ] **Approve / release on order completion** — the existing `delivered → complete` step (buyer confirms receipt) calls `approveRelease`. On success, the order doc updates to `complete` and the `txSignature` of the release joins `txSignature` of the fund.
- [ ] **Brand refund on missed delivery** — new UI surface in the order thread: if `now > approval_deadline + 24h` and order is still `paid` (creator never delivered), brand sees a "Reclaim escrow" action that calls `brandRefund`. Order doc transitions to `failed` with the refund tx pinned.
- [ ] **Open dispute on-chain** — `DisputeDialog` currently writes `/disputes/{orderId}` Firestore-only. Flip to: call `openDispute` first, only then write the Firestore doc with the `txSignature`. If the on-chain call fails, the Firestore doc is never written — keeps the two stores in lockstep.
- [ ] **Arbitrate on-chain** — `/admin/disputes` panel resolution path calls `arbitrate(outcome)`. Map `release_to_creator` → `Release`, `refund_to_brand` → `Refund`, `split` → `Split { num: splitPercentToCreator, denom: 100 }`. Disputes with on-chain settlement drop the "pending program" badge from `DisputeOutcomesSection` on profiles.
- [ ] **Auto-release Cloud Function** — `../adler-app/functions/index.js`: scheduled function (every 15 min) scans `/orders` for status=`paid` orders past their `approval_deadline + tolerance`, and calls `autoRelease` on the program. Permissionless on-chain, so no key management — but the function still needs a funded fee-payer keypair (nominal lamports per call). Pair with `notifyOrderStateChanged` so the auto-release pings both parties.
- [ ] **Approval deadline policy** — settle the canonical default. Whitepaper §6 currently says "delivery + brand approval"; the program needs a concrete `approval_deadline` at fund time. Suggest **delivery + 72h** (matches the auto-release language in marketing). Document in `docs/approval-deadline.md` and reference from the web client.
- [ ] **Insufficient-balance UX** — `fundEscrow` requires `price + fee + rent + tx fee` upfront. Today the buy flow checks balance against `price + fee` only. Add the rent + tx fee to the precheck so users get a friendly error instead of an RPC failure.

## Mainnet

- [ ] **Audit** — external review of the program before any mainnet lamport ever flows. Specifically scope: re-entrancy, lamport accounting in close-PDA, signer constraints on each handler, arithmetic overflow in `Split` math, deadline edge cases (approval_deadline equal to current slot timestamp). Out of scope for the hackathon submission per README; necessary before public mainnet.
- [ ] **Multisig upgrade authority** — rotate `DfTwUKsEJjpTwTC4hHDPQDMtSfxH3iKibbVQnHp1Ff8z` to a 2-of-3 (or 3-of-5) Squads multisig before mainnet deploy. Single-key upgrade is a footgun on a contract holding user funds.
- [ ] **Mainnet treasury** — the `44B9k33cVU85tEYAxDbE51byadgvdfVjmZk57HDc3iS3` address is the production fee treasury (provided by Maru, currently used by the interim split-transfer too). Confirm it's a hardware-wallet-controlled address and document the rotation procedure.
- [ ] **Mainnet deploy** — `solana config set --url mainnet-beta && anchor deploy --provider.cluster mainnet`. Pin the resulting program ID in `Anchor.toml` `[programs.mainnet]` and add a `MAINNET_PROGRAM_ID` constant on the web side.
- [ ] **Cluster cutover** — flip the web client cluster gate from devnet to mainnet on launch day (Q3 2026 per marketing copy). Until then, **devnet only** — the closed beta runs on devnet so real lamports are never at risk pre-audit.
- [ ] **IDL upgrade in CI** — every mainnet deploy must run `anchor idl upgrade --provider.cluster mainnet`. Add to the deploy runbook.

## Ops

- [X] README with instruction table, devnet program ID, repo layout, and build-vs-buy note
- [ ] **`docs/toolchain.md`** — referenced from README but the file doesn't exist yet. Should pin: rustup toolchain (1.79.0 or whatever Anchor 0.31 needs), `solana-cli` 2.x, `avm install 0.31` + `avm use 0.31`, and the Node version for the test runner. Capture lockstep so a fresh contributor doesn't burn an afternoon on toolchain drift.
- [ ] **`docs/build-vs-buy.md`** — referenced from README ("full notes in docs/build-vs-buy.md") but missing. Document the spike against Streamflow / Squads / Helio so the decision is durable.
- [ ] **`docs/approval-deadline.md`** — see Settlement flows. Pin the canonical 72h policy + the rationale (matches marketing copy + whitepaper §6).
- [ ] **License** — currently "TBD pre-launch" in README. Decide before any external contributor opens a PR. Default suggestion: Apache-2.0 (matches the Firebase extensions ecosystem we already pull from).
- [ ] **Hackathon submission writeup** — short post / video walking through the program: PDA model, the six instructions, the per-PDA arbitration_authority innovation, why it's not Streamflow / Squads. Out of scope until mainnet is closer.
