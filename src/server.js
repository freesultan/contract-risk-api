// Local/dev entry point. Vercel's own runtime imports src/app.js directly
// via api/index.js and never runs this file.
import { app, paymentEnabled } from "./app.js";

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`contract-risk-api listening on :${PORT} (payment gating: ${paymentEnabled ? "ON" : "OFF (free/test mode)"})`);
});
