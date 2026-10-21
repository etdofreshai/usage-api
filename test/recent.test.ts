import assert from "node:assert/strict";
import test from "node:test";
import { RecentRequests, parseRecentExchanges } from "../src/recent.js";

test("recent requests are bounded, newest first, and exclude credentials and private metadata", () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ timestamp_ms: 1700000000000 + i,
    model: "gpt-6.1-sol", resolved_model: "gpt-6.1-sol", reasoning_effort: "high", failed: i === 24,
    access_token_sha256: "private", api_key_hash: "private", account_snapshot: "private", client_ip: "private" }));
  const rows = parseRecentExchanges({ events: { items } });
  assert.equal(rows.length, 20);
  assert.equal(rows[0].outcome, "error");
  assert.equal(rows[0].jev.effort, "high");
  assert.ok(rows[0].startedAt > rows[19].startedAt);
  assert.ok(!JSON.stringify(rows).includes("private"));
});

test("monitor requests share the same short-lived history cache", async () => {
  let count = 0;
  const recent = new RecentRequests("http://manager", "secret", (async (_url, init) => {
    count++;
    const request = JSON.parse(String(init?.body));
    assert.equal(request.include.events_page.limit, 20);
    return new Response(JSON.stringify({ events: { items: [] } }));
  }) as typeof fetch);
  await Promise.all([recent.get(), recent.get()]);
  await recent.get();
  assert.equal(count, 1);
});
