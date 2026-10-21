import "dotenv/config";
import express from "express";
import favicon from "serve-favicon";
import path from "path";
import { waitUntil } from "@vercel/functions";
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
import { buildX402Manifest, buildLlmsTxt, buildOpenApiSpec } from "./discovery.js";
import { buildUiHtml } from "./ui.js";
import { searchChannels } from "./telegram.js";
import { summarize } from "./categorize.js";
import { TRACKED_CHANNELS } from "./channels.js";
import { notifyTelegram } from "./telegram-notify.js";

const app = express();

// Serve favicon first, so it doesn't get caught by other middleware
app.use(favicon(path.join(process.cwd(), "favicon.ico")));


// Vercel terminates TLS upstream and forwards over plain HTTP with
// X-Forwarded-Proto: https — without trusting that header, req.protocol
// (used to build the /.well-known/x402, /llms.txt and /openapi.json resource
// URLs) reports "http", handing agents a URL that isn't actually the site's
// real address.
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
// agents keep using the JSON routes directly.
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

// Canonical OpenAPI 3.1 spec for x402scan registration and any crawler that
// discovers services via /openapi.json. Only paid /v1/* routes appear in it —
// free routes are excluded because x402scan rejects specs that advertise
// non-paid paths.
app.get("/openapi.json", (req, res) => {
  const baseUrl = `${req.protocol}://${req.get("host")}`;
  res.json(buildOpenApiSpec(baseUrl));
});

// ---------------------------------------------------------------------------
// Background work
// ---------------------------------------------------------------------------

/**
 * Run a promise after the response has been sent, without blocking the client.
 *
 * On Vercel the function is frozen as soon as the response is returned, so a
 * bare `void promise` is killed mid-flight — which is why the Telegram
 * notification fired locally but arrived late or dropped in production.
 * waitUntil() extends the function's lifetime until the promise settles.
 *
 * Outside Vercel (local `npm start`), waitUntil is a no-op or its shim may be
 * inactive; the long-lived process won't freeze the promise, so the fallback
 * is simply to let it run.
 */
function background(promise) {
  try {
    waitUntil(promise);
  } catch {
    // Local dev: nothing to do. The promise is already in flight and this
    // process won't freeze it.
  }
}

// Compact an address/ticker for the Telegram message. Long addresses are
// truncated so the notification stays phone-readable; tickers like "USDC"
// pass through unchanged.
function shortId(v) {
  if (v == null) return "";
  const s = String(v);
  if (s.length <= 18) return s;
  return s.slice(0, 10) + "\u2026" + s.slice(-4);
}

// Standard header line for every notification. Payment mode distinguishes a
// real settled call from a local free-test call, which is the single most
// useful signal when monitoring.
function header(route, price, mode) {
  return mode === "paid"
    ? `\uD83D\uDCB0 ${route} \u2014 ${price}`
    : `\uD83E\uDDEA ${route} \u2014 free-test`;
}

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
    const latencyMs = Date.now() - startedAt;

    logUsage({
      route: req.path,
      address,
      chain,
      paymentMode: res.locals.paymentMode,
      riskLevel: result.riskLevel,
      riskScore: result.riskScore,
      latencyMs,
    });

    // Respond first — the client's latency must not depend on Telegram.
    res.json({ address, chain, ...result });

    // Then notify via waitUntil so the fetch survives the response boundary.
    background(
      notifyTelegram(
        `${header("/v1/scan", "$0.02", res.locals.paymentMode)}\n` +
        `${shortId(address)} (${chain})\n` +
        `Risk: ${result.riskLevel} (${result.riskScore})\n` +
        `${latencyMs}ms`
      )
    );
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
    const latencyMs = Date.now() - startedAt;
    const c = result.categories || {};

    logUsage({
      route: req.path,
      address,
      chain,
      paymentMode: res.locals.paymentMode,
      alertMentions: result.alertMentions,
      latencyMs,
    });

    res.json({ query: address, chain, ...result });

    background(
      notifyTelegram(
        `${header("/v1/alert-check", "$0.03", res.locals.paymentMode)}\n` +
        `Query: ${shortId(address)} (${chain})\n` +
        `Mentions: ${result.alertMentions} \u00B7 ` +
        `sec ${c.securityAlert || 0} \u00B7 whale ${c.whaleMovement || 0} \u00B7 listing ${c.listing || 0}\n` +
        `${latencyMs}ms`
      )
    );
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
    const latencyMs = Date.now() - startedAt;

    logUsage({
      route: req.path,
      address,
      chain,
      paymentMode: res.locals.paymentMode,
      riskLevel: risk.riskLevel,
      riskScore: risk.riskScore,
      alertMentions: alerts.alertMentions,
      latencyMs,
    });

    res.json({ address, chain, risk, alerts });

    background(
      notifyTelegram(
        `${header("/v1/full-check", "$0.04", res.locals.paymentMode)}\n` +
        `${shortId(address)} (${chain})\n` +
        `Risk: ${risk.riskLevel} (${risk.riskScore}) \u00B7 ` +
        `Alerts: ${alerts.alertMentions}\n` +
        `${latencyMs}ms`
      )
    );
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