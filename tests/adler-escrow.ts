import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import * as crypto from "crypto";
import { AdlerEscrow } from "../target/types/adler_escrow";

// Run via:  anchor test
//
// `anchor test` spins up `solana-test-validator` on a fresh ledger, deploys
// the program, and executes this file. Default keypair is pre-funded with
// many SOL — no public faucet involved.
//
// Coverage: 7 cases. Time-warp tests for brand_refund (24h grace) deferred
// until we add solana-bankrun (out of scope for this initial commit).

const ESCROW_SEED = Buffer.from("escrow");

describe("adler-escrow", () => {
  const provider = anchor.AnchorProvider.env();
  // Make .rpc() wait for "confirmed" so subsequent getBalance() reads (also
  // confirmed) see the post-tx state. Without this the next test's
  // `creatorBefore` snapshot lags by one tx and breaks the delta math.
  provider.opts.commitment = "confirmed";
  provider.opts.preflightCommitment = "confirmed";
  anchor.setProvider(provider);

  const program = anchor.workspace.adlerEscrow as Program<AdlerEscrow>;

  // Per-suite actors. Brand pays for everything, fee_treasury + creator + arbitrator
  // are receivers (we still need their pubkeys at fund time).
  const brand = (provider.wallet as anchor.Wallet).payer;
  let creator: Keypair;
  let feeTreasury: Keypair;
  let arbitrator: Keypair;

  before(async () => {
    creator = Keypair.generate();
    feeTreasury = Keypair.generate();
    arbitrator = Keypair.generate();
    // Pre-fund the receivers with rent so the lamport math doesn't have to
    // create them mid-instruction. Even 0.01 SOL is plenty.
    for (const k of [creator, feeTreasury, arbitrator]) {
      const sig = await provider.connection.requestAirdrop(k.publicKey, 0.01 * LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig, "confirmed");
    }
  });

  // ---------- helpers ----------

  function randomContractId(): number[] {
    return Array.from(crypto.randomBytes(32));
  }

  function pdaFor(contractId: number[]): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [ESCROW_SEED, brand.publicKey.toBuffer(), Buffer.from(contractId)],
      program.programId
    );
  }

  async function balance(key: PublicKey): Promise<number> {
    return await provider.connection.getBalance(key, "confirmed");
  }

  async function fund(args: {
    contractId: number[];
    priceLamports: number;
    feeLamports: number;
    deadlineSecondsFromNow: number;
  }): Promise<PublicKey> {
    const [pda] = pdaFor(args.contractId);
    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .fundEscrow(
        args.contractId,
        new BN(args.priceLamports),
        new BN(args.feeLamports),
        new BN(now + args.deadlineSecondsFromNow)
      )
      .accounts({
        brand: brand.publicKey,
        creator: creator.publicKey,
        feeTreasury: feeTreasury.publicKey,
        arbitrationAuthority: arbitrator.publicKey,
        escrow: pda,
        systemProgram: SystemProgram.programId,
      })
      .signers([brand])
      .rpc();
    return pda;
  }

  async function fetchEscrow(pda: PublicKey) {
    return await program.account.escrowAccount.fetch(pda);
  }

  // ---------- happy paths ----------

  it("fund_escrow → approve_release: creator + treasury credited, PDA closed", async () => {
    const cid = randomContractId();
    const price = 0.5 * LAMPORTS_PER_SOL;
    const fee = 0.025 * LAMPORTS_PER_SOL; // 5%

    const creatorBefore = await balance(creator.publicKey);
    const treasuryBefore = await balance(feeTreasury.publicKey);

    const pda = await fund({ contractId: cid, priceLamports: price, feeLamports: fee, deadlineSecondsFromNow: 600 });
    const escrow = await fetchEscrow(pda);
    expect(escrow.state).to.equal(0); // Funded
    expect(escrow.priceLamports.toString()).to.equal(price.toString());
    expect(escrow.feeLamports.toString()).to.equal(fee.toString());

    await program.methods
      .approveRelease(cid)
      .accounts({
        brand: brand.publicKey,
        creator: creator.publicKey,
        feeTreasury: feeTreasury.publicKey,
        escrow: pda,
      })
      .signers([brand])
      .rpc();

    const creatorAfter = await balance(creator.publicKey);
    const treasuryAfter = await balance(feeTreasury.publicKey);
    expect(creatorAfter - creatorBefore).to.equal(price);
    expect(treasuryAfter - treasuryBefore).to.equal(fee);

    // PDA closed
    const closed = await provider.connection.getAccountInfo(pda);
    expect(closed).to.equal(null);
  });

  it("fund_escrow → wait → auto_release: permissionless caller settles after deadline", async () => {
    const cid = randomContractId();
    const price = 0.3 * LAMPORTS_PER_SOL;
    const fee = 0.015 * LAMPORTS_PER_SOL;

    const creatorBefore = await balance(creator.publicKey);
    const treasuryBefore = await balance(feeTreasury.publicKey);

    // 2-second deadline so we can wait it out without bankrun.
    const pda = await fund({ contractId: cid, priceLamports: price, feeLamports: fee, deadlineSecondsFromNow: 2 });

    // Wait past the deadline. solana-test-validator advances the clock in
    // real time, so a few real seconds ≈ a few program seconds.
    await new Promise((r) => setTimeout(r, 4000));

    // ANYONE can call auto_release — use the brand keypair as the caller
    // (it's just paying gas; the funds still go to creator + treasury).
    await program.methods
      .autoRelease(cid)
      .accounts({
        caller: brand.publicKey,
        brand: brand.publicKey,
        creator: creator.publicKey,
        feeTreasury: feeTreasury.publicKey,
        escrow: pda,
      })
      .signers([brand])
      .rpc();

    expect((await balance(creator.publicKey)) - creatorBefore).to.equal(price);
    expect((await balance(feeTreasury.publicKey)) - treasuryBefore).to.equal(fee);
    expect(await provider.connection.getAccountInfo(pda)).to.equal(null);
  });

  it("open_dispute → arbitrate(Release): creator + treasury credited, PDA closed", async () => {
    const cid = randomContractId();
    const price = 0.4 * LAMPORTS_PER_SOL;
    const fee = 0.02 * LAMPORTS_PER_SOL;

    const creatorBefore = await balance(creator.publicKey);
    const treasuryBefore = await balance(feeTreasury.publicKey);

    const pda = await fund({ contractId: cid, priceLamports: price, feeLamports: fee, deadlineSecondsFromNow: 600 });

    await program.methods
      .openDispute(cid)
      .accounts({ party: brand.publicKey, brand: brand.publicKey, escrow: pda })
      .signers([brand])
      .rpc();

    const after = await fetchEscrow(pda);
    expect(after.state).to.equal(3); // Disputed

    await program.methods
      .arbitrate(cid, { release: {} })
      .accounts({
        arbitrator: arbitrator.publicKey,
        brand: brand.publicKey,
        creator: creator.publicKey,
        feeTreasury: feeTreasury.publicKey,
        escrow: pda,
      })
      .signers([arbitrator])
      .rpc();

    expect((await balance(creator.publicKey)) - creatorBefore).to.equal(price);
    expect((await balance(feeTreasury.publicKey)) - treasuryBefore).to.equal(fee);
    expect(await provider.connection.getAccountInfo(pda)).to.equal(null);
  });

  it("open_dispute → arbitrate(Split 60/40): creator gets 60% of price, fee always to treasury", async () => {
    const cid = randomContractId();
    const price = 1 * LAMPORTS_PER_SOL;
    const fee = 0.05 * LAMPORTS_PER_SOL;

    const creatorBefore = await balance(creator.publicKey);
    const treasuryBefore = await balance(feeTreasury.publicKey);

    const pda = await fund({ contractId: cid, priceLamports: price, feeLamports: fee, deadlineSecondsFromNow: 600 });

    await program.methods
      .openDispute(cid)
      .accounts({ party: brand.publicKey, brand: brand.publicKey, escrow: pda })
      .signers([brand])
      .rpc();

    await program.methods
      .arbitrate(cid, { split: { num: new BN(60), denom: new BN(100) } })
      .accounts({
        arbitrator: arbitrator.publicKey,
        brand: brand.publicKey,
        creator: creator.publicKey,
        feeTreasury: feeTreasury.publicKey,
        escrow: pda,
      })
      .signers([arbitrator])
      .rpc();

    const expectedCreator = price * 0.6;
    const expectedTreasury = fee;

    expect((await balance(creator.publicKey)) - creatorBefore).to.equal(expectedCreator);
    expect((await balance(feeTreasury.publicKey)) - treasuryBefore).to.equal(expectedTreasury);
  });

  // ---------- negative cases ----------

  it("rejects approve_release when signer is not the brand", async () => {
    const cid = randomContractId();
    const pda = await fund({ contractId: cid, priceLamports: 0.1 * LAMPORTS_PER_SOL, feeLamports: 0, deadlineSecondsFromNow: 600 });

    const stranger = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(stranger.publicKey, 0.01 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");

    let threw = false;
    try {
      await program.methods
        .approveRelease(cid)
        .accounts({
          brand: stranger.publicKey,
          creator: creator.publicKey,
          feeTreasury: feeTreasury.publicKey,
          escrow: pda,
        })
        .signers([stranger])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "stranger approve_release should fail").to.equal(true);
  });

  it("rejects auto_release before deadline", async () => {
    const cid = randomContractId();
    const pda = await fund({ contractId: cid, priceLamports: 0.1 * LAMPORTS_PER_SOL, feeLamports: 0, deadlineSecondsFromNow: 600 });

    let threw = false;
    try {
      await program.methods
        .autoRelease(cid)
        .accounts({
          caller: brand.publicKey,
          brand: brand.publicKey,
          creator: creator.publicKey,
          feeTreasury: feeTreasury.publicKey,
          escrow: pda,
        })
        .signers([brand])
        .rpc();
    } catch (e: any) {
      threw = true;
      expect(e.toString()).to.match(/DeadlineNotReached|6008/);
    }
    expect(threw, "auto_release before deadline should fail").to.equal(true);
  });

  it("rejects arbitrate by non-arbitrator AND on non-disputed PDA", async () => {
    const cid = randomContractId();
    const pda = await fund({ contractId: cid, priceLamports: 0.1 * LAMPORTS_PER_SOL, feeLamports: 0, deadlineSecondsFromNow: 600 });

    // 1. Wrong arbitrator on a Disputed PDA
    await program.methods
      .openDispute(cid)
      .accounts({ party: brand.publicKey, brand: brand.publicKey, escrow: pda })
      .signers([brand])
      .rpc();

    const stranger = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(stranger.publicKey, 0.01 * LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");

    let threw1 = false;
    try {
      await program.methods
        .arbitrate(cid, { release: {} })
        .accounts({
          arbitrator: stranger.publicKey,
          brand: brand.publicKey,
          creator: creator.publicKey,
          feeTreasury: feeTreasury.publicKey,
          escrow: pda,
        })
        .signers([stranger])
        .rpc();
    } catch {
      threw1 = true;
    }
    expect(threw1, "stranger arbitrate should fail").to.equal(true);

    // 2. Real arbitrator on a NOT-disputed PDA
    const cid2 = randomContractId();
    const pda2 = await fund({ contractId: cid2, priceLamports: 0.1 * LAMPORTS_PER_SOL, feeLamports: 0, deadlineSecondsFromNow: 600 });

    let threw2 = false;
    try {
      await program.methods
        .arbitrate(cid2, { release: {} })
        .accounts({
          arbitrator: arbitrator.publicKey,
          brand: brand.publicKey,
          creator: creator.publicKey,
          feeTreasury: feeTreasury.publicKey,
          escrow: pda2,
        })
        .signers([arbitrator])
        .rpc();
    } catch (e: any) {
      threw2 = true;
      expect(e.toString()).to.match(/NotDisputed|6007/);
    }
    expect(threw2, "arbitrate on non-disputed PDA should fail").to.equal(true);
  });
});
