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
  computeFee,
  deriveContractEscrowPda,
  deriveContractId,
  deriveContractRecordPda,
  ensureProtocolInitialized,
  FEE_BPS,
  getProgram,
  getProvider,
  setupActors,
  sleep,
  withShrunkenApprovalWindow,
} from "./helpers/setup";

describe("auto_release", () => {
  let configPda: PublicKey;
  let treasury: PublicKey;

  before(async () => {
    ({ configPda, treasury } = await ensureProtocolInitialized());
  });

  it("happy path: fires after approval_deadline; price → creator, fee → treasury, escrow closed", async function () {
    this.timeout(15000);

    const program = getProgram();
    const provider = getProvider();
    const { brand, creator } = await setupActors();
    const caller = Keypair.generate();
    await airdrop(caller.publicKey, 1);

    await withShrunkenApprovalWindow(1, async () => {
      const contractId = deriveContractId("auto-release-happy");
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
      const price = new BN(0.5 * LAMPORTS_PER_SOL);
      const fee = computeFee(price, FEE_BPS);

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

      await program.methods
        .submitDelivery([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          creator: creator.publicKey,
        })
        .signers([creator])
        .rpc();

      // approval_deadline = submit_delivery_at + 1s. Wait past it.
      await sleep(2500);

      const creatorBefore = await provider.connection.getBalance(
        creator.publicKey,
      );
      const treasuryBefore = await provider.connection.getBalance(treasury);

      await program.methods
        .autoRelease([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          record: recordPda,
          brand: brand.publicKey,
          creator: creator.publicKey,
          feeTreasury: treasury,
          caller: caller.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([caller])
        .rpc();

      expect(
        (await provider.connection.getBalance(creator.publicKey)) -
          creatorBefore,
      ).to.equal(price.toNumber());
      expect(
        (await provider.connection.getBalance(treasury)) - treasuryBefore,
      ).to.equal(fee.toNumber());
      expect(await provider.connection.getBalance(escrowPda)).to.equal(0);

      const record = await program.account.contractRecord.fetch(recordPda);
      expect(JSON.stringify(record.outcome)).to.equal(
        JSON.stringify({ settled: {} }),
      );
    });
  });

  it("rejects auto_release while state is Bound (creator never delivered) — fixes v0.1 bug", async () => {
    const program = getProgram();
    const { brand, creator } = await setupActors();
    const caller = Keypair.generate();
    await airdrop(caller.publicKey, 1);

    const contractId = deriveContractId("auto-release-bound");
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
        .autoRelease([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          record: recordPda,
          brand: brand.publicKey,
          creator: creator.publicKey,
          feeTreasury: treasury,
          caller: caller.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([caller])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("WrongState");
  });

  it("rejects auto_release before approval_deadline (Delivered but too early)", async () => {
    const program = getProgram();
    const { brand, creator } = await setupActors();
    const caller = Keypair.generate();
    await airdrop(caller.publicKey, 1);

    // Use the standard 72h window so approval_deadline is far in the future
    // immediately after submit_delivery.
    const contractId = deriveContractId("auto-release-too-early");
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
        .autoRelease([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          record: recordPda,
          brand: brand.publicKey,
          creator: creator.publicKey,
          feeTreasury: treasury,
          caller: caller.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([caller])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("ApprovalDeadlineNotReached");
  });
});
