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

describe("flow: service happy path", () => {
  it("fund → deliver → approve, end-to-end lamport balances", async () => {
    const program = getProgram();
    const provider = getProvider();
    const { configPda, treasury } = await ensureProtocolInitialized();
    const { brand, creator } = await setupActors();

    const contractId = deriveContractId("flow-service-001");
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
    const price = new BN(1.0 * LAMPORTS_PER_SOL);
    const fee = computeFee(price, FEE_BPS);

    const brandStart = await provider.connection.getBalance(brand.publicKey);
    const creatorStart = await provider.connection.getBalance(creator.publicKey);
    const treasuryStart = await provider.connection.getBalance(treasury);

    // 1. Fund
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

    expect(
      JSON.stringify(
        (await program.account.contractEscrow.fetch(escrowPda)).state,
      ),
    ).to.equal(JSON.stringify({ bound: {} }));

    // 2. Deliver
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

    // 3. Approve
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

    // Lamport invariants:
    //   creator:  +price
    //   treasury: +fee
    //   escrow:   closed (= 0)
    //   brand:    -price - fee - record_rent - 3 * tx_fee  (escrow rent
    //             returned to brand on close)
    expect(creatorEnd - creatorStart).to.equal(price.toNumber());
    expect(treasuryEnd - treasuryStart).to.equal(fee.toNumber());
    expect(escrowEnd).to.equal(0);

    const brandSpent = brandStart - brandEnd;
    expect(brandSpent).to.be.greaterThan(price.toNumber() + fee.toNumber());
    expect(brandSpent).to.be.lessThan(
      price.toNumber() + fee.toNumber() + 0.01 * LAMPORTS_PER_SOL,
    );

    // ContractRecord persists with Settled outcome.
    const record = await program.account.contractRecord.fetch(recordPda);
    expect(JSON.stringify(record.outcome)).to.equal(
      JSON.stringify({ settled: {} }),
    );
  });
});
