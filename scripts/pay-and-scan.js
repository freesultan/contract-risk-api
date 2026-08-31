// One-off x402 payer script: calls POST /scan against a real deployment,
// signs the x402 "exact" EVM payment (EIP-3009 transferWithAuthorization —
// gasless for the payer, no on-chain approval step, no ETH needed) using the
// wallet in PAYER_PRIVATE_KEY, and prints the settlement result.
//
// This is the trigger PayAI's facilitator needs to index /scan in its Bazaar
// catalog (GET /discovery/resources) — indexing happens after the route's
// first *real settled* payment, not just from being configured.
//
// Usage:
//   PAYER_PRIVATE_KEY=0x... node scripts/pay-and-scan.js
// (or set PAYER_PRIVATE_KEY in .env — it's gitignored)
//
// The payer wallet must hold a little USDC on Base (network eip155:8453 —
// same chain the server is configured for; USDC on other chains, e.g.
// Polygon or zkSync Era, is a different asset on a different network and
// cannot pay this route as configured).
//
// Self-paying (PAYER_PRIVATE_KEY belonging to the same wallet as your
// EVM_ADDRESS payout address) is a valid, effectively free way to trigger
// the listing: the USDC leaves and immediately returns to the same address,
// and the facilitator (not you) covers gas — so the net cost is ~$0, you
// just need that wallet to already hold at least the PRICE_PER_SCAN amount
// of Base USDC to sign the authorization against.

import "dotenv/config";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const {
  PAYER_PRIVATE_KEY,
  SCAN_API_URL = "https://contract-risk-api-six.vercel.app/scan",
  SCAN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  SCAN_CHAIN = "base",
  X402_NETWORK = "eip155:8453",
} = process.env;

if (!PAYER_PRIVATE_KEY) {
  throw new Error(
    "Set PAYER_PRIVATE_KEY (a wallet holding Base USDC) in .env or the environment."
  );
}

const account = privateKeyToAccount(PAYER_PRIVATE_KEY);

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: X402_NETWORK, client: new ExactEvmScheme(account) }],
});

console.log(`Paying from wallet: ${account.address}`);
console.log(`POST ${SCAN_API_URL}`, { address: SCAN_ADDRESS, chain: SCAN_CHAIN });

const res = await fetchWithPayment(SCAN_API_URL, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ address: SCAN_ADDRESS, chain: SCAN_CHAIN }),
});

console.log("HTTP status:", res.status);

const paymentResponseHeader = res.headers.get("payment-response");
if (paymentResponseHeader) {
  console.log("Payment settled:", decodePaymentResponseHeader(paymentResponseHeader));
} else {
  console.log("No PAYMENT-RESPONSE header (payment may not have been required or settlement failed).");
}

console.log("Body:", await res.json());
