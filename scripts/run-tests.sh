#!/usr/bin/env bash
#
# Test runner. Workaround for Anchor 0.31 + Solana 3.x where `anchor test`'s
# auto-validator-start + deploy doesn't reliably load the program before the
# mocha suite begins (program returns "Program is not deployed" mid-run).
#
# This wrapper:
#   1. Kills any stale solana-test-validator
#   2. Starts a fresh one with the program pre-loaded via --bpf-program
#   3. Waits for the RPC to be reachable
#   4. Runs the ts-mocha suite against it
#   5. Tears down the validator on exit

set -euo pipefail

cd "$(dirname "$0")/.."

PROGRAM_ID="BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr"
PROGRAM_SO="target/deploy/adler_escrow.so"
RPC_URL="http://localhost:8899"
LEDGER_DIR="test-ledger"

if [[ ! -f "$PROGRAM_SO" ]]; then
    echo "ERROR: $PROGRAM_SO missing — run 'anchor build' first" >&2
    exit 1
fi

# Kill stale validator (best effort) and clear ledger.
pkill -f "solana-test-validator" 2>/dev/null || true
sleep 1
rm -rf "$LEDGER_DIR"

# Start validator in background with the program preloaded. --bpf-program
# loads the .so at the given address before the validator accepts RPCs, so
# tests can invoke immediately on first connection.
solana-test-validator \
    --reset \
    --quiet \
    --bpf-program "$PROGRAM_ID" "$PROGRAM_SO" \
    --ledger "$LEDGER_DIR" \
    > /dev/null 2>&1 &
VALIDATOR_PID=$!

cleanup() {
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
    rm -rf "$LEDGER_DIR"
}
trap cleanup EXIT

# Wait for RPC to be ready (up to 30 s).
for _ in $(seq 1 30); do
    if solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then
        break
    fi
    sleep 1
done

if ! solana cluster-version --url "$RPC_URL" >/dev/null 2>&1; then
    echo "ERROR: validator did not start within 30s" >&2
    exit 1
fi

# Sanity check: program must be loaded and executable.
if ! solana account "$PROGRAM_ID" --url "$RPC_URL" 2>&1 | grep -q "Executable: true"; then
    echo "ERROR: program $PROGRAM_ID not loaded as executable" >&2
    exit 1
fi

# Run the test suite.
ANCHOR_PROVIDER_URL="$RPC_URL" \
ANCHOR_WALLET="$HOME/.config/solana/id.json" \
    npx ts-mocha -p ./tsconfig.json -t 1000000 'tests/**/*.test.ts'
