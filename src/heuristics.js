import { EIP1967_IMPLEMENTATION_SLOT, FLAGGED_SELECTORS } from "./selectors.js";

const ZERO_SLOT = "0x" + "0".repeat(64);

// Exported so the docs and the UI's scoring table are generated from the same
// numbers the scorer uses, and can't drift from it.
export const PROXY_WEIGHT = 10;

export const RISK_THRESHOLDS = { medium: 10, high: 30 };

function normalizeHex(hex) {
  return (hex || "").toLowerCase().replace(/^0x/, "");
}

// Detects PUSH4 <selector> (opcode 0x63) — the standard Solidity function
// dispatcher pattern. This is a substring heuristic: it can miss obfuscated
// dispatchers and (rarely) false-positive on constructor/data segments.
// It is a signal, not proof.
function hasSelector(bytecodeHex, selector) {
  return normalizeHex(bytecodeHex).includes("63" + selector);
}

export function riskLevel(score) {
  if (score >= RISK_THRESHOLDS.high) return "high";
  if (score >= RISK_THRESHOLDS.medium) return "medium";
  return "low";
}

/**
 * Pure heuristic scan — no network calls. Takes already-fetched on-chain
 * data so it can be unit-tested without an RPC connection.
 *
 * @param {object} input
 * @param {string} input.bytecode - runtime bytecode hex (0x-prefixed), or "0x" for an EOA
 * @param {string} input.implementationSlotValue - raw storage read at the EIP-1967 slot (0x-prefixed bytes32)
 */
export function analyzeBytecode({ bytecode, implementationSlotValue }) {
  const code = normalizeHex(bytecode);
  const isContract = code.length > 0;

  if (!isContract) {
    return {
      isContract: false,
      isProxy: false,
      flags: [],
      riskScore: 0,
      riskLevel: "unknown",
      note: "Address has no contract code (EOA or not yet deployed).",
    };
  }

  const isProxy =
    !!implementationSlotValue && implementationSlotValue.toLowerCase() !== ZERO_SLOT;

  const flags = [];
  let score = 0;

  if (isProxy) {
    flags.push({
      label: "upgradeable proxy (EIP-1967) — logic can be swapped by admin",
      weight: PROXY_WEIGHT,
    });
    score += PROXY_WEIGHT;
  }

  for (const f of FLAGGED_SELECTORS) {
    if (hasSelector(code, f.selector)) {
      if (f.weight > 0) {
        flags.push({ label: f.label, weight: f.weight });
      }
      score += f.weight;
    }
  }

  return {
    isContract: true,
    isProxy,
    flags,
    riskScore: score,
    riskLevel: riskLevel(score),
  };
}
