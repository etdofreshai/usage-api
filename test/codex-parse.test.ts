import assert from "node:assert/strict";
import test from "node:test";
import { parseCodexUsage, parseResetCredits } from "../src/providers/codex.ts";

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
