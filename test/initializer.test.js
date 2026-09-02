// Covers the lazy facilitator initializer.
//
// This exists because @x402/express fires initialize() at module load and
// memoizes the promise. On a frozen serverless instance that promise can
// reject unseen, and every later request gets the cached rejection back —
// observed in production as a 502 "timed out after 30000ms" returned in under
// a second. The initializer must therefore retry rather than cache a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createInitializer } from "../src/payment.js";

test("initializes once and does not re-initialize on later calls", async () => {
  let calls = 0;
  const ensure = createInitializer({
    initialize: async () => {
      calls++;
    },
  });
  await ensure();
  await ensure();
  await ensure();
  assert.equal(calls, 1);
});

test("retries after a failure instead of caching the rejection", async () => {
  let calls = 0;
  const ensure = createInitializer({
    initialize: async () => {
      calls++;
      if (calls === 1) throw new Error("supported request timed out after 30000ms");
    },
  });

  await assert.rejects(ensure(), /timed out/);
  // The retry must actually re-run initialize, not hand back the failure.
  await ensure();
  assert.equal(calls, 2);

  // And once it has succeeded it stays initialized.
  await ensure();
  assert.equal(calls, 2);
});

test("concurrent callers share one in-flight initialization", async () => {
  let calls = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const ensure = createInitializer({
    initialize: async () => {
      calls++;
      await gate;
    },
  });

  const all = Promise.all([ensure(), ensure(), ensure()]);
  release();
  await all;
  assert.equal(calls, 1, "three concurrent callers should trigger one initialize");
});

test("a failure rejects every concurrent caller, and a later call retries", async () => {
  let calls = 0;
  const ensure = createInitializer({
    initialize: async () => {
      calls++;
      if (calls === 1) throw new Error("boom");
    },
  });

  const results = await Promise.allSettled([ensure(), ensure()]);
  assert.ok(results.every((r) => r.status === "rejected"));
  assert.equal(calls, 1);

  await ensure();
  assert.equal(calls, 2);
});
