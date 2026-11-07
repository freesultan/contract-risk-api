// scripts/sign-ownership.js
//
// Produce the EIP-191 personal_sign signature SealKeeper expects in
// /.well-known/x402 -> ownershipProofs. Signed with the PAY_TO wallet's
// private key (the wallet that receives payments), NOT the payer wallet
// and NOT the receipt-signing key.
//
// Run once locally, then paste the output into SEALKEEPER_OWNERSHIP_PROOF
// in Vercel's environment variables. The private key is never stored in
// the repo or in Vercel — only the resulting signature is.
//
//   ORIGIN=https://smartcontractrisk.0xhodhod.xyz \
//   PAY_TO_PRIVATE_KEY=0x... \
//   node scripts/sign-ownership.js
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";

const origin = process.env.ORIGIN || "https://smartcontractrisk.0xhodhod.xyz";
const pk = process.env.PAY_TO_PRIVATE_KEY;

if (!/^0x[0-9a-fA-F]{64}$/.test(pk || "")) {
  console.error("PAY_TO_PRIVATE_KEY missing or malformed (expected 0x + 64 hex).");
  process.exit(1);
}

// SealKeeper is explicit: the message is the ORIGIN only. No trailing slash,
// no path. https://smartcontractrisk.0xhodhod.xyz, not .../ or .../app.
if (origin.endsWith("/") || origin.includes("/", 8)) {
  console.error("ORIGIN must be scheme + host only, no trailing slash, no path.");
  process.exit(1);
}

const account = privateKeyToAccount(pk);
const signature = await account.signMessage({ message: origin });

// Sanity: 0x + 130 hex = 65 bytes (r + s + v).
if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
  console.error("Unexpected signature length:", signature);
  process.exit(1);
}

console.log("ORIGIN: ", origin);
console.log("SIGNER: ", account.address);
console.log("PROOF:  ", signature);
console.log("\nIf SIGNER does not match EVM_ADDRESS, you signed with the wrong key.");
console.log("Set SEALKEEPER_OWNERSHIP_PROOF in Vercel to PROOF above, then redeploy.");