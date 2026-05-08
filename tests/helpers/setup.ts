import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";

import type { AdlerEscrow } from "../../target/types/adler_escrow";

// Documented defaults — match `docs/approval-deadline.md`.
export const APPROVAL_WINDOW_SECS = new BN(72 * 3600);
export const REFUND_GRACE_SECS = new BN(24 * 3600);
export const FEE_BPS = 50;
export const FEE_BPS_DIVISOR = 10_000;

let cachedProvider: anchor.AnchorProvider | undefined;
let cachedProgram: Program<AdlerEscrow> | undefined;

export function getProvider(): anchor.AnchorProvider {
  if (!cachedProvider) {
    cachedProvider = anchor.AnchorProvider.env();
    anchor.setProvider(cachedProvider);
  }
  return cachedProvider;
}

export function getProgram(): Program<AdlerEscrow> {
  if (!cachedProgram) {
    getProvider();
    cachedProgram = anchor.workspace.AdlerEscrow as Program<AdlerEscrow>;
  }
  return cachedProgram;
}

export function getAdmin(): Keypair {
  return (getProvider().wallet as anchor.Wallet).payer;
}

/** sha256 of UTF-8 bytes — matches Rust `state::contract_id::derive`. */
export function deriveContractId(offChainId: string): Buffer {
  return createHash("sha256").update(offChainId, "utf8").digest();
}

export function deriveProtocolConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], programId)[0];
}

export function deriveContractEscrowPda(
  programId: PublicKey,
  brand: PublicKey,
  contractId: Buffer,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("contract"), brand.toBuffer(), contractId],
    programId,
  )[0];
}

export function deriveContractRecordPda(
  programId: PublicKey,
  brand: PublicKey,
  contractId: Buffer,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("record"), brand.toBuffer(), contractId],
    programId,
  )[0];
}

export function deriveArbitrationPoolPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("arb_pool")],
    programId,
  )[0];
}

export function deriveReputationCardPda(
  programId: PublicKey,
  subject: PublicKey,
  contractId: Buffer,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("rep"), subject.toBuffer(), contractId],
    programId,
  )[0];
}

export async function airdrop(pubkey: PublicKey, sol = 5): Promise<void> {
  const provider = getProvider();
  const sig = await provider.connection.requestAirdrop(
    pubkey,
    sol * LAMPORTS_PER_SOL,
  );
  await provider.connection.confirmTransaction(sig, "confirmed");
}

export interface Actors {
  brand: Keypair;
  creator: Keypair;
}

/** Generate ephemeral brand + creator wallets and airdrop SOL to both. */
export async function setupActors(): Promise<Actors> {
  const brand = Keypair.generate();
  const creator = Keypair.generate();
  await Promise.all([
    airdrop(brand.publicKey, 5),
    airdrop(creator.publicKey, 1),
  ]);
  return { brand, creator };
}

export interface ProtocolEnv {
  configPda: PublicKey;
  treasury: PublicKey;
}

/**
 * Initialize the protocol singleton if it doesn't exist. Idempotent across
 * test files — first caller initializes with a fresh treasury, later callers
 * fetch the existing one from the on-chain config.
 */
export async function ensureProtocolInitialized(): Promise<ProtocolEnv> {
  const provider = getProvider();
  const program = getProgram();
  const admin = getAdmin();
  const configPda = deriveProtocolConfigPda(program.programId);

  const existing = await provider.connection.getAccountInfo(configPda);
  if (existing) {
    const cfg = await program.account.protocolConfig.fetch(configPda);
    return { configPda, treasury: cfg.feeTreasury };
  }

  const treasury = Keypair.generate().publicKey;
  await program.methods
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

  return { configPda, treasury };
}

/** Floor(price * fee_bps / 10_000). Mirrors the program's fee math. */
export function computeFee(priceLamports: BN, feeBps: number): BN {
  return priceLamports.muln(feeBps).divn(FEE_BPS_DIVISOR);
}

/**
 * Initialize the ArbitrationPool singleton if needed. Idempotent across test
 * files. Pool admin = ProtocolConfig admin = the provider wallet.
 */
export async function ensureArbitrationPoolInitialized(): Promise<{
  poolPda: PublicKey;
}> {
  const provider = getProvider();
  const program = getProgram();
  const admin = getAdmin();
  const poolPda = deriveArbitrationPoolPda(program.programId);
  const configPda = deriveProtocolConfigPda(program.programId);

  const existing = await provider.connection.getAccountInfo(poolPda);
  if (existing) return { poolPda };

  await program.methods
    .initArbitrationPool(1)
    .accountsStrict({
      config: configPda,
      pool: poolPda,
      admin: admin.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { poolPda };
}

/** Add `arbiter` to the pool if not already present. */
export async function ensureArbiterInPool(arbiter: PublicKey): Promise<void> {
  const program = getProgram();
  const admin = getAdmin();
  const { poolPda } = await ensureArbitrationPoolInitialized();
  const pool = await program.account.arbitrationPool.fetch(poolPda);
  if (pool.arbiters.some((a) => a.toBase58() === arbiter.toBase58())) return;
  await program.methods
    .addArbiter(arbiter)
    .accountsStrict({ pool: poolPda, admin: admin.publicKey })
    .rpc();
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Temporarily set `approval_window_secs` to `seconds`, run `body`, restore.
 * Used by time-sensitive tests (auto_release fires after deadline) so they
 * don't have to wait 72 hours.
 */
export async function withShrunkenApprovalWindow<T>(
  seconds: number,
  body: () => Promise<T>,
): Promise<T> {
  const program = getProgram();
  const admin = getAdmin();
  const { configPda } = await ensureProtocolInitialized();
  const original = (await program.account.protocolConfig.fetch(configPda))
    .approvalWindowSecs;
  await program.methods
    .updateProtocolField({ approvalWindowSecs: { value: new BN(seconds) } })
    .accountsStrict({ config: configPda, admin: admin.publicKey })
    .rpc();
  try {
    return await body();
  } finally {
    await program.methods
      .updateProtocolField({ approvalWindowSecs: { value: original } })
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();
  }
}

/**
 * Temporarily set both `approval_window_secs` and `refund_grace_secs`, run
 * `body`, restore both. Used by `brand_refund` tests where total wait time is
 * `approval_window + refund_grace`.
 */
export async function withShrunkenWindows<T>(
  approvalSecs: number,
  refundGraceSecs: number,
  body: () => Promise<T>,
): Promise<T> {
  const program = getProgram();
  const admin = getAdmin();
  const { configPda } = await ensureProtocolInitialized();
  const cfg = await program.account.protocolConfig.fetch(configPda);
  const originalApproval = cfg.approvalWindowSecs;
  const originalGrace = cfg.refundGraceSecs;

  await program.methods
    .updateProtocolField({ approvalWindowSecs: { value: new BN(approvalSecs) } })
    .accountsStrict({ config: configPda, admin: admin.publicKey })
    .rpc();
  await program.methods
    .updateProtocolField({ refundGraceSecs: { value: new BN(refundGraceSecs) } })
    .accountsStrict({ config: configPda, admin: admin.publicKey })
    .rpc();

  try {
    return await body();
  } finally {
    await program.methods
      .updateProtocolField({ approvalWindowSecs: { value: originalApproval } })
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();
    await program.methods
      .updateProtocolField({ refundGraceSecs: { value: originalGrace } })
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();
  }
}
