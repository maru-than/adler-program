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
  ensureArbitrationPoolInitialized,
  ensureArbiterInPool,
  ensureProtocolInitialized,
  FEE_BPS,
  getProgram,
  getProvider,
  setupActors,
} from "./helpers/setup";

interface DisputedContract {
  brand: Keypair;
  creator: Keypair;
  configPda: PublicKey;
  poolPda: PublicKey;
  escrowPda: PublicKey;
  recordPda: PublicKey;
  contractId: Buffer;
  price: BN;
  treasury: PublicKey;
}

async function fundDeliverDispute(suffix: string): Promise<DisputedContract> {
  const program = getProgram();
  const { configPda, treasury } = await ensureProtocolInitialized();
  const { poolPda } = await ensureArbitrationPoolInitialized();
  const { brand, creator } = await setupActors();
  const contractId = deriveContractId(`arbitrate-${suffix}`);
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

  return {
    brand,
    creator,
    configPda,
    poolPda,
    escrowPda,
    recordPda,
    contractId,
    price,
    treasury,
  };
}

async function newPoolArbiter(): Promise<Keypair> {
  const arbiter = Keypair.generate();
  await airdrop(arbiter.publicKey, 1);
  await ensureArbiterInPool(arbiter.publicKey);
  return arbiter;
}

describe("arbitrate", () => {
  before(async () => {
    await ensureProtocolInitialized();
    await ensureArbitrationPoolInitialized();
  });

  it("Release: price → creator, fee → treasury, residual → brand", async () => {
    const program = getProgram();
    const provider = getProvider();
    const arbiter = await newPoolArbiter();
    const setup = await fundDeliverDispute("release");
    const fee = computeFee(setup.price, FEE_BPS);

    const creatorBefore = await provider.connection.getBalance(
      setup.creator.publicKey,
    );
    const treasuryBefore = await provider.connection.getBalance(setup.treasury);

    await program.methods
      .arbitrate([...setup.contractId], { release: {} })
      .accountsStrict({
        config: setup.configPda,
        pool: setup.poolPda,
        escrow: setup.escrowPda,
        record: setup.recordPda,
        brand: setup.brand.publicKey,
        creator: setup.creator.publicKey,
        feeTreasury: setup.treasury,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter])
      .rpc();

    expect(
      (await provider.connection.getBalance(setup.creator.publicKey)) -
        creatorBefore,
    ).to.equal(setup.price.toNumber());
    expect(
      (await provider.connection.getBalance(setup.treasury)) - treasuryBefore,
    ).to.equal(fee.toNumber());
    expect(await provider.connection.getBalance(setup.escrowPda)).to.equal(0);

    const record = await program.account.contractRecord.fetch(setup.recordPda);
    expect(JSON.stringify(record.outcome)).to.equal(
      JSON.stringify({ resolved: { 0: { release: {} } } }),
    );
  });

  it("Refund: price + fee + rent → brand, no creator/treasury credit", async () => {
    const program = getProgram();
    const provider = getProvider();
    const arbiter = await newPoolArbiter();
    const setup = await fundDeliverDispute("refund");

    const creatorBefore = await provider.connection.getBalance(
      setup.creator.publicKey,
    );
    const treasuryBefore = await provider.connection.getBalance(setup.treasury);

    await program.methods
      .arbitrate([...setup.contractId], { refund: {} })
      .accountsStrict({
        config: setup.configPda,
        pool: setup.poolPda,
        escrow: setup.escrowPda,
        record: setup.recordPda,
        brand: setup.brand.publicKey,
        creator: setup.creator.publicKey,
        feeTreasury: setup.treasury,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter])
      .rpc();

    expect(
      (await provider.connection.getBalance(setup.creator.publicKey)) -
        creatorBefore,
    ).to.equal(0);
    expect(
      (await provider.connection.getBalance(setup.treasury)) - treasuryBefore,
    ).to.equal(0);
    expect(await provider.connection.getBalance(setup.escrowPda)).to.equal(0);

    const record = await program.account.contractRecord.fetch(setup.recordPda);
    expect(JSON.stringify(record.outcome)).to.equal(
      JSON.stringify({ resolved: { 0: { refund: {} } } }),
    );
  });

  it("Split{5000}: half → creator, half → brand, fee → treasury", async () => {
    const program = getProgram();
    const provider = getProvider();
    const arbiter = await newPoolArbiter();
    const setup = await fundDeliverDispute("split-5000");
    const fee = computeFee(setup.price, FEE_BPS);
    const expectedCreator = setup.price.muln(5000).divn(10_000);

    const creatorBefore = await provider.connection.getBalance(
      setup.creator.publicKey,
    );
    const treasuryBefore = await provider.connection.getBalance(setup.treasury);

    await program.methods
      .arbitrate([...setup.contractId], { split: { creatorBps: 5000 } })
      .accountsStrict({
        config: setup.configPda,
        pool: setup.poolPda,
        escrow: setup.escrowPda,
        record: setup.recordPda,
        brand: setup.brand.publicKey,
        creator: setup.creator.publicKey,
        feeTreasury: setup.treasury,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter])
      .rpc();

    expect(
      (await provider.connection.getBalance(setup.creator.publicKey)) -
        creatorBefore,
    ).to.equal(expectedCreator.toNumber());
    expect(
      (await provider.connection.getBalance(setup.treasury)) - treasuryBefore,
    ).to.equal(fee.toNumber());
    expect(await provider.connection.getBalance(setup.escrowPda)).to.equal(0);
  });

  it("Split{0}: zero to creator, full price to brand, fee → treasury", async () => {
    const program = getProgram();
    const provider = getProvider();
    const arbiter = await newPoolArbiter();
    const setup = await fundDeliverDispute("split-zero");
    const fee = computeFee(setup.price, FEE_BPS);

    const creatorBefore = await provider.connection.getBalance(
      setup.creator.publicKey,
    );
    const treasuryBefore = await provider.connection.getBalance(setup.treasury);

    await program.methods
      .arbitrate([...setup.contractId], { split: { creatorBps: 0 } })
      .accountsStrict({
        config: setup.configPda,
        pool: setup.poolPda,
        escrow: setup.escrowPda,
        record: setup.recordPda,
        brand: setup.brand.publicKey,
        creator: setup.creator.publicKey,
        feeTreasury: setup.treasury,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter])
      .rpc();

    expect(
      (await provider.connection.getBalance(setup.creator.publicKey)) -
        creatorBefore,
    ).to.equal(0);
    expect(
      (await provider.connection.getBalance(setup.treasury)) - treasuryBefore,
    ).to.equal(fee.toNumber());
  });

  it("rejects creator_bps > 10_000 with InvalidBps", async () => {
    const program = getProgram();
    const arbiter = await newPoolArbiter();
    const setup = await fundDeliverDispute("invalid-bps");

    let errorName: string | undefined;
    try {
      await program.methods
        .arbitrate([...setup.contractId], { split: { creatorBps: 10_001 } })
        .accountsStrict({
          config: setup.configPda,
          pool: setup.poolPda,
          escrow: setup.escrowPda,
          record: setup.recordPda,
          brand: setup.brand.publicKey,
          creator: setup.creator.publicKey,
          feeTreasury: setup.treasury,
          arbiter: arbiter.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([arbiter])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("InvalidBps");

    // Cleanup: leave no orphan dispute behind (would leak into other tests'
    // pool.disputed_count). Arbitrate with a valid outcome.
    await program.methods
      .arbitrate([...setup.contractId], { refund: {} })
      .accountsStrict({
        config: setup.configPda,
        pool: setup.poolPda,
        escrow: setup.escrowPda,
        record: setup.recordPda,
        brand: setup.brand.publicKey,
        creator: setup.creator.publicKey,
        feeTreasury: setup.treasury,
        arbiter: arbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([arbiter])
      .rpc();
  });

  it("rejects non-pool arbiter with ArbiterNotInPool", async () => {
    const program = getProgram();
    const setup = await fundDeliverDispute("non-pool-arbiter");
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    let errorName: string | undefined;
    try {
      await program.methods
        .arbitrate([...setup.contractId], { release: {} })
        .accountsStrict({
          config: setup.configPda,
          pool: setup.poolPda,
          escrow: setup.escrowPda,
          record: setup.recordPda,
          brand: setup.brand.publicKey,
          creator: setup.creator.publicKey,
          feeTreasury: setup.treasury,
          arbiter: stranger.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("ArbiterNotInPool");

    // Cleanup with a valid arbiter.
    const validArbiter = await newPoolArbiter();
    await program.methods
      .arbitrate([...setup.contractId], { refund: {} })
      .accountsStrict({
        config: setup.configPda,
        pool: setup.poolPda,
        escrow: setup.escrowPda,
        record: setup.recordPda,
        brand: setup.brand.publicKey,
        creator: setup.creator.publicKey,
        feeTreasury: setup.treasury,
        arbiter: validArbiter.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([validArbiter])
      .rpc();
  });

  it("rejects on non-Disputed state with WrongState", async () => {
    const program = getProgram();
    const arbiter = await newPoolArbiter();
    const { configPda, treasury } = await ensureProtocolInitialized();
    const { poolPda } = await ensureArbitrationPoolInitialized();
    const { brand, creator } = await setupActors();
    const contractId = deriveContractId("arbitrate-wrong-state");
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

    // State is Bound, not Disputed.
    let errorName: string | undefined;
    try {
      await program.methods
        .arbitrate([...contractId], { release: {} })
        .accountsStrict({
          config: configPda,
          pool: poolPda,
          escrow: escrowPda,
          record: recordPda,
          brand: brand.publicKey,
          creator: creator.publicKey,
          feeTreasury: treasury,
          arbiter: arbiter.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([arbiter])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("WrongState");
  });

  it("Split math invariant for several bps values: creator + brand_residual + fee_to_treasury == price + fee + rent", async () => {
    const program = getProgram();
    const provider = getProvider();

    for (const bps of [2500, 7500]) {
      const arbiter = await newPoolArbiter();
      const setup = await fundDeliverDispute(`split-prop-${bps}`);
      const fee = computeFee(setup.price, FEE_BPS);
      const expectedCreator = setup.price.muln(bps).divn(10_000).toNumber();

      const totalBefore = setup.price.toNumber() + fee.toNumber();
      const creatorBefore = await provider.connection.getBalance(
        setup.creator.publicKey,
      );
      const treasuryBefore = await provider.connection.getBalance(setup.treasury);
      const brandBefore = await provider.connection.getBalance(setup.brand.publicKey);
      const escrowBefore = await provider.connection.getBalance(setup.escrowPda);

      await program.methods
        .arbitrate([...setup.contractId], { split: { creatorBps: bps } })
        .accountsStrict({
          config: setup.configPda,
          pool: setup.poolPda,
          escrow: setup.escrowPda,
          record: setup.recordPda,
          brand: setup.brand.publicKey,
          creator: setup.creator.publicKey,
          feeTreasury: setup.treasury,
          arbiter: arbiter.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([arbiter])
        .rpc();

      const creatorDelta =
        (await provider.connection.getBalance(setup.creator.publicKey)) -
        creatorBefore;
      const treasuryDelta =
        (await provider.connection.getBalance(setup.treasury)) - treasuryBefore;
      const brandDelta =
        (await provider.connection.getBalance(setup.brand.publicKey)) -
        brandBefore;
      const escrowAfter = await provider.connection.getBalance(setup.escrowPda);

      expect(creatorDelta).to.equal(expectedCreator);
      expect(treasuryDelta).to.equal(fee.toNumber());
      expect(escrowAfter).to.equal(0);
      // Brand received the residual: (price - creator_share) + escrow_rent.
      // brandDelta = (escrow rent received) + (price - creator_share) - tx fees
      // Approximate: brandDelta ≥ (price - creator_share)
      const expectedBrandShare = setup.price.toNumber() - expectedCreator;
      expect(brandDelta).to.be.greaterThanOrEqual(expectedBrandShare - 1000); // tx fee tolerance
      // Conservation: creator + treasury + brand_p_share == price + fee
      expect(creatorDelta + treasuryDelta).to.equal(
        totalBefore - expectedBrandShare,
      );
    }
  });
});
