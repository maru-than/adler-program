import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";

import {
  airdrop,
  deriveContractEscrowPda,
  deriveContractId,
  deriveContractRecordPda,
  ensureProtocolInitialized,
  getProgram,
  setupActors,
  sleep,
} from "./helpers/setup";

interface DeliveredContract {
  brand: Keypair;
  creator: Keypair;
  configPda: PublicKey;
  escrowPda: PublicKey;
  recordPda: PublicKey;
  contractId: Buffer;
}

async function fundAndDeliver(suffix: string): Promise<DeliveredContract> {
  const program = getProgram();
  const { configPda } = await ensureProtocolInitialized();
  const { brand, creator } = await setupActors();
  const contractId = deriveContractId(`revision-${suffix}`);
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

  await program.methods
    .fundService([...contractId], new BN(0.3 * LAMPORTS_PER_SOL))
    .accountsStrict({
      config: configPda,
      escrow: escrowPda,
      brand: brand.publicKey,
      creator: creator.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([brand])
    .rpc();

  await program.methods
    .submitDelivery([...contractId])
    .accountsStrict({
      config: configPda,
      escrow: escrowPda,
      creator: creator.publicKey,
    })
    .signers([creator])
    .rpc();

  return { brand, creator, configPda, escrowPda, recordPda, contractId };
}

describe("request_revision", () => {
  before(async () => {
    await ensureProtocolInitialized();
  });

  it("happy path: Delivered → Bound, revisions_used 0 → 1", async () => {
    const program = getProgram();
    const { brand, configPda, escrowPda, contractId } =
      await fundAndDeliver("happy");

    await program.methods
      .requestRevision([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
      })
      .signers([brand])
      .rpc();

    const escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(JSON.stringify(escrow.state)).to.equal(JSON.stringify({ bound: {} }));
    expect(escrow.revisionsUsed).to.equal(1);
  });

  it("full cycle: 3 deliveries / 2 revisions / approve_release", async () => {
    const program = getProgram();
    const { brand, creator, configPda, escrowPda, recordPda, contractId } =
      await fundAndDeliver("full-cycle");
    const { treasury } = await ensureProtocolInitialized();

    // First revision: Delivered → Bound (revisions_used=1)
    await program.methods
      .requestRevision([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
      })
      .signers([brand])
      .rpc();

    // Second delivery
    await program.methods
      .submitDelivery([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    // Second revision: revisions_used=2 (at the cap)
    await program.methods
      .requestRevision([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
      })
      .signers([brand])
      .rpc();

    let escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(escrow.revisionsUsed).to.equal(2);
    expect(JSON.stringify(escrow.state)).to.equal(JSON.stringify({ bound: {} }));

    // Third delivery
    await program.methods
      .submitDelivery([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    // Approve — revisions_used carried through to ContractRecord settlement.
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

    const record = await program.account.contractRecord.fetch(recordPda);
    expect(JSON.stringify(record.outcome)).to.equal(
      JSON.stringify({ settled: {} }),
    );
  });

  it("rejects third revision with RevisionCapReached", async () => {
    const program = getProgram();
    const { brand, creator, configPda, escrowPda, contractId } =
      await fundAndDeliver("cap");

    // 1st revision
    await program.methods
      .requestRevision([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
      })
      .signers([brand])
      .rpc();

    // 2nd delivery + 2nd revision
    await program.methods
      .submitDelivery([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();
    await program.methods
      .requestRevision([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
      })
      .signers([brand])
      .rpc();

    // 3rd delivery
    await program.methods
      .submitDelivery([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    // 3rd revision — must fail (cap = 2).
    let errorName: string | undefined;
    try {
      await program.methods
        .requestRevision([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: brand.publicKey,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("RevisionCapReached");
  });

  it("approval_deadline advances on each re-submission after a revision", async function () {
    this.timeout(15000);
    const program = getProgram();
    const { brand, creator, configPda, escrowPda, contractId } =
      await fundAndDeliver("deadline-reset");

    const firstDeadline = (
      await program.account.contractEscrow.fetch(escrowPda)
    ).approvalDeadline;

    await program.methods
      .requestRevision([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
      })
      .signers([brand])
      .rpc();

    // Wait so the next slot timestamp is strictly later.
    await sleep(1500);

    await program.methods
      .submitDelivery([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    const secondDeadline = (
      await program.account.contractEscrow.fetch(escrowPda)
    ).approvalDeadline;

    expect(secondDeadline.toNumber()).to.be.greaterThan(
      firstDeadline.toNumber(),
    );
  });

  it("rejects request_revision while state is Bound (pre-delivery) with WrongState", async () => {
    const program = getProgram();
    const { configPda } = await ensureProtocolInitialized();
    const { brand, creator } = await setupActors();
    const contractId = deriveContractId("revision-bound");
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

    let errorName: string | undefined;
    try {
      await program.methods
        .requestRevision([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: brand.publicKey,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("WrongState");
  });

  it("rejects request_revision from a non-brand signer", async () => {
    const program = getProgram();
    const { configPda, escrowPda, contractId } = await fundAndDeliver(
      "non-brand",
    );
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    let threw = false;
    try {
      await program.methods
        .requestRevision([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "non-brand revision must fail").to.equal(true);
  });
});
