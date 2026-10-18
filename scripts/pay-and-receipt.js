// Pay any x402 route once and print the decoded PAYMENT-RESPONSE header.
//   node scripts/pay-and-receipt.js http://localhost:3000/v1/alert-check '{"address":"USDC"}'
// Requires PAYER_PRIVATE_KEY with a little USDC on Base (eip155:8453).
import "dotenv/config";
import { privateKeyToAccount } from "viem/accounts";

const [url, bodyJson] = process.argv.slice(2);
if (!url || !bodyJson) {
  console.error('usage: node scripts/pay-and-receipt.js <url> \'{"address":"USDC"}\'');
  process.exit(1);
}
const pk = process.env.PAYER_PRIVATE_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(pk || "")) {
  console.error("PAYER_PRIVATE_KEY missing or malformed");
  process.exit(1);
}

const account = privateKeyToAccount(pk);
const body = JSON.parse(bodyJson);

// 1. First request — expect 402 with the signed offer
const r1 = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
if (r1.status !== 402) {
  console.log("unexpected status", r1.status, await r1.text());
  process.exit(1);
}
const requiredB64 = r1.headers.get("payment-required");
const required = JSON.parse(Buffer.from(requiredB64, "base64").toString("utf8"));
const accepted = required.accepts[0];
console.log("offer:", {
  network: accepted.network,
  asset: accepted.asset,
  payTo: accepted.payTo,
  amount: accepted.amount,
});

// 2. Build + sign the EIP-3009 authorization
const nonce = "0x" + [...crypto.getRandomValues(new Uint8Array(32))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
const auth = {
  from: account.address,
  to: accepted.payTo,
  value: String(accepted.amount),
  validAfter: 0n,
  validBefore: BigInt(Math.floor(Date.now() / 1000) + (accepted.maxTimeoutSeconds || 300)),
  nonce,
};
const signature = await account.signTypedData({
  domain: {
    name: accepted.extra.name,
    version: accepted.extra.version,
    chainId: Number(String(accepted.network).split(":")[1]),
    verifyingContract: accepted.asset,
  },
  types: {
    TransferWithAuthorization: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
    ],
  },
  primaryType: "TransferWithAuthorization",
  message: auth,
});
const payload = {
  x402Version: required.x402Version,
  payload: {
    authorization: {
      ...auth,
      value: String(auth.value),
      validAfter: String(auth.validAfter),
      validBefore: String(auth.validBefore),
    },
    signature,
  },
  extensions: required.extensions,
  resource: required.resource,
  accepted,
};
const paymentHeader = Buffer.from(JSON.stringify(payload)).toString("base64");

// 3. Paid request — expect 200 + PAYMENT-RESPONSE with the receipt
const r2 = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "PAYMENT-SIGNATURE": paymentHeader,
  },
  body: JSON.stringify(body),
});
console.log("paid status:", r2.status);
console.log("body:", await r2.text());

const respB64 = r2.headers.get("payment-response");
if (!respB64) {
  console.log("PAYMENT-RESPONSE header absent — no receipt issued");
  process.exit(1);
}
const resp = JSON.parse(Buffer.from(respB64, "base64").toString("utf8"));
const receipt = resp?.extensions?.["offer-receipt"]?.info?.receipt;
console.log("\n=== receipt ===");
console.log(JSON.stringify(receipt, null, 2));
 // The settlement hash lives at the top level of PAYMENT-RESPONSE, not inside
// the signed receipt (whose schema marks `transaction` as optional).
const txHash = resp?.transaction || resp?.transactionHash;
if (txHash) {
  console.log("\ntransaction:", txHash);
  console.log("basescan: https://basescan.org/tx/" + txHash);
  console.log("payer:     ", resp.payer);
  console.log("network:   ", resp.network);
}

//console.log("full PAYMENT-RESPONSE:", JSON.stringify(resp, null, 2));