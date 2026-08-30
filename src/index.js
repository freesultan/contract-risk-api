import "dotenv/config";
import express from "express";
import { fetchOnChainData, DEFAULT_RPC_URLS } from "./chain.js";
import { analyzeBytecode } from "./heuristics.js";
import { logUsage } from "./logger.js";
import { buildPaymentMiddleware, logRequestMode } from "./payment.js";

const app = express();
app.use(express.json());
app.use(logRequestMode);

const { enabled: paymentEnabled, middleware: paymentMiddleware } = await buildPaymentMiddleware();
app.use(paymentMiddleware);

app.get("/health", (req, res) => {
  res.json({ ok: true, paymentEnabled, supportedChains: Object.keys(DEFAULT_RPC_URLS) });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`contract-risk-api listening on :${PORT} (payment gating: ${paymentEnabled ? "ON" : "OFF (free/test mode)"})`);
});

export { app };
