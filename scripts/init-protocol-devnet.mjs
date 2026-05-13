// One-shot: call init_protocol on devnet for the bounty escrow program.
// Run from adler-program/ via:
//   node scripts/init-protocol-devnet.mjs
//
// Re-running is safe: anchor's `init` constraint will fail with
// "AlreadyInitialized" if the singleton config PDA already exists.

import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const PROGRAM_ID = new PublicKey('BArnn6qEM45LMxntW2eBKc5icsZGGqaLiDFCSTFx1uZr');
const PROTOCOL_CONFIG_SEED = Buffer.from('bounty_config_v2');

const idl = JSON.parse(
  readFileSync('./target/idl/adler_escrow.json', 'utf-8'),
);

const adminBytes = JSON.parse(
  readFileSync(join(homedir(), '.config/solana/id.json'), 'utf-8'),
);
const admin = Keypair.fromSecretKey(Uint8Array.from(adminBytes));

const conn = new Connection('https://api.devnet.solana.com', 'confirmed');
const wallet = {
  publicKey: admin.publicKey,
  signTransaction: async (tx) => {
    tx.partialSign(admin);
    return tx;
  },
  signAllTransactions: async (txs) =>
    txs.map((tx) => {
      tx.partialSign(admin);
      return tx;
    }),
};
const provider = new anchor.AnchorProvider(conn, wallet, {
  commitment: 'confirmed',
});
const program = new anchor.Program(idl, provider);

const [configPda] = PublicKey.findProgramAddressSync(
  [PROTOCOL_CONFIG_SEED],
  PROGRAM_ID,
);

console.log('Admin pubkey: ', admin.publicKey.toBase58());
console.log('Config PDA:   ', configPda.toBase58());

const existing = await conn.getAccountInfo(configPda);
if (existing) {
  console.log('Config PDA already initialized; nothing to do.');
  process.exit(0);
}

const sig = await program.methods
  .initProtocol(admin.publicKey, admin.publicKey, 50)
  .accountsPartial({
    config: configPda,
    payer: admin.publicKey,
    systemProgram: anchor.web3.SystemProgram.programId,
  })
  .signers([admin])
  .rpc();

console.log('init_protocol tx:', sig);
console.log('https://solscan.io/tx/' + sig + '?cluster=devnet');
