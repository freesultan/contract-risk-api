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

## Browser UI

`GET /` serves a self-contained page that lets a human pay for a scan with a
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

**Not verified:** the wallet interaction itself (connect / network switch /
signing prompt) needs a real browser with an injected wallet, which can't be
exercised headlessly here. The payment payload it builds is verified; the
wallet plumbing around it is not.

CORS is open (`Access-Control-Allow-Origin: *`) and exposes
`PAYMENT-REQUIRED` / `PAYMENT-RESPONSE` while allowing `PAYMENT-SIGNATURE`,
so the API is payable from a browser page on *any* origin, not just this one
— non-safelisted response headers are invisible to cross-origin JS otherwise.
PayAI's own reference merchant does the same.

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

## Safety of `pay:scan` (it signs a real transfer)

The script signs automatically, with no interactive confirmation, so what
bounds the damage is worth stating explicitly:

- **The key never leaves the machine.** It goes to viem's
  `privateKeyToAccount` and then to `@x402/evm`'s signer, which contains no
  `fetch` calls and no URLs anywhere in its 56 dist files. The only outbound
  request is to `SCAN_API_URL`. The script prints the derived address, never
  the key. `.env` is gitignored (verified with `git check-ignore`).
- **An EIP-3009 authorization is narrow**: it commits to one exact amount,
  one exact recipient, a random nonce, and an expiry. It is not an allowance
  and cannot be replayed for more.
- **There is a per-payment spend cap.** The SDK defaults to `$1`; this script
  pins it explicitly to `$0.05` (`MAX_PAYMENT`), verified both ways — a
  hostile server demanding `$0.99` gets refused with nothing signed, while
  the real `$0.001` route still pays.

Residual risk: anything **at or under the cap** is signed with no prompt, so
a wrong or tampered `SCAN_API_URL` could pay a stranger up to `MAX_PAYMENT`.
Note also that `@x402/fetch` re-signs a second authorization (fresh nonce) on
its internal `recovered` retry path, so budget worst case as 2× the cap.

Given that, **use a burner wallet** funded with a few cents rather than a
main wallet. That caps total exposure at the balance regardless of any
supply-chain assumption about the `@x402/*` packages.

## Known limitation (cold-start 502)

One observed request to the deployed `/scan` returned
`502 {"error":"Facilitator supported request timed out after 30000ms"}` —
the resource server's call to the facilitator's `/supported` endpoint
exceeded its 30s budget on a cold start. It did not reproduce (6/6
subsequent probes returned a normal 402 in <1.2s, and the facilitator's
`/supported` answers in ~1s when called directly), so this looks like a
cold-start race rather than a facilitator outage. Worth watching: a paying
agent that hits a cold instance could see a 502 instead of a 402.

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

The route is **live in that catalog** as of 2026-09-01, with the correct
description, price, payTo and input/output schema.

### The catalog row's metadata is write-once (`serviceName`/`tags` are null)

`serviceName`, `tags` and `iconUrl` are `RouteConfig` fields rather than
discovery-extension ones, so the first deploy didn't send them and the row
was indexed with them `null`. They are now emitted — but **the row still
shows null, and re-paying does not fix it.** Established by testing, not
assumption:

- The live 402's `resource` object now carries `serviceName` and `tags`, and
  a capture of the client's `PAYMENT-SIGNATURE` payload (replaying the real
  live 402 against a local relay) confirms both survive into what is sent to
  the facilitator, alongside the `bazaar` extension. Our side is correct.
- A second payment settled successfully (tx `0xb4804de7…03f9`, payout wallet
  now 0.002 USDC). PayAI counted it —
  `/discovery/resources/<urlencoded>/stats` reports 2 settlements — but the
  catalog row's `lastUpdated` stayed frozen at the first settlement and the
  fields stayed null. **So don't re-pay hoping to refresh metadata.**
- Their OpenAPI (`/openapi.json`) exposes no register/refresh endpoint, and
  `/discovery/resources` accepts only `limit` and `offset` — the `?payTo=`
  filter mentioned in the generic x402 docs is not implemented here.

The x402 docs state catalog behaviour is "an implementation detail of the
facilitator operator". So the options are: ask PayAI to re-index
(info@payai.network), or force a fresh row by serving the route at a new
resource URL and paying once — which works because rows are created per URL,
but leaves the old null-metadata row behind.

**We took the new-URL route.** The scan is now served at both `/scan` and
`/v1/scan` with identical terms (`SCAN_PATHS` in `src/payment.js`), and
`/v1/scan` is canonical for the manifest, `llms.txt` and the browser UI. The
first settled payment against `/v1/scan` should create a second catalog row
carrying `serviceName` and `tags`. `/scan` keeps working, so the existing
listing and any agent already using it are unaffected — at the cost of one
stale row in the catalog.

To do it after deploying: `SCAN_API_URL=https://<host>/v1/scan npm run pay:scan`,
then re-check the catalog.

This is polish, not a blocker: `description` — the main thing agents and LLMs
rank on — is populated and correct.

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
   listing. **Done — 2026-09-01.** Settled on Base in tx
   `0xf879c81db44142a33defda343f1f0f931cc066f2a2791c491093ce56eb51b054`
   (block 50740559): 0.001 USDC from a burner wallet to the payout address,
   gas paid by the facilitator. PayAI indexed `/scan` into
   `/discovery/resources` within minutes — the catalog went from 27,946 to
   27,947 entries with this route as the newest.

   `scripts/pay-and-scan.js` does this: set `PAYER_PRIVATE_KEY` in
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
