import "dotenv/config";
import express from "express";
import { fetchOnChainData, DEFAULT_RPC_URLS } from "./chain.js";
import { analyzeBytecode } from "./heuristics.js";
import { logUsage } from "./logger.js";
import { buildPaymentMiddleware, logRequestMode, SCAN_PATHS } from "./payment.js";
import { buildX402Manifest, buildLlmsTxt } from "./discovery.js";
import { buildUiHtml } from "./ui.js";

const app = express();
// Vercel terminates TLS upstream and forwards over plain HTTP with
// X-Forwarded-Proto: https — without trusting that header, req.protocol
// (used to build the /.well-known/x402 and /llms.txt resource URLs) reports
// "http", handing agents a URL that isn't actually the site's real address.
app.set("trust proxy", true);
app.use(express.json());

// x402 is designed to be paid from anywhere, including a browser page hosted on
// someone else's origin. That only works if the payment headers cross origins:
// the client must be allowed to SEND PAYMENT-SIGNATURE, and must be able to
// READ PAYMENT-REQUIRED/PAYMENT-RESPONSE (non-safelisted response headers are
// hidden from JS unless explicitly exposed).
app.use((req, res, next) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, PAYMENT-SIGNATURE, X-PAYMENT",
    "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE",
    "Access-Control-Max-Age": "600",
  });
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(logRequestMode);

const { enabled: paymentEnabled, middleware: paymentMiddleware } = await buildPaymentMiddleware();
app.use(paymentMiddleware);

// Browser UI. Served at / so a human can pay for and read a scan without any
// tooling; agents keep using the JSON route directly.
app.get("/", (req, res) => {
  // An unhandled throw here becomes an opaque Vercel FUNCTION_INVOCATION_FAILED
  // with no message and no stack in the response, which is unactionable. Catch
  // it and return the actual error so a failure is diagnosable from a curl.
  try {
    res.type("html").send(buildUiHtml());
  } catch (err) {
    res
      .status(500)
      .type("text/plain")
      .send(`UI render failed: ${err && err.stack ? err.stack : err}`);
  }
});

app.get("/health", (req, res) => {
  res.json({ ok: true, paymentEnabled, supportedChains: Object.keys(DEFAULT_RPC_URLS) });
});

app.get("/.well-known/x402", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json(buildX402Manifest(baseUrl));
});

app.get("/llms.txt", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.type("text/plain").send(buildLlmsTxt(baseUrl));
});

app.post(SCAN_PATHS, async (req, res) => {
  const { address, chain = "base" } = req.body || {};
  const startedAt = Date.now();

  if (!address) {
    return res.status(400).json({ error: "Missing required field: address" });
  }

  try {
    const { bytecode, implementationSlotValue } = await fetchOnChainData(address, chain);
    const result = analyzeBytecode({ bytecode, implementationSlotValue });

    // Best-effort local log (not durable on serverless — the facilitator and
    // the chain are the authoritative record of paid usage).
    logUsage({
      route: req.path,
      address,
      chain,
      paymentMode: res.locals.paymentMode,
      riskLevel: result.riskLevel,
      riskScore: result.riskScore,
      latencyMs: Date.now() - startedAt,
    });

    res.json({ address, chain, ...result });
  } catch (err) {
    logUsage({
      route: req.path,
      address,
      chain,
      paymentMode: res.locals.paymentMode,
      error: err.message,
      latencyMs: Date.now() - startedAt,
    });
    res.status(400).json({ error: err.message });
  }
});

// Last-resort error handler. Without it, anything thrown outside a route's own
// try/catch surfaces on Vercel as FUNCTION_INVOCATION_FAILED — a 500 with no
// message, no stack, and nothing in the response to act on.
// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return;
  res.status(500).json({
    error: err && err.message ? err.message : String(err),
    route: req.path,
  });
});

export { app, paymentEnabled };
