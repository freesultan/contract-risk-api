import { ethers } from "ethers";
import { EIP1967_IMPLEMENTATION_SLOT } from "./selectors.js";

// Free, no-signup public RPC endpoints. Configurable via env for later
// upgrade to a dedicated provider (that step requires approval — see README).
const DEFAULT_RPC_URLS = {
  base: process.env.RPC_URL_BASE || "https://mainnet.base.org",
  ethereum: process.env.RPC_URL_ETHEREUM || "https://ethereum-rpc.publicnode.com",
};

function getProvider(chain) {
  const url = DEFAULT_RPC_URLS[chain];
  if (!url) {
    const supported = Object.keys(DEFAULT_RPC_URLS).join(", ");
    throw new Error(`Unsupported chain "${chain}". Supported: ${supported}`);
  }
  return new ethers.JsonRpcProvider(url);
}

export async function fetchOnChainData(address, chain) {
  if (!ethers.isAddress(address)) {
    // A mixed-case address that is 40 hex chars long but fails isAddress has a
    // bad EIP-55 checksum. Keep rejecting it — that check exists to catch
    // typos — but say so, because the same address lowercased is accepted and
    // a bare "Invalid address" makes that look arbitrary.
    if (/^0x[0-9a-fA-F]{40}$/.test(address) && address !== address.toLowerCase()) {
      throw new Error(
        "Invalid address: failed EIP-55 checksum (capitalization doesn't match). " +
          "Re-copy it, or pass it in all lowercase to skip the checksum check."
      );
    }
    throw new Error("Invalid address: expected a 0x-prefixed 40-character hex address");
  }
  const provider = getProvider(chain);
  const [bytecode, implementationSlotValue] = await Promise.all([
    provider.getCode(address),
    provider.getStorage(address, EIP1967_IMPLEMENTATION_SLOT),
  ]);
  return { bytecode, implementationSlotValue };
}

export { DEFAULT_RPC_URLS };
