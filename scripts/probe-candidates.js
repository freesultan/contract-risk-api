// Batch-runs the real scan logic against known mainnet contracts to find
// addresses that actually exercise proxy detection and the privileged-function
// flags. Uses the app's own modules directly, so results match what /scan
// returns -- no server, no payment.
import { fetchOnChainData } from "../src/chain.js";
import { analyzeBytecode } from "../src/heuristics.js";

const CANDIDATES = [
  // --- Ethereum ---
  ["ethereum", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "USDC (FiatTokenProxy)"],
  ["ethereum", "0xdAC17F958D2ee523a2206206994597C13D831ec7", "USDT"],
  ["ethereum", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "WBTC"],
  ["ethereum", "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84", "stETH (Lido)"],
  ["ethereum", "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", "Aave v3 Pool"],
  ["ethereum", "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9", "Aave v2 LendingPool"],
  ["ethereum", "0x6B175474E89094C44Da98b954EedeAC495271d0F", "DAI"],
  ["ethereum", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "WETH"],
  ["ethereum", "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", "UNI"],
  ["ethereum", "0x514910771AF9Ca656af840dff83E8264EcF986CA", "LINK"],
  ["ethereum", "0x5A98FcBEA516Cf06857215779Fd812CA3beF1B32", "LDO"],
  ["ethereum", "0x4d224452801ACEd8B2F0aebE155379bb5D594381", "APE"],
  ["ethereum", "0xba100000625a3754423978a60c9317c58a424e3D", "BAL"],
  ["ethereum", "0x111111111117dC0aa78b770fA6A738034120C302", "1INCH"],
  ["ethereum", "0x853d955aCEf822Db058eb8505911ED77F175b99e", "FRAX"],
  ["ethereum", "0xD533a949740bb3306d119CC777fa900bA034cd52", "CRV"],
  ["ethereum", "0x0000000000000000000000000000000000000000", "zero address (EOA case)"],

  // --- Base ---
  ["base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USDC (current default)"],
  ["base", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", "USDbC (bridged)"],
  ["base", "0x4200000000000000000000000000000000000006", "WETH (predeploy)"],
  ["base", "0x4200000000000000000000000000000000000010", "L2StandardBridge"],
  ["base", "0x4200000000000000000000000000000000000007", "L2CrossDomainMessenger"],
  ["base", "0x4200000000000000000000000000000000000011", "SequencerFeeVault"],
  ["base", "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", "cbETH"],
  ["base", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "cbBTC"],
  ["base", "0x940181a94A35A4569E4529A3CDfB74e38FD98631", "AERO"],
  ["base", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", "DAI"],
];

const results = [];
for (const [chain, address, label] of CANDIDATES) {
  try {
    const data = await fetchOnChainData(address, chain);
    const r = analyzeBytecode(data);
    results.push({ chain, address, label, ...r });
    const flagList = r.flags.map((f) => f.label.split(" (")[0].split(" —")[0]).join("; ");
    console.log(
      `${r.riskLevel.padEnd(7)} score=${String(r.riskScore).padEnd(3)} proxy=${String(r.isProxy).padEnd(5)} ${chain.padEnd(8)} ${label}`
    );
    if (flagList) console.log(`          flags: ${flagList}`);
  } catch (e) {
    console.log(`ERROR   ${chain} ${label}: ${e.message}`);
  }
}

console.log("\n=== BEST DEMO ADDRESSES ===");
const proxies = results.filter((r) => r.isProxy);
const rich = results.filter((r) => r.flags.length >= 2);
const scored = [...results].sort((a, b) => b.riskScore - a.riskScore).slice(0, 5);
console.log("proxy=true:", proxies.length, proxies.map((p) => `${p.label} (${p.chain})`).join(", ") || "none");
console.log(">=2 flags:", rich.length, rich.map((p) => `${p.label} (${p.chain})`).join(", ") || "none");
console.log("highest scores:", scored.map((s) => `${s.label}=${s.riskScore}`).join(", "));
