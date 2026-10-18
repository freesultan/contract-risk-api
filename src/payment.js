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
// Offer/receipt signing (Day 3): every 402 carries a signed offer committing
// to the payment terms, and every 200 carries a signed receipt confirming
// delivery. Signed with a DEDICATED key, separate from the payment wallet.
// The spec is explicit that signing and payment receipt should be different
// keys — "separating signing from payment receipt limits exposure if the
// signing key is compromised."
//
// Disabled by default (ENABLE_PAYMENTS unset/false): every request is served
// free, but still logged, so early usage evidence isn't lost while this is
// off for local testing.

import { logUsage } from "./logger.js";
import { privateKeyToAccount } from "viem/accounts";

const ENABLED = String(process.env.ENABLE_PAYMENTS).toLowerCase() === "true";
const NETWORK = process.env.X402_NETWORK || "eip155:8453"; // Base mainnet

// ---------------------------------------------------------------------------
// Paths — the single source of truth, shared by app.js (route registration),
// discovery.js (manifest + llms.txt + openapi.json) and the middleware below.
// ---------------------------------------------------------------------------

// Only /v1/scan is registered. The original unversioned /scan was a legacy
// alias added because PayAI's catalog keys rows by URL and never re-reads
// metadata for an existing row — so /v1/scan earned a fresh row carrying
// serviceName/tags. That purpose is served; /scan was removed to reduce the
// x402scan probe surface (it rejects registrations advertising unnecessary
// routes) and the drift risk of two paths that must stay in sync.
//
// If a real client is later found still calling /scan, add a 410 Gone handler
// in app.js rather than a redirect: a 301/302 on a POST with a body and
// PAYMENT-SIGNATURE header is unreliable across HTTP clients.
export const SCAN_PATHS = ["/v1/scan"];
export const ALERT_PATHS = ["/v1/alert-check"];
export const FULLCHECK_PATHS = ["/v1/full-check"];

export const CANONICAL_SCAN_PATH = SCAN_PATHS[SCAN_PATHS.length - 1];
export const CANONICAL_ALERT_PATH = ALERT_PATHS[ALERT_PATHS.length - 1];
export const CANONICAL_FULLCHECK_PATH = FULLCHECK_PATHS[FULLCHECK_PATHS.length - 1];

// ---------------------------------------------------------------------------
// Per-route terms
// ---------------------------------------------------------------------------

// ---- Scan ----
const SCAN_DESCRIPTION =
  "On-chain contract risk score: detects upgradeable proxies and privileged functions from live bytecode. Use before trading/interacting with an unfamiliar contract.";

const SCAN_INPUT_SCHEMA = {
  properties: {
    address: { type: "string", description: "0x-prefixed EVM contract address to scan" },
    chain: { type: "string", enum: ["base", "ethereum"], description: "Chain to query (default: base)" },
  },
  required: ["address"],
};

const SCAN_EXAMPLE_INPUT = { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" };
const SCAN_EXAMPLE_OUTPUT = { ...SCAN_EXAMPLE_INPUT, riskLevel: "low", riskScore: 0 };
const SCAN_SERVICE_NAME = "Contract Risk API";
const SCAN_TAGS = ["security", "risk-analysis", "smart-contracts", "evm", "defi"];

// ---- Alert-channel monitor ----
const ALERT_DESCRIPTION =
  "Telegram alert-channel monitoring for a contract address or ticker: returns mention volume across tracked crypto channels, categorized into security alerts, whale movements, and listing/news. Use alongside an on-chain risk scan — a contract with a high risk score that is also being flagged by a security channel is a materially different signal.";

const ALERT_INPUT_SCHEMA = {
  properties: {
    address: { type: "string", description: "Contract address or search term (e.g. a ticker like USDC)" },
    chain: { type: "string", enum: ["base", "ethereum"], description: "Chain hint (default: base)" },
  },
  required: ["address"],
};

const ALERT_EXAMPLE_INPUT = { address: "USDC", chain: "base" };
const ALERT_EXAMPLE_OUTPUT = {
  query: "USDC",
  chain: "base",
  alertMentions: 14,
  categories: { securityAlert: 0, whaleMovement: 14, listing: 0, other: 0 },
  channels: ["whale_alert", "whale_alert_io"],
  lastCheckedAt: "2026-10-14T12:19:44.073Z",
};
const ALERT_SERVICE_NAME = "Alert-Channel Monitor";
const ALERT_TAGS = [
  "security", "risk-analysis", "smart-contracts", "defi","telegram"
];

// ---- Full check (both) ----
const FULLCHECK_DESCRIPTION =
  "Combined pre-trade safety check: on-chain risk score (proxy + privileged-function detection from live bytecode) plus Telegram alert-channel monitoring, in one call. Cheaper than calling /v1/scan and /v1/alert-check separately ($0.04 vs $0.05), and the two signals are worth more together — a contract with privileged functions that is also being flagged in a security channel is a different situation than either signal alone.";

const FULLCHECK_INPUT_SCHEMA = SCAN_INPUT_SCHEMA;
const FULLCHECK_EXAMPLE_INPUT = { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", chain: "base" };
const FULLCHECK_EXAMPLE_OUTPUT = {
  address: FULLCHECK_EXAMPLE_INPUT.address,
  chain: "base",
  risk: {
    isContract: true, isProxy: true,
    flags: [{ label: "upgradeable proxy (EIP-1967) — logic can be swapped by admin", weight: 10 }],
    riskScore: 10, riskLevel: "medium",
  },
  alerts: {
    alertMentions: 0,
    categories: { securityAlert: 0, whaleMovement: 0, listing: 0, other: 0 },
    channels: [],
    note: "No mentions in the current rolling window (last 30 messages per tracked channel). Absence of alerts is not a safety guarantee.",
  },
};
const FULLCHECK_SERVICE_NAME = "Contract Pre-Trade Check";
const FULLCHECK_TAGS = [
  "security", "risk-analysis", "smart-contracts","pre-trade", "agent-safety"
];

// ---------------------------------------------------------------------------
// Public term builders (used by discovery.js and app.js)
// ---------------------------------------------------------------------------

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

export function getAlertTerms() {
  return {
    price: process.env.PRICE_PER_ALERT || "$0.03",
    network: NETWORK,
    payTo: process.env.EVM_ADDRESS || null,
    description: ALERT_DESCRIPTION,
    serviceName: ALERT_SERVICE_NAME,
    tags: ALERT_TAGS,
    inputSchema: ALERT_INPUT_SCHEMA,
    exampleInput: ALERT_EXAMPLE_INPUT,
    exampleOutput: ALERT_EXAMPLE_OUTPUT,
  };
}

export function getFullCheckTerms() {
  return {
    price: process.env.PRICE_PER_FULLCHECK || "$0.04",
    network: NETWORK,
    payTo: process.env.EVM_ADDRESS || null,
    description: FULLCHECK_DESCRIPTION,
    serviceName: FULLCHECK_SERVICE_NAME,
    tags: FULLCHECK_TAGS,
    inputSchema: FULLCHECK_INPUT_SCHEMA,
    exampleInput: FULLCHECK_EXAMPLE_INPUT,
    exampleOutput: FULLCHECK_EXAMPLE_OUTPUT,
  };
}

// ---------------------------------------------------------------------------
// Signing identity (offer/receipt)
// ---------------------------------------------------------------------------

/**
 * Resolve the dedicated offer/receipt signing identity.
 *
 * Returns null when SIGNING_PRIVATE_KEY is unset, so discovery surfaces can
 * render in free-test mode without a key present. Throws if the key is present
 * but malformed — a silently-unsigned deployment is worse than a loud failure.
 *
 * kid is a did:pkh, which is self-resolving: the address IS the identifier, so
 * a client can recover the signer from a signature and compare addresses with
 * no did.json to fetch and no shared secret. The chain reference here is the
 * settlement network (Base, 8453); address recovery is chain-agnostic, so a
 * verifier working from eip155:1 recovers the same address.
 */
export function getSigningInfo() {
  const key = process.env.SIGNING_PRIVATE_KEY;
  if (!key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "SIGNING_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key. " +
        "Generate one with: node -e \"console.log(require('ethers').Wallet.createRandom().privateKey)\""
    );
  }
  const account = privateKeyToAccount(key);
  const chainRef = NETWORK.split(":")[1] || "8453";
  return {
    kid: `did:pkh:eip155:${chainRef}:${account.address}#key-1`,
    address: account.address,
    format: "eip712",
  };
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

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
 * This also matters for offer/receipt: the middleware wrapper below awaits
 * ensureInitialized() BEFORE handing the request to the gate, so extension
 * hooks are registered by the time the 402 is generated on a cold instance.
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
        () => { done = true; pending = null; },
        (err) => { pending = null; throw err; }
      );
    }
    await pending;
  };
}

export async function buildPaymentMiddleware() {
  if (!ENABLED) {
    return { enabled: false, middleware: (req, res, next) => next() };
  }

  const scanTerms = getScanTerms();
  const alertTerms = getAlertTerms();
  const fullTerms = getFullCheckTerms();
  if (!scanTerms.payTo) {
    throw new Error("ENABLE_PAYMENTS=true requires EVM_ADDRESS to be set.");
  }

  const signing = getSigningInfo();
  if (!signing) {
    throw new Error(
      "ENABLE_PAYMENTS=true requires SIGNING_PRIVATE_KEY (dedicated receipt-signing key, not the payment wallet)."
    );
  }

  const { paymentMiddleware, x402ResourceServer } = await import("@x402/express");
  const { ExactEvmScheme } = await import("@x402/evm/exact/server");
  const { HTTPFacilitatorClient } = await import("@x402/core/server");
  const { facilitator } = await import("@payai/facilitator");
  const { declareDiscoveryExtension } = await import("@x402/extensions/bazaar");
  const {
    createOfferReceiptExtension,
    createEIP712OfferReceiptIssuer,
    declareOfferReceiptExtension,
  } = await import("@x402/extensions/offer-receipt");

  // EIP-712 issuer: signs with the dedicated key, identified by did:pkh.
  const signingAccount = privateKeyToAccount(process.env.SIGNING_PRIVATE_KEY);
  const offerReceiptIssuer = createEIP712OfferReceiptIssuer(
    signing.kid,
    signingAccount.signTypedData.bind(signingAccount)
  );

  const facilitatorClient = new HTTPFacilitatorClient(facilitator);
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(NETWORK, new ExactEvmScheme())
    .registerExtension(createOfferReceiptExtension(offerReceiptIssuer));

  // One route config builder, three callers. The unpaidResponseBody / accepts
  // shape is identical across routes — only the price, description and
  // discovery metadata differ.
  const makeConfig = (terms) => ({
    accepts: [{ scheme: "exact", price: terms.price, network: terms.network, payTo: terms.payTo }],
    description: terms.description,
    serviceName: terms.serviceName,
    tags: terms.tags,
    extensions: {
      // Bazaar discovery metadata: drives PayAI's catalog listing.
      ...declareDiscoveryExtension({
        bodyType: "json",
        input: terms.exampleInput,
        inputSchema: terms.inputSchema,
        output: { example: terms.exampleOutput },
      }),
      // Signed offer (on 402) + signed receipt (on 200).
      // `includeTxHash` is NOT passed: the receipt schema marks `transaction`
      // as optional, and this extension leaves it empty — the settlement hash
      // lives at the TOP LEVEL of PAYMENT-RESPONSE (standard x402 envelope),
      // not inside the signed receipt. That separation is deliberate and
      // stronger: the receipt attests to who said this / for whom / when, and
      // the chain attests to settlement.
      ...declareOfferReceiptExtension({
        offerValiditySeconds: 300,
      }),
    },
    // Echo the terms in the 402 body as well as the PAYMENT-REQUIRED header.
    // The header is canonical, but a cross-origin browser client can only read
    // it when CORS exposes it, and the body always survives — PayAI's own
    // reference merchant does the same.
    unpaidResponseBody: () => ({
      contentType: "application/json",
      body: {
        x402Version: 2,
        error: "PAYMENT-SIGNATURE header is required",
        accepts: [{
          scheme: "exact",
          network: terms.network,
          payTo: terms.payTo,
          price: terms.price,
          description: terms.description,
        }],
      },
    }),
  });

  const scanConfig = makeConfig(scanTerms);
  const alertConfig = makeConfig(alertTerms);
  const fullConfig = makeConfig(fullTerms);

  const routes = {
    ...Object.fromEntries(SCAN_PATHS.map((p) => [`POST ${p}`, scanConfig])),
    ...Object.fromEntries(ALERT_PATHS.map((p) => [`POST ${p}`, alertConfig])),
    ...Object.fromEntries(FULLCHECK_PATHS.map((p) => [`POST ${p}`, fullConfig])),
  };

  // Trailing `false` disables the module-load initialize() — see
  // createInitializer above for why that eager call is unsafe on serverless.
  // With it off, the middleware never initializes on its own, so we own that.
  const gate = paymentMiddleware(routes, resourceServer, undefined, undefined, false);
  const ensureInitialized = createInitializer(resourceServer);
  const paidPaths = new Set([...SCAN_PATHS, ...ALERT_PATHS, ...FULLCHECK_PATHS]);

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