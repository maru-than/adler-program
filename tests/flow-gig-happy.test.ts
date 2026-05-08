import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";

import {
  computeFee,
  deriveContractEscrowPda,
  deriveContractId,
  deriveContractRecordPda,
  ensureProtocolInitialized,
  FEE_BPS,
  getProgram,
  getProvider,
  setupActors,
} from "./helpers/setup";

describe("flow: gig happy path", () => {
  it("fund_gig → bind_creator → submit_delivery → approve_release", async () => {
    const program = getProgram();
    const provider = getProvider();
    const { configPda, treasury } = await ensureProtocolInitialized();
    const { brand, creator } = await setupActors();

    const contractId = deriveContractId("flow-gig-001");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );
    const recordPda = deriveContractRecordPda(
      program.programId,
      brand.publicKey,
      contractId,
    );
    const budget = new BN(0.8 * LAMPORTS_PER_SOL);
    const fee = computeFee(budget, FEE_BPS);
    const deadline = new BN(Math.floor(Date.now() / 1000) + 24 * 3600);

    const brandStart = await provider.connection.getBalance(brand.publicKey);
    const creatorStart = await provider.connection.getBalance(creator.publicKey);
    const treasuryStart = await provider.connection.getBalance(treasury);

    // 1. Brand pre-locks gig budget — creator slot empty.
    await program.methods
      .fundGig([...contractId], budget, deadline)
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    let escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(JSON.stringify(escrow.kind)).to.equal(JSON.stringify({ gig: {} }));
    expect(JSON.stringify(escrow.state)).to.equal(JSON.stringify({ funded: {} }));

    // 2. Brand awards to a creator (gig → service equivalent from here on).
    await program.methods
      .bindCreator([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
        creator: creator.publicKey,
      })
      .signers([brand])
      .rpc();

    escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(escrow.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(JSON.stringify(escrow.state)).to.equal(JSON.stringify({ bound: {} }));

    // 3. Creator delivers.
    await program.methods
      .submitDelivery([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    expect(
      JSON.stringify(
        (await program.account.contractEscrow.fetch(escrowPda)).state,
      ),
    ).to.equal(JSON.stringify({ delivered: {} }));

    // 4. Brand approves.
    await program.methods
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
      .signers([brand])
      .rpc();

    const brandEnd = await provider.connection.getBalance(brand.publicKey);
    const creatorEnd = await provider.connection.getBalance(creator.publicKey);
    const treasuryEnd = await provider.connection.getBalance(treasury);
    const escrowEnd = await provider.connection.getBalance(escrowPda);

    expect(creatorEnd - creatorStart).to.equal(budget.toNumber());
    expect(treasuryEnd - treasuryStart).to.equal(fee.toNumber());
    expect(escrowEnd).to.equal(0);

    const brandSpent = brandStart - brandEnd;
    expect(brandSpent).to.be.greaterThan(budget.toNumber() + fee.toNumber());
    expect(brandSpent).to.be.lessThan(
      budget.toNumber() + fee.toNumber() + 0.01 * LAMPORTS_PER_SOL,
    );

    // ContractRecord persists with kind=Gig + Settled outcome.
    const record = await program.account.contractRecord.fetch(recordPda);
    expect(JSON.stringify(record.kind)).to.equal(JSON.stringify({ gig: {} }));
    expect(JSON.stringify(record.outcome)).to.equal(
      JSON.stringify({ settled: {} }),
    );
  });
});
