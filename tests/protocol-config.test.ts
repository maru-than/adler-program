import { expect } from "chai";
import { BN } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

import {
  airdrop,
  APPROVAL_WINDOW_SECS,
  ensureProtocolInitialized,
  FEE_BPS,
  getAdmin,
  getProgram,
  REFUND_GRACE_SECS,
} from "./helpers/setup";

describe("protocol_config", () => {
  let configPda: PublicKey;

  before(async () => {
    ({ configPda } = await ensureProtocolInitialized());
  });

  it("writes the documented defaults on init", async () => {
    const program = getProgram();
    const cfg = await program.account.protocolConfig.fetch(configPda);

    expect(cfg.feeBps).to.equal(FEE_BPS);
    expect(cfg.approvalWindowSecs.toNumber()).to.equal(
      APPROVAL_WINDOW_SECS.toNumber(),
    );
    expect(cfg.refundGraceSecs.toNumber()).to.equal(
      REFUND_GRACE_SECS.toNumber(),
    );
    expect(cfg.paused).to.equal(false);
    expect(cfg.admin.toBase58()).to.equal(getAdmin().publicKey.toBase58());
    expect(cfg.arbitrationPool.toBase58()).to.equal(PublicKey.default.toBase58());
  });

  it("rejects a second init_protocol call", async () => {
    const program = getProgram();
    const admin = getAdmin();
    let threw = false;
    try {
      await program.methods
        .initProtocol(
          admin.publicKey,
          Keypair.generate().publicKey,
          FEE_BPS,
          APPROVAL_WINDOW_SECS,
          REFUND_GRACE_SECS,
        )
        .accountsStrict({
          config: configPda,
          payer: admin.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "second init must fail").to.equal(true);
  });

  it("rejects update_protocol_field from a non-admin signer", async () => {
    const program = getProgram();
    const stranger = Keypair.generate();
    await airdrop(stranger.publicKey, 1);

    let threw = false;
    try {
      await program.methods
        .updateProtocolField({ feeBps: { value: 100 } })
        .accountsStrict({
          config: configPda,
          admin: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
    } catch {
      threw = true;
    }
    expect(threw, "non-admin update must fail").to.equal(true);
  });

  it("admin can toggle the kill switch", async () => {
    const program = getProgram();
    const admin = getAdmin();

    await program.methods
      .setPaused(true)
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();
    expect(
      (await program.account.protocolConfig.fetch(configPda)).paused,
    ).to.equal(true);

    await program.methods
      .setPaused(false)
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();
    expect(
      (await program.account.protocolConfig.fetch(configPda)).paused,
    ).to.equal(false);
  });

  it("admin can update fee_bps via update_protocol_field", async () => {
    const program = getProgram();
    const admin = getAdmin();

    const original = (await program.account.protocolConfig.fetch(configPda))
      .feeBps;
    const newValue = original === 100 ? 50 : 100;

    await program.methods
      .updateProtocolField({ feeBps: { value: newValue } })
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();
    expect(
      (await program.account.protocolConfig.fetch(configPda)).feeBps,
    ).to.equal(newValue);

    // Restore for downstream tests.
    await program.methods
      .updateProtocolField({ feeBps: { value: original } })
      .accountsStrict({ config: configPda, admin: admin.publicKey })
      .rpc();
  });

  it("rejects update_protocol_field with an invalid approval window", async () => {
    const program = getProgram();
    const admin = getAdmin();

    let errorName: string | undefined;
    try {
      await program.methods
        .updateProtocolField({ approvalWindowSecs: { value: new BN(0) } })
        .accountsStrict({ config: configPda, admin: admin.publicKey })
        .rpc();
    } catch (e: any) {
      errorName = e?.error?.errorCode?.code;
    }
    expect(errorName).to.equal("InvalidDeadline");
  });
});
