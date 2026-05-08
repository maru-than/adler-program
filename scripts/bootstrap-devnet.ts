/**
 * Bootstrap the protocol singletons (ProtocolConfig + ArbitrationPool) on
 * devnet (or any cluster).
 *
 * Idempotent: each PDA is checked first and only written if it doesn't yet
 * exist. Already-initialized state is logged for verification.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   [ADLER_DEVNET_TREASURY=<base58>] \
 *   npx ts-node scripts/bootstrap-devnet.ts
 *
 * The ADLER_DEVNET_TREASURY env var is only required on FIRST init of
 * ProtocolConfig (the script errors otherwise). Re-running once initialized
 * is always a no-op read.
 *
 * Defaults written on first init match docs/approval-deadline.md:
 *   fee_bps              50     (0.5 %)
 *   approval_window_secs 259200 (72 h)
 *   refund_grace_secs    86400  (24 h)
 *   admin                provider wallet pubkey
 *   arbitration_pool     populated by this same script
 *   pool.quorum          1
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

import type { AdlerEscrow } from "../target/types/adler_escrow";

const FEE_BPS = 50;
const APPROVAL_WINDOW_SECS = new BN(72 * 3600);
const REFUND_GRACE_SECS = new BN(24 * 3600);

async function bootstrapProtocolConfig(
  program: Program<AdlerEscrow>,
  provider: anchor.AnchorProvider,
  admin: anchor.web3.Keypair,
): Promise<PublicKey> {
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );

  const existing = await provider.connection.getAccountInfo(configPda);
  if (existing) {
    const cfg = await program.account.protocolConfig.fetch(configPda);
    console.log("→ ProtocolConfig already initialized:");
    console.log(`    admin:                ${cfg.admin.toBase58()}`);
    console.log(`    fee_treasury:         ${cfg.feeTreasury.toBase58()}`);
    console.log(`    fee_bps:              ${cfg.feeBps}`);
    console.log(`    approval_window_secs: ${cfg.approvalWindowSecs.toString()}`);
    console.log(`    refund_grace_secs:    ${cfg.refundGraceSecs.toString()}`);
    console.log(`    arbitration_pool:     ${cfg.arbitrationPool.toBase58()}`);
    console.log(`    paused:               ${cfg.paused}`);
    return configPda;
  }

  const treasuryEnv = process.env.ADLER_DEVNET_TREASURY;
  if (!treasuryEnv) {
    throw new Error(
      "ProtocolConfig not yet initialized. " +
        "Set ADLER_DEVNET_TREASURY=<base58 pubkey> and re-run.",
    );
  }
  const treasury = new PublicKey(treasuryEnv);

  console.log(`→ Initializing ProtocolConfig (treasury=${treasury.toBase58()})…`);
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
  console.log(`  ✓ tx ${sig}`);
  return configPda;
}

async function bootstrapArbitrationPool(
  program: Program<AdlerEscrow>,
  provider: anchor.AnchorProvider,
  admin: anchor.web3.Keypair,
  configPda: PublicKey,
): Promise<PublicKey> {
  const [poolPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("arb_pool")],
    program.programId,
  );

  const existing = await provider.connection.getAccountInfo(poolPda);
  if (existing) {
    const pool = await program.account.arbitrationPool.fetch(poolPda);
    console.log("→ ArbitrationPool already initialized:");
    console.log(`    admin:           ${pool.admin.toBase58()}`);
    console.log(`    arbiters:        [${pool.arbiters.map((a) => a.toBase58()).join(", ")}]`);
    console.log(`    quorum:          ${pool.quorum}`);
    console.log(`    disputed_count:  ${pool.disputedCount}`);
    return poolPda;
  }

  console.log("→ Initializing ArbitrationPool…");
  const sig = await program.methods
    .initArbitrationPool(1)
    .accountsStrict({
      config: configPda,
      pool: poolPda,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  ✓ tx ${sig}`);
  return poolPda;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AdlerEscrow as Program<AdlerEscrow>;
  const admin = (provider.wallet as anchor.Wallet).payer;
  const cluster = provider.connection.rpcEndpoint;

  console.log(`RPC:        ${cluster}`);
  console.log(`Program ID: ${program.programId.toBase58()}`);
  console.log(`Admin:      ${admin.publicKey.toBase58()}`);
  console.log();

  const configPda = await bootstrapProtocolConfig(program, provider, admin);
  console.log();
  await bootstrapArbitrationPool(program, provider, admin, configPda);
  console.log();
  console.log("✓ Bootstrap complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
