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
} from "./helpers/setup";

interface DeliveredContract {
  brand: Keypair;
  creator: Keypair;
  configPda: PublicKey;
  escrowPda: PublicKey;
  recordPda: PublicKey;
  contractId: Buffer;
  price: BN;
}

async function fundAndDeliver(suffix: string): Promise<DeliveredContract> {
  const program = getProgram();
  const { configPda } = await ensureProtocolInitialized();
  const { brand, creator } = await setupActors();
  const contractId = deriveContractId(`approve-${suffix}`);
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

  return { brand, creator, configPda, escrowPda, recordPda, contractId, price };
}

describe("approve_release", () => {
  let treasury: PublicKey;

  before(async () => {
    ({ treasury } = await ensureProtocolInitialized());
  });

  it("happy path: price → creator, fee → treasury, rent → brand, escrow closed", async () => {
    const program = getProgram();
    const provider = getProvider();
    const { brand, creator, configPda, escrowPda, recordPda, contractId, price } =
      await fundAndDeliver("happy");
    const fee = computeFee(price, FEE_BPS);

    const brandBefore = await provider.connection.getBalance(brand.publicKey);
    const creatorBefore = await provider.connection.getBalance(
      creator.publicKey,
    );
    const treasuryBefore = await provider.connection.getBalance(treasury);

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

    const brandAfter = await provider.connection.getBalance(brand.publicKey);
    const creatorAfter = await provider.connection.getBalance(creator.publicKey);
    const treasuryAfter = await provider.connection.getBalance(treasury);
    const escrowAfter = await provider.connection.getBalance(escrowPda);

    expect(creatorAfter - creatorBefore).to.equal(price.toNumber());
    expect(treasuryAfter - treasuryBefore).to.equal(fee.toNumber());
    expect(escrowAfter).to.equal(0);

    // Brand: received escrow rent on close, paid record rent + tx fee. Net
    // delta can be positive OR negative depending on which rent is larger;
    // the absolute change should be small (under 0.005 SOL).
    const brandDelta = brandBefore - brandAfter;
    expect(Math.abs(brandDelta)).to.be.lessThan(0.005 * LAMPORTS_PER_SOL);

    // ContractRecord persists with the right snapshot.
    const record = await program.account.contractRecord.fetch(recordPda);
    expect(record.brand.toBase58()).to.equal(brand.publicKey.toBase58());
    expect(record.creator.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(record.priceLamports.toString()).to.equal(price.toString());
    expect(record.feeLamports.toString()).to.equal(fee.toString());
    expect(JSON.stringify(record.outcome)).to.equal(
      JSON.stringify({ settled: {} }),
    );
    expect(JSON.stringify(record.kind)).to.equal(
      JSON.stringify({ service: {} }),
    );
  });

  it("rejects approve_release while state is Bound (pre-delivery)", async () => {
    const program = getProgram();
    const { configPda } = await ensureProtocolInitialized();
    const { brand, creator } = await setupActors();
    const contractId = deriveContractId("approve-bound");
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

  it("rejects approve_release from a non-brand signer", async () => {
    const program = getProgram();
    const { creator, configPda, escrowPda, recordPda, contractId } =
      await fundAndDeliver("non-brand");
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    let threw = false;
    try {
      await program.methods
        .approveRelease([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          record: recordPda,
          brand: stranger.publicKey,
          creator: creator.publicKey,
          feeTreasury: treasury,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "non-brand approve must fail").to.equal(true);
  });

  it("rejects approve_release with the wrong fee_treasury", async () => {
    const program = getProgram();
    const { brand, creator, configPda, escrowPda, recordPda, contractId } =
      await fundAndDeliver("wrong-treasury");
    const wrongTreasury = Keypair.generate().publicKey;

    let threw = false;
    try {
      await program.methods
        .approveRelease([...contractId])
        .accountsStrict({
          config: configPda,
          escrow: escrowPda,
          record: recordPda,
          brand: brand.publicKey,
          creator: creator.publicKey,
          feeTreasury: wrongTreasury,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "wrong-treasury approve must fail").to.equal(true);
  });
});
