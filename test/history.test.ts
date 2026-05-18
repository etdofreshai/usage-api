import assert from "node:assert/strict";
import test from "node:test";
import { HistoryStore, extractUsageMetrics } from "../src/history.ts";

test("extractUsageMetrics finds percentage windows without token details", () => {
  const metrics = extractUsageMetrics({
    five_hour: { utilization: 12.5, expected_percent: 20, resets_at: "2026-01-01T05:00:00.000Z" },
    monthly: { used_percent: 34.25, expected_percent: 50.5, resets_at: "2026-02-01T00:00:00.000Z" },
    ignored: { current: 10, limit: 20 },
  });

  assert.deepEqual(metrics, [
    { metric: "five_hour", value: 12.5, expectedValue: 20, resetIso: "2026-01-01T05:00:00.000Z" },
    { metric: "monthly", value: 34.25, expectedValue: 50.5, resetIso: "2026-02-01T00:00:00.000Z" },
  ]);
});

test("HistoryStore includes expected usage percentage in fine and aggregate graph points", () => {
  const store = new HistoryStore({ retentionMs: 8 * 24 * 60 * 60 * 1000 });

  store.recordProvider("codex", { primary: { used_percent: 10, expected_percent: 20, resets_at: null } }, new Date("2026-01-02T01:10:00.000Z"));
  store.recordProvider("codex", { primary: { used_percent: 20, expected_percent: 30, resets_at: null } }, new Date("2026-01-02T01:40:00.000Z"));

  const fine = store.toSeries("fine");
  const hourly = store.toSeries("hourly");

  assert.deepEqual(fine.series[0].points.map((p) => p.expectedValue), [20, 30]);
  assert.deepEqual(hourly.series[0].points.map((p) => p.expectedValue), [25]);
});

test("HistoryStore retains only the last eight days of refresh samples", () => {
  const store = new HistoryStore({ retentionMs: 8 * 24 * 60 * 60 * 1000 });

  store.recordProvider("claude", { five_hour: { utilization: 1, resets_at: null } }, new Date("2026-01-01T00:00:00.000Z"));
  store.recordProvider("claude", { five_hour: { utilization: 2, resets_at: null } }, new Date("2026-01-08T23:59:00.000Z"));
  store.recordProvider("claude", { five_hour: { utilization: 3, resets_at: null } }, new Date("2026-01-09T00:01:00.000Z"));

  const fine = store.toSeries("fine");

  assert.equal(fine.series.length, 1);
  assert.deepEqual(fine.series[0].points.map((p) => p.value), [2, 3]);
});

test("HistoryStore keeps usage samples indefinitely by default", () => {
  const store = new HistoryStore();

  store.recordProvider("claude", { five_hour: { utilization: 1, resets_at: null } }, new Date("2020-01-01T00:00:00.000Z"));
  store.recordProvider("claude", { five_hour: { utilization: 2, resets_at: null } }, new Date("2026-01-09T00:01:00.000Z"));

  const fine = store.toSeries("fine");

  assert.equal(fine.retentionDays, null);
  assert.deepEqual(fine.series[0].points.map((p) => p.value), [1, 2]);
});

test("HistoryStore can aggregate percentage samples into hourly and daily graph points", () => {
  const store = new HistoryStore({ retentionMs: 8 * 24 * 60 * 60 * 1000 });

  store.recordProvider("codex", { primary: { used_percent: 10, resets_at: null } }, new Date("2026-01-02T01:10:00.000Z"));
  store.recordProvider("codex", { primary: { used_percent: 20, resets_at: null } }, new Date("2026-01-02T01:40:00.000Z"));
  store.recordProvider("codex", { primary: { used_percent: 40, resets_at: null } }, new Date("2026-01-02T05:00:00.000Z"));

  const hourly = store.toSeries("hourly");
  const daily = store.toSeries("daily");

  assert.deepEqual(hourly.series[0].points.map((p) => ({ t: p.t, value: p.value, min: p.min, max: p.max, count: p.count })), [
    { t: "2026-01-02T01:00:00.000Z", value: 15, min: 10, max: 20, count: 2 },
    { t: "2026-01-02T05:00:00.000Z", value: 40, min: 40, max: 40, count: 1 },
  ]);
  assert.deepEqual(daily.series[0].points.map((p) => ({ t: p.t, value: p.value, min: p.min, max: p.max, count: p.count })), [
    { t: "2026-01-02T00:00:00.000Z", value: 23.333, min: 10, max: 40, count: 3 },
  ]);
});
