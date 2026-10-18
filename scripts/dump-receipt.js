// Decode the x402 payment headers from a saved curl -i response.
//
//   curl.exe -s -i -X POST http://localhost:3000/v1/alert-check `
//     -H "Content-Type: application/json" -d '{\"address\":\"USDC\"}' |
//     Out-File -Encoding utf8 resp402.txt
//   node scripts/dump-receipt.js resp402.txt
//
// PowerShell's `>` writes UTF-16LE on 5.1 and UTF-8 on 7+; sniff the BOM so
// this works either way.
import fs from "fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/dump-receipt.js <saved-curl-response.txt>");
  process.exit(1);
}

const buf = fs.readFileSync(file);
let text;
if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
  text = buf.slice(2).toString("utf16le");
} else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
  const swapped = Buffer.from(buf.slice(2));
  swapped.swap16();
  text = swapped.toString("utf16le");
} else if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
  text = buf.slice(3).toString("utf8");
} else {
  text = buf.toString("utf8");
}

// Line-scan rather than block-regex: a single malformed line can't break the
// match, and the split is independent of any blank-line assumptions.
function header(name) {
  const upper = name.toUpperCase();
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim().toUpperCase() === upper) {
      return line.slice(idx + 1).trim();
    }
  }
  return null;
}

for (const name of ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"]) {
  const value = header(name);
  console.log(`\n=== ${name} ===`);
  if (!value) {
    console.log("(absent)");
    continue;
  }
  console.log(`(raw ${value.length} chars)`);

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64").toString("utf8"));
  } catch (e) {
    console.log(`(decode failed: ${e.message})`);
    continue;
  }

  const ext = parsed?.extensions?.["offer-receipt"];
  console.log("offer-receipt present:", Boolean(ext));

  if (ext?.info?.offers) {
    console.log(`offers: ${ext.info.offers.length}`);
    for (const [i, o] of ext.info.offers.entries()) {
      console.log(`  [${i}] format=${o.format} acceptIndex=${o.acceptIndex} sigLen=${o.signature?.length ?? 0}`);
      const p = o.payload ?? {};
      if (p.resourceUrl) {
        console.log(`       resourceUrl=${p.resourceUrl}`);
        console.log(`       network=${p.network} asset=${p.asset}`);
        console.log(`       payTo=${p.payTo} amount=${p.amount}`);
        if (typeof p.validUntil === "number") {
          console.log(`       validUntil=${p.validUntil} (${new Date(p.validUntil * 1000).toISOString()})`);
        }
      }
    }
  }

  if (ext?.info?.receipt) {
    console.log("receipt:", JSON.stringify(ext.info.receipt, null, 2));
  }
}