# Adler Escrow v1.0 — Design Document

**Status:** Design freeze (Phase 0 of the v1 plan)
**Program ID (devnet):** `BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr`
**Toolchain:** Anchor 0.31.1, Solana 3.1.x, Rust 1.79+
**Target:** hackathon submission

This document is the source of truth for the v1.0 program. The Rust source under
`programs/adler-escrow/src/` is built against this spec; the TypeScript wrappers
under `../adler-website/lib/anchor/` and `../adler-website/lib/escrow/` mirror
it. **If the source and this doc disagree, the doc is wrong** — open a PR
against the doc, then change the code.

## 1. Scope

Adler Escrow v1.0 is the on-chain settlement layer for [Adler](https://github.com/maru-than/adler-website),
a Solana-native UGC marketplace described in [`PRODUCT.md`](../PRODUCT.md). The
program holds the brand's budget for the duration of a contract and routes
lamports per the documented lifecycle.

### What v1 does that v0.1 did not

| Concern | v0.1 | v1.0 |
|---|---|---|
| Product paths | Service buy only | Service + Gig (post → applicants → award) |
| Delivery on-chain | None — `auto_release` could fire on `Funded` ⚠️ | `submit_delivery` flips state; `auto_release` gated on `Delivered` |
| Revisions | None | `request_revision`, capped at 2 |
| Arbitration | One pubkey per PDA | Singleton `ArbitrationPool` with up to 16 arbiters |
| Policy tuning | Hardcoded constants | Singleton `ProtocolConfig`, runtime-tunable by admin |
| Pause switch | None | `set_paused` blocks all settlement-mutating ix |
| Reputation | Off-chain only | On-chain `ReputationCard` PDA per (contract, reviewer) |
| Dispute outcomes | `Split { num, denom }` (denom can be 0 — footgun) | `Split { creator_bps }`, `creator_bps ≤ 10_000` |

### What v1 does NOT do

- **Token payments**: SOL only. SPL tokens are explicitly out of scope.
- **Multi-sig escrows**: a single `brand` and (optionally) single `creator` per contract.
- **Mainnet**: deploys to devnet for the hackathon. Audit + multisig upgrade
  authority + treasury rotation are the gating items for mainnet
  ([`TODO.md`](../TODO.md) → **Mainnet** group).
- **Migration from v0.1**: v0.1 PDAs are not readable by v1. The deployed v0.1
  binary at `3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD` stays untouched on
  devnet for the museum reference.

## 2. PDA layout

All PDAs are derived from this program's ID. Seeds + field layouts below are
normative.

### 2.1 `ProtocolConfig`

Singleton. Stores tunable policy and the kill switch.

- **Seeds:** `[b"config"]`
- **Init:** `init_protocol` (admin signer; one-shot)
- **Mutated by:** `update_protocol_field`, `set_paused` (admin signer)
- **Read by:** every settlement instruction (for `fee_bps`, treasury,
  deadlines, paused flag)

| Field | Type | Description |
|---|---|---|
| `admin` | `Pubkey` | Admin pubkey allowed to update config + pause |
| `fee_bps` | `u16` | Protocol fee in basis points (default `50` = 0.5 %) |
| `fee_treasury` | `Pubkey` | Lamport sink for protocol fees |
| `approval_window_secs` | `i64` | Default 72 × 3600 = 259_200 |
| `refund_grace_secs` | `i64` | Default 24 × 3600 = 86_400 |
| `arbitration_pool` | `Pubkey` | The `ArbitrationPool` PDA address |
| `paused` | `bool` | Kill switch — blocks settlement-mutating ix |
| `bump` | `u8` | PDA bump |

**Pause semantics:** when `paused == true`, the following ix early-return with
`ProtocolPaused`: `fund_service`, `fund_gig`, `bind_creator`,
`cancel_unbound_gig`, `submit_delivery`, `request_revision`, `approve_release`,
`auto_release`, `brand_refund`, `open_dispute`, `arbitrate`. Reads,
`mint_reputation`, and admin ix continue to work — reputation minting on
already-settled contracts shouldn't be blocked by a pause.

### 2.2 `ArbitrationPool`

Singleton. Stores the set of pubkeys allowed to call `arbitrate`.

- **Seeds:** `[b"arb_pool"]`
- **Init:** `init_arbitration_pool` (admin signer; one-shot)
- **Mutated by:** `add_arbiter`, `remove_arbiter` (admin signer);
  `disputed_count` mutated by `open_dispute` / `arbitrate`
- **Read by:** `arbitrate` (signer membership check), `remove_arbiter`
  (last-arbiter guard)

| Field | Type | Description |
|---|---|---|
| `admin` | `Pubkey` | Admin (initially same as `ProtocolConfig.admin`) |
| `arbiters` | `Vec<Pubkey>` | Up to 16 entries, `#[max_len(16)]` |
| `quorum` | `u8` | 1 for v1; raisable later (multi-sig arbitration is post-v1) |
| `disputed_count` | `u32` | Number of contracts currently in `Disputed` state |
| `bump` | `u8` | PDA bump |

**Capacity:** `arbiters` is bounded at 16 by `#[max_len(16)]` so the account has
a fixed footprint. `add_arbiter` rejects when `arbiters.len() >= 16` with
`PoolFull`.

**Last-arbiter guard:** `remove_arbiter` rejects when `disputed_count > 0` and
the removal would empty the pool. Otherwise an admin could brick all open
disputes. Surfaced as `LastArbiterWithDisputes`.

**Mirrors Firestore:** the web admin path provisions arbiters via firebase-cli
(`firebase firestore:set roles/<uid> '{"role":"arbiter"}'`) per
[`PRODUCT.md`](../PRODUCT.md) Disputes section. The `arbiterSync` Cloud
Function listens on `roles/{uid}` writes and calls `add_arbiter` /
`remove_arbiter` — the program is downstream of Firestore for arbiter
membership.

### 2.3 `ContractEscrow`

Per-contract. The lamport vault for one service order or gig.

- **Seeds:** `[b"contract", brand.key().as_ref(), &contract_id]`
- **Init:** `fund_service` (`Service` kind) or `fund_gig` (`Gig` kind)
- **Mutated by:** `bind_creator`, `submit_delivery`, `request_revision`,
  `open_dispute`
- **Closed by:** `approve_release`, `auto_release`, `brand_refund`,
  `cancel_unbound_gig`, `arbitrate` (any terminal outcome). Rent always returns
  to `brand` on close.

| Field | Type | Description |
|---|---|---|
| `kind` | `Kind` | `Service` or `Gig` (see §3.1) |
| `contract_id` | `[u8; 32]` | sha256(off-chain id) — see §4 |
| `brand` | `Pubkey` | Funder; rent recipient on close |
| `creator` | `Pubkey` | Payee on `Release`. `Pubkey::default()` while a `Gig` is unbound |
| `fee_treasury` | `Pubkey` | Snapshotted from `ProtocolConfig` at fund time |
| `price_lamports` | `u64` | Amount paid to creator on `Release` (the "budget" for gigs) |
| `fee_lamports` | `u64` | `floor(price_lamports * config.fee_bps / 10_000)`, snapshotted at fund time |
| `state` | `State` | See §3.2 |
| `delivery_deadline` | `i64` | After this slot timestamp, brand can `brand_refund` (Bound only). For Service: set to `now + config.approval_window_secs` at fund time. For Gig: brand-supplied at fund time, must be `> now` |
| `delivered_at` | `Option<i64>` | Set on `submit_delivery` |
| `approval_deadline` | `i64` | Set lazily on `submit_delivery`: `now + config.approval_window_secs`. Reset on each `submit_delivery` after a `request_revision` |
| `revisions_used` | `u8` | Increments on `request_revision`; capped at 2 |
| `dispute_filer` | `Pubkey` | Set on `open_dispute`; `Pubkey::default()` otherwise |
| `dispute_opened_at` | `i64` | Set on `open_dispute` |
| `bump` | `u8` | PDA bump |

**Lamport invariant:** at any time, `lamports(PDA) == price_lamports +
fee_lamports + rent` (rent =
`Rent::get()?.minimum_balance(8 + ContractEscrow::INIT_SPACE)`).

### 2.4 `ContractRecord`

Per (brand, contract_id). Initialized by the closing instruction immediately
before `ContractEscrow` is closed; serves as the on-chain record that
`mint_reputation` reads to verify the contract was settled (the `ContractEscrow`
itself is gone by then).

- **Seeds:** `[b"record", brand.key().as_ref(), &contract_id]`
- **Init:** `approve_release`, `auto_release`, `arbitrate` (immediately before
  `escrow.close`)
- **Read by:** `mint_reputation`
- **Never mutated, never closed.**

| Field | Type | Description |
|---|---|---|
| `kind` | `Kind` | Snapshotted from the closed escrow |
| `brand` | `Pubkey` | Snapshotted |
| `creator` | `Pubkey` | Snapshotted |
| `price_lamports` | `u64` | Snapshotted (used by reputation aggregates) |
| `fee_lamports` | `u64` | Snapshotted |
| `outcome` | `SettledOutcome` | `Settled` or `Resolved(Outcome)` (see §3.4) |
| `settled_at` | `i64` | Slot timestamp at close |
| `bump` | `u8` | PDA bump |

**Why this exists:** by the time reputation is minted, the `ContractEscrow` is
closed. Two design options were considered:

- **Option A:** mint emits an event in the closing ix and `mint_reputation` is
  gated only by signer-membership. Simpler on-chain; abuse vector requires both
  brand and creator keys to collude (not a realistic threat for this product,
  but still rule-level unsafe).
- **Option B (chosen):** the closing ix writes a tiny `ContractRecord` PDA
  before closing the escrow. ~150 extra bytes/contract, ~0.002 SOL extra rent
  to brand. Rule-level safe: `mint_reputation` reads the record and enforces
  the gate.

The 0.002 SOL is cheap; rule-level safety is worth it. `ContractRecord` is also
a useful indexer hook — `getProgramAccounts(filter: brand==X)` returns every
contract this brand ever settled.

`brand_refund` and `cancel_unbound_gig` do **not** write a `ContractRecord` —
those paths produce no `ReputationCard` (no service rendered, no rating to be
made). Keeps the indexer cleaner.

### 2.5 `ReputationCard`

Per (subject, contract_id). Immutable after mint.

- **Seeds:** `[b"rep", subject.key().as_ref(), &contract_id]`
- **Init:** `mint_reputation`
- **Never mutated, never closed.**

| Field | Type | Description |
|---|---|---|
| `record` | `Pubkey` | The `ContractRecord` PDA address (the source of truth for which contract was rated) |
| `reviewer` | `Pubkey` | Whichever counterparty rated |
| `subject` | `Pubkey` | The other counterparty (`reviewer != subject` enforced) |
| `axes` | `[u8; 4]` | scope / communication / timeliness / quality, each 1..=5 |
| `comment_hash` | `[u8; 32]` | sha256 of off-chain comment (Firestore mirror) |
| `amount_lamports` | `u64` | Snapshot of `record.price_lamports` for weighted aggregates |
| `timestamp` | `i64` | Slot timestamp at mint |
| `bump` | `u8` | PDA bump |

**Why subject in seeds, not contract:** indexers compute "all reputation for
user X" as `getProgramAccounts(filter: subject==X)`. That filter is cheap;
filtering by contract requires off-chain joins. The `(subject, contract_id)`
pair is unique by construction (one contract has one creator + one brand;
each can rate the other once).

**Why no `reviewer` in seeds:** a contract has exactly two parties. Each can
rate once → at most one `ReputationCard` per direction. The `(subject,
contract_id)` pair already guarantees uniqueness — adding `reviewer` would be
redundant.

### 2.6 Account size budget

Anchor's `#[derive(InitSpace)]` computes `INIT_SPACE` exactly. Approximate
sizes (excluding the 8-byte discriminator) below; exact figures pinned in
[`docs/toolchain.md`](toolchain.md) once the structs compile.

| Account | Size (bytes, w/ disc) | Approx. rent (lamports) | SOL |
|---|---|---|---|
| `ProtocolConfig` | ~125 | ~1.76 M | ~0.00176 |
| `ArbitrationPool` | ~565 | ~4.83 M | ~0.00483 |
| `ContractEscrow` | ~225 | ~2.46 M | ~0.00246 |
| `ContractRecord` | ~155 | ~1.97 M | ~0.00197 |
| `ReputationCard` | ~160 | ~2.00 M | ~0.00200 |

**Brand cost per contract:** `price + fee + ContractEscrow rent + ContractRecord
rent` ≈ `price + fee + 0.0044 SOL` (the contract's rent comes back on close;
the record's rent does not). The web client's "insufficient balance" precheck
in [`TODO.md`](../TODO.md) → **Settlement flows** uses these numbers.

## 3. Enums

### 3.1 `Kind`

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Kind {
    Service,  // Creator known at fund time. Starts in `Bound`.
    Gig,      // Brand-posted brief. Starts in `Funded` (no creator yet).
}
```

### 3.2 `State`

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum State {
    Funded,    // Gig only — no creator bound yet
    Bound,     // Creator known; awaiting delivery
    Delivered, // Creator submitted; awaiting approval / revision / dispute
    Disputed,  // Either party filed; locked until `arbitrate`
    // Settled / Refunded / Resolved are terminal — escrow is closed in those cases
    // (no need to encode them as live state)
}
```

The terminal states (`Settled`, `Refunded`, `Resolved`) live on `ContractRecord`
via the `SettledOutcome` enum (§3.4) — once `ContractEscrow` is closed there's
no PDA to hold a state on anyway.

State machine:

```
Service path:
  Bound ──submit_delivery──▶ Delivered ──approve_release──▶ ◯ Settled (record)
                                  │
                                  ├──auto_release (after approval_deadline)──▶ ◯ Settled (record)
                                  │
                                  ├──request_revision──▶ Bound (loop, max 2 times)
                                  │
                                  └──open_dispute──▶ Disputed ──arbitrate──▶ ◯ Resolved (record)

Gig path:
  Funded ──bind_creator──▶ Bound ──[same as service from Bound]──
     │
     └──cancel_unbound_gig──▶ ◯ Refunded (no record)

Brand reclaim (creator never delivered):
  Bound ──brand_refund (after delivery_deadline + grace)──▶ ◯ Refunded (no record)

Disputes:
  Bound | Delivered ──open_dispute──▶ Disputed ──arbitrate──▶ ◯ Resolved (record)
```

`◯` denotes a terminal — `ContractEscrow` is closed and (for `Settled` /
`Resolved`) a `ContractRecord` is written.

### 3.3 `Outcome`

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum Outcome {
    Release,                       // price → creator, fee → treasury (== approve_release)
    Refund,                        // price + fee → brand
    Split { creator_bps: u16 },    // creator_bps ≤ 10_000; floor(price * bps/10_000) → creator,
                                   // remainder → brand, fee → treasury, rent → brand
}
```

**Why bps not num/denom:** `creator_bps == 0` is meaningful (== refund of price;
fee still to treasury). `creator_bps == 10_000` is meaningful (== release).
The single-`u16` shape eliminates v0.1's `denom == 0` footgun and matches the
rest of the protocol (`fee_bps`).

**Fee always to treasury on `Split`:** the marketplace did the work of routing
the contract regardless of which party ends up with the price.

### 3.4 `SettledOutcome`

Lives on `ContractRecord`. The terminal-state distinguisher.

```rust
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum SettledOutcome {
    Settled,            // approve_release or auto_release
    Resolved(Outcome),  // arbitrate
}
```

`Refunded` is not represented here — `brand_refund` and `cancel_unbound_gig`
don't write a `ContractRecord` (no rating to be made).

## 4. Contract ID derivation

`contract_id` is a 32-byte client-supplied id used as the second seed of the
`ContractEscrow` PDA. To prevent silent client/program drift, both sides
compute it the same way:

```
contract_id = sha256(utf8_bytes(off_chain_id))
```

sha256 already produces 32 bytes — no truncation needed.

| Off-chain source | Input | Where it comes from |
|---|---|---|
| Service order | Firestore `orders/{orderId}` document id | Auto-generated by Firestore |
| Gig contract | Firestore `gigs/{gigId}` document id | Auto-generated by Firestore |

The Rust side exposes `state::contract_id::derive(&str) -> [u8; 32]` plus a
fixture module with known-input/known-output pairs:

```rust
pub const FIXTURES: &[(&str, [u8; 32])] = &[
    ("test-order-001", hex_literal::hex!("...")),
    ("test-gig-001",   hex_literal::hex!("...")),
];
```

The TypeScript side at `../adler-website/lib/anchor/pda.ts` imports these
fixtures (via a generated JSON file) and asserts byte-for-byte parity in
`pda.test.ts`. **CI gate on the web side.**

## 5. Instruction matrix

13 ix total. Each row: signer, key accounts, preconditions, postconditions,
lamport effect.

### 5.1 Admin

| Ix | Signer | Accounts (writable) | Preconditions | Postconditions | Lamports |
|---|---|---|---|---|---|
| `init_protocol(args)` | admin (any) | `ProtocolConfig` (init) | PDA does not exist | `ProtocolConfig` written with args | None |
| `update_protocol_field(field)` | `config.admin` | `ProtocolConfig` | PDA exists | One field updated per call | None |
| `set_paused(paused)` | `config.admin` | `ProtocolConfig` | PDA exists | `paused = arg` | None |
| `init_arbitration_pool(quorum)` | admin (any) | `ArbitrationPool` (init), `ProtocolConfig` (write `arbitration_pool`) | Pool PDA does not exist | Pool initialized; `config.arbitration_pool` written | None |
| `add_arbiter(pubkey)` | `pool.admin` | `ArbitrationPool` | `arbiters.len() < 16`, pubkey not already in `arbiters` | Pubkey appended | None |
| `remove_arbiter(pubkey)` | `pool.admin` | `ArbitrationPool` | Pubkey in `arbiters`; if `disputed_count > 0`, `arbiters.len() > 1` | Pubkey removed | None |

### 5.2 Service path

| Ix | Signer | Accounts (writable) | Preconditions | Postconditions | Lamports |
|---|---|---|---|---|---|
| `fund_service(contract_id, price_lamports)` | brand | `ContractEscrow` (init), brand (debit), `ProtocolConfig` (read) | `!paused`; `price_lamports > 0`; reads `fee_bps` from config | `kind=Service`, `state=Bound`, `creator=arg`, `fee_lamports` computed, `delivery_deadline = now + approval_window_secs` | brand → PDA: `price + fee` |

### 5.3 Gig path

| Ix | Signer | Accounts (writable) | Preconditions | Postconditions | Lamports |
|---|---|---|---|---|---|
| `fund_gig(contract_id, budget_lamports, delivery_deadline)` | brand | `ContractEscrow` (init), brand (debit) | `!paused`; `budget_lamports > 0`; `delivery_deadline > now` | `kind=Gig`, `state=Funded`, `creator=Pubkey::default()`, args stored | brand → PDA: `price + fee` |
| `bind_creator(contract_id, creator)` | brand | `ContractEscrow` | `!paused`; `state==Funded`; if `state==Bound && escrow.creator==arg`: no-op (idempotent) | `state=Bound`, `creator=arg` | None |
| `cancel_unbound_gig(contract_id)` | brand | `ContractEscrow` (close to brand) | `!paused`; `state==Funded` | PDA closed | PDA → brand: `price + fee + rent` |

### 5.4 Lifecycle

| Ix | Signer | Accounts (writable) | Preconditions | Postconditions | Lamports |
|---|---|---|---|---|---|
| `submit_delivery(contract_id)` | escrow.creator | `ContractEscrow` | `!paused`; `state==Bound` | `state=Delivered`, `delivered_at=now`, `approval_deadline=now + approval_window_secs` | None |
| `request_revision(contract_id)` | escrow.brand | `ContractEscrow` | `!paused`; `state==Delivered`; `revisions_used < 2` | `state=Bound`, `revisions_used += 1` | None |
| `approve_release(contract_id)` | escrow.brand | `ContractEscrow` (close to brand), `ContractRecord` (init), creator (credit), fee_treasury (credit) | `!paused`; `state==Delivered`; `fee_treasury == config.fee_treasury` | Record written (`outcome=Settled`), PDA closed | PDA → creator: `price`; PDA → treasury: `fee`; PDA → brand: `rent` (minus record's rent paid by brand) |
| `auto_release(contract_id)` | any | `ContractEscrow` (close to brand), `ContractRecord` (init, brand pays rent), creator (credit), fee_treasury (credit) | `!paused`; `state==Delivered`; `now >= approval_deadline` | Same as `approve_release` | Same as `approve_release` |
| `brand_refund(contract_id)` | escrow.brand | `ContractEscrow` (close to brand) | `!paused`; `state==Bound`; `now >= delivery_deadline + refund_grace_secs` | PDA closed (no record written) | PDA → brand: `price + fee + rent` |

**Note on `auto_release` rent:** the caller pays gas (it's permissionless) but
the `ContractRecord` rent comes from `brand` via `payer = brand`. This requires
brand to be a signer for `auto_release` — but `auto_release` is permissionless
(any caller). The resolution: `ContractRecord` is initialized with
`init_if_needed = false, payer = caller`, and the caller (the auto-release
fee-payer keypair) eats the ~0.002 SOL. The fee-payer wallet is topped up via
`solana airdrop` on devnet ([`TODO.md`](../TODO.md) → **Devnet**).

### 5.5 Disputes

| Ix | Signer | Accounts (writable) | Preconditions | Postconditions | Lamports |
|---|---|---|---|---|---|
| `open_dispute(contract_id)` | escrow.brand or escrow.creator | `ContractEscrow`, `ArbitrationPool` (`disputed_count += 1`) | `!paused`; `state == Bound \| Delivered`; signer is brand or creator | `state=Disputed`, `dispute_filer=signer`, `dispute_opened_at=now` | None |
| `arbitrate(contract_id, outcome)` | arbiter (in pool) | `ContractEscrow` (close), `ContractRecord` (init), creator (credit), brand (credit + rent), fee_treasury (credit), `ArbitrationPool` (`disputed_count -= 1`) | `!paused`; `state==Disputed`; signer in `pool.arbiters`; for `Split { creator_bps }`: `creator_bps <= 10_000` | Record written (`outcome=Resolved(arg)`), PDA closed | Per outcome (see §3.3) |

### 5.6 Reputation

| Ix | Signer | Accounts (writable) | Preconditions | Postconditions | Lamports |
|---|---|---|---|---|---|
| `mint_reputation(contract_id, axes, comment_hash)` | brand or creator (per `ContractRecord`) | `ReputationCard` (init), `ContractRecord` (read) | `record.outcome ∈ {Settled, Resolved(Release), Resolved(Split{*})}` (NOT `Resolved(Refund)` — no fund movement to creator); `reviewer != subject`; each axis ∈ 1..=5; PDA does not exist | `ReputationCard` written | None |

**Why `Resolved(Refund)` is excluded:** when the dispute resolved as a full
refund, the creator received nothing — there's no contractual relationship to
rate. `Split { creator_bps: 0 }` is treated like `Refund` for this purpose; the
record's outcome is `Resolved(Split{0})` which is technically allowed for
minting, but in practice the UI gates the rating dialog on this flag too.

## 6. Lamport accounting

### 6.1 Fee math

```rust
let fee_lamports = price_lamports
    .checked_mul(config.fee_bps as u64)
    .ok_or(EscrowError::Overflow)?
    / 10_000;
```

Floor rounding (integer division). At the documented `priceSol <= 10_000`
ceiling and `fee_bps <= 1000`, `price_lamports * fee_bps` peaks at
`10_000 * 1e9 * 1000 = 1e16`, well under `u64::MAX = 1.8e19`. Safety margin is
3 orders of magnitude.

### 6.2 Rent

`rent = Rent::get()?.minimum_balance(8 + ContractEscrow::INIT_SPACE)`. Brand
pays it at fund time; brand receives it back on close (every terminal path that
closes the escrow returns rent to brand).

### 6.3 Lamport flow per terminal ix

| Ix | Total in PDA | Out: creator | Out: brand | Out: treasury |
|---|---|---|---|---|
| `approve_release` | `price + fee + rent` | `price` | `rent` | `fee` |
| `auto_release` | `price + fee + rent` | `price` | `rent` | `fee` |
| `brand_refund` | `price + fee + rent` | 0 | `price + fee + rent` | 0 |
| `cancel_unbound_gig` | `price + fee + rent` | 0 | `price + fee + rent` | 0 |
| `arbitrate(Release)` | `price + fee + rent` | `price` | `rent` | `fee` |
| `arbitrate(Refund)` | `price + fee + rent` | 0 | `price + fee + rent` | 0 |
| `arbitrate(Split{bps})` | `price + fee + rent` | `floor(price * bps / 10_000)` | `price - floor(price * bps / 10_000) + rent` | `fee` |

**Invariant:** for every row, `creator + brand + treasury == price + fee + rent`.
This is the property test target in Phase 5 (Tests group of [`TODO.md`](../TODO.md)).

### 6.4 Close semantics

For the `Release` / `Split` / `arbitrate(Release)` paths, we need *partial*
movement before close: transfer `price` to creator, `fee` to treasury, *then*
`close = brand` returns the residual (= `rent`) to brand. **Order matters —
close last.**

Use direct lamport mutation on the PDA:

```rust
**ctx.accounts.escrow.to_account_info().try_borrow_mut_lamports()? -= price;
**ctx.accounts.creator.to_account_info().try_borrow_mut_lamports()? += price;
```

…since the source is a PDA and `system_program::transfer` requires the source
to be system-owned. Anchor's `close = brand` constraint at the account level
handles the final residual correctly.

## 7. Errors

```rust
#[error_code]
pub enum EscrowError {
    // Carried over from v0.1
    #[msg("Price must be greater than zero.")]
    InvalidPrice,
    #[msg("Brand pubkey on the instruction does not match the PDA's brand.")]
    BrandMismatch,
    #[msg("Creator pubkey on the instruction does not match the PDA's creator.")]
    CreatorMismatch,
    #[msg("Fee treasury pubkey does not match ProtocolConfig.fee_treasury.")]
    FeeTreasuryMismatch,
    #[msg("Arithmetic overflow.")]
    Overflow,

    // New in v1
    #[msg("Protocol is paused; settlement-mutating instructions are blocked.")]
    ProtocolPaused,
    #[msg("Signer is not a party to this contract.")]
    NotAParty,
    #[msg("Revision cap (2) reached; the next step is open_dispute.")]
    RevisionCapReached,
    #[msg("Contract is not in the required state for this instruction.")]
    WrongState,
    #[msg("Delivery deadline has not yet passed.")]
    DeliveryDeadlineNotReached,
    #[msg("Approval deadline has not yet passed.")]
    ApprovalDeadlineNotReached,
    #[msg("Refund grace window has not yet elapsed.")]
    RefundGraceActive,
    #[msg("Reputation axis must be between 1 and 5 inclusive.")]
    InvalidAxis,
    #[msg("Split creator_bps must be ≤ 10_000.")]
    InvalidBps,
    #[msg("Signer is not a member of the arbitration pool.")]
    ArbiterNotInPool,
    #[msg("contract_id arg does not match the PDA's contract_id.")]
    ContractIdMismatch,
    #[msg("Brand transferred the wrong fee amount.")]
    FeeMismatch,
    #[msg("Arbitration pool is full (max 16 arbiters).")]
    PoolFull,
    #[msg("Pubkey is already in the arbitration pool.")]
    DuplicateArbiter,
    #[msg("Cannot remove the last arbiter while disputes are open.")]
    LastArbiterWithDisputes,
    #[msg("Deadline argument is invalid (must be in the future).")]
    InvalidDeadline,
    #[msg("Singleton PDA is already initialized.")]
    AlreadyInitialized,
    #[msg("Reviewer cannot rate themselves.")]
    SelfRating,
    #[msg("Cannot mint reputation for a refund-resolved contract.")]
    NotRatable,
}
```

## 8. Security notes

These are the audit checklist items, not a substitute for an external audit
(out of scope for the hackathon per [`TODO.md`](../TODO.md) → **Mainnet**).

### 8.1 Signer authority

Every settlement ix has exactly one or two valid signers. The Anchor account
constraints encode this:

```rust
// Example: approve_release
#[account(
    mut,
    seeds = [b"contract", brand.key().as_ref(), &contract_id],
    bump = escrow.bump,
    has_one = brand,
    has_one = creator,
    has_one = fee_treasury,
    close = brand,
)]
pub escrow: Account<'info, ContractEscrow>,

#[account(mut)]
pub brand: Signer<'info>,  // ← enforced by Anchor
```

`open_dispute` is the only ix where the valid signer is "either of two
pubkeys" — encoded via a custom check:

```rust
require!(
    signer.key() == escrow.brand || signer.key() == escrow.creator,
    EscrowError::NotAParty,
);
```

### 8.2 Re-entrancy

Solana's runtime executes one CPI at a time per top-level transaction;
cross-program re-entrancy is prevented by the loader (a program cannot call
itself recursively). Within a single ix, lamport mutations happen on
already-borrowed accounts via `try_borrow_mut_lamports` — no second mutable
borrow path. Re-entrancy is structurally impossible here.

### 8.3 Overflow

Every arithmetic op on `u64` lamports uses `checked_mul`, `checked_add`,
`checked_sub`. The release `[profile.release]` block in `Cargo.toml` already
has `overflow-checks = true`, so even unchecked ops would panic at runtime —
but explicit `checked_*` is cleaner and produces our `Overflow` error code.

### 8.4 Account validation

PDA seeds embed `brand` (the funder) → an attacker cannot swap an unrelated
brand into an instruction without the PDA mismatch failing the bump check.
`has_one` on `brand`, `creator`, `fee_treasury` ensures the supplied accounts
match what was snapshotted at fund time.

### 8.5 Time

`Clock::get()?.unix_timestamp` is the only time source. Slot timestamps can
drift from wall-clock by minutes under network stress; deadlines are coarse
(24h+) so this is non-issue.

### 8.6 PDA-init race

Ix that create singleton PDAs (`init_protocol`, `init_arbitration_pool`) are
racy: two admins submitting at the same time → one succeeds, one fails with
the standard "account already exists" error. We surface this as
`AlreadyInitialized` for clarity.

### 8.7 Admin compromise

`config.admin` can update fees, treasury, deadlines, and the pause flag. On
devnet this is a single key; mainnet rotates to a Squads multisig
([`TODO.md`](../TODO.md) → **Mainnet**). `update_protocol_field` is
per-field-typed-enum so audit logs show exactly what changed.

## 9. Differences from v0.1

For posterity. The deployed v0.1 binary at
`3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD` is the museum reference; source
for v0.1 is preserved in git history before the v1 cutover commit.

| Concern | v0.1 | v1.0 |
|---|---|---|
| Program ID | `3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD` | `BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr` |
| PDA seeds | `[b"escrow", brand, contract_id]` | `[b"contract", brand, contract_id]` (renamed; v0.1 PDAs not readable by v1) |
| Account layouts | One: `EscrowAccount` | Five: `ProtocolConfig`, `ArbitrationPool`, `ContractEscrow`, `ContractRecord`, `ReputationCard` |
| Settlement state machine | `Funded → Settled\|Refunded\|Disputed` | `Funded → Bound → Delivered → ◯` plus branches |
| Auto-release gate | Fires on `Funded` ⚠️ | Fires on `Delivered` (v0.1 bug fixed) |
| Arbitration | One pubkey per PDA | Singleton `ArbitrationPool`, up to 16 arbiters |
| Fee policy | Hardcoded per-call args | Stored in `ProtocolConfig`, runtime-tunable |
| Pause switch | None | `set_paused` |
| Revisions | None | `request_revision`, capped at 2 |
| Gig path | None | `fund_gig` + `bind_creator` + `cancel_unbound_gig` |
| Reputation | None | `ReputationCard` PDA per (subject, contract_id) |
| `Outcome::Split` | `{ num: u64, denom: u64 }` (denom == 0 footgun) | `{ creator_bps: u16 }` (≤ 10_000) |
| Errors | 12 codes | 22 codes |
| Total ix | 6 | 13 |
