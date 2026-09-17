import assert from "node:assert/strict";
import test from "node:test";
import { RateLimitError } from "../src/cache.ts";
import { createCodexUsageFetcher, parseCodexUsage, parseResetCredits } from "../src/providers/codex.ts";
import type { RouterConnection } from "../src/providers/ninerouter.ts";

const fiveHourRaw = {
  used_percent: 18,
  limit_window_seconds: 5 * 60 * 60,
  reset_at: 1785000000,
};
const sevenDayRaw = {
  used_percent: 42,
  limit_window_seconds: 7 * 24 * 60 * 60,
  reset_at: 1785259658,
};

const usageResponse = (extra: object = {}) => new Response(JSON.stringify({
  plan_type: "pro",
  rate_limit: { primary_window: fiveHourRaw, secondary_window: sevenDayRaw },
  ...extra,
}), { headers: { "Content-Type": "application/json" } });

const connection = (accessToken: string): RouterConnection => ({
  id: "conn-1",
  provider: "codex",
  name: "etdofresh@gmail.com",
  email: "etdofresh@gmail.com",
  accessToken,
  expiresAt: null,
});

function headersOf(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

// 9router owns the OAuth account and refreshes the token; usage-api must send
// whatever token the connection store currently holds, without caching one of
// its own across calls.
test("Codex usage is requested with the token 9router currently holds", async () => {
  const seen: string[] = [];
  let current = "first-token";
  const fetcher = createCodexUsageFetcher({
    resolveConnection: (account) => {
      assert.equal(account, "etdofresh@gmail.com");
      return connection(current);
    },
    fetchImpl: (async (_input, init) => {
      seen.push(String(headersOf(init).get("Authorization")));
      return usageResponse();
    }) as typeof fetch,
  });

  await fetcher("etdofresh@gmail.com");
  current = "rotated-token";
  await fetcher("etdofresh@gmail.com");

  assert.deepEqual(seen, ["Bearer first-token", "Bearer rotated-token"]);
});

// The usage response already carries the count, so the detail request only
// earns its keep when there is a credit to describe.
test("reset-credit detail is skipped when the usage response reports none available", async () => {
  const urls: string[] = [];
  const fetcher = createCodexUsageFetcher({
    resolveConnection: () => connection("token"),
    fetchImpl: (async (input) => {
      urls.push(String(input));
      return usageResponse({ rate_limit_reset_credits: { available_count: 0 } });
    }) as typeof fetch,
  });

  const usage = await fetcher();

  assert.deepEqual(urls, ["https://chatgpt.com/backend-api/wham/usage"]);
  assert.deepEqual(usage.reset_credits, { available_count: 0, next_expires_at: null, credits: [] });
});

test("reset-credit detail is fetched when the usage response reports credits", async () => {
  const urls: string[] = [];
  const fetcher = createCodexUsageFetcher({
    resolveConnection: () => connection("token"),
    fetchImpl: (async (input) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/rate-limit-reset-credits")) {
        return new Response(JSON.stringify({
          available_count: 1,
          credits: [{ status: "available", granted_at: "2026-09-01T00:00:00Z", expires_at: "2026-09-30T00:00:00Z" }],
        }), { headers: { "Content-Type": "application/json" } });
      }
      return usageResponse({ rate_limit_reset_credits: { available_count: 1 } });
    }) as typeof fetch,
  });

  const usage = await fetcher();

  assert.equal(urls.length, 2);
  assert.equal(usage.reset_credits?.available_count, 1);
  assert.equal(usage.reset_credits?.next_expires_at, "2026-09-30T00:00:00Z");
});

// A 429 must reach the poller as a RateLimitError so it backs off rather than
// hammering OpenAI on the next tick.
test("a rate-limited usage response surfaces Retry-After to the poller", async () => {
  const fetcher = createCodexUsageFetcher({
    resolveConnection: () => connection("token"),
    fetchImpl: (async () => new Response("", { status: 429, headers: { "retry-after": "120" } })) as typeof fetch,
  });

  await assert.rejects(fetcher(), (err: unknown) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.retryAfterSec, 120);
    return true;
  });
});

test("parseCodexUsage classifies the normal 5-hour and 7-day windows by duration", () => {
  const parsed = parseCodexUsage({
    plan_type: "pro",
    rate_limit: { primary_window: fiveHourRaw, secondary_window: sevenDayRaw },
  });

  assert.equal(parsed.five_hour?.used_percent, 18);
  assert.equal(parsed.five_hour?.window_minutes, 300);
  assert.equal(parsed.seven_day?.used_percent, 42);
  assert.equal(parsed.seven_day?.window_minutes, 10080);
  assert.deepEqual(parsed.primary, parsed.five_hour);
  assert.deepEqual(parsed.secondary, parsed.seven_day);
});

test("parseCodexUsage reports a suspended 5-hour window as null when weekly usage moves to primary", () => {
  const parsed = parseCodexUsage({
    plan_type: "pro",
    rate_limit: { primary_window: sevenDayRaw, secondary_window: null },
    additional_rate_limits: [{
      limit_name: "GPT-5.3-Codex-Spark",
      metered_feature: "codex_bengalfox",
      rate_limit: { primary_window: { ...sevenDayRaw, used_percent: 1 }, secondary_window: null },
    }],
  });

  assert.equal(parsed.five_hour, null);
  assert.equal(parsed.primary, null);
  assert.equal(parsed.seven_day?.used_percent, 42);
  assert.deepEqual(parsed.secondary, parsed.seven_day);
  assert.equal(parsed.additional[0].five_hour, null);
  assert.equal(parsed.additional[0].primary, null);
  assert.equal(parsed.additional[0].seven_day?.used_percent, 1);
  assert.deepEqual(parsed.additional[0].secondary, parsed.additional[0].seven_day);
});

test("parseCodexUsage does not manufacture zero-valued windows when both are absent", () => {
  const parsed = parseCodexUsage({ rate_limit: { primary_window: null, secondary_window: null } });
  assert.equal(parsed.five_hour, null);
  assert.equal(parsed.seven_day, null);
  assert.equal(parsed.primary, null);
  assert.equal(parsed.secondary, null);
});

test("parseResetCredits picks the soonest expiry among available credits", () => {
  const parsed = parseResetCredits({
    credits: [
      { status: "available", granted_at: "2026-06-26T23:51:22Z", expires_at: "2026-07-26T23:51:22Z" },
      { status: "available", granted_at: "2026-06-18T00:35:11Z", expires_at: "2026-07-18T00:35:11Z" },
      { status: "redeemed", granted_at: "2026-05-01T00:00:00Z", expires_at: "2026-05-31T00:00:00Z" },
      { status: "available", granted_at: "2026-07-12T21:09:48Z", expires_at: "2026-08-11T21:09:48Z" },
    ],
    available_count: 3,
  });

  assert.equal(parsed.available_count, 3);
  // Redeemed credit's earlier expiry must not win — only available ones count.
  assert.equal(parsed.next_expires_at, "2026-07-18T00:35:11Z");
  assert.equal(parsed.credits.length, 4);
  assert.deepEqual(parsed.credits[1], {
    status: "available",
    granted_at: "2026-06-18T00:35:11Z",
    expires_at: "2026-07-18T00:35:11Z",
  });
});

test("parseResetCredits derives available_count when the summary field is absent", () => {
  const parsed = parseResetCredits({
    credits: [
      { status: "available", expires_at: "2026-08-01T00:00:00Z" },
      { status: "redeemed", expires_at: "2026-07-01T00:00:00Z" },
    ],
  });
  assert.equal(parsed.available_count, 1);
  assert.equal(parsed.next_expires_at, "2026-08-01T00:00:00Z");
});

test("parseResetCredits handles empty and malformed responses", () => {
  assert.deepEqual(parseResetCredits({}), {
    available_count: 0,
    next_expires_at: null,
    credits: [],
  });
  const sparse = parseResetCredits({ credits: [{}], available_count: 0 });
  assert.deepEqual(sparse.credits, [{ status: null, granted_at: null, expires_at: null }]);
  assert.equal(sparse.next_expires_at, null);
});
