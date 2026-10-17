// Verified working: 2026-10-14 via scripts/verify-channels.js
// Telegram disables /s/ previews over time — re-run the verifier monthly or if
// hit rates drop in production.
//
// Selection criteria: ≥3 messages in the verifier run, OR a canonical source
// whose single message is high-signal for pre-trade safety checks (PeckShieldAlert).
// Dropped all channels returning 0 messages, and non-safety ecosystem channels
// (soliditylang, sherlockdefi) that don't map to the risk categories.
export const TRACKED_CHANNELS = [
  // on-chain movement — feeds `whaleMovement` category
  "whale_alert_io",
  "whale_alert",

  // security alerts — feeds `securityAlert` category (highest signal)
  "PeckShieldAlert",
  "CertiKAlert",
  "rekt_news",
  "immunefi",

  // ecosystem news — feeds `listing` / general context
  "base_news",
  "arbitrum",
  "glassnode",
  "token_alerts",
];