/**
 * Devnet smoke test — runs the full service happy path against the live
 * devnet program and asserts lamport movements. Run before each redeploy
 * promotion to confirm the on-chain binary still satisfies the contract
 * we test on localnet.
 *
 * This is a one-shot script (NOT a mocha test) since it touches a live
 * cluster and depends on the bootstrapped ProtocolConfig + ArbitrationPool.
 *
 * Usage:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=$HOME/.config/solana/id.json \
 *   npx ts-node tests/devnet-smoke.ts
 *
 * Requirements:
 *   - The wallet at $ANCHOR_WALLET must hold ≥ 0.5 SOL on the target cluster.
 *   - ProtocolConfig + ArbitrationPool must already be initialized
 *     (run scripts/bootstrap-devnet.ts first).
 *
 * Cost per run: ~0.01 SOL (price + fee + record rent + tx fees, mostly
 * recovered on close).
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { createHash } from "crypto";

import type { AdlerEscrow } from "../target/types/adler_escrow";

const PRICE_LAMPORTS = new BN(0.01 * LAMPORTS_PER_SOL);
const CREATOR_GAS = 0.005 * LAMPORTS_PER_SOL;

function deriveContractId(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

function explorerTx(sig: string, cluster: string): string {
  const c = cluster.includes("devnet") ? "devnet" : "mainnet-beta";
  return `https://explorer.solana.com/tx/${sig}?cluster=${c}`;
}

function explorerAddr(addr: string, cluster: string): string {
  const c = cluster.includes("devnet") ? "devnet" : "mainnet-beta";
  return `https://explorer.solana.com/address/${addr}?cluster=${c}`;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.AdlerEscrow as Program<AdlerEscrow>;
  const cluster = provider.connection.rpcEndpoint;
  const brand = (provider.wallet as anchor.Wallet).payer;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId,
  );
  const cfg = await program.account.protocolConfig.fetch(configPda);
  const treasury = cfg.feeTreasury;

  // Fresh creator each run so the (brand, contract_id) PDA pair is unique.
  const creator = Keypair.generate();
  const orderId = `smoke-${Date.now()}`;
  const contractId = deriveContractId(orderId);
  const [escrowPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("contract"), brand.publicKey.toBuffer(), contractId],
    program.programId,
  );
  const [recordPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("record"), brand.publicKey.toBuffer(), contractId],
    program.programId,
  );

  console.log(`RPC:        ${cluster}`);
  console.log(`Program:    ${program.programId.toBase58()}`);
  console.log(`Brand:      ${brand.publicKey.toBase58()}`);
  console.log(`Creator:    ${creator.publicKey.toBase58()}`);
  console.log(`Order ID:   ${orderId}`);
  console.log(`Escrow PDA: ${escrowPda.toBase58()}`);
  console.log(`Record PDA: ${recordPda.toBase58()}`);
  console.log();

  const brandStart = await provider.connection.getBalance(brand.publicKey);
  if (brandStart < 0.05 * LAMPORTS_PER_SOL) {
    throw new Error(
      `Brand balance too low (${brandStart / LAMPORTS_PER_SOL} SOL). Need ≥ 0.05.`,
    );
  }

  // The treasury is a System account (no data). Solana requires the post-tx
  // balance to be 0 OR ≥ rent-exempt-minimum, so a fresh treasury can't
  // receive a sub-rent-exempt fee credit. Seed it once if needed.
  const rentExemptMin =
    await provider.connection.getMinimumBalanceForRentExemption(0);
  const treasuryBalance = await provider.connection.getBalance(treasury);
  if (treasuryBalance < rentExemptMin) {
    const topUp = rentExemptMin - treasuryBalance;
    console.log(
      `→ Seeding treasury with ${topUp / LAMPORTS_PER_SOL} SOL (rent-exempt minimum)…`,
    );
    const seedSig = await provider.sendAndConfirm(
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: brand.publicKey,
          toPubkey: treasury,
          lamports: topUp,
        }),
      ),
    );
    console.log(`  ✓ ${explorerTx(seedSig, cluster)}`);
  }

  // Bootstrap creator with enough lamports to sign one tx.
  console.log("→ Funding creator with gas…");
  const fundCreatorTx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: brand.publicKey,
      toPubkey: creator.publicKey,
      lamports: CREATOR_GAS,
    }),
  );
  const fundSig = await provider.sendAndConfirm(fundCreatorTx);
  console.log(`  ✓ ${explorerTx(fundSig, cluster)}`);

  // 1. fund_service
  console.log("→ fund_service…");
  const fundIxSig = await program.methods
    .fundService([...contractId], PRICE_LAMPORTS)
    .accountsStrict({
      config: configPda,
      escrow: escrowPda,
      brand: brand.publicKey,
      creator: creator.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  ✓ ${explorerTx(fundIxSig, cluster)}`);

  // 2. submit_delivery
  console.log("→ submit_delivery…");
  const deliverSig = await program.methods
    .submitDelivery([...contractId])
    .accountsStrict({
      config: configPda,
      escrow: escrowPda,
      creator: creator.publicKey,
    })
    .signers([creator])
    .rpc();
  console.log(`  ✓ ${explorerTx(deliverSig, cluster)}`);

  // 3. approve_release
  console.log("→ approve_release…");
  const approveSig = await program.methods
    .approveRelease([...contractId])
    .accountsStrict({
      config: configPda,
      escrow: escrowPda,
      record: recordPda,
      brand: brand.publicKey,
      creator: creator.publicKey,
      feeTreasury: treasury,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  console.log(`  ✓ ${explorerTx(approveSig, cluster)}`);

  // Verify the record persisted.
  const record = await program.account.contractRecord.fetch(recordPda);
  const settled = JSON.stringify(record.outcome).includes("settled");
  if (!settled) {
    throw new Error(`Record outcome unexpected: ${JSON.stringify(record.outcome)}`);
  }
  console.log();
  console.log("Verifying lamport invariants:");

  const creatorBalance = await provider.connection.getBalance(creator.publicKey);
  const escrowBalance = await provider.connection.getBalance(escrowPda);
  const recordExists =
    (await provider.connection.getAccountInfo(recordPda)) != null;

  console.log(`  creator balance: ${creatorBalance / LAMPORTS_PER_SOL} SOL`);
  console.log(`  escrow closed:   ${escrowBalance === 0}`);
  console.log(`  record exists:   ${recordExists}`);

  if (escrowBalance !== 0) throw new Error("escrow not closed");
  if (!recordExists) throw new Error("record not initialized");
  // Creator should have CREATOR_GAS (minus 1 tx fee) + PRICE_LAMPORTS.
  const creatorMinExpected =
    CREATOR_GAS - 5_000 + PRICE_LAMPORTS.toNumber() - 1; // floor tolerance
  if (creatorBalance < creatorMinExpected) {
    throw new Error(
      `creator balance too low: ${creatorBalance} < ${creatorMinExpected}`,
    );
  }

  console.log();
  console.log("✓ Smoke test passed.");
  console.log(`  Record:   ${explorerAddr(recordPda.toBase58(), cluster)}`);
  console.log(`  Settled:  outcome=${JSON.stringify(record.outcome)}`);
}

main().catch((e) => {
  console.error("✗ Smoke test failed:", e);
  process.exit(1);
});
