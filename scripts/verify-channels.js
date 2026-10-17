import { fetchChannel } from "../src/telegram.js";

const CANDIDATES = [
  // confirmed working from your test:
  "whale_alert_io", "PeckShieldAlert", "CertiKAlert",
  "base_news", "rekt_news", "thedefiedge",
  // additional candidates:
  "whale_alert", "DefiLlama", "Lookonchain", "lookonchain",
  "bancor", "Uniswap", "Aave", "ChainLinkGod",
  "Ethereum", "ethereum_news", "soliditylang",
  "immunefi", "code4rena", "sherlockdefi",
  "l2beat", "Optimism", "arbitrum", "arbitrum_news",
  "base", "coinbase", "Binance",
  "cryptoquant", "glassnode", "santiment",
  "crypto_alerts", "degen_alerts", "token_alerts",
];

const UA = "Mozilla/5.0 (compatible; ContractRiskAPI/1.0)";
const MSG_RE = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;

async function probe(channel) {
  const url = `https://t.me/s/${channel}`;
  let status = 0, html = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    status = res.status;
    html = await res.text();
  } catch (err) {
    return { status: "ERR", count: 0, size: 0, note: err.message };
  }
  // count using the same regex as telegram.js, so the number matches production
  let count = 0;
  MSG_RE.lastIndex = 0;
  while (MSG_RE.exec(html)) count++;
  return { status, count, size: html.length };
}

console.log("http  msgs   size  channel");
console.log("----  ----  -----  -------");
for (const c of CANDIDATES) {
  const { status, count, size, note } = await probe(c);
  const s = String(status).padStart(4);
  const m = String(count).padStart(4);
  const b = String(size).padStart(6);
  console.log(`${s}  ${m}  ${b}  ${c}${note ? "  [" + note + "]" : ""}`);
  await new Promise((r) => setTimeout(r, 200)); // be polite to t.me
}