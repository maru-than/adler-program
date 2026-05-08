import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  airdrop,
  deriveContractEscrowPda,
  deriveContractId,
  ensureProtocolInitialized,
  getProgram,
  setupActors,
} from "./helpers/setup";

interface FundedContract {
  brand: Keypair;
  creator: Keypair;
  configPda: PublicKey;
  escrowPda: PublicKey;
  contractId: Buffer;
}

async function fundFresh(suffix: string): Promise<FundedContract> {
  const program = getProgram();
  const { configPda } = await ensureProtocolInitialized();
  const { brand, creator } = await setupActors();
  const contractId = deriveContractId(`submit-${suffix}`);
  const escrowPda = deriveContractEscrowPda(
    program.programId,
    brand.publicKey,
    contractId,
  );
  await program.methods
    .fundService([...contractId], new BN(0.5 * LAMPORTS_PER_SOL))
    .accountsStrict({
      config: configPda,
      escrow: escrowPda,
      brand: brand.publicKey,
      creator: creator.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([brand])
    .rpc();
  return { brand, creator, configPda, escrowPda, contractId };
}

describe("submit_delivery", () => {
  before(async () => {
    await ensureProtocolInitialized();
  });

  it("happy path: Bound → Delivered, sets approval_deadline", async () => {
    const program = getProgram();
    const { creator, configPda, escrowPda, contractId } = await fundFresh("happy");

    await program.methods
      .submitDelivery([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        creator: creator.publicKey,
      })
      .signers([creator])
      .rpc();

    const escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(JSON.stringify(escrow.state)).to.equal(
      JSON.stringify({ delivered: {} }),
    );
    expect(escrow.deliveredAt).to.not.equal(null);
    expect(escrow.approvalDeadline.toNumber()).to.be.greaterThan(0);
  });

  it("rejects non-creator signer", async () => {
    const program = getProgram();
    const { configPda, escrowPda, contractId } = await fundFresh("non-creator");
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    let threw = false;
    try {
      await program.methods
        .submitDelivery([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          creator: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "non-creator submission must fail").to.equal(true);
  });

  it("rejects double-delivery (state must be Bound, not Delivered)", async () => {
    const program = getProgram();
    const { creator, configPda, escrowPda, contractId } = await fundFresh("double");

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
});
