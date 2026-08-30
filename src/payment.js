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

export async function buildPaymentMiddleware() {
  if (!ENABLED) {
    return {
      enabled: false,
      middleware: (req, res, next) => next(),
    };
  }

  const payTo = process.env.EVM_ADDRESS;
  const price = process.env.PRICE_PER_SCAN || "$0.02";

  if (!payTo) {
    throw new Error("ENABLE_PAYMENTS=true requires EVM_ADDRESS to be set.");
  }

  const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
  const { ExactEvmScheme } = await import("@x402/evm/exact/server");
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const { facilitator } = await import("@payai/facilitator");

  const facilitatorClient = new HTTPFacilitatorClient(facilitator);
  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    NETWORK,
    new ExactEvmScheme()
  );

  const routes = {
    "POST /scan": {
      accepts: [{ scheme: "exact", price, network: NETWORK, payTo }],
      description: "On-chain contract risk score",
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
