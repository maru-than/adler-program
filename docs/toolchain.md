# Toolchain

The exact versions this repo is built against. Drift from these has caused
hard-to-debug failures on previous runs (Anchor's IDL spec, Solana's deploy
semantics, and Rust's `derive` macros all churn between minor versions).

## Pinned versions

| Tool | Version | How to install |
|---|---|---|
| Anchor CLI | `0.31.1` | `avm install 0.31.1 && avm use 0.31.1` |
| Solana CLI | `3.1.x` (`agave`) | `sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.14/install)"` |
| Rust toolchain | `stable` (1.79+) | Anchor's `Cargo.toml` requires anchor-lang 0.31.1 which builds against rustc 1.79+ |
| Node | `≥ 20` | `nvm install 20` |
| npm packages | per `package.json` | `npm install` |

Verify your local installs match:

```bash
anchor --version       # → anchor-cli 0.31.1
solana --version       # → solana-cli 3.1.x (agave)
solana-keygen --version # → matches solana-cli
rustc --version        # → rustc 1.79.x or later
node --version         # → v20.x or later
```

## Why these specific versions

- **Anchor 0.31.1**: the v0.1 program shipped on Anchor 0.31. v1 stays on the
  same major to preserve IDL compatibility for any consumer that already
  parses the v0.1 IDL.
- **Solana 3.1 (agave)**: 2.x and 3.x have meaningful runtime behavior
  changes around rent + tx fees. The smoke test in
  [`tests/devnet-smoke.ts`](../tests/devnet-smoke.ts) needed a
  treasury-pre-seed step on 3.x because System accounts must be ≥
  rent-exempt-minimum after any credit (this was looser on 2.x). Stick to
  3.x to keep production semantics aligned with what's tested.
- **Rust stable, not nightly**: Anchor 0.31's `derive(Accounts)` macro emits
  some deprecated calls (`AccountInfo::realloc` etc) that produce nightly
  warnings; on stable they're warnings only and don't break the build.

## Test runner

`anchor test` on Anchor 0.31 + Solana 3.1 has a race between
`solana-test-validator` startup and the mocha suite kicking off — the program
deploy can land *after* the first ix tries to invoke it, producing
"Program is not deployed" failures across the suite.

Workaround: [`scripts/run-tests.sh`](../scripts/run-tests.sh), which:

1. Kills any stale validator on `localhost:8899`
2. Starts a fresh `solana-test-validator` with the program preloaded via
   `--bpf-program`
3. Waits for RPC readiness
4. Runs `npx ts-mocha 'tests/**/*.test.ts'`
5. Tears down the validator on exit

`Anchor.toml`'s `[scripts] test` points at this wrapper, so `anchor test`
calls it transparently.

## Account size estimates

Computed from `#[derive(InitSpace)]`. The 8-byte discriminator is added at
account-init time.

| PDA | `INIT_SPACE` (bytes) | + disc | Rent (≈ lamports) |
|---|---|---|---|
| `ProtocolConfig` | ~117 | 125 | ~1.76 M |
| `ArbitrationPool` | ~554 | 562 | ~4.81 M |
| `ContractEscrow` | ~217 | 225 | ~2.46 M |
| `ContractRecord` | ~147 | 155 | ~1.97 M |
| `ReputationCard` | ~149 | 157 | ~1.99 M |

Brand cost per contract = `price + fee + ContractEscrow rent + ContractRecord
rent` ≈ `price + fee + 0.0044 SOL`. Escrow rent is refundable on close;
record rent is not.

## Solana program ID

`BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr` (devnet, v1.0).

The v0.1 program ID `3GtvfooGkkXDjeAaMSAZBzzUbH7vYSFKhgKJewbi4iWD` is
preserved on devnet as the museum reference; source for v0.1 is at git tag
`v0.1`.

The keypair file `target/deploy/adler_escrow-keypair.json` is gitignored.
Losing it = losing the ability to upgrade the program at this address; back
it up out-of-band before doing anything destructive in `target/`.
