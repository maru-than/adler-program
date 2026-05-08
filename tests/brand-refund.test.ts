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
  sleep,
  withShrunkenWindows,
} from "./helpers/setup";

describe("brand_refund", () => {
  let configPda: PublicKey;

  before(async () => {
    ({ configPda } = await ensureProtocolInitialized());
  });

  it("happy path: full refund (price + fee + rent) returns to brand after grace", async function () {
    this.timeout(15000);

    const program = getProgram();
    const provider = getProvider();
    const { brand, creator } = await setupActors();

    await withShrunkenWindows(1, 1, async () => {
      const contractId = deriveContractId("brand-refund-happy");
      const escrowPda = deriveContractEscrowPda(
        program.programId,
        brand.publicKey,
        contractId,
      );
      const price = new BN(0.5 * LAMPORTS_PER_SOL);

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

      // Wait past delivery_deadline (1 s) + refund_grace (1 s).
      await sleep(3000);

      await program.methods
        .brandRefund([...contractId])
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

      // Brand spent: 2 tx fees. Got back: price + fee + rent. Net should be
      // tiny (under 0.001 SOL) and non-negative — brand never gains lamports
      // from a refund.
      const netCost = brandBefore - brandAfter;
      expect(netCost).to.be.greaterThanOrEqual(0);
      expect(netCost).to.be.lessThan(0.001 * LAMPORTS_PER_SOL);
    });
  });

  it("rejects before refund grace elapses with RefundGraceActive", async function () {
    this.timeout(15000);

    const program = getProgram();
    const { brand, creator } = await setupActors();

    // approval_window = 1s, refund_grace = 60s. Fund, wait 2s (past
    // delivery_deadline but before delivery_deadline + grace).
    await withShrunkenWindows(1, 60, async () => {
      const contractId = deriveContractId("brand-refund-too-early");
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

      await sleep(2000);

      let errorName: string | undefined;
      try {
        await program.methods
          .brandRefund([...contractId])
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
      expect(errorName).to.equal("RefundGraceActive");
    });
  });

  it("rejects on Delivered (auto_release covers that path) with WrongState", async () => {
    const program = getProgram();
    const { brand, creator } = await setupActors();

    const contractId = deriveContractId("brand-refund-delivered");
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
        .brandRefund([...contractId])
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

  it("rejects from non-brand signer", async () => {
    const program = getProgram();
    const { brand, creator } = await setupActors();
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    const contractId = deriveContractId("brand-refund-stranger");
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
        .brandRefund([...contractId])
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
    expect(threw, "non-brand brand_refund must fail").to.equal(true);
  });
});
