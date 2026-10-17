const CATEGORIES = {
    securityAlert: [
      "hack", "exploit", "rug", "drain", "vulnerab", "attack",
      "phish", "compromis", "stolen", "malicious", "blacklist", "frozen",
    ],
    whaleMovement: [
      "minted", "burned", "transferred", "whale", "moved", "deposit", "withdraw",
    ],
    listing: [
      "listed", "listing", "launch", "upgrade", "integration", "partnership",
    ],
  };
  
  export function categorize(hits) {
    const counts = { securityAlert: 0, whaleMovement: 0, listing: 0, other: 0 };
    for (const h of hits) {
      const t = h.text.toLowerCase();
      let matched = false;
      for (const [cat, words] of Object.entries(CATEGORIES)) {
        if (words.some((w) => t.includes(w))) {
          counts[cat]++;
          matched = true;
          break;
        }
      }
      if (!matched) counts.other++;
    }
    return counts;
  }
  
  export function summarize(hits) {
    const categories = categorize(hits);
    return {
      alertMentions: hits.length,
      categories,
      channels: [...new Set(hits.map((h) => h.channel))],
      samples: hits.slice(0, 5).map((h) => ({
        channel: h.channel,
        text: h.text.slice(0, 200),
      })),
      // Exposed so a calling agent can reason about freshness — the scrape window
      // is a rolling cache, not a live stream, and security alerts on low-volume
      // channels may be up to 15 minutes old.
      lastCheckedAt: new Date().toISOString(),
      note:
      hits.length === 0
        ? "No mentions in the current rolling window (last 30 messages per tracked channel). Absence of alerts is not a safety guarantee."
        : categories.securityAlert === 0
          ? "No security-channel mentions in the current window. A contract flagged before the window will not appear here."
          : undefined,
    };
  }