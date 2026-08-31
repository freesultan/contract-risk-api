// x402 payment gating via PayAI's facilitator (facilitator.payai.network) —
// chosen after both Coinbase (per instruction) and Nevermined (forces a
// mandatory Stripe Connect payout, which wasn't usable) were ruled out.
//
// This uses the standard/generic x402 "exact" scheme: settlement is
// peer-to-peer on-chain, straight to the EVM_ADDRESS wallet below. The
// facilitator only verifies signatures and broadcasts the transaction — it
// never custodies funds, so no Stripe/KYC/company account is needed to get
// paid. PayAI's free tier requires no signup at all (PAYAI_API_KEY_ID/SECRET
// are optional, only needed to raise rate limits later).
//
// Disabled by default (ENABLE_PAYMENTS unset/false): every request is served
// free, but still logged, so early usage evidence isn't lost while this is
// off for local testing.

import { logUsage } from "./logger.js";

const ENABLED = String(process.env.ENABLE_PAYMENTS).toLowerCase() === "true";
const NETWORK = process.env.X402_NETWORK || "eip155:8453"; // Base mainnet

// Single source of truth for /scan's terms, shared by the live x402 payment
// route (via declareDiscoveryExtension, once ENABLE_PAYMENTS=true) and the
// static /.well-known/x402 + /llms.txt discovery surfaces (src/discovery.js),
// so price/description/schema can't drift between the two.
const SCAN_DESCRIPTION =
  "On-chain contract risk score: detects upgradeable proxies and privileged functions from live bytecode. Use before trading/interacting with an unfamiliar contract.";

const SCAN_INPUT_SCHEMA = {
  properties: {
    address: {
      type: "string",
      description: "0x-prefixed EVM contract address to scan",
    },
    chain: {
      type: "string",
      enum: ["base", "ethereum"],
      description: "Chain to query (default: base)",
    },
  },
  required: ["address"],
};

const SCAN_EXAMPLE_INPUT = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  chain: "base",
};

const SCAN_EXAMPLE_OUTPUT = {
  ...SCAN_EXAMPLE_INPUT,
  riskLevel: "low",
  riskScore: 0,
};

export function getScanTerms() {
  return {
    price: process.env.PRICE_PER_SCAN || "$0.02",
    network: NETWORK,
    payTo: process.env.EVM_ADDRESS || null,
    description: SCAN_DESCRIPTION,
    inputSchema: SCAN_INPUT_SCHEMA,
    exampleInput: SCAN_EXAMPLE_INPUT,
    exampleOutput: SCAN_EXAMPLE_OUTPUT,
  };
}

export async function buildPaymentMiddleware() {
  if (!ENABLED) {
    return {
      enabled: false,
      middleware: (req, res, next) => next(),
    };
  }

  const terms = getScanTerms();
  if (!terms.payTo) {
    throw new Error("ENABLE_PAYMENTS=true requires EVM_ADDRESS to be set.");
  }

  const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
  const { ExactEvmScheme } = await import("@x402/evm/exact/server");
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const { facilitator } = await import("@payai/facilitator");
  const { declareDiscoveryExtension } = await import("@x402/extensions/bazaar");

  const facilitatorClient = new HTTPFacilitatorClient(facilitator);
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    NETWORK,
    new ExactEvmScheme()
  );

  const routes = {
    "POST /scan": {
      accepts: [
        { scheme: "exact", price: terms.price, network: terms.network, payTo: terms.payTo },
      ],
      description: terms.description,
      // Bazaar discovery metadata: `@x402/express` auto-registers this with the
      // facilitator's resource server, and PayAI indexes it at
      // GET /discovery/resources after the route's first real settled payment.
      extensions: declareDiscoveryExtension({
        bodyType: "json",
        input: terms.exampleInput,
        inputSchema: terms.inputSchema,
        output: { example: terms.exampleOutput },
      }),
    },
  };

  return {
    enabled: true,
    middleware: paymentMiddleware(routes, resourceServer),
  };
}

export function logRequestMode(req, res, next) {
  res.locals.paymentMode = ENABLED ? "paid" : "free-test";
  next();
}

export { ENABLED };
