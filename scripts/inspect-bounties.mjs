// One-off diagnostic: dump every BountyEscrow PDA on-chain.
// Run: node scripts/inspect-bounties.mjs

import anchor from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL = JSON.parse(
    readFileSync(join(__dirname, '..', 'target', 'idl', 'adler_escrow.json'), 'utf-8'),
);

const RPC = process.env.RPC_URL ?? 'https://api.devnet.solana.com';
const conn = new Connection(RPC, 'confirmed');
const dummy = new anchor.Wallet(Keypair.generate());
const provider = new anchor.AnchorProvider(conn, dummy, { commitment: 'confirmed' });
const program = new anchor.Program(IDL, provider);

// BountyEscrow discriminator from the IDL (first 8 bytes of sha256("account:BountyEscrow"))
const escrowAccount = IDL.accounts.find((a) => a.name === 'BountyEscrow');
const discriminator = Buffer.from(escrowAccount.discriminator);

console.log(`→ Fetching program accounts with BountyEscrow discriminator from ${RPC}`);
const accounts = await conn.getProgramAccounts(new PublicKey(IDL.address), {
    filters: [{ memcmp: { offset: 0, bytes: discriminator.toString('base64'), encoding: 'base64' } }],
});

console.log(`→ Found ${accounts.length} candidate accounts`);
console.log('---');

const now = Math.floor(Date.now() / 1000);

for (const { pubkey, account } of accounts) {
    try {
        const decoded = program.coder.accounts.decode('bountyEscrow', account.data);
        const bountyId = Buffer.from(decoded.bountyId).toString('hex');
        const expiresAt = decoded.expiresAt.toNumber();
        const expiresInDays = ((expiresAt - now) / 86400).toFixed(2);
        const amountSol = Number(decoded.amountLamports) / 1e9;
        console.log(JSON.stringify({
            pda: pubkey.toBase58(),
            poster: decoded.poster.toBase58(),
            bountyId,
            amountSol,
            feeLamports: decoded.feeLamports.toString(),
            expiresAt: new Date(expiresAt * 1000).toISOString(),
            expiresInDays,
            feeTreasury: decoded.feeTreasury.toBase58(),
            dataLen: account.data.length,
        }, null, 2));
    } catch (err) {
        console.log(JSON.stringify({
            pda: pubkey.toBase58(),
            dataLen: account.data.length,
            decodeError: err.message,
            // Try to extract poster pubkey from raw bytes (offset 8 after discriminator)
            posterRaw: account.data.length >= 40
                ? new PublicKey(account.data.subarray(8, 40)).toBase58()
                : null,
        }, null, 2));
    }
}
