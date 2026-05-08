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
  ensureProtocolInitialized,
  getProgram,
  setupActors,
} from "./helpers/setup";

const ONE_DAY_SECS = 24 * 3600;
const futureDeadline = (secs = ONE_DAY_SECS) =>
  new BN(Math.floor(Date.now() / 1000) + secs);

interface FundedGig {
  brand: Keypair;
  creator: Keypair;
  configPda: PublicKey;
  escrowPda: PublicKey;
  contractId: Buffer;
}

async function fundFreshGig(suffix: string): Promise<FundedGig> {
  const program = getProgram();
  const { configPda } = await ensureProtocolInitialized();
  const { brand, creator } = await setupActors();
  const contractId = deriveContractId(`bind-${suffix}`);
  const escrowPda = deriveContractEscrowPda(
    program.programId,
    brand.publicKey,
    contractId,
  );
  await program.methods
    .fundGig([...contractId], new BN(0.3 * LAMPORTS_PER_SOL), futureDeadline())
    .accountsStrict({
      config: configPda,
      escrow: escrowPda,
      brand: brand.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([brand])
    .rpc();
  return { brand, creator, configPda, escrowPda, contractId };
}

describe("bind_creator", () => {
  before(async () => {
    await ensureProtocolInitialized();
  });

  it("happy path: Funded → Bound, sets escrow.creator", async () => {
    const program = getProgram();
    const { brand, creator, configPda, escrowPda, contractId } =
      await fundFreshGig("happy");

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

    const escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(escrow.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(JSON.stringify(escrow.state)).to.equal(JSON.stringify({ bound: {} }));
  });

  it("idempotent on same creator (no error, no state change)", async () => {
    const program = getProgram();
    const { brand, creator, configPda, escrowPda, contractId } =
      await fundFreshGig("idempotent");

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

    // Same creator again — should be a no-op.
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

    const escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(escrow.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(JSON.stringify(escrow.state)).to.equal(JSON.stringify({ bound: {} }));
  });

  it("rejects re-bind to a different creator with CreatorMismatch", async () => {
    const program = getProgram();
    const { brand, creator, configPda, escrowPda, contractId } =
      await fundFreshGig("different");
    const otherCreator = Keypair.generate();

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

    let errorName: string | undefined;
    try {
      await program.methods
        .bindCreator([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: brand.publicKey,
          creator: otherCreator.publicKey,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("CreatorMismatch");
  });

  it("rejects bind from a non-brand signer", async () => {
    const program = getProgram();
    const { creator, configPda, escrowPda, contractId } =
      await fundFreshGig("non-brand");
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    let threw = false;
    try {
      await program.methods
        .bindCreator([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: stranger.publicKey,
          creator: creator.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "non-brand bind must fail").to.equal(true);
  });

  it("rejects bind after delivery (state is Delivered, not Funded/Bound)", async () => {
    const program = getProgram();
    const { brand, creator, configPda, escrowPda, contractId } =
      await fundFreshGig("after-delivery");

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

    await program.methods
      .submitDelivery([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    let errorName: string | undefined;
    try {
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
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("WrongState");
  });
});
