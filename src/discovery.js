// Static discovery surfaces for LLM/agent crawlers that don't talk to a
// facilitator's Bazaar API directly: a machine-readable manifest at the
// conventional .well-known/x402 path, and a plain-text summary at llms.txt
// (the format popular x402 catalogs like x402.openwebninja.com use). Both
// are generated from the same terms as the live payment route
// (src/payment.js's getScanTerms()), so they can't drift out of sync.

import { ENABLED, getScanTerms, SCAN_PATHS, CANONICAL_SCAN_PATH } from "./payment.js";

export function buildX402Manifest(baseUrl) {
  const terms = getScanTerms();

  return {
    x402Version: 2,
    // Every path the route answers on, so a crawler that finds either URL gets
    // the full terms. Canonical last-listed URL is also named below.
    resources: SCAN_PATHS.map((path) => ({
      resource: `${baseUrl}${path}`,
      type: "http",
      method: "POST",
      description: terms.description,
      serviceName: terms.serviceName,
      tags: terms.tags,
      accepts: [
        {
          scheme: "exact",
          network: terms.network,
          payTo: terms.payTo,
          price: terms.price,
        },
      ],
      input: {
        type: "http",
        bodyType: "json",
        body: terms.exampleInput,
      },
      inputSchema: terms.inputSchema,
      output: {
        type: "json",
        example: terms.exampleOutput,
      },
    })),
    canonical: `${baseUrl}${CANONICAL_SCAN_PATH}`,
    discovery: {
      llmsTxt: `${baseUrl}/llms.txt`,
    },
    x402: {
      // Reflects current live mode: while ENABLE_PAYMENTS is unset/false,
      // /scan is served free and this manifest describes the terms it will
      // charge once payments are turned on.
      enabled: ENABLED,
      mode: ENABLED ? "paid" : "free-test",
    },
  };
}

export function buildLlmsTxt(baseUrl) {
  const terms = getScanTerms();
  const payToLine = terms.payTo ? `, payTo ${terms.payTo}` : " (payTo not yet configured)";

  return `# ${terms.serviceName}

${terms.description}

Tags: ${terms.tags.join(", ")}

## POST ${baseUrl}${CANONICAL_SCAN_PATH}
Price: ${terms.price} via x402 "exact" scheme, network ${terms.network}${payToLine}.
Mode: ${ENABLED ? "paid" : "free-test (payments not yet enabled)"}
Request body (application/json): { "address": "0x...", "chain": "base" | "ethereum" }
Example request: ${JSON.stringify(terms.exampleInput)}
Example response: ${JSON.stringify(terms.exampleOutput)}
Also served at: ${SCAN_PATHS.map((p) => baseUrl + p).join(", ")} (identical terms)

## GET ${baseUrl}/
Browser UI: connect an EVM wallet, pay with USDC on Base, read the scan.

## GET ${baseUrl}/health
Free liveness check, no payment required.

## Machine-readable manifest
${baseUrl}/.well-known/x402
`;
}
