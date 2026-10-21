// src/telegram-notify.js

/**
 * Fire-and-forget Telegram notification.
 * Does not throw on failure — a notification failure must never break an API response.
 *
 * No `parse_mode` is set deliberately. The messages carry user-supplied values
 * (addresses, tickers) plus punctuation like "($0.02)" and "medium (10)".
 * Under MarkdownV2 every one of `_ * [ ] ( ) ~ ` > # + - = | { } . !` must be
 * escaped, and any unescaped occurrence causes Telegram to return 400 — which
 * this function swallows by design, so the notification vanishes with no error
 * in the logs. Plain text has no such failure mode.
 *
 * Vercel caveat: after res.json() the function may be frozen before this fetch
 * completes, so an occasional notification can drop under cold-start. If that
 * becomes a problem, wrap the call site in `waitUntil()` from
 * `@vercel/functions`.
 */
export async function notifyTelegram(text) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHANNEL_ID;
  
    // Not configured → no-op. Keeps local/free-test mode working without secrets.
    if (!token || !chatId) return;
  
    try {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      });
    } catch (err) {
      // Deliberately swallowed. A Telegram outage must not surface as an API error.
      console.error("Telegram notify failed:", err.message);
    }
  }