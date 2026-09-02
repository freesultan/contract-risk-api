// Browser UI for /scan. Served as a single self-contained page so it works on
// Vercel's serverless runtime without a bundler or a static-asset step (files
// read from disk at request time aren't reliably included in the function
// bundle; a JS module always is).
//
// The page implements the x402 "exact" EVM scheme by hand against an injected
// wallet — no SDK, since the client SDKs assume a bundler. The payload shape
// below was validated against the facilitator's /verify endpoint (which checks
// the signature without settling) before this page was written.
//
// The page's own script uses string concatenation rather than template
// literals, so nothing inside it collides with this module's interpolation.

import { getScanTerms, ENABLED, CANONICAL_SCAN_PATH } from "./payment.js";

// Pays the canonical path by default, so UI traffic also accrues settlements
// against the URL whose catalog row carries the full metadata.
export function buildUiHtml(scanPath = CANONICAL_SCAN_PATH) {
  const terms = getScanTerms();
  const config = {
    scanPath,
    enabled: ENABLED,
    price: terms.price,
    network: terms.network,
    payTo: terms.payTo,
    serviceName: terms.serviceName,
    description: terms.description,
    // The published schema's example is USDC, but USDC scores 0 with no flags,
    // which makes the UI look broken on first load. Prefill a Base contract
    // that actually trips the proxy heuristic so the first scan shows real
    // output. (USDbC, verified: isProxy true, medium risk.)
    exampleAddress: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${terms.serviceName}</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9; --card: #fff; --fg: #14181f; --muted: #5c6673;
    --line: #e2e6ec; --accent: #2f6df6; --accent-fg: #fff;
    --low: #1a7f4b; --low-bg: #e6f5ec;
    --med: #9a6100; --med-bg: #fdf1dc;
    --high: #b3261e; --high-bg: #fce9e7;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0f1216; --card: #171b21; --fg: #e8ecf1; --muted: #98a3b2;
      --line: #262c35; --accent: #5b8dff;
      --low: #6ee7a8; --low-bg: #10291d;
      --med: #f0c072; --med-bg: #2d2313;
      --high: #ff9c94; --high-bg: #33191a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 32px 20px 64px; background: var(--bg); color: var(--fg);
    font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .wrap { max-width: 680px; margin: 0 auto; }
  h1 { font-size: 24px; margin: 0 0 6px; letter-spacing: -0.02em; }
  .sub { color: var(--muted); margin: 0 0 24px; }
  .card {
    background: var(--card); border: 1px solid var(--line); border-radius: 12px;
    padding: 20px; margin-bottom: 16px;
  }
  label { display: block; font-weight: 600; font-size: 13px; margin-bottom: 6px; }
  input, select {
    width: 100%; padding: 10px 12px; font: inherit; color: inherit;
    background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  }
  input { font-family: var(--mono); font-size: 13px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; }
  .row > * { flex: 1; min-width: 160px; }
  button {
    font: inherit; font-weight: 600; padding: 10px 18px; border-radius: 8px;
    border: 1px solid transparent; background: var(--accent); color: var(--accent-fg);
    cursor: pointer;
  }
  button.secondary { background: transparent; border-color: var(--line); color: var(--fg); }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .actions { display: flex; gap: 10px; align-items: center; margin-top: 18px; flex-wrap: wrap; }
  .meta { font-size: 13px; color: var(--muted); }
  .mono { font-family: var(--mono); font-size: 12px; word-break: break-all; }
  .badge {
    display: inline-block; padding: 4px 12px; border-radius: 999px;
    font-weight: 700; font-size: 13px; text-transform: uppercase; letter-spacing: .04em;
    /* Neutral default so an unrecognised level (e.g. "unknown") still reads. */
    color: var(--muted); background: var(--bg); border: 1px solid var(--line);
  }
  .badge.low, .badge.medium, .badge.high { border-color: transparent; }
  .low { color: var(--low); background: var(--low-bg); }
  .medium { color: var(--med); background: var(--med-bg); }
  .high { color: var(--high); background: var(--high-bg); }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; margin: 16px 0 0; }
  dt { color: var(--muted); font-size: 13px; }
  dd { margin: 0; font-size: 13px; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  .status { margin-top: 14px; font-size: 13px; min-height: 20px; }
  .err { color: var(--high); }
  .hidden { display: none; }
  a { color: var(--accent); }
</style>
</head>
<body>
<div class="wrap">
  <h1>${terms.serviceName}</h1>
  <p class="sub">${terms.description}</p>

  <div class="card">
    <div class="row">
      <div style="flex:2">
        <label for="addr">Contract address</label>
        <input id="addr" spellcheck="false" autocomplete="off" placeholder="0x...">
      </div>
      <div>
        <label for="chain">Chain</label>
        <select id="chain"><option value="base">Base</option><option value="ethereum">Ethereum</option></select>
      </div>
    </div>
    <div class="actions">
      <button id="scan">Scan</button>
      <button id="connect" class="secondary">Connect wallet</button>
      <span id="wallet" class="meta"></span>
    </div>
    <div id="status" class="status"></div>
  </div>

  <div id="result" class="card hidden"></div>

  <p class="meta" id="terms"></p>
</div>

<script id="cfg" type="application/json">${JSON.stringify(config)}</script>
<script>
(function () {
  var CFG = JSON.parse(document.getElementById("cfg").textContent);
  var $ = function (id) { return document.getElementById(id); };
  var account = null;

  $("addr").value = CFG.exampleAddress;
  $("terms").textContent = CFG.enabled
    ? "Each scan costs " + CFG.price + " in USDC on Base (x402). Paid peer-to-peer to " + CFG.payTo + " \\u2014 no account, no signup."
    : "Running in free/test mode \\u2014 no payment required.";

  function status(msg, isErr) {
    var el = $("status");
    el.textContent = msg || "";
    el.className = "status" + (isErr ? " err" : "");
  }

  function toHexChainId(caip) { return "0x" + Number(caip.split(":")[1]).toString(16); }

  async function connect() {
    if (!window.ethereum) {
      status("No Ethereum wallet found. Install MetaMask (or any injected wallet) to pay.", true);
      return null;
    }
    var accts = await window.ethereum.request({ method: "eth_requestAccounts" });
    account = accts[0];
    $("wallet").textContent = account.slice(0, 6) + "\\u2026" + account.slice(-4);
    return account;
  }

  async function ensureChain(caip) {
    var want = toHexChainId(caip);
    var current = await window.ethereum.request({ method: "eth_chainId" });
    if (current === want) return;
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    } catch (e) {
      // 4902 = chain unknown to the wallet; add it, then the switch sticks.
      if (e && e.code === 4902 && want === "0x2105") {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: "0x2105", chainName: "Base",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: ["https://mainnet.base.org"],
            blockExplorerUrls: ["https://basescan.org"]
          }]
        });
      } else { throw e; }
    }
  }

  function randomNonce() {
    var b = new Uint8Array(32);
    crypto.getRandomValues(b);
    var s = "0x";
    for (var i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
    return s;
  }

  // Build + sign the EIP-3009 authorization the x402 "exact" scheme expects.
  // Gasless for the payer: the facilitator broadcasts and pays gas.
  async function signPayment(required) {
    var accepted = required.accepts[0];
    await ensureChain(accepted.network);

    var auth = {
      from: account,
      to: accepted.payTo,
      value: String(accepted.amount),
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + (accepted.maxTimeoutSeconds || 300)),
      nonce: randomNonce()
    };

    var typedData = {
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" }
        ],
        TransferWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" }
        ]
      },
      primaryType: "TransferWithAuthorization",
      domain: {
        name: accepted.extra.name,
        version: accepted.extra.version,
        chainId: Number(accepted.network.split(":")[1]),
        verifyingContract: accepted.asset
      },
      message: auth
    };

    var signature = await window.ethereum.request({
      method: "eth_signTypedData_v4",
      params: [account, JSON.stringify(typedData)]
    });

    return {
      x402Version: required.x402Version,
      payload: { authorization: auth, signature: signature },
      extensions: required.extensions,
      resource: required.resource,
      accepted: accepted
    };
  }

  function b64encode(obj) {
    return btoa(String.fromCharCode.apply(null, new TextEncoder().encode(JSON.stringify(obj))));
  }
  function b64decode(str) {
    var bin = atob(str);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  function post(body, paymentHeader) {
    var headers = { "Content-Type": "application/json" };
    if (paymentHeader) headers["PAYMENT-SIGNATURE"] = paymentHeader;
    return fetch(CFG.scanPath, { method: "POST", headers: headers, body: JSON.stringify(body) });
  }

  // Values here are echoed back from the request, so never interpolate them
  // into markup raw.
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function render(data, settlement) {
    var lvl = String(data.riskLevel || "low").toLowerCase();
    // Only these map to a CSS class; anything else (e.g. "unknown") gets none.
    var lvlClass = ["low", "medium", "high"].indexOf(lvl) >= 0 ? lvl : "";
    var html = '<span class="badge ' + lvlClass + '">' + esc(lvl) + " risk</span>";
    html += "<dl>";
    html += "<dt>Score</dt><dd>" + esc(data.riskScore) + "</dd>";
    html += "<dt>Contract</dt><dd>" + (data.isContract ? "yes" : "no (EOA \\u2014 not a contract)") + "</dd>";
    html += "<dt>Upgradeable proxy</dt><dd>" + (data.isProxy ? "yes" : "no") + "</dd>";
    html += "<dt>Address</dt><dd class='mono'>" + esc(data.address) + "</dd>";
    html += "</dl>";
    if (data.note) html += "<p class='meta'>" + esc(data.note) + "</p>";
    if (data.flags && data.flags.length) {
      html += "<p style='margin:16px 0 0'><strong>Flags</strong></p><ul>";
      for (var i = 0; i < data.flags.length; i++) {
        // Flags are {label, weight} objects, not strings — concatenating one
        // straight into the markup renders "[object Object]".
        var f = data.flags[i];
        var isObj = f && typeof f === "object";
        var label = isObj ? f.label : f;
        var weight = isObj && typeof f.weight === "number" ? f.weight : null;
        html += "<li>" + esc(label) +
          (weight ? " <span class='meta'>(+" + weight + ")</span>" : "") +
          "</li>";
      }
      html += "</ul>";
    } else {
      html += "<p class='meta' style='margin-top:14px'>No privileged-function flags detected. This is a v0 heuristic, not a guarantee.</p>";
    }
    if (settlement && settlement.transaction) {
      html += "<p class='meta' style='margin-top:16px'>Paid " + esc(CFG.price) +
        " \\u2014 <a href='https://basescan.org/tx/" + encodeURIComponent(settlement.transaction) +
        "' target='_blank' rel='noopener'>view transaction</a></p>";
    }
    $("result").innerHTML = html;
    $("result").classList.remove("hidden");
  }

  async function scan() {
    var address = $("addr").value.trim();
    var chain = $("chain").value;
    $("result").classList.add("hidden");
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      status("Enter a valid 0x-prefixed contract address (40 hex characters).", true);
      return;
    }
    $("scan").disabled = true;
    try {
      status("Requesting scan\\u2026");
      var res = await post({ address: address, chain: chain });

      if (res.status === 200) { render(await res.json()); status(""); return; }

      if (res.status !== 402) {
        var errBody = await res.json().catch(function () { return {}; });
        status("Request failed (" + res.status + "): " + (errBody.error || "unknown error"), true);
        return;
      }

      // Payment required.
      var required = b64decode(res.headers.get("payment-required"));
      if (!account && !(await connect())) return;

      status("Waiting for signature in your wallet\\u2026");
      var payload = await signPayment(required);

      status("Submitting payment\\u2026");
      var paid = await post({ address: address, chain: chain }, b64encode(payload));

      if (paid.status === 200) {
        var settlement = null;
        var respHeader = paid.headers.get("payment-response");
        if (respHeader) { try { settlement = b64decode(respHeader); } catch (e) {} }
        render(await paid.json(), settlement);
        status("");
        return;
      }

      // A second 402 means the facilitator refused to settle; the reason is in
      // the header, not the body.
      var reason = "";
      var again = paid.headers.get("payment-required");
      if (again) { try { reason = b64decode(again).error || ""; } catch (e) {} }
      if (reason === "invalid_exact_evm_insufficient_balance") {
        status("Payment declined: that wallet needs at least " + CFG.price + " of USDC on Base.", true);
      } else {
        status("Payment did not settle" + (reason ? " (" + reason + ")" : "") + ".", true);
      }
    } catch (e) {
      // 4001 = user rejected the signature request.
      if (e && e.code === 4001) status("Signature rejected \\u2014 nothing was charged.");
      else status(e && e.message ? e.message : String(e), true);
    } finally {
      $("scan").disabled = false;
    }
  }

  $("scan").addEventListener("click", scan);
  $("connect").addEventListener("click", function () {
    connect().catch(function (e) { status(e.message || String(e), true); });
  });
  if (window.ethereum && window.ethereum.selectedAddress) connect().catch(function () {});
})();
</script>
</body>
</html>`;
}
