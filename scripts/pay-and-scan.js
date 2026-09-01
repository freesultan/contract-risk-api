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
  SCAN_API_URL = "https://contract-risk-api-six.vercel.app/v1/scan",
  SCAN_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  SCAN_CHAIN = "base",
  X402_NETWORK = "eip155:8453",
  MAX_PAYMENT = "$0.05",
} = process.env;

if (!PAYER_PRIVATE_KEY) {
  throw new Error(
    "Set PAYER_PRIVATE_KEY (a wallet holding Base USDC) in .env or the environment."
  );
}

// Signing the EIP-3009 authorization needs the WebCrypto global. Node 20+ has
// it always; Node 18 exposes it in ESM only behind a flag, where the SDK
// otherwise fails deep in the stack with a bare "Crypto API not available".
if (!globalThis.crypto?.getRandomValues) {
  throw new Error(
    `WebCrypto is unavailable on ${process.version}. Use Node 20+ (recommended), ` +
      `or re-run as: node --experimental-global-webcrypto scripts/pay-and-scan.js`
  );
}

// Wallet exports vary: some emit the raw 64 hex chars with no `0x`, and .env
// values often arrive quoted or with trailing whitespace. viem requires the
// prefix and rejects anything else with an opaque "invalid private key", so
// normalize here rather than making that the user's problem.
const normalizedKey = (() => {
  const t = PAYER_PRIVATE_KEY.trim().replace(/^["']|["']$/g, "");
  const hex = t.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `PAYER_PRIVATE_KEY is not a 32-byte hex private key (got ${hex.length} hex chars, expected 64). ` +
        `If you pasted a seed phrase, use the account's private key instead.`
    );
  }
  return `0x${hex}`;
})();

const account = privateKeyToAccount(normalizedKey);

// This script signs whatever the server at SCAN_API_URL asks for, with no
// interactive confirmation — so the spend cap is the only thing standing
// between a wrong/tampered SCAN_API_URL and a real transfer. The SDK does
// default to $1 per payment, but relying on a library default for that is
// thin: pin it explicitly, and well below $1, since a scan costs $0.001.
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: X402_NETWORK, client: new ExactEvmScheme(account) }],
  spendControls: { maxAmountPerPayment: MAX_PAYMENT },
});

console.log(`Paying from wallet: ${account.address}`);
console.log(`Spend cap: ${MAX_PAYMENT} per payment`);
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
  // A second 402 means the payment was signed and submitted but the
  // facilitator refused to settle it. The reason is in the `error` field of
  // the PAYMENT-REQUIRED header, not in the (empty) body — surfacing it here
  // is the difference between "something went wrong" and a fix you can act on.
  console.log("Payment did not settle.");
  const required = res.headers.get("payment-required");
  if (required) {
    let reason;
    try {
      reason = JSON.parse(Buffer.from(required, "base64").toString("utf8")).error;
    } catch {
      /* header wasn't valid base64 JSON; leave `reason` undefined */
    }
    if (reason) console.log("Facilitator reason:", reason);
    if (reason === "invalid_exact_evm_insufficient_balance") {
      console.log(
        `Hint: ${account.address} needs at least the scan price in USDC on Base ` +
          `(asset 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, network ${X402_NETWORK}). ` +
          `USDC on any other chain cannot pay this route.`
      );
    }
  } else {
    console.log("(No PAYMENT-REQUIRED header either — payment may not have been required at all.)");
  }
}

console.log("Body:", await res.json());
