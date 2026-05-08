# Adler Escrow — Approval & Refund Deadlines

The on-chain settlement program holds brand funds for the duration of a
contract. Two deadlines bound that hold:

- **`approval_window_secs`** — how long the brand has to approve a delivered
  contract before `auto_release` becomes callable. Default **72 hours**
  (259_200 seconds).
- **`refund_grace_secs`** — how long after the delivery deadline the brand has
  to wait before reclaiming funds for a never-delivered contract via
  `brand_refund`. Default **24 hours** (86_400 seconds).

Both are stored in `ProtocolConfig` and tunable at runtime via
`update_protocol_field` — they're not hardcoded constants. This document pins
the canonical defaults and the rationale.

## Defaults

| Parameter | Value | Where |
|---|---|---|
| `approval_window_secs` | 259_200 (72 h) | `ProtocolConfig.approval_window_secs` |
| `refund_grace_secs` | 86_400 (24 h) | `ProtocolConfig.refund_grace_secs` |

These are the values `init_protocol` writes on the first deploy. If
`update_protocol_field` is later called to change them, this document gets a
footnote — the defaults here are the *initial* policy, not necessarily current
state.

## Rationale

### 72-hour approval window

Three days covers a full weekend. Most creators submit deliveries Monday–Friday;
brands review on the next business day. A 72-hour window means a Friday-afternoon
delivery is reviewable by Monday-afternoon without `auto_release` firing.

Shorter windows (e.g. 24h) make weekend deliveries unsafe. Longer windows (e.g.
1 week) let bad-faith brands sit on a delivery indefinitely while the creator's
funds are locked in escrow.

72h is also what the marketing copy on `app/page.tsx` advertises ("approve
within 3 days") — changing the window means changing the copy. **If you bump
this, also update the landing page hero and the FAQ.**

### 24-hour refund grace

If the delivery deadline elapses and the creator hasn't submitted, the brand
wants their money back. But "instantly clawable on the second the deadline
passes" is too aggressive: the creator might have submitted minutes before the
deadline and the chain is still confirming. A 24-hour buffer absorbs that
timing noise.

It also gives the creator a final window to dispute (e.g. "I submitted on time,
the network was congested, here's the tx") before the brand reclaims.

### Whitepaper §6

Both numbers are pinned in the [v0.1 whitepaper](../../adler-website/app/whitepaper/page.tsx)
under "Payments". When the whitepaper hits v1, this document is the
authoritative source — the whitepaper references it, not vice versa.

## Where these values are read

- `init_protocol` (Rust): writes them into `ProtocolConfig` on first deploy.
  The bootstrap script (`scripts/bootstrap-devnet.ts`) passes them as arguments.
- `fund_service` (Rust): reads `approval_window_secs` to compute
  `delivery_deadline = now + approval_window_secs`.
- `submit_delivery` (Rust): reads `approval_window_secs` to compute
  `approval_deadline = now + approval_window_secs`.
- `brand_refund` (Rust): reads `refund_grace_secs` to enforce
  `now >= delivery_deadline + refund_grace_secs`.
- `paymentService.payForListing` and `DeliverableDialog` (web,
  `../adler-website`): show the projected deadlines in user-facing copy.
  Pulled from `ProtocolConfig` via the typed program client, not hardcoded —
  copy stays in sync if the admin tunes the config.

## Tuning policy

`update_protocol_field` is admin-only and per-field. Changes take effect for
*new* contracts only — already-funded `ContractEscrow` PDAs snapshotted the
old values at fund time and use those. This is intentional: brands and
creators agreed to the deadlines at fund time, and a mid-flight change would
be a unilateral repricing.

If you tune one of these values:

1. Open a PR against this document with the new value and the rationale.
2. Update the whitepaper + landing copy in the same change.
3. Coordinate the on-chain `update_protocol_field` call with the deploy of the
   copy change so the UI never shows a deadline that doesn't match what the
   program enforces.
