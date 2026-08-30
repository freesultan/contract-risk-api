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

## Distribution (not done yet)

Nothing earns until agents/bots actually find and call this. Options
researched: the big Coinbase-run x402 Bazaar directory (10,000+ tools) only
indexes CDP-facilitator services, so it won't auto-list us. PayAI or other
neutral registries would need checking for an equivalent discovery layer.

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
