import { id, keccak256, toUtf8Bytes, toBigInt, zeroPadValue, toBeHex } from "ethers";

// Computed at load time from canonical signatures/names instead of hardcoded
// hex literals, so correctness never depends on a memorized or fetched constant.
function eip1967Slot(name) {
  const hash = keccak256(toUtf8Bytes(name));
  const minusOne = toBigInt(hash) - 1n;
  return zeroPadValue(toBeHex(minusOne), 32);
}

export const EIP1967_IMPLEMENTATION_SLOT = eip1967Slot("eip1967.proxy.implementation");

// signature -> { selector, weight, label }
// weight is added to the risk score if the selector's PUSH4 pattern is found
// in the runtime bytecode. These are owner/admin-privilege style functions;
// their presence is a signal, not proof of malicious intent.
const FLAGGED_SIGNATURES = [
  { sig: "renounceOwnership()", weight: 0, label: "has renounceOwnership() (informational)" },
  { sig: "owner()", weight: 5, label: "has an owner() function (centralized control)" },
  { sig: "transferOwnership(address)", weight: 5, label: "owner can transfer ownership" },
  { sig: "mint(address,uint256)", weight: 15, label: "owner/admin can mint new tokens" },
  { sig: "pause()", weight: 10, label: "owner/admin can pause transfers" },
  { sig: "unpause()", weight: 0, label: "has unpause() (paired with pause())" },
  { sig: "blacklist(address)", weight: 20, label: "owner/admin can blacklist addresses" },
  { sig: "setBlacklist(address,bool)", weight: 20, label: "owner/admin can blacklist addresses" },
  { sig: "excludeFromFee(address)", weight: 5, label: "has fee-exclusion logic (common in tax tokens)" },
  { sig: "setTaxFee(uint256)", weight: 15, label: "owner/admin can change transfer tax at will" },
];

export const FLAGGED_SELECTORS = FLAGGED_SIGNATURES.map((f) => ({
  ...f,
  selector: id(f.sig).slice(2, 10), // 4 bytes, no "0x" prefix, for bytecode search
}));
