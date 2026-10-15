import assert from "node:assert/strict";
import test from "node:test";
import { fetchOpenRouterUsage } from "../src/providers/openrouter.ts";
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
test("OpenRouter account credits, key allowance and trailing seven-day spend have separate scopes", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/key")) return json({ data: { usage: 20, limit_remaining: 3, label: "secret key label" } });
    if (String(url).endsWith("/credits")) return json({ data: { total_credits: "100.00", total_usage: 27.25 } });
    return json({ data: { data: [{ model: "a", total_usage: 2 }, { model: "b", total_usage: "4.75" }], metadata: { truncated: false } } });
  }) as typeof fetch;
  try {
    const result = await fetchOpenRouterUsage("regular", "management");
    assert.equal(result.credits_balance, 72.75); assert.equal(result.limit_remaining, 3);
    assert.equal(result.spend_7d, 6.75); assert.equal(result.usage, 20);
    const query = JSON.parse(String(calls.find(c => c.url.endsWith("/query"))?.init?.body));
    assert.deepEqual(query.dimensions, ["model"]); assert.deepEqual(query.metrics, ["total_usage"]);
    assert.equal(Date.parse(query.time_range.end) - Date.parse(query.time_range.start), 7 * 86400000);
    assert.equal(query.time_range.start, result.spend_start);
  } finally { globalThis.fetch = original; }
});
test("missing credit/analytics responses stay unknown while key usage remains available", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async url => String(url).endsWith("/key") ? json({ data: { usage: 0 } }) : json({}, 403)) as typeof fetch;
  try {
    const r = await fetchOpenRouterUsage("regular");
    assert.equal(r.usage, 0); assert.equal(r.credits_balance, null); assert.equal(r.spend_7d, null);
    assert.equal(r.balance_error, true); assert.equal(r.spend_error, true);
  } finally { globalThis.fetch = original; }
});
test("truncated analytics never reports partial spending", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async url => String(url).endsWith("/query") ? json({ data: { data: [{total_usage: 1}], metadata: {truncated: true} } }) : json({data: {}})) as typeof fetch;
  try { assert.equal((await fetchOpenRouterUsage("key", "management")).spend_7d, null); } finally { globalThis.fetch = original; }
});
