// Nevermined x402 payment gating — chosen instead of Coinbase's facilitator
// per instruction. Nevermined is NOT a drop-in "swap the facilitator URL"
// like generic x402: it's its own SDK with a plans/credits model, requiring
// a Nevermined account + a payment plan created in their dashboard.
//
// Disabled by default (ENABLE_PAYMENTS unset/false): every request is served
// free, but still logged, so early usage evidence isn't lost while account
// setup (an approval-gated step: signup, wallet, payment plan) is pending.
//
// Known dependency risk (documented, assessed low for our usage): the
// installed @nevermined-io/payments bundles its own nested express@4.21.2
// with a high-severity path-to-regexp ReDoS (GHSA-37ch-88jc-xwx2). That
// nested express only backs Nevermined's MCP-server module (dist/mcp/http/*),
// which this project never starts — we only import the ./express subpath
// (dist/x402/express/*), which does not use the vulnerable code path. Re-run
// `npm audit` before going to production in case a patched release exists.

import { logUsage } from "./logger.js";

const ENABLED = String(process.env.ENABLE_PAYMENTS).toLowerCase() === "true";

export async function buildPaymentMiddleware() {
  if (!ENABLED) {
    return {
      enabled: false,
      middleware: (req, res, next) => next(),
    };
  }

  const nvmApiKey = process.env.NVM_API_KEY;
  const planId = process.env.NVM_PLAN_ID;
  const credits = Number(process.env.CREDITS_PER_SCAN || 1);

  if (!nvmApiKey || !planId) {
    throw new Error(
      "ENABLE_PAYMENTS=true requires NVM_API_KEY and NVM_PLAN_ID to be set."
    );
  }

  const { Payments } = await import("@nevermined-io/payments");
  const { paymentMiddleware } = await import("@nevermined-io/payments/express");

  const payments = Payments.getInstance({ nvmApiKey });

  const routes = {
    "POST /scan": { planId, credits },
  };

  return {
    enabled: true,
    middleware: paymentMiddleware(payments, routes),
  };
}

export function logRequestMode(req, res, next) {
  res.locals.paymentMode = ENABLED ? "paid" : "free-test";
  next();
}

export { ENABLED };
