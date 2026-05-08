#!/usr/bin/env bash
#
# One-shot devnet deploy: build, deploy to devnet, init or upgrade the IDL.
# Idempotent — safe to re-run after every program change.
#
# Usage:
#   scripts/deploy-devnet.sh
#
# Prereqs:
#   - solana-cli configured to a wallet with ≥ 5 SOL on devnet
#     (`solana config set --url devnet && solana airdrop 5`)
#   - target/deploy/adler_escrow-keypair.json present (the v1 program key)

set -euo pipefail

cd "$(dirname "$0")/.."

KEYPAIR="target/deploy/adler_escrow-keypair.json"
IDL_FILE="target/idl/adler_escrow.json"
CLUSTER="devnet"

if [[ ! -f "$KEYPAIR" ]]; then
    echo "ERROR: $KEYPAIR not found. Generate via solana-keygen new -o $KEYPAIR" >&2
    exit 1
fi

PROGRAM_ID=$(solana-keygen pubkey "$KEYPAIR")
echo "→ Program ID: $PROGRAM_ID"
echo "→ Cluster:    $CLUSTER"

echo
echo "→ anchor build"
anchor build

if [[ ! -f "$IDL_FILE" ]]; then
    echo "ERROR: $IDL_FILE missing after build" >&2
    exit 1
fi

echo
echo "→ anchor deploy --provider.cluster $CLUSTER"
anchor deploy --provider.cluster "$CLUSTER"

echo
echo "→ anchor idl (init or upgrade)"
if anchor idl fetch "$PROGRAM_ID" --provider.cluster "$CLUSTER" >/dev/null 2>&1; then
    echo "  IDL exists; upgrading"
    anchor idl upgrade --provider.cluster "$CLUSTER" --filepath "$IDL_FILE" "$PROGRAM_ID"
else
    echo "  IDL not found on-chain; initializing"
    anchor idl init --provider.cluster "$CLUSTER" --filepath "$IDL_FILE" "$PROGRAM_ID"
fi

echo
echo "→ Done."
echo "  Program: https://explorer.solana.com/address/$PROGRAM_ID?cluster=$CLUSTER"
echo
echo "  Next: scripts/bootstrap-devnet.ts (initialize ProtocolConfig if needed)"
echo "        scripts/sync-idl.sh         (push IDL into ../adler-website)"
