import test from "node:test";
import assert from "node:assert/strict";
import { analyzeBytecode, riskLevel } from "../src/heuristics.js";
import { FLAGGED_SELECTORS, EIP1967_IMPLEMENTATION_SLOT } from "../src/selectors.js";

const ZERO_SLOT = "0x" + "0".repeat(64);

function bytecodeWithSelectors(selectors) {
  // Minimal synthetic bytecode: each selector embedded as PUSH4 <selector>,
  // matching the real Solidity dispatcher pattern our heuristic searches for.
  return "0x" + selectors.map((s) => "63" + s).join("5b");
}

test("EOA (no code) is reported as not-a-contract with unknown risk", () => {
  const result = analyzeBytecode({ bytecode: "0x", implementationSlotValue: ZERO_SLOT });
  assert.equal(result.isContract, false);
  assert.equal(result.riskLevel, "unknown");
  assert.deepEqual(result.flags, []);
});

test("plain contract with no flagged selectors and no proxy slot scores low risk", () => {
  const bytecode = bytecodeWithSelectors([]) + "6080604052"; // arbitrary non-matching bytes
  const result = analyzeBytecode({ bytecode, implementationSlotValue: ZERO_SLOT });
  assert.equal(result.isContract, true);
  assert.equal(result.isProxy, false);
  assert.equal(result.riskLevel, "low");
  assert.equal(result.riskScore, 0);
});

test("EIP-1967 proxy (non-zero implementation slot) is flagged as proxy", () => {
  const bytecode = bytecodeWithSelectors([]) + "6080604052"; // needs non-empty code to count as a contract
  const nonZeroSlot = "0x" + "1".repeat(64);
  const result = analyzeBytecode({ bytecode, implementationSlotValue: nonZeroSlot });
  assert.equal(result.isProxy, true);
  assert.ok(result.flags.some((f) => f.label.includes("upgradeable proxy")));
  assert.ok(result.riskScore >= 10);
});

test("mint() + blacklist() selectors push risk to high", () => {
  const mint = FLAGGED_SELECTORS.find((f) => f.sig === "mint(address,uint256)").selector;
  const blacklist = FLAGGED_SELECTORS.find((f) => f.sig === "blacklist(address)").selector;
  const bytecode = bytecodeWithSelectors([mint, blacklist]);
  const result = analyzeBytecode({ bytecode, implementationSlotValue: ZERO_SLOT });
  assert.equal(result.riskLevel, "high");
  assert.equal(result.flags.length, 2);
});

test("owner() alone (no dangerous privileged functions) stays low/medium, not high", () => {
  const owner = FLAGGED_SELECTORS.find((f) => f.sig === "owner()").selector;
  const bytecode = bytecodeWithSelectors([owner]);
  const result = analyzeBytecode({ bytecode, implementationSlotValue: ZERO_SLOT });
  assert.notEqual(result.riskLevel, "high");
});

test("riskLevel() boundaries match documented thresholds", () => {
  assert.equal(riskLevel(0), "low");
  assert.equal(riskLevel(9), "low");
  assert.equal(riskLevel(10), "medium");
  assert.equal(riskLevel(29), "medium");
  assert.equal(riskLevel(30), "high");
});

test("EIP1967_IMPLEMENTATION_SLOT is a well-formed 32-byte hex value", () => {
  assert.match(EIP1967_IMPLEMENTATION_SLOT, /^0x[0-9a-f]{64}$/);
});
