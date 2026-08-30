# contract-risk-api

On-chain contract risk-score API. POST an address, get back a heuristic risk
signal (upgradeable-proxy detection + privileged-function detection) for
trading bots, wallets, and agents doing pre-trade safety checks.

Monetization: Nevermined's x402 facilitator (chosen instead of Coinbase's,
per instruction — ~1% fee, EVM/Base USDC, no KYA overhead unlike Skyfire).
**Not yet connected to a live account** — see "What's approval-gated" below.

## What's built (Phase 1)

- `POST /scan { address, chain }` → risk score, running against **live**
  Base/Ethereum mainnet data over free public RPC endpoints (no signup).
- Heuristics are pure functions (`src/heuristics.js`), unit-tested without
  network access (`test/heuristics.test.js`, 7/7 passing).
- Every request is logged to `usage.log.jsonl` (JSON Lines) — this file is
  the evidence source for Phase 2 verification. Numbers reported later must
  trace back to lines in this file, not estimates.
- Payment gating (`src/payment.js`) is wired against Nevermined's real SDK
  (`@nevermined-io/payments`, `Payments.getInstance()` + `paymentMiddleware`)
  but is **disabled by default** (`ENABLE_PAYMENTS=false`) — every request is
  served free in the meantime, still logged with `paymentMode: "free-test"`.
- Project is ESM (`"type": "module"`) — required because Nevermined's SDK
  ships ESM-only with no CommonJS export.

## Known dependency risk (disclosed, assessed low for our usage)

`npm audit` flags `@nevermined-io/payments` as high-severity because it
bundles its own nested `express@4.21.2` with a known ReDoS vulnerability
(GHSA-37ch-88jc-xwx2, CVSS 7.5). Verified in the package source: that nested
express only backs Nevermined's **MCP-server module** (`dist/mcp/http/*`),
which this project never imports or starts. We only use the `./express`
subpath (`dist/x402/express/*`), which doesn't touch the vulnerable code
path. Re-run `npm audit` before going to production in case a patched
release exists by then — flagging this now rather than burying it, since
this is itself a security-tooling product.

## What's approval-gated (not done yet — needs your action)

None of this was done autonomously — real accounts and money are involved:

1. **Sign up** at nevermined.app.
2. **Get a sandbox API key first**: Settings → Global NVM API Keys → "+ New
   API Key". It will look like `sandbox:xxxxx`. Test the whole paid flow with
   zero real money before ever touching a `live:` key.
3. **Create a payment plan** in the dashboard — this defines the price and
   generates an `NVM_PLAN_ID`. It's also where you configure the wallet
   address that actually receives funds (our code never holds or sees a
   private key — Nevermined's infrastructure handles settlement to whatever
   wallet you register there).
4. Put `NVM_API_KEY` and `NVM_PLAN_ID` into `.env`, set `ENABLE_PAYMENTS=true`.
5. Test locally against the **sandbox** environment end-to-end (a request
   without valid payment should get a 402; one with a valid sandbox payment
   token should succeed) before ever switching to a `live:` key.
6. Only after sandbox testing passes: get a `live:` key, a real funded plan,
   and **deploy to a public endpoint** (currently localhost-only).
7. **List it** somewhere agents/bots discover x402 tools (Nevermined's own
   agent directory, MCP tool registries) — the distribution step Phase 2
   depends on.

I will not do any of steps 1–3 or 6–7 without your explicit confirmation.
Step 4–5 (wiring the values you provide, and testing in sandbox) I can do
as soon as you hand me a sandbox key + plan ID.

## Known limitation (heuristic accuracy)

Function-selector detection is a bytecode substring search for the standard
`PUSH4 <selector>` dispatcher pattern. It can under-detect on heavily
optimized/obfuscated bytecode (confirmed empirically: a real mainnet token
contract returned zero flags in manual testing despite typically having
privileged functions). This is a v0 heuristic, not a guarantee — worth
tightening in Phase 3 if the idea earns out, not before.

## Running locally

```bash
npm install
cp .env.example .env
npm start          # or: node src/index.js
npm test           # runs test/heuristics.test.js (no network needed)
```

```bash
curl -X POST http://localhost:3000/scan \
  -H "Content-Type: application/json" \
  -d '{"address":"0xSomeAddress","chain":"base"}'
```

## Evidence log format

Each line in `usage.log.jsonl`:
```json
{"ts":"2026-08-27T...","route":"/scan","address":"0x...","chain":"base","paymentMode":"free-test","riskLevel":"low","riskScore":0,"latencyMs":120}
```
