import { expect } from "chai";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  airdrop,
  deriveArbitrationPoolPda,
  deriveProtocolConfigPda,
  ensureArbitrationPoolInitialized,
  getAdmin,
  getProgram,
} from "./helpers/setup";

describe("arbitration_pool", () => {
  let poolPda: PublicKey;

  before(async () => {
    ({ poolPda } = await ensureArbitrationPoolInitialized());
  });

  it("init writes the pool with admin = provider wallet, quorum >= 1", async () => {
    const program = getProgram();
    const admin = getAdmin();
    const pool = await program.account.arbitrationPool.fetch(poolPda);
    expect(pool.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(pool.quorum).to.be.greaterThanOrEqual(1);
    // disputed_count starts at 0 but accumulates across the test session as
    // open-dispute / arbitrate tests run; just sanity-check it's a number.
    expect(pool.disputedCount).to.be.a("number");
    expect(pool.disputedCount).to.be.greaterThanOrEqual(0);
  });

  it("rejects a second init", async () => {
    const program = getProgram();
    const admin = getAdmin();
    let threw = false;
    try {
      await program.methods
        .initArbitrationPool(1)
        .accountsStrict({
          config: deriveProtocolConfigPda(program.programId),
          pool: poolPda,
          admin: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "second init must fail").to.equal(true);
  });

  it("admin can add and remove an arbiter", async () => {
    const program = getProgram();
    const admin = getAdmin();
    const arbiter = Keypair.generate().publicKey;

    await program.methods
      .addArbiter(arbiter)
      .accountsStrict({ pool: poolPda, admin: admin.publicKey })
      .rpc();
    expect(
      (await program.account.arbitrationPool.fetch(poolPda)).arbiters.some(
        (a) => a.toBase58() === arbiter.toBase58(),
      ),
    ).to.equal(true);

    await program.methods
      .removeArbiter(arbiter)
      .accountsStrict({ pool: poolPda, admin: admin.publicKey })
      .rpc();
    expect(
      (await program.account.arbitrationPool.fetch(poolPda)).arbiters.some(
        (a) => a.toBase58() === arbiter.toBase58(),
      ),
    ).to.equal(false);
  });

  it("rejects duplicate add with DuplicateArbiter", async () => {
    const program = getProgram();
    const admin = getAdmin();
    const arbiter = Keypair.generate().publicKey;

    await program.methods
      .addArbiter(arbiter)
      .accountsStrict({ pool: poolPda, admin: admin.publicKey })
      .rpc();

    let errorName: string | undefined;
    try {
      await program.methods
        .addArbiter(arbiter)
        .accountsStrict({ pool: poolPda, admin: admin.publicKey })
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }

    // Cleanup
    await program.methods
      .removeArbiter(arbiter)
      .accountsStrict({ pool: poolPda, admin: admin.publicKey })
      .rpc();

    expect(errorName).to.equal("DuplicateArbiter");
  });

  it("rejects remove of unknown pubkey with ArbiterNotInPool", async () => {
    const program = getProgram();
    const admin = getAdmin();
    const ghost = Keypair.generate().publicKey;

    let errorName: string | undefined;
    try {
      await program.methods
        .removeArbiter(ghost)
        .accountsStrict({ pool: poolPda, admin: admin.publicKey })
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("ArbiterNotInPool");
  });

  it("rejects add from a non-admin signer", async () => {
    const program = getProgram();
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);
    const arbiter = Keypair.generate().publicKey;

    let threw = false;
    try {
      await program.methods
        .addArbiter(arbiter)
        .accountsStrict({ pool: poolPda, admin: stranger.publicKey })
        .signers([stranger])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "non-admin add must fail").to.equal(true);
  });

  it("rejects remove from a non-admin signer", async () => {
    const program = getProgram();
    const admin = getAdmin();
    const arbiter = Keypair.generate().publicKey;
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    await program.methods
      .addArbiter(arbiter)
      .accountsStrict({ pool: poolPda, admin: admin.publicKey })
      .rpc();

    let threw = false;
    try {
      await program.methods
        .removeArbiter(arbiter)
        .accountsStrict({ pool: poolPda, admin: stranger.publicKey })
        .signers([stranger])
        .rpc();
    } catch {
      threw = true;
    }

    // Cleanup
    await program.methods
      .removeArbiter(arbiter)
      .accountsStrict({ pool: poolPda, admin: admin.publicKey })
      .rpc();

    expect(threw, "non-admin remove must fail").to.equal(true);
  });

  it("init also writes config.arbitration_pool", async () => {
    const program = getProgram();
    const cfg = await program.account.protocolConfig.fetch(
      deriveProtocolConfigPda(program.programId),
    );
    expect(cfg.arbitrationPool.toBase58()).to.equal(poolPda.toBase58());
  });
});
