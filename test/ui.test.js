// Runs the UI page's real inline script under a minimal DOM stub and drives a
// scan with a stubbed fetch, so the render path is covered.
//
// This exists because a shipped bug rendered flags as "[object Object]":
// flags are {label, weight} objects, and generating the HTML server-side
// never exercised the client-side rendering that consumes them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUiHtml } from "../src/ui.js";

function runPageWith(scanResult) {
  const html = buildUiHtml();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const cfgJson = html.match(
    /<script id="cfg" type="application\/json">([\s\S]*?)<\/script>/
  )[1];

  const mkEl = () => ({
    value: "",
    textContent: "",
    innerHTML: "",
    className: "",
    disabled: false,
    classList: { add() {}, remove() {} },
    addEventListener(ev, fn) {
      (this.handlers ||= {})[ev] = fn;
    },
  });

  const els = {};
  for (const id of ["addr", "chain", "scan", "connect", "wallet", "status", "result", "terms", "cfg"]) {
    els[id] = mkEl();
  }
  els.cfg.textContent = cfgJson;

  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
  globalThis.document = { getElementById: (id) => els[id] };
  globalThis.window = {};
  globalThis.fetch = async () => ({
    status: 200,
    headers: { get: () => null },
    json: async () => scanResult,
  });

  try {
    new Function(script)();
  } finally {
    Object.assign(globalThis, saved);
  }
  return els;
}

async function scanAndRender(scanResult) {
  const els = runPageWith(scanResult);
  // The click handler re-reads globals, so restore the stubs for the call.
  const saved = { document: globalThis.document, fetch: globalThis.fetch };
  globalThis.document = { getElementById: (id) => els[id] };
  globalThis.fetch = async () => ({
    status: 200,
    headers: { get: () => null },
    json: async () => scanResult,
  });
  try {
    await els.scan.handlers.click();
  } finally {
    Object.assign(globalThis, saved);
  }
  return els.result.innerHTML;
}

const PROXY_RESULT = {
  address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
  chain: "base",
  isContract: true,
  isProxy: true,
  flags: [{ label: "upgradeable proxy (EIP-1967) — logic can be swapped by admin", weight: 10 }],
  riskScore: 10,
  riskLevel: "medium",
};

const EOA_RESULT = {
  address: "0x0000000000000000000000000000000000000000",
  chain: "base",
  isContract: false,
  isProxy: false,
  flags: [],
  riskScore: 0,
  riskLevel: "unknown",
  note: "Address has no contract code (EOA or not yet deployed).",
};

test("renders flag objects as their labels, never [object Object]", async () => {
  const out = await scanAndRender(PROXY_RESULT);
  assert.ok(!out.includes("[object Object]"), "flags must not stringify as objects");
  assert.ok(out.includes("upgradeable proxy (EIP-1967)"), "flag label should be shown");
  assert.ok(out.includes("(+10)"), "flag weight should be shown");
});

test("renders multiple flags with individual weights", async () => {
  const out = await scanAndRender({
    ...PROXY_RESULT,
    isProxy: false,
    riskScore: 35,
    riskLevel: "high",
    flags: [
      { label: "has an owner() function (centralized control)", weight: 5 },
      { label: "owner/admin can mint new tokens", weight: 15 },
    ],
  });
  assert.ok(!out.includes("[object Object]"));
  assert.ok(out.includes("owner/admin can mint new tokens"));
  assert.ok(out.includes("(+5)") && out.includes("(+15)"));
  assert.ok(out.includes('class="badge high"'));
});

test("handles an unknown risk level and an empty flag list", async () => {
  const out = await scanAndRender(EOA_RESULT);
  assert.ok(!out.includes("[object Object]"));
  assert.ok(out.includes("No privileged-function flags detected"));
  assert.ok(out.includes("no contract code"), "the note should be surfaced");
  // "unknown" isn't a colour class; the badge must not claim one.
  assert.ok(!/class="badge (low|medium|high)"/.test(out));
});

test("scoring explainer is generated from the scorer's own constants", async () => {
  const { RISK_THRESHOLDS, PROXY_WEIGHT } = await import("../src/heuristics.js");
  const { FLAGGED_SELECTORS } = await import("../src/selectors.js");
  const html = buildUiHtml();

  // Bands must match the thresholds the scorer actually applies.
  assert.match(html, new RegExp(`0&ndash;${RISK_THRESHOLDS.medium - 1}`));
  assert.match(html, new RegExp(`${RISK_THRESHOLDS.medium}&ndash;${RISK_THRESHOLDS.high - 1}`));
  assert.match(html, new RegExp(`${RISK_THRESHOLDS.high}\\+`));

  const expectedMax =
    PROXY_WEIGHT + FLAGGED_SELECTORS.reduce((n, f) => n + f.weight, 0);
  assert.match(html, new RegExp(`Maximum possible score is ${expectedMax}`));

  // Every scoring signal is listed, and weight-0 entries are not — they never
  // appear as flags, so showing them as score contributors would mislead.
  for (const f of FLAGGED_SELECTORS) {
    if (f.weight > 0) {
      assert.ok(html.includes(`<code>${f.sig}</code>`), `${f.sig} should be listed`);
    } else {
      assert.ok(
        !html.includes(`<code>${f.sig}</code></td><td>+`),
        `${f.sig} has weight 0 and should not be listed as scoring`
      );
    }
  }
});

test("escapes values echoed back from the request", async () => {
  const out = await scanAndRender({
    ...PROXY_RESULT,
    address: '0x<img src=x onerror=alert(1)>"',
  });
  assert.ok(!out.includes("<img"), "echoed address must not inject markup");
  assert.ok(out.includes("&lt;img"), "it should appear escaped instead");
});
