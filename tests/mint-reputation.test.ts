import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";

import {
  airdrop,
  deriveContractEscrowPda,
  deriveContractId,
  deriveContractRecordPda,
  deriveReputationCardPda,
  ensureArbitrationPoolInitialized,
  ensureArbiterInPool,
  ensureProtocolInitialized,
  getProgram,
  setupActors,
} from "./helpers/setup";

function commentHash(text: string): number[] {
  return [...createHash("sha256").update(text, "utf8").digest()];
}

interface SettledViaApprove {
  brand: Keypair;
  creator: Keypair;
  configPda: PublicKey;
  recordPda: PublicKey;
  contractId: Buffer;
}

async function settledViaApprove(suffix: string): Promise<SettledViaApprove> {
  const program = getProgram();
  const { configPda, treasury } = await ensureProtocolInitialized();
  const { brand, creator } = await setupActors();
  const contractId = deriveContractId(`rep-${suffix}`);
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
    .fundService([...contractId], new BN(0.4 * LAMPORTS_PER_SOL))
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

  return { brand, creator, configPda, recordPda, contractId };
}

async function settledViaArbitrate(
  suffix: string,
  outcome: { release?: {} } | { refund?: {} } | { split?: { creatorBps: number } },
): Promise<{
  brand: Keypair;
  creator: Keypair;
  recordPda: PublicKey;
  contractId: Buffer;
}> {
  const program = getProgram();
  const { configPda, treasury } = await ensureProtocolInitialized();
  const { poolPda } = await ensureArbitrationPoolInitialized();
  const { brand, creator } = await setupActors();
  const arbiter = Keypair.generate();
  await airdrop(arbiter.publicKey, 1);
  await ensureArbiterInPool(arbiter.publicKey);

  const contractId = deriveContractId(`rep-arb-${suffix}`);
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
    .fundService([...contractId], new BN(0.4 * LAMPORTS_PER_SOL))
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

  await program.methods
    .arbitrate([...contractId], outcome as any)
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

  return { brand, creator, recordPda, contractId };
}

const AXES_SAMPLE: number[] = [5, 4, 5, 5];

describe("mint_reputation", () => {
  before(async () => {
    await ensureProtocolInitialized();
    await ensureArbitrationPoolInitialized();
  });

  it("happy: brand rates creator after Settled", async () => {
    const program = getProgram();
    const { brand, creator, contractId } = await settledViaApprove("brand-rates-creator");
    const cardPda = deriveReputationCardPda(
      program.programId,
      creator.publicKey,
      contractId,
    );

    await program.methods
      .mintReputation([...contractId], AXES_SAMPLE, commentHash("great work"))
      .accountsStrict({
        brand: brand.publicKey,
        record: deriveContractRecordPda(
          program.programId,
          brand.publicKey,
          contractId,
        ),
        subject: creator.publicKey,
        card: cardPda,
        reviewer: brand.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    const card = await program.account.reputationCard.fetch(cardPda);
    expect(card.reviewer.toBase58()).to.equal(brand.publicKey.toBase58());
    expect(card.subject.toBase58()).to.equal(creator.publicKey.toBase58());
    expect([...card.axes]).to.deep.equal(AXES_SAMPLE);
    expect(card.amountLamports.toNumber()).to.equal(0.4 * LAMPORTS_PER_SOL);
  });

  it("happy: creator rates brand after Settled (separate card from the brand's review)", async () => {
    const program = getProgram();
    const { brand, creator, contractId } = await settledViaApprove(
      "creator-rates-brand",
    );

    // Brand → Creator direction
    const brandToCreatorCard = deriveReputationCardPda(
      program.programId,
      creator.publicKey,
      contractId,
    );
    await program.methods
      .mintReputation([...contractId], AXES_SAMPLE, commentHash("good buyer"))
      .accountsStrict({
        brand: brand.publicKey,
        record: deriveContractRecordPda(program.programId, brand.publicKey, contractId),
        subject: creator.publicKey,
        card: brandToCreatorCard,
        reviewer: brand.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    // Creator → Brand direction. PDA differs because subject = brand now.
    const creatorToBrandCard = deriveReputationCardPda(
      program.programId,
      brand.publicKey,
      contractId,
    );
    await program.methods
      .mintReputation([...contractId], [4, 5, 4, 5], commentHash("paid promptly"))
      .accountsStrict({
        brand: brand.publicKey,
        record: deriveContractRecordPda(program.programId, brand.publicKey, contractId),
        subject: brand.publicKey,
        card: creatorToBrandCard,
        reviewer: creator.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc();

    const card1 = await program.account.reputationCard.fetch(brandToCreatorCard);
    const card2 = await program.account.reputationCard.fetch(creatorToBrandCard);
    expect(card1.subject.toBase58()).to.equal(creator.publicKey.toBase58());
    expect(card2.subject.toBase58()).to.equal(brand.publicKey.toBase58());
  });

  it("happy: rates after Resolved(Release)", async () => {
    const program = getProgram();
    const { brand, creator, recordPda, contractId } =
      await settledViaArbitrate("release", { release: {} });
    const cardPda = deriveReputationCardPda(
      program.programId,
      creator.publicKey,
      contractId,
    );

    await program.methods
      .mintReputation([...contractId], AXES_SAMPLE, commentHash("ok"))
      .accountsStrict({
        brand: brand.publicKey,
        record: recordPda,
        subject: creator.publicKey,
        card: cardPda,
        reviewer: brand.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    const card = await program.account.reputationCard.fetch(cardPda);
    expect(card.subject.toBase58()).to.equal(creator.publicKey.toBase58());
  });

  it("happy: rates after Resolved(Split{5000})", async () => {
    const program = getProgram();
    const { brand, creator, recordPda, contractId } = await settledViaArbitrate(
      "split",
      { split: { creatorBps: 5000 } },
    );
    const cardPda = deriveReputationCardPda(
      program.programId,
      creator.publicKey,
      contractId,
    );

    await program.methods
      .mintReputation([...contractId], [3, 3, 3, 3], commentHash("partial work"))
      .accountsStrict({
        brand: brand.publicKey,
        record: recordPda,
        subject: creator.publicKey,
        card: cardPda,
        reviewer: brand.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    expect(
      (await program.account.reputationCard.fetch(cardPda)).subject.toBase58(),
    ).to.equal(creator.publicKey.toBase58());
  });

  it("rejects after Resolved(Refund) with NotRatable", async () => {
    const program = getProgram();
    const { brand, creator, recordPda, contractId } = await settledViaArbitrate(
      "refund",
      { refund: {} },
    );
    const cardPda = deriveReputationCardPda(
      program.programId,
      creator.publicKey,
      contractId,
    );

    let errorName: string | undefined;
    try {
      await program.methods
        .mintReputation([...contractId], AXES_SAMPLE, commentHash(""))
        .accountsStrict({
          brand: brand.publicKey,
          record: recordPda,
          subject: creator.publicKey,
          card: cardPda,
          reviewer: brand.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("NotRatable");
  });

  it("rejects double-mint of the same (subject, contract_id)", async () => {
    const program = getProgram();
    const { brand, creator, contractId } = await settledViaApprove("double-mint");
    const cardPda = deriveReputationCardPda(
      program.programId,
      creator.publicKey,
      contractId,
    );
    const recordPda = deriveContractRecordPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    await program.methods
      .mintReputation([...contractId], AXES_SAMPLE, commentHash("first"))
      .accountsStrict({
        brand: brand.publicKey,
        record: recordPda,
        subject: creator.publicKey,
        card: cardPda,
        reviewer: brand.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();

    let threw = false;
    try {
      await program.methods
        .mintReputation([...contractId], AXES_SAMPLE, commentHash("second"))
        .accountsStrict({
          brand: brand.publicKey,
          record: recordPda,
          subject: creator.publicKey,
          card: cardPda,
          reviewer: brand.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "double-mint must fail (PDA already initialized)").to.equal(
      true,
    );
  });

  it("rejects reviewer == subject with SelfRating", async () => {
    const program = getProgram();
    const { brand, contractId } = await settledViaApprove("self-rate");
    const cardPda = deriveReputationCardPda(
      program.programId,
      brand.publicKey,
      contractId,
    );
    const recordPda = deriveContractRecordPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    let errorName: string | undefined;
    try {
      await program.methods
        .mintReputation([...contractId], AXES_SAMPLE, commentHash(""))
        .accountsStrict({
          brand: brand.publicKey,
          record: recordPda,
          subject: brand.publicKey,
          card: cardPda,
          reviewer: brand.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("SelfRating");
  });

  it("rejects reviewer not a party with NotAParty", async () => {
    const program = getProgram();
    const { brand, creator, contractId } = await settledViaApprove("non-party");
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);
    const cardPda = deriveReputationCardPda(
      program.programId,
      creator.publicKey,
      contractId,
    );
    const recordPda = deriveContractRecordPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    let errorName: string | undefined;
    try {
      await program.methods
        .mintReputation([...contractId], AXES_SAMPLE, commentHash(""))
        .accountsStrict({
          brand: brand.publicKey,
          record: recordPda,
          subject: creator.publicKey,
          card: cardPda,
          reviewer: stranger.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([stranger])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("NotAParty");
  });

  it("rejects axis 0 with InvalidAxis", async () => {
    const program = getProgram();
    const { brand, creator, contractId } = await settledViaApprove("axis-zero");
    const cardPda = deriveReputationCardPda(
      program.programId,
      creator.publicKey,
      contractId,
    );
    const recordPda = deriveContractRecordPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    let errorName: string | undefined;
    try {
      await program.methods
        .mintReputation([...contractId], [0, 5, 5, 5], commentHash(""))
        .accountsStrict({
          brand: brand.publicKey,
          record: recordPda,
          subject: creator.publicKey,
          card: cardPda,
          reviewer: brand.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("InvalidAxis");
  });

  it("rejects axis 6 with InvalidAxis", async () => {
    const program = getProgram();
    const { brand, creator, contractId } = await settledViaApprove("axis-six");
    const cardPda = deriveReputationCardPda(
      program.programId,
      creator.publicKey,
      contractId,
    );
    const recordPda = deriveContractRecordPda(
      program.programId,
      brand.publicKey,
      contractId,
    );

    let errorName: string | undefined;
    try {
      await program.methods
        .mintReputation([...contractId], [5, 6, 5, 5], commentHash(""))
        .accountsStrict({
          brand: brand.publicKey,
          record: recordPda,
          subject: creator.publicKey,
          card: cardPda,
          reviewer: brand.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("InvalidAxis");
  });
});
