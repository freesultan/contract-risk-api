import "dotenv/config";
import express from "express";
import { fetchOnChainData, DEFAULT_RPC_URLS } from "./chain.js";
import { analyzeBytecode } from "./heuristics.js";
import { logUsage } from "./logger.js";
import {
  buildPaymentMiddleware,
  logRequestMode,
  SCAN_PATHS,
  ALERT_PATHS,
  FULLCHECK_PATHS,
} from "./payment.js";
import { buildX402Manifest, buildLlmsTxt } from "./discovery.js";
import { buildUiHtml } from "./ui.js";
import { searchChannels } from "./telegram.js";
import { summarize } from "./categorize.js";
import { TRACKED_CHANNELS } from "./channels.js";

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

// Browser UI, so a human can pay for and read a scan without any tooling;
// agents keep using the JSON route directly.
// An unhandled throw here becomes an opaque Vercel FUNCTION_INVOCATION_FAILED
// with no message and no stack, so catch and report instead.
function serveUi(req, res) {
  try {
    res.type("html").send(buildUiHtml());
  } catch (err) {
    res
      .status(500)
      .type("text/plain")
      .send(`UI render failed: ${err && err.stack ? err.stack : err}`);
  }
}

// `/app` is the canonical UI path. `GET /` returned FUNCTION_INVOCATION_FAILED
// on Vercel while `/app` — the same page from this same handler — worked, which
// isolated the fault to the platform's root-path routing rather than this code
// (it serves `/` fine locally under Node 18 and 22, via src/server.js and via
// api/index.js invoked the way Vercel invokes it). vercel.json now redirects
// `/` to `/app`, so the root never reaches the function in production; the
// route below still answers `/` for local runs and any other host.
app.get("/", serveUi);
app.get("/app", serveUi);

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

// ---------------------------------------------------------------------------
// Paid routes
// ---------------------------------------------------------------------------

app.post(SCAN_PATHS, async (req, res) => {
  const { address, chain = "base" } = req.body || {};
  const startedAt = Date.now();

  if (!address) {
    return res.status(400).json({ error: "Missing required field: address" });
  }

  try {
    const { bytecode, implementationSlotValue } = await fetchOnChainData(address, chain);
    const result = analyzeBytecode({ bytecode, implementationSlotValue });

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

app.post(ALERT_PATHS, async (req, res) => {
  const { address, chain = "base" } = req.body || {};
  const startedAt = Date.now();

  if (!address) {
    return res.status(400).json({ error: "Missing required field: address" });
  }

  try {
    const hits = await searchChannels(address, TRACKED_CHANNELS);
    const result = summarize(hits);

    logUsage({
      route: req.path,
      address,
      chain,
      paymentMode: res.locals.paymentMode,
      alertMentions: result.alertMentions,
      latencyMs: Date.now() - startedAt,
    });

    res.json({ query: address, chain, ...result });
  } catch (err) {
    logUsage({
      route: req.path,
      address,
      chain,
      paymentMode: res.locals.paymentMode,
      error: err.message,
      latencyMs: Date.now() - startedAt,
    });
    res.status(500).json({ error: err.message });
  }
});

app.post(FULLCHECK_PATHS, async (req, res) => {
  const { address, chain = "base" } = req.body || {};
  const startedAt = Date.now();

  if (!address) {
    return res.status(400).json({ error: "Missing required field: address" });
  }

  try {
    // Both branches are independent, so run them together. The alert branch
    // never rejects on a per-channel failure (searchChannels catches and
    // skips channels), so a partial scrape still yields a usable response.
    const [onChain, hits] = await Promise.all([
      fetchOnChainData(address, chain),
      searchChannels(address, TRACKED_CHANNELS),
    ]);

    const risk = analyzeBytecode(onChain);
    const alerts = summarize(hits);

    logUsage({
      route: req.path,
      address,
      chain,
      paymentMode: res.locals.paymentMode,
      riskLevel: risk.riskLevel,
      riskScore: risk.riskScore,
      alertMentions: alerts.alertMentions,
      latencyMs: Date.now() - startedAt,
    });

    res.json({ address, chain, risk, alerts });
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