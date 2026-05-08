/**
 * Bootstrap the ProtocolConfig singleton on devnet (or any cluster).
 *
 * Idempotent: if the ProtocolConfig PDA already exists, this script reads it
 * back and prints the current values without any on-chain writes. To
 * initialize for the first time, set ADLER_DEVNET_TREASURY to the base58
 * pubkey that should receive protocol fees.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   ADLER_DEVNET_TREASURY=<base58> \
 *   npx ts-node scripts/bootstrap-devnet.ts
 *
 * Or via Anchor:
 *   anchor run bootstrap-devnet
 *
 * Defaults written on first init match docs/approval-deadline.md:
 *   fee_bps             50    (0.5 %)
 *   approval_window_secs 259200 (72 h)
 *   refund_grace_secs   86400  (24 h)
 *   admin               provider wallet pubkey
 *   arbitration_pool    Pubkey::default()  (set later by init_arbitration_pool)
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import type { AdlerEscrow } from "../target/types/adler_escrow";

const FEE_BPS = 50;
const APPROVAL_WINDOW_SECS = new BN(72 * 3600);
const REFUND_GRACE_SECS = new BN(24 * 3600);

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AdlerEscrow as Program<AdlerEscrow>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const cluster = provider.connection.rpcEndpoint;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );

  console.log(`→ RPC:                ${cluster}`);
  console.log(`→ Program ID:         ${program.programId.toBase58()}`);
  console.log(`→ Admin (signer):     ${admin.publicKey.toBase58()}`);
  console.log(`→ ProtocolConfig PDA: ${configPda.toBase58()}`);
  console.log();

  const existing = await provider.connection.getAccountInfo(configPda);
  if (existing) {
    const cfg = await program.account.protocolConfig.fetch(configPda);
    console.log("ProtocolConfig already initialized — no on-chain writes:");
    console.log(`  admin:                ${cfg.admin.toBase58()}`);
    console.log(`  fee_treasury:         ${cfg.feeTreasury.toBase58()}`);
    console.log(`  fee_bps:              ${cfg.feeBps}`);
    console.log(`  approval_window_secs: ${cfg.approvalWindowSecs.toString()}`);
    console.log(`  refund_grace_secs:    ${cfg.refundGraceSecs.toString()}`);
    console.log(`  arbitration_pool:     ${cfg.arbitrationPool.toBase58()}`);
    console.log(`  paused:               ${cfg.paused}`);
    return;
  }

  const treasuryEnv = process.env.ADLER_DEVNET_TREASURY;
  if (!treasuryEnv) {
    console.error(
      "ERROR: ProtocolConfig not yet initialized.\n" +
        "Set ADLER_DEVNET_TREASURY=<base58 pubkey> (the lamport sink for protocol fees) and re-run.",
    );
    process.exit(1);
  }

  let treasury: PublicKey;
  try {
    treasury = new PublicKey(treasuryEnv);
  } catch (e) {
    console.error(`ERROR: ADLER_DEVNET_TREASURY is not a valid base58 pubkey: ${treasuryEnv}`);
    process.exit(1);
  }

  console.log(`→ Initializing with treasury ${treasury.toBase58()} ...`);

  const sig = await program.methods
    .initProtocol(
      admin.publicKey,
      treasury,
      FEE_BPS,
      APPROVAL_WINDOW_SECS,
      REFUND_GRACE_SECS,
    )
    .accountsStrict({
      config: configPda,
      payer: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  console.log();
  console.log(`✓ Initialized. Tx: ${sig}`);
  if (cluster.includes("devnet")) {
    console.log(`  Explorer: https://explorer.solana.com/tx/${sig}?cluster=devnet`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
