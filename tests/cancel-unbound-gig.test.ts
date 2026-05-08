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
  getProvider,
  setupActors,
} from "./helpers/setup";

const futureDeadline = () => new BN(Math.floor(Date.now() / 1000) + 24 * 3600);

describe("cancel_unbound_gig", () => {
  let configPda: PublicKey;

  before(async () => {
    ({ configPda } = await ensureProtocolInitialized());
  });

  it("happy path: full refund (budget + fee + rent) returns to brand, escrow closed", async () => {
    const program = getProgram();
    const provider = getProvider();
    const { brand } = await setupActors();

    const contractId = deriveContractId("cancel-gig-happy");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );
    const budget = new BN(0.4 * LAMPORTS_PER_SOL);

    const brandBefore = await provider.connection.getBalance(brand.publicKey);

    await program.methods
      .fundGig([...contractId], budget, futureDeadline())
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    await program.methods
      .cancelUnboundGig([...contractId])
      .accountsStrict({
        config: configPda,
        escrow: escrowPda,
        brand: brand.publicKey,
      })
      .signers([brand])
      .rpc();

    const brandAfter = await provider.connection.getBalance(brand.publicKey);
    const escrowAfter = await provider.connection.getBalance(escrowPda);

    expect(escrowAfter).to.equal(0);
    // Brand spent: 2 tx fees. Got back: budget + fee + rent. Net cost is tiny.
    const netCost = brandBefore - brandAfter;
    expect(netCost).to.be.greaterThanOrEqual(0);
    expect(netCost).to.be.lessThan(0.001 * LAMPORTS_PER_SOL);
  });

  it("rejects after bind_creator (state is Bound, not Funded)", async () => {
    const program = getProgram();
    const { brand, creator } = await setupActors();
    const contractId = deriveContractId("cancel-gig-bound");
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
        .cancelUnboundGig([...contractId])
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

  it("rejects from a non-brand signer", async () => {
    const program = getProgram();
    const { brand } = await setupActors();
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    const contractId = deriveContractId("cancel-gig-stranger");
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

    let threw = false;
    try {
      await program.methods
        .cancelUnboundGig([...contractId])
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
    expect(threw, "non-brand cancel must fail").to.equal(true);
  });
});
