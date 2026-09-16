import assert from "node:assert/strict";
import test from "node:test";
import { carryForwardWindow } from "../src/providers/anthropic.ts";

const NOW = Date.parse("2026-09-16T06:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

test("a fresh reading always wins over the remembered one", () => {
  const fresh = { utilization: 12, resets_at: iso(NOW + 60_000) };
  const cached = { utilization: 99, resets_at: iso(NOW + 60_000) };
  assert.deepEqual(carryForwardWindow(fresh, cached, NOW), fresh);
});

test("a gap inside a live window carries the last real reading forward", () => {
  // The regression: CLIProxyAPI refreshes its OAuth token, drops the cached
  // header snapshot, and an idle account used to read back as 0%.
  const cached = { utilization: 82, resets_at: iso(NOW + 30 * 60_000) };
  assert.deepEqual(carryForwardWindow(null, cached, NOW), cached);
});

test("a gap after the window has reset reports zero", () => {
  // Once the window rolls over the spend really is gone, so zero is honest.
  const cached = { utilization: 82, resets_at: iso(NOW - 1_000) };
  assert.deepEqual(carryForwardWindow(null, cached, NOW), { utilization: 0, resets_at: null });
});

test("a gap with nothing remembered reports zero", () => {
  assert.deepEqual(carryForwardWindow(null, undefined, NOW), { utilization: 0, resets_at: null });
});

test("a remembered window without a reset time is not carried forward", () => {
  // With no reset stamp there is no way to tell whether it is still live.
  const cached = { utilization: 82, resets_at: null };
  assert.deepEqual(carryForwardWindow(null, cached, NOW), { utilization: 0, resets_at: null });
});

test("an unparseable reset time is not carried forward", () => {
  const cached = { utilization: 82, resets_at: "not-a-date" };
  assert.deepEqual(carryForwardWindow(null, cached, NOW), { utilization: 0, resets_at: null });
});
