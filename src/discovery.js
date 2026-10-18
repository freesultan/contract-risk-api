// Static discovery surfaces for LLM/agent crawlers that don't talk to a
// facilitator's Bazaar API directly: a machine-readable manifest at the
// conventional .well-known/x402 path, and a plain-text summary at llms.txt
// (the format popular x402 catalogs like x402.openwebninja.com use). Both
// are generated from the same terms as the live payment routes
// (payment.js's get*Terms()), so they can't drift out of sync.

import {
  ENABLED,
  getScanTerms,
  getAlertTerms,
  getFullCheckTerms,
  getSigningInfo,
  SCAN_PATHS,
  ALERT_PATHS,
  FULLCHECK_PATHS,
  CANONICAL_SCAN_PATH,
} from "./payment.js";
import { RISK_THRESHOLDS, PROXY_WEIGHT } from "./heuristics.js";
import { FLAGGED_SELECTORS } from "./selectors.js";

// All paid routes, in the order they should appear in listings. Grouped so
// both discovery surfaces (manifest + llms.txt) iterate the same shape.
function allRoutes() {
  return [
    { paths: SCAN_PATHS, terms: getScanTerms() },
    { paths: ALERT_PATHS, terms: getAlertTerms() },
    { paths: FULLCHECK_PATHS, terms: getFullCheckTerms() },
  ];
}

// Signing identity is optional (absent in free-test mode), but a throw here
// would take down the manifest for a malformed key — better to surface it as
// "not configured" than to 500 the discovery surface agents depend on.
function safeSigningInfo() {
  try {
    return getSigningInfo();
  } catch {
    return null;
  }
}

export function buildX402Manifest(baseUrl) {
  const resources = [];
  for (const { paths, terms } of allRoutes()) {
    for (const path of paths) {
      resources.push({
        resource: `${baseUrl}${path}`,
        type: "http",
        method: "POST",
        description: terms.description,
        serviceName: terms.serviceName,
        tags: terms.tags,
        accepts: [{
          scheme: "exact",
          network: terms.network,
          payTo: terms.payTo,
          price: terms.price,
        }],
        input: { type: "http", bodyType: "json", body: terms.exampleInput },
        inputSchema: terms.inputSchema,
        output: { type: "json", example: terms.exampleOutput },
      });
    }
  }

  const signing = safeSigningInfo();
  const manifest = {
    x402Version: 2,
    resources,
    canonical: `${baseUrl}${CANONICAL_SCAN_PATH}`,
    discovery: { llmsTxt: `${baseUrl}/llms.txt` },
    x402: {
      enabled: ENABLED,
      mode: ENABLED ? "paid" : "free-test",
      // Advertise the extension so a crawler knows to look for it before
      // paying. Absent in free-test mode, where nothing is signed.
      extensions: signing ? ["offer-receipt"] : [],
    },
  };

  // Published signing identity. A client verifies a receipt by recovering the
  // signer from its EIP-712 signature and comparing against this address —
  // no shared secret, no document to fetch, nothing mutable in the trust path.
  if (signing) {
    manifest.signing = {
      format: signing.format,
      kid: signing.kid,
      address: signing.address,
    };
  }

  return manifest;
}

export function buildLlmsTxt(baseUrl) {
  const scan = getScanTerms();
  const alert = getAlertTerms();
  const full = getFullCheckTerms();
  const signing = safeSigningInfo();

  const payTo = scan.payTo; // same wallet for all three
  const payToLine = payTo ? `, payTo ${payTo}` : " (payTo not yet configured)";

  const signingSection = signing
  ? `## Verifying a paid response

Every 402 response carries a signed **offer** in
extensions["offer-receipt"].info.offers — one per accepted payment option,
each committing to resourceUrl, scheme, network, asset, payTo, amount and
validUntil, signed with EIP-712.

Every 200 response carries:

1. A signed **receipt** in extensions["offer-receipt"].info.receipt — an
   EIP-712 signature over { version, network, resourceUrl, payer, issuedAt }.
   This proves which service produced the response, for which payer, at
   what time.
2. The **settlement transaction hash** at the TOP LEVEL of the same header
   (fields: success, payer, transaction, network). This is the standard
   x402 envelope, separate from the signed receipt.

To verify end-to-end:

a. Base64-decode the PAYMENT-RESPONSE header.
b. Recover the EIP-712 signer from extensions["offer-receipt"].info.receipt
   and compare to ${baseUrl}/.well-known/x402 -> signing.address
   (currently ${signing.address}).
c. Confirm the top-level "transaction" field exists on-chain (basescan),
   from "payer" to the offer's payTo, in the offered amount.

What this proves: the response was produced by this service, for this payer,
at the stated time; and that settlement for that payer occurred on-chain at
the stated transaction hash. What it does NOT prove: that the underlying
on-chain or Telegram data is correct. A signature answers "who said this,
and when" — not "is it true". Treat it as a resolvable audit trail, not a
safety score.

`
  : `## Signed offers & receipts
Not active in free-test mode. Once ENABLE_PAYMENTS=true, every 402 carries a
signed offer and every 200 a signed receipt (EIP-712), plus the settlement
transaction hash in the same PAYMENT-RESPONSE envelope. Verify the signer
against the address published at ${baseUrl}/.well-known/x402.

`;

  return `# ${scan.serviceName} (and companion routes)

Pre-trade safety checks for smart contracts and tokens. Three POST routes, all
x402 "exact" scheme, USDC on ${scan.network}${payToLine}.

Mode: ${ENABLED ? "paid" : "free-test (payments not yet enabled)"}

## POST ${baseUrl}${CANONICAL_SCAN_PATH} — risk score — ${scan.price}
${scan.description}

Request body (application/json): { "address": "0x...", "chain": "base" | "ethereum" }
Example request: ${JSON.stringify(scan.exampleInput)}
Example response: ${JSON.stringify(scan.exampleOutput)}
Also served at: ${SCAN_PATHS.filter((p) => p !== CANONICAL_SCAN_PATH).map((p) => baseUrl + p).join(", ") || "(none)"}

How to read riskScore: the sum of the weights of every risk signal found in
the contract's live bytecode and its EIP-1967 proxy slot. riskLevel bands it:
low ${0}-${RISK_THRESHOLDS.medium - 1}, medium ${RISK_THRESHOLDS.medium}-${RISK_THRESHOLDS.high - 1}, high ${RISK_THRESHOLDS.high}+, and "unknown" when the
address holds no code. Max score ${PROXY_WEIGHT + FLAGGED_SELECTORS.reduce((n, f) => n + f.weight, 0)}.
Weights: upgradeable proxy +${PROXY_WEIGHT}${FLAGGED_SELECTORS.filter((f) => f.weight > 0)
    .map((f) => `, ${f.sig} +${f.weight}`)
    .join("")}.
A high score is not proof of malice and a low score is not a guarantee — it
measures how much power the owner holds, not their intent. Detection is a
bytecode heuristic and only reads the EIP-1967 proxy slot, so it can
under-report on optimised bytecode and on older proxy layouts.

## POST ${baseUrl}${ALERT_PATHS[0]} — Telegram alert-channel monitor — ${alert.price}
${alert.description}

Request body (application/json): { "address": "0x... or a ticker like USDC", "chain": "base" | "ethereum" }
Example request: ${JSON.stringify(alert.exampleInput)}
Example response: ${JSON.stringify(alert.exampleOutput)}

How to read alertMentions: it counts appearances in the *current rolling
window* — the last 30 messages per tracked channel, cached for up to 15
minutes. securityAlert=0 means "no security-channel mentions in the current
window", NOT "never flagged." Absence of alerts is not a safety guarantee.
Categories: securityAlert, whaleMovement, listing, other. lastCheckedAt
reports the scan timestamp, so a caller can reason about freshness.

## POST ${baseUrl}${FULLCHECK_PATHS[0]} — combined pre-trade check — ${full.price}
${full.description}

Request body (application/json): { "address": "0x...", "chain": "base" | "ethereum" }
Example request: ${JSON.stringify(full.exampleInput)}
Example response: ${JSON.stringify(full.exampleOutput)}

Returns { address, chain, risk: <scan response>, alerts: <alert-check response> }
in one call. $0.04 vs $0.05 for the two routes separately.

${signingSection}## GET ${baseUrl}/app
Browser UI: connect an EVM wallet, pay with USDC on Base, read the scan.
${baseUrl}/ redirects here.

## GET ${baseUrl}/health
Free liveness check, no payment required.

## Machine-readable manifest
${baseUrl}/.well-known/x402
`;
}