import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCodexUsageFetcher, parseCodexUsage, parseResetCredits } from "../src/providers/codex.ts";

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

const usageResponse = () => new Response(JSON.stringify({
  plan_type: "pro",
  rate_limit: { primary_window: fiveHourRaw, secondary_window: sevenDayRaw },
}), { headers: { "Content-Type": "application/json" } });

async function withAuthFile<T>(auth: object, run: (authPath: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(path.join(tmpdir(), "usage-api-codex-auth-"));
  const authPath = path.join(directory, "auth.json");
  await writeFile(authPath, JSON.stringify(auth), { mode: 0o600 });
  try {
    return await run(authPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function headersOf(init?: RequestInit): Headers {
  return new Headers(init?.headers);
}

test("Codex refresh persists a rotated refresh token with the new access token", async () => {
  await withAuthFile({ tokens: { access_token: "old-access", refresh_token: "old-refresh", account_id: "account" }, preserved: true }, async (authPath) => {
    const fetcher = createCodexUsageFetcher({
      authPath,
      fetchImpl: (async (input, init) => {
        const url = String(input);
        if (url === "https://auth.openai.com/oauth/token") {
          assert.match(String(init?.body), /old-refresh/);
          return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }), { headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith("/rate-limit-reset-credits")) return new Response("", { status: 404 });
        if (headersOf(init).get("Authorization") === "Bearer old-access") return new Response("", { status: 401 });
        assert.equal(headersOf(init).get("Authorization"), "Bearer new-access");
        assert.equal(headersOf(init).get("ChatGPT-Account-Id"), "account");
        return usageResponse();
      }) as typeof fetch,
    });

    const usage = await fetcher();
    assert.equal(usage.five_hour?.used_percent, 18);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), {
      tokens: { access_token: "new-access", refresh_token: "new-refresh", account_id: "account" },
      preserved: true,
    });
  });
});

test("Codex refresh is single-flight for concurrent 401 responses", async () => {
  await withAuthFile({ access_token: "old-access", refresh_token: "old-refresh" }, async (authPath) => {
    let refreshCalls = 0;
    let releaseRefresh!: () => void;
    const refreshReleased = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => { refreshStarted = resolve; });
    const fetcher = createCodexUsageFetcher({
      authPath,
      fetchImpl: (async (input, init) => {
        const url = String(input);
        if (url === "https://auth.openai.com/oauth/token") {
          refreshCalls += 1;
          refreshStarted();
          await refreshReleased;
          return new Response(JSON.stringify({ access_token: "new-access", refresh_token: "new-refresh" }), { headers: { "Content-Type": "application/json" } });
        }
        if (url.endsWith("/rate-limit-reset-credits")) return new Response("", { status: 404 });
        return headersOf(init).get("Authorization") === "Bearer old-access"
          ? new Response("", { status: 401 })
          : usageResponse();
      }) as typeof fetch,
    });

    const first = fetcher();
    await started;
    const second = fetcher();
    await Promise.resolve();
    assert.equal(refreshCalls, 1);
    releaseRefresh();
    await Promise.all([first, second]);
    assert.equal(refreshCalls, 1);
  });
});

test("failed Codex refresh leaves credentials unchanged", async () => {
  const original = { access_token: "old-access", refresh_token: "old-refresh", account_id: "account" };
  await withAuthFile(original, async (authPath) => {
    const fetcher = createCodexUsageFetcher({
      authPath,
      fetchImpl: (async (input) => String(input) === "https://auth.openai.com/oauth/token"
        ? new Response(JSON.stringify({ error: "rejected" }), { status: 401, headers: { "Content-Type": "application/json" } })
        : new Response("", { status: 401 })) as typeof fetch,
    });

    await assert.rejects(fetcher(), /codex token refresh failed: HTTP 401/);
    assert.deepEqual(JSON.parse(await readFile(authPath, "utf8")), original);
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
