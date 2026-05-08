# Build vs buy: why a custom Anchor program

Adler v0.1 was built greenfield against [PRODUCT.md](../PRODUCT.md) and the
v0.1 whitepaper instead of integrating an existing escrow primitive. That
decision is non-obvious — there are several mature Solana products in the
adjacent space — so this doc records the spike findings.

The summary: **none of the off-the-shelf options can deliver the
"non-custodial brand budget locked between match and approval" primitive
that Adler's settlement model requires.** They miss in two directions —
either the wrong settlement curve (Streamflow) or the wrong custody model
(Squads, Helio, Sphere, Crossmint).

## What we needed

The on-chain primitive Adler needs is, exactly:

1. **Brand-funded escrow per contract.** Brand transfers `price + fee` into
   a per-contract account at match time.
2. **0% release until approval, then 100% atomic split.** No vesting, no
   streaming. Funds sit until the brand approves; then `price → creator`,
   `fee → treasury`, `rent → brand`, all in one tx.
3. **No marketplace co-sign.** The marketplace operator (Adler) cannot
   block, redirect, or take custody. Only the brand (approve / refund) and
   the bound creator (deliver / dispute) and the arbitration pool
   (resolve disputes) can move funds.
4. **Auto-release after timeout.** Permissionless permission to release
   after `approval_deadline` so brands can't grief by withholding approval.
5. **Three dispute outcomes** — release, refund, split{creator_bps} — with
   a defined arbiter signer set.
6. **Deterministic on-chain reputation** as a side-effect of settlement.

## Streamflow

[Streamflow](https://streamflow.finance/) is a vesting + token-streaming
protocol. The on-chain primitive is "release X tokens linearly between
`start` and `end`" with optional cliff / step parameters.

**Why it doesn't fit:**
- The release curve is wrong. Adler's curve is binary (0% then 100% on
  approval), not linear. Mapping that onto Streamflow would require
  setting `cliff = end` and a release-on-cliff-only mode, which works
  topologically but inverts the model — what Streamflow calls "the cliff"
  is what Adler calls "approval", and Streamflow has no notion of an
  approval signer-gate distinct from the cliff timestamp.
- No multi-party resolution. Streamflow has a single sender + recipient.
  Adler's three-outcome dispute path needs an arbiter who isn't the
  sender or recipient and can split funds non-linearly.
- No fee-routing primitive. Adler takes a 50 bps protocol fee on every
  settled contract (see whitepaper §6); Streamflow has no built-in fee
  treasury concept.

**Verdict:** wrong primitive.

## Squads

[Squads Protocol](https://squads.so/) is a multisig wallet system. Could be
used for "the marketplace co-signs every contract release."

**Why it doesn't fit:**
- Violates non-custody. If Adler is a co-signer on every contract release,
  Adler holds discretionary authority over user funds — exactly what the
  whitepaper says it must NOT do (§4 and §11). A regulator or an internal
  bad actor at Adler could halt every payment.
- Bad UX. Each contract would require a Squads tx + signature flow on top
  of the buy / deliver / approve flow. The wallet UX would be three
  signatures per contract instead of one per phase.
- Doesn't solve dispute resolution. Multisig signs or doesn't sign — there's
  no native "split 60/40" outcome.

**Verdict:** wrong custody model.

## Helio / Sphere / Crossmint

Three Solana payment processors with different go-to-market. All three are
custody-positive: the user pays the processor, the processor settles to the
merchant (with or without escrow flavor depending on the product).

**Why none fit:**
- Custody. Same problem as Squads. Adler explicitly does not hold user
  funds; the program does.
- Subscription-style fees. All three monetize via per-tx + monthly fees on
  top of the payment, on top of Solana network fees. Adler's 50 bps on
  *settled* contracts is structurally cheaper.
- Closed source / proprietary settlement contracts. Auditing the actual
  fund-routing logic is hard or impossible. For a marketplace where the
  "money is on-chain, programmatic, auditable" thesis is core, opaque
  settlement is a non-starter.

**Verdict:** wrong custody model + business model.

## Cost of building it ourselves

The v1 program is **18 instructions across ~1500 LoC of Rust** spread across
focused modules. Tests are 76 cases at ~3 minutes total runtime. The IDL is
~25 KB.

External audit cost is the dominant unknown — quotes from previous
shipments suggest $25-50K for a comprehensive audit of a program at this
size. That cost is not unique to building vs buying: any of the
off-the-shelf options would still need an *integration* audit (how Adler
glues itself onto their primitive) and additional config validation. The
delta is "audit our 1500 LoC" vs "audit ours + the integration glue", which
is comparable.

**Verdict:** custom Anchor was the right call. The build cost
(~10 working days through Phases 0-7) is small compared to the
hard-or-impossible compromises forced by every alternative.

---

This decision is reviewed pre-mainnet. If a primitive emerges that matches
all six requirements above, swapping is mechanical (the web client's
`lib/escrow/*` wrappers are the only seam that needs to change).
