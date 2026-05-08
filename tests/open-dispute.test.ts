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
  deriveArbitrationPoolPda,
  deriveContractEscrowPda,
  deriveContractId,
  ensureArbitrationPoolInitialized,
  ensureProtocolInitialized,
  getProgram,
  setupActors,
} from "./helpers/setup";

const futureDeadline = () => new BN(Math.floor(Date.now() / 1000) + 86400);

interface Setup {
  brand: Keypair;
  creator: Keypair;
  configPda: PublicKey;
  poolPda: PublicKey;
  escrowPda: PublicKey;
  contractId: Buffer;
}

async function fundAndDeliver(suffix: string, deliver = true): Promise<Setup> {
  const program = getProgram();
  const { configPda } = await ensureProtocolInitialized();
  const { poolPda } = await ensureArbitrationPoolInitialized();
  const { brand, creator } = await setupActors();
  const contractId = deriveContractId(`dispute-${suffix}`);
  const escrowPda = deriveContractEscrowPda(
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

  if (deliver) {
    await program.methods
      .submitDelivery([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();
  }

  return { brand, creator, configPda, poolPda, escrowPda, contractId };
}

describe("open_dispute", () => {
  before(async () => {
    await ensureProtocolInitialized();
    await ensureArbitrationPoolInitialized();
  });

  it("happy: brand opens on Bound (creator never delivered)", async () => {
    const program = getProgram();
    const { brand, configPda, poolPda, escrowPda, contractId } =
      await fundAndDeliver("brand-bound", false);

    const beforeCount = (await program.account.arbitrationPool.fetch(poolPda))
      .disputedCount;

    await program.methods
      .openDispute([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        pool: poolPda,
        signer: brand.publicKey,
      })
      .signers([brand])
      .rpc();

    const escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(JSON.stringify(escrow.state)).to.equal(
      JSON.stringify({ disputed: {} }),
    );
    expect(escrow.disputeFiler.toBase58()).to.equal(brand.publicKey.toBase58());
    expect(escrow.disputeOpenedAt.toNumber()).to.be.greaterThan(0);

    const afterCount = (await program.account.arbitrationPool.fetch(poolPda))
      .disputedCount;
    expect(afterCount).to.equal(beforeCount + 1);
  });

  it("happy: creator opens on Delivered", async () => {
    const program = getProgram();
    const { creator, configPda, poolPda, escrowPda, contractId } =
      await fundAndDeliver("creator-delivered");

    await program.methods
      .openDispute([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        pool: poolPda,
        signer: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    const escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(JSON.stringify(escrow.state)).to.equal(
      JSON.stringify({ disputed: {} }),
    );
    expect(escrow.disputeFiler.toBase58()).to.equal(
      creator.publicKey.toBase58(),
    );
  });

  it("rejects from a third party with NotAParty", async () => {
    const program = getProgram();
    const { configPda, poolPda, escrowPda, contractId } =
      await fundAndDeliver("third-party");
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    let errorName: string | undefined;
    try {
      await program.methods
        .openDispute([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          pool: poolPda,
          signer: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("NotAParty");
  });

  it("rejects on Funded gig (no creator yet) with WrongState", async () => {
    const program = getProgram();
    const { configPda } = await ensureProtocolInitialized();
    const { poolPda } = await ensureArbitrationPoolInitialized();
    const { brand } = await setupActors();
    const contractId = deriveContractId("dispute-funded-gig");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    await program.methods
      .fundGig([...contractId], new BN(0.1 * LAMPORTS_PER_SOL), futureDeadline())
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    let errorName: string | undefined;
    try {
      await program.methods
        .openDispute([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          pool: poolPda,
          signer: brand.publicKey,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("WrongState");
  });

  it("locks subsequent submit_delivery (state becomes Disputed)", async () => {
    const program = getProgram();
    const { brand, creator, configPda, poolPda, escrowPda, contractId } =
      await fundAndDeliver("lock-deliver", false);

    await program.methods
      .openDispute([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        pool: poolPda,
        signer: brand.publicKey,
      })
      .signers([brand])
      .rpc();

    let errorName: string | undefined;
    try {
      await program.methods
        .submitDelivery([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("WrongState");
  });

  it("locks subsequent approve_release", async () => {
    const program = getProgram();
    const { brand, creator, configPda, poolPda, escrowPda, contractId } =
      await fundAndDeliver("lock-approve");
    const recordPda = require("@solana/web3.js").PublicKey.findProgramAddressSync(
      [Buffer.from("record"), brand.publicKey.toBuffer(), contractId],
      program.programId,
    )[0] as PublicKey;
    const treasury = (
      await program.account.protocolConfig.fetch(configPda)
    ).feeTreasury;

    await program.methods
      .openDispute([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        pool: poolPda,
        signer: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    let errorName: string | undefined;
    try {
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
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("WrongState");
  });
});
