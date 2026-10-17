const CACHE = new Map();
const TTL_MS = 5 * 60 * 1000;

// Low-volume channels can show 0 messages within the standard TTL even when
// there's real news — the preview is slow to update. Give them a longer cache
// so a single security alert stays visible across several requests.
const LOW_VOLUME_CHANNELS = new Set(["PeckShieldAlert"]);
const LOW_VOLUME_TTL_MS = 15 * 60 * 1000;

export async function fetchChannel(channel) {
  const cached = CACHE.get(channel);
  const ttl = LOW_VOLUME_CHANNELS.has(channel) ? LOW_VOLUME_TTL_MS : TTL_MS;
  if (cached && Date.now() - cached.ts < ttl) return cached.messages;

  const res = await fetch(`https://t.me/s/${channel}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; ContractRiskAPI/1.0)" },
  });
  if (!res.ok) return [];
  const html = await res.text();

  // t.me/s/ wraps each message in <div class="tgme_widget_message_text">...</div>
  const messages = [];
  const re = /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const text = m[1]
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\s*/gu, "")
      .replace(/\s*Details\s*$/i, "")
      .replace(/Tx:\s*https?:\/\/\S+/gi, "")
      .replace(/https?:\/\/\S+/g, "")
      .trim();
    if (text) messages.push(text);
  }
  CACHE.set(channel, { ts: Date.now(), messages: messages.slice(-30) });
  return CACHE.get(channel).messages;
}

export async function searchChannels(term, channels) {
  const hits = [];
  await Promise.all(channels.map(async (ch) => {
    const msgs = await fetchChannel(ch);
    for (const text of msgs) {
      if (text.toLowerCase().includes(term.toLowerCase())) {
        hits.push({ channel: ch, text });
      }
    }
  }));
  return hits;
}