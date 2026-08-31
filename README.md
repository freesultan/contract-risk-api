# contract-risk-api

On-chain contract risk-score API. POST an address, get back a heuristic risk
signal (upgradeable-proxy detection + privileged-function detection) for
trading bots, wallets, and agents doing pre-trade safety checks.

**Live**: https://contract-risk-api-six.vercel.app

Monetization: standard x402 ("exact" scheme) via **PayAI's facilitator**
(facilitator.payai.network, free tier, no signup). Settlement is
peer-to-peer on-chain straight to a wallet you control — the facilitator
only verifies signatures and broadcasts the transaction, it never
custodies funds. Chosen after ruling out Coinbase's facilitator (per
instruction) and Nevermined (forces a mandatory Stripe Connect payout,
which wasn't usable — see git history for that abandoned integration).

## What's built

- `POST /scan { address, chain }` → risk score, running against **live**
  Base/Ethereum mainnet data over free public RPC endpoints (no signup).
- Heuristics are pure functions (`src/heuristics.js`), unit-tested without
  network access (`test/heuristics.test.js`, 7/7 passing).
- Every request is logged to `usage.log.jsonl` (JSON Lines) — best-effort
  only (not durable on Vercel's serverless runtime). The facilitator/chain
  itself is the authoritative evidence source for real payments received.
- Payment gating (`src/payment.js`) uses the generic `@x402/express` +
  `@x402/core` + `@x402/evm` SDK with `@payai/facilitator`, gated by
  `ENABLE_PAYMENTS` (default `false` — free/test mode, logged as
  `paymentMode: "free-test"`).
- Deployed on Vercel: `src/app.js` exports the Express app, `api/index.js`
  wraps it as a serverless function, `src/server.js` is the local-dev
  entry point (`npm start`).
- Project is ESM (`"type": "module"`).

## How to verify it's actually working

```bash
curl -s https://contract-risk-api-six.vercel.app/health

curl -s -i -X POST https://contract-risk-api-six.vercel.app/scan \
  -H "Content-Type: application/json" \
  -d '{"address":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","chain":"base"}'
# expect 402 with a payment-required header when ENABLE_PAYMENTS=true;
# decode it: echo "<header value>" | base64 -d | python3 -m json.tool
# check: network is "eip155:8453" (Base MAINNET, real money) and payTo
# matches your wallet.
```

## Known limitation (heuristic accuracy)

Function-selector detection is a bytecode substring search for the standard
`PUSH4 <selector>` dispatcher pattern. It can under-detect on heavily
optimized/obfuscated bytecode (confirmed empirically: a real mainnet token
contract returned zero flags in manual testing despite typically having
privileged functions). This is a v0 heuristic, not a guarantee — worth
tightening if the idea earns out.

## Distribution

Nothing earns until agents/bots actually find and call this. Coinbase's
CDP-run x402 Bazaar only indexes CDP-facilitator traffic, so it won't
auto-list us — but PayAI runs its own equivalent discovery catalog at
`GET https://facilitator.payai.network/discovery/resources`, and it's tied
directly to the facilitator we already use.

`POST /scan`'s route config in `src/payment.js` declares a Bazaar discovery
extension (`@x402/extensions/bazaar`'s `declareDiscoveryExtension`) with a
description, example input/output, and a JSON Schema for the body.
`@x402/express`'s `paymentMiddleware` auto-registers this with the resource
server — no extra wiring needed. Once the route has settled **one real
payment**, PayAI indexes it in `/discovery/resources` automatically (an
empty `declareDiscoveryExtension({})` is enough to qualify; richer metadata
just helps agents/LLMs decide to call it).

To actually go live and start earning:

1. Set `EVM_ADDRESS` (your payout wallet) and `ENABLE_PAYMENTS=true` in the
   Vercel project's environment variables, then redeploy. **Done** — live in
   paid mode as of this writing.
2. Drive one real settled payment against `/scan` to trigger the Bazaar
   listing. `scripts/pay-and-scan.js` does this: set `PAYER_PRIVATE_KEY` in
   `.env` to a wallet holding a little **USDC on Base** (network
   `eip155:8453` — USDC on another chain, e.g. Polygon or zkSync Era, is a
   different asset and can't pay this route as configured), then
   `npm run pay:scan`. The x402 "exact" EVM scheme signs an EIP-3009
   authorization — gasless for the payer, no prior approval transaction —
   so the actual cost is exactly `PRICE_PER_SCAN` (currently $0.001), with
   the facilitator covering gas. Self-paying (same wallet as `EVM_ADDRESS`)
   works too and nets to ~$0 since the funds return to the same address; you
   just need that wallet to already hold at least `PRICE_PER_SCAN` in Base
   USDC to sign the authorization against.
3. Optionally also submit the endpoint to independent aggregators that
   aren't facilitator-specific, e.g. https://x402all.com (manual "Register
   your origin" submission) — worth rechecking periodically since this
   space is adding directories fast.

A third, facilitator-independent discovery surface is also served directly
by this app (`src/discovery.js`, generated from the same terms as the live
route so it can't drift):

- `GET /.well-known/x402` — machine-readable manifest (price, network,
  payTo, input/output schema) for crawlers that scrape this well-known path
  directly rather than querying a facilitator's API.
- `GET /llms.txt` — plain-text summary for LLM agents, following the
  convention used by catalogs like x402.openwebninja.com.

Both reflect real config either way: while `ENABLE_PAYMENTS` is off they
report `"mode": "free-test"` and `payTo: null`; once it's on they report the
actual price/network/wallet being charged.

## Running locally

```bash
npm install
cp .env.example .env       # set EVM_ADDRESS to your own wallet if testing payments
npm start                  # node src/server.js
npm test                   # runs test/heuristics.test.js (no network needed)
```

## Evidence log format

Each line in `usage.log.jsonl` (best-effort, local/dev only):
```json
{"ts":"2026-08-27T...","route":"/scan","address":"0x...","chain":"base","paymentMode":"free-test","riskLevel":"low","riskScore":0,"latencyMs":120}
```
