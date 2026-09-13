# contract-risk-api

On-chain contract risk-score API. POST an address, get back a heuristic risk
signal (upgradeable-proxy detection + privileged-function detection) for
trading bots, wallets, and agents doing pre-trade safety checks.

**Live**: https://smartcontractrisk.0xhodhod.xyz

Monetization: standard x402 ("exact" scheme) via **PayAI's facilitator**
(facilitator.payai.network, free tier, no signup). Settlement is
peer-to-peer on-chain straight to a wallet you control — the facilitator
only verifies signatures and broadcasts the transaction, it never
custodies funds. Chosen after ruling out Coinbase's facilitator (per
instruction) and Nevermined (forces a mandatory Stripe Connect payout,
which wasn't usable — see git history for that abandoned integration).

## Browser UI

**The UI lives at `/app`.** `GET /` returns Vercel's
`FUNCTION_INVOCATION_FAILED` no matter what the function does, so `vercel.json`
redirects `/` → `/app` rather than trying to serve the root.

That wasn't a guess: `/app` serves the identical page from the identical
handler and works, while `/` fails. The crash is also unreachable from
Express — the route is wrapped in try/catch and the global error handler is
confirmed live in production (a malformed-JSON POST returns its JSON, not
Vercel's error page) — and `/` works locally under Node 18 and 22, via
`src/server.js` and via `api/index.js` invoked the way Vercel invokes it. So
it is the platform's root-path routing, not this code.

`/app` serves a self-contained page that lets a human pay for a scan with a
browser wallet — connect, sign, read the result — with no tooling. It
implements the x402 "exact" EVM scheme by hand against `window.ethereum`
(the client SDKs assume a bundler, which this deploy target doesn't have),
signing the EIP-3009 authorization via `eth_signTypedData_v4`. Payment is
gasless for the visitor; the facilitator broadcasts and covers gas.

The payload shape wasn't guessed: it was validated against the facilitator's
`POST /verify`, which checks the signature and balance *without settling*, so
the browser code was proven correct at zero cost before being written.
`/verify` is the right tool for testing payment changes — use it instead of
burning real settlements.

The page is served from a JS module rather than a static file because files
read from disk at request time aren't reliably included in Vercel's function
bundle, while an imported module always is.
 

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
curl -s https://smartcontractrisk.0xhodhod.xyz/health

# Use a demo address that actually trips the heuristic (see "Demo addresses"
# below) — the old USDC example returns an empty result and looks broken.
curl -s -i -X POST https://smartcontractrisk.0xhodhod.xyz/v1/scan \
  -H "Content-Type: application/json" \
  -d '{"address":"0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599","chain":"ethereum"}'
# expect 402 with a payment-required header when ENABLE_PAYMENTS=true;
# decode it: echo "<header value>" | base64 -d | python3 -m json.tool
# check: network is "eip155:8453" (Base MAINNET, real money) and payTo
# matches your wallet.
```



## Understanding the response

A scan reads the contract's live runtime bytecode and its EIP-1967 proxy
storage slot, adds a weight for each risk signal it finds, and reports the
total. Nothing is inferred from the token's name, its liquidity, or any
off-chain reputation source — only what the deployed code exposes.

### Fields

| Field | Meaning |
| --- | --- |
| `riskLevel` | The band `riskScore` falls into: `low`, `medium`, `high`, or `unknown`. |
| `riskScore` | Sum of the weights of every signal found. Higher means more owner power. |
| `isContract` | Whether the address has bytecode. `false` means a wallet (EOA) or an address nothing is deployed to yet. |
| `isProxy` | Whether the EIP-1967 implementation slot is set — an admin can swap the contract's logic for different code. |
| `flags` | One entry per signal found, each `{ label, weight }`. `label` is human-readable; `weight` is its contribution to the score. |
| `address`, `chain` | Echoed back, so a stored result is self-describing. |
| `note` | Present only when there is no code to analyse. |

### Levels

| Level | Score | Reading |
| --- | --- | --- |
| `low` | 0–9 | No centralised-control signals found. |
| `medium` | 10–29 | Privileged functions or upgradeability present. |
| `high` | 30+ | Several powerful owner capabilities at once. |
| `unknown` | — | Not a contract, so there is nothing to score. |

### Weights

| Signal | Weight |
| --- | --- |
| Upgradeable proxy (EIP-1967 slot set) | +10 |
| `owner()` | +5 |
| `transferOwnership(address)` | +5 |
| `mint(address,uint256)` | +15 |
| `pause()` | +10 |
| `blacklist(address)` | +20 |
| `setBlacklist(address,bool)` | +20 |
| `excludeFromFee(address)` | +5 |
| `setTaxFee(uint256)` | +15 |

Maximum possible score is 105. `renounceOwnership()` and `unpause()` are
recognised but weighted 0 — they are context for other findings rather than
risks themselves, so they never appear as flags.

These numbers are not duplicated by hand: the `/app` page builds its tables
from `RISK_THRESHOLDS`, `PROXY_WEIGHT` and `FLAGGED_SELECTORS` directly, and a
test asserts the rendered bands and weights match the scorer's constants.

### How to read a result

**A high score is not proof of a scam, and a low score is not a safety
guarantee.** Many legitimate tokens are pausable, mintable, and upgradeable by
design — USDC is all three. What the score tells you is *how much power the
contract's owner holds over your funds*, so you can decide whether you trust
whoever holds it. A `high` result on an unknown deployer is a very different
thing from the same result on a well-known issuer.

Read it as a prompt to look closer, not a verdict — and note the two known
blind spots below (non-EIP-1967 proxies, and bytecode-level under-detection).

## Demo addresses (verified against live mainnet)

The published example (USDC) scores 0 with no flags, which makes the API look
inert. These were run through the real heuristic — `node
scripts/probe-candidates.js` re-checks them and prints the full table.

| Address | Chain | Result |
| --- | --- | --- |
| `0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599` (WBTC) | ethereum | **high**, score 35 — owner, transferOwnership, mint, pause |
| `0x111111111117dC0aa78b770fA6A738034120C302` (1INCH) | ethereum | medium, score 25 — owner, transferOwnership, mint |
| `0xdAC17F958D2ee523a2206206994597C13D831ec7` (USDT) | ethereum | medium, score 20 — owner, transferOwnership, pause |
| `0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA` (USDbC) | base | medium, score 10 — **proxy detected** |
| `0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22` (cbETH) | base | medium, score 10 — **proxy detected** |
| `0x4200000000000000000000000000000000000010` (L2StandardBridge) | base | medium, score 10 — **proxy detected** |
| `0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2` (Aave v3 Pool) | ethereum | medium, score 10 — **proxy detected** |
| `0x0000000000000000000000000000000000000000` | either | `riskLevel: "unknown"` — EOA/no code path |

WBTC is the best single demo (proxy aside): four flags and the only `high` in
the set. USDbC is the best proxy demo on Base, and is what the UI prefills.

### Copy-pasteable

Swap the host for `http://localhost:3000` to run these free against a local
server (`ENABLE_PAYMENTS` unset), or pay them for real with
`SCAN_ADDRESS=... SCAN_CHAIN=... npm run pay:scan`.

```bash
# Highest-signal demo: WBTC, four privileged-function flags
curl -s -X POST https://smartcontractrisk.0xhodhod.xyz/v1/scan \
  -H "Content-Type: application/json" \
  -d '{"address":"0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599","chain":"ethereum"}'

# Proxy detection on Base
curl -s -X POST https://smartcontractrisk.0xhodhod.xyz/v1/scan \
  -H "Content-Type: application/json" \
  -d '{"address":"0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA","chain":"base"}'
```

Real responses (captured from the live heuristic, not illustrative):

```json
{
  "address": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
  "chain": "ethereum",
  "isContract": true,
  "isProxy": false,
  "flags": [
    { "label": "has an owner() function (centralized control)", "weight": 5 },
    { "label": "owner can transfer ownership", "weight": 5 },
    { "label": "owner/admin can mint new tokens", "weight": 15 },
    { "label": "owner/admin can pause transfers", "weight": 10 }
  ],
  "riskScore": 35,
  "riskLevel": "high"
}
```

```json
{
  "address": "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  "chain": "base",
  "isContract": true,
  "isProxy": true,
  "flags": [
    { "label": "upgradeable proxy (EIP-1967) — logic can be swapped by admin", "weight": 10 }
  ],
  "riskScore": 10,
  "riskLevel": "medium"
}
```

## Known limitation (proxy false negatives)

**The proxy check only reads the EIP-1967 slot, so it misses proxies that use
other slots — including USDC itself.** Confirmed on-chain: USDC on Base has an
empty EIP-1967 slot but a populated legacy OpenZeppelin slot
(`keccak256("org.zeppelinos.proxy.implementation")` →
`0x2ce6311ddae708829bc0784c967b7d77d19fd779`). So the API currently reports
`isProxy: false` for the most widely held stablecoin on both supported chains.
Lido's stETH (an Aragon-style proxy) is missed too — none of the three common
slots are populated for it.

Fixing this means reading the legacy Zeppelin and EIP-1822 slots alongside
EIP-1967. That is a small change, but it would flip existing answers (USDC
would move from `low` to `medium`), so it is deliberately left as a decision
rather than applied silently.

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

**Node 20+ is required to run `npm run pay:scan`.** Signing the x402
authorization needs the WebCrypto global, which Node 18 exposes to ESM only
behind a flag (without it the SDK fails with a bare "Crypto API not
available" from deep in the stack). The script now checks this up front and
tells you what to do. On a Node 18 machine, either upgrade or run:

```bash
node --experimental-global-webcrypto scripts/pay-and-scan.js
```

## Evidence log format

Each line in `usage.log.jsonl` (best-effort, local/dev only):
```json
{"ts":"2026-08-27T...","route":"/scan","address":"0x...","chain":"base","paymentMode":"free-test","riskLevel":"low","riskScore":0,"latencyMs":120}
```
