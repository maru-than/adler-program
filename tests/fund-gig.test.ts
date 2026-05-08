import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";

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

const ONE_DAY_SECS = 24 * 3600;

function futureDeadline(secsFromNow = ONE_DAY_SECS): BN {
  return new BN(Math.floor(Date.now() / 1000) + secsFromNow);
}

describe("fund_gig", () => {
  let configPda: PublicKey;

  before(async () => {
    ({ configPda } = await ensureProtocolInitialized());
  });

  it("happy path: writes Funded state, creator=default, kind=Gig", async () => {
    const program = getProgram();
    const provider = getProvider();
    const { brand } = await setupActors();

    const contractId = deriveContractId("fund-gig-happy");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );
    const budget = new BN(0.5 * LAMPORTS_PER_SOL);
    const fee = computeFee(budget, FEE_BPS);
    const deadline = futureDeadline();

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

    const escrow = await program.account.contractEscrow.fetch(escrowPda);
    expect(JSON.stringify(escrow.kind)).to.equal(JSON.stringify({ gig: {} }));
    expect(JSON.stringify(escrow.state)).to.equal(JSON.stringify({ funded: {} }));
    expect(escrow.creator.toBase58()).to.equal(PublicKey.default.toBase58());
    expect(escrow.priceLamports.toString()).to.equal(budget.toString());
    expect(escrow.feeLamports.toString()).to.equal(fee.toString());
    expect(escrow.deliveryDeadline.toString()).to.equal(deadline.toString());

    const escrowBalance = await provider.connection.getBalance(escrowPda);
    expect(escrowBalance).to.be.greaterThanOrEqual(budget.toNumber() + fee.toNumber());
  });

  it("rejects budget = 0 with InvalidPrice", async () => {
    const program = getProgram();
    const { brand } = await setupActors();
    const contractId = deriveContractId("fund-gig-zero");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    let errorName: string | undefined;
    try {
      await program.methods
        .fundGig([...contractId], new BN(0), futureDeadline())
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: brand.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("InvalidPrice");
  });

  it("rejects deadline in the past with InvalidDeadline", async () => {
    const program = getProgram();
    const { brand } = await setupActors();
    const contractId = deriveContractId("fund-gig-past");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );
    const past = new BN(Math.floor(Date.now() / 1000) - 60);

    let errorName: string | undefined;
    try {
      await program.methods
        .fundGig([...contractId], new BN(0.1 * LAMPORTS_PER_SOL), past)
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: brand.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("InvalidDeadline");
  });

  it("rejects when paused with ProtocolPaused", async () => {
    const program = getProgram();
    const admin = getAdmin();
    const { brand } = await setupActors();

    await program.methods
      .setPaused(true)
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();

    const contractId = deriveContractId("fund-gig-paused");
    const escrowPda = deriveContractEscrowPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    let errorName: string | undefined;
    try {
      await program.methods
        .fundGig([...contractId], new BN(LAMPORTS_PER_SOL), futureDeadline())
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          brand: brand.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }

    await program.methods
      .setPaused(false)
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();

    expect(errorName).to.equal("ProtocolPaused");
  });
});
