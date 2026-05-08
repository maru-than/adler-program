import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";

import {
  computeFee,
  deriveContractEscrowPda,
  deriveContractId,
  ensureProtocolInitialized,
  FEE_BPS,
  getAdmin,
  getProgram,
  getProvider,
  setupActors,
} from "./helpers/setup";

describe("fund_service", () => {
  before(async () => {
    await ensureProtocolInitialized();
  });

  it("happy path: writes Bound state, escrow holds price + fee + rent", async () => {
    const program = getProgram();
    const provider = getProvider();
    const { configPda } = await ensureProtocolInitialized();
    const { brand, creator } = await setupActors();

    const contractId = deriveContractId("fund-svc-happy-001");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );
    const price = new BN(0.5 * LAMPORTS_PER_SOL);
    const fee = computeFee(price, FEE_BPS);

    const brandBefore = await provider.connection.getBalance(brand.publicKey);

    await program.methods
      .fundService([...contractId], price)
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    const escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(escrow.priceLamports.toString()).to.equal(price.toString());
    expect(escrow.feeLamports.toString()).to.equal(fee.toString());
    expect(escrow.brand.toBase58()).to.equal(brand.publicKey.toBase58());
    expect(escrow.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(JSON.stringify(escrow.kind)).to.equal(JSON.stringify({ service: {} }));
    expect(JSON.stringify(escrow.state)).to.equal(JSON.stringify({ bound: {} }));
    expect(escrow.revisionsUsed).to.equal(0);

    const brandAfter = await provider.connection.getBalance(brand.publicKey);
    const debited = brandBefore - brandAfter;
    // Brand paid price + fee + (escrow rent ~0.0025 SOL) + tx fee.
    expect(debited).to.be.greaterThan(price.toNumber() + fee.toNumber());
    expect(debited).to.be.lessThan(
      price.toNumber() + fee.toNumber() + 0.01 * LAMPORTS_PER_SOL,
    );

    const escrowBalance = await provider.connection.getBalance(escrowPda);
    expect(escrowBalance).to.be.greaterThanOrEqual(
      price.toNumber() + fee.toNumber(),
    );
  });

  it("rejects price = 0 with InvalidPrice", async () => {
    const program = getProgram();
    const { configPda } = await ensureProtocolInitialized();
    const { brand, creator } = await setupActors();

    const contractId = deriveContractId("fund-svc-zero-price");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    let errorName: string | undefined;
    try {
      await program.methods
        .fundService([...contractId], new BN(0))
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: brand.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("InvalidPrice");
  });

  it("rejects when paused with ProtocolPaused", async () => {
    const program = getProgram();
    const admin = getAdmin();
    const { configPda } = await ensureProtocolInitialized();
    const { brand, creator } = await setupActors();

    await program.methods
      .setPaused(true)
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();

    const contractId = deriveContractId("fund-svc-paused");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    let errorName: string | undefined;
    try {
      await program.methods
        .fundService([...contractId], new BN(LAMPORTS_PER_SOL))
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: brand.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }

    // Always unpause for downstream tests.
    await program.methods
      .setPaused(false)
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();

    expect(errorName).to.equal("ProtocolPaused");
  });

  it("rejects double-fund of the same (brand, contract_id)", async () => {
    const program = getProgram();
    const { configPda } = await ensureProtocolInitialized();
    const { brand, creator } = await setupActors();

    const contractId = deriveContractId("fund-svc-double");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    await program.methods
      .fundService([...contractId], new BN(0.1 * LAMPORTS_PER_SOL))
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
        creator: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .fundService([...contractId], new BN(0.1 * LAMPORTS_PER_SOL))
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: brand.publicKey,
          creator: creator.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "double-fund must fail (PDA already initialized)").to.equal(
      true,
    );
  });
});
