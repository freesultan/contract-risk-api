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

// Service-level metadata for the Bazaar catalog. These are `RouteConfig`
// fields (not part of the discovery extension), and without them the catalog
// entry carries `serviceName: null` / `tags: null` — which is what agents and
// LLMs filter and rank on when choosing between ~28k listed resources.
const SCAN_SERVICE_NAME = "Contract Risk API";

// Paths the scan route is served at. The catalog keys rows by resource URL and
// never re-reads metadata for a row it already has, so the versioned alias is
// how a listing with serviceName/tags gets created (see README). Order matters:
// the first entry is the original, still-indexed URL; the last is canonical for
// new discovery surfaces.
export const SCAN_PATHS = ["/scan", "/v1/scan"];
export const CANONICAL_SCAN_PATH = SCAN_PATHS[SCAN_PATHS.length - 1];

const SCAN_TAGS = [
  "security",
  "risk-analysis",
  "smart-contracts",
  "evm",
  "base",
  "ethereum",
  "defi",
  "trading",
];

/**
 * Lazily initializes the resource server, retrying on failure.
 *
 * `paymentMiddleware` otherwise fires `initialize()` at module load and
 * memoizes the promise. On a serverless host that is a trap: the instance is
 * frozen between invocations, so a fetch started during module load can be
 * suspended while its 30s abort timer keeps running in wall-clock time. It
 * rejects unseen, and the next request to that instance gets the already-
 * rejected promise back — which is why the failure returns
 * "timed out after 30000ms" in under a second, a timing that is impossible for
 * a real timeout.
 *
 * Initializing inside a request instead means the fetch runs while the
 * instance is actually awake, and a failure is retried rather than cached.
 *
 * Exported for tests.
 *
 * @param {{initialize: () => Promise<unknown>}} server - resource server to initialize
 * @returns {() => Promise<void>} idempotent initializer that retries after a failure
 */
export function createInitializer(server) {
  let pending = null;
  let done = false;
  return async function ensureInitialized() {
    if (done) return;
    if (!pending) {
      // Drop the promise on rejection so the next call retries rather than
      // handing back the same failure forever.
      pending = server.initialize().then(
        () => {
          done = true;
          pending = null;
        },
        (err) => {
          pending = null;
          throw err;
        }
      );
    }
    await pending;
  };
}

export function getScanTerms() {
  return {
    price: process.env.PRICE_PER_SCAN || "$0.02",
    network: NETWORK,
    payTo: process.env.EVM_ADDRESS || null,
    description: SCAN_DESCRIPTION,
    serviceName: SCAN_SERVICE_NAME,
    tags: SCAN_TAGS,
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

  const routeConfig = {
    accepts: [
      { scheme: "exact", price: terms.price, network: terms.network, payTo: terms.payTo },
    ],
    description: terms.description,
    serviceName: terms.serviceName,
    tags: terms.tags,
    // Bazaar discovery metadata: `@x402/express` auto-registers this with the
    // facilitator's resource server, and PayAI indexes it at
    // GET /discovery/resources after the route's first real settled payment.
    extensions: declareDiscoveryExtension({
      bodyType: "json",
      input: terms.exampleInput,
      inputSchema: terms.inputSchema,
      output: { example: terms.exampleOutput },
    }),
    // Echo the terms in the 402 body as well as the PAYMENT-REQUIRED header.
    // The header is canonical, but a cross-origin browser client can only read
    // it when CORS exposes it, and the body always survives — PayAI's own
    // reference merchant does the same.
    unpaidResponseBody: () => ({
      contentType: "application/json",
      body: {
        x402Version: 2,
        error: "PAYMENT-SIGNATURE header is required",
        accepts: [
          {
            scheme: "exact",
            network: terms.network,
            payTo: terms.payTo,
            price: terms.price,
            description: terms.description,
          },
        ],
      },
    }),
  };

  // Both paths serve the same route. SCAN_PATHS[0] stays for the agents and
  // catalog entry that already know it; the versioned alias is a distinct
  // resource URL, which is what earns a fresh Bazaar row (see README).
  const routes = Object.fromEntries(
    SCAN_PATHS.map((p) => [`POST ${p}`, routeConfig])
  );

  // The trailing `false` disables the module-load `initialize()` — see
  // createInitializer above for why that eager call is unsafe on serverless.
  // With it off, the middleware never initializes on its own, so we own that.
  const gate = paymentMiddleware(routes, resourceServer, undefined, undefined, false);
  const ensureInitialized = createInitializer(resourceServer);
  const paidPaths = new Set(SCAN_PATHS);

  return {
    enabled: true,
    middleware: async (req, res, next) => {
      // Only paid routes need the facilitator, so the UI and /health never pay
      // for a round trip to it.
      if (req.method !== "POST" || !paidPaths.has(req.path)) return next();

      try {
        await ensureInitialized();
      } catch (first) {
        try {
          // A cold instance's first attempt can fail on a transient network
          // hiccup; one immediate retry is enough to cover it.
          await ensureInitialized();
        } catch (second) {
          console.error("Facilitator initialization failed twice:", second);
          return res.status(503).json({
            error: "Payment facilitator unavailable, please retry",
            detail: second && second.message ? second.message : String(second),
          });
        }
      }
      return gate(req, res, next);
    },
  };
}

export function logRequestMode(req, res, next) {
  res.locals.paymentMode = ENABLED ? "paid" : "free-test";
  next();
}

export { ENABLED };
