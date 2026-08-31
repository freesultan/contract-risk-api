import "dotenv/config";
import express from "express";
import { fetchOnChainData, DEFAULT_RPC_URLS } from "./chain.js";
import { analyzeBytecode } from "./heuristics.js";
import { logUsage } from "./logger.js";
import { buildPaymentMiddleware, logRequestMode } from "./payment.js";
import { buildX402Manifest, buildLlmsTxt } from "./discovery.js";

const app = express();
app.use(express.json());
app.use(logRequestMode);

const { enabled: paymentEnabled, middleware: paymentMiddleware } = await buildPaymentMiddleware();
app.use(paymentMiddleware);

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

app.post("/scan", async (req, res) => {
  const { address, chain = "base" } = req.body || {};
  const startedAt = Date.now();

  if (!address) {
    return res.status(400).json({ error: "Missing required field: address" });
  }

  try {
    const { bytecode, implementationSlotValue } = await fetchOnChainData(address, chain);
    const result = analyzeBytecode({ bytecode, implementationSlotValue });

    // Best-effort local log (not durable on serverless — Nevermined's own
    // dashboard is the authoritative source for paid-usage evidence there).
    logUsage({
      route: "/scan",
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
      route: "/scan",
      address,
      chain,
      paymentMode: res.locals.paymentMode,
      error: err.message,
      latencyMs: Date.now() - startedAt,
    });
    res.status(400).json({ error: err.message });
  }
});

export { app, paymentEnabled };
