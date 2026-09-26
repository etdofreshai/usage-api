import test from "node:test";
import assert from "node:assert/strict";
import { Poller, RateLimitError, staleness } from "../src/cache.ts";

// Retry-After is honored exactly (even past the ceiling) and does not inflate
// the steady cadence; a 429 without a hint falls back to doubling.
test("poller retries at Retry-After, then resumes its normal interval", async () => {
  const errs = [new RateLimitError(900), new RateLimitError(0)];
  const p = new Poller("t", async () => { throw errs.shift(); });
  const next = () => (Date.parse(p.snapshot().nextFetchAt) - Date.now()) / 1000;
  const tick = () => (p as any).tick() as Promise<void>;

  await tick();
  assert.ok(Math.abs(next() - 901) < 2, `expected ~901s, got ${next()}`);
  assert.equal(p.snapshot().intervalSec, 150);

  await tick();
  assert.equal(p.snapshot().intervalSec, 300);
  p.stop();
});

test("a failed poll keeps the previous value and its fetchedAt", async () => {
  const results: Array<() => number> = [() => 42, () => { throw new Error("boom"); }];
  const p = new Poller("t", async () => results.shift()!());
  const tick = () => (p as any).tick() as Promise<void>;

  await tick();
  const good = p.snapshot();
  assert.equal(good.staleness, "fresh");
  await tick();
  const s = p.snapshot();
  p.stop();
  assert.equal(s.data, 42);
  assert.equal(s.fetchedAt, good.fetchedAt);
  assert.equal(s.error, "boom");
  assert.ok(s.lastAttemptAt && s.lastAttemptAt >= s.fetchedAt!);
});

test("staleness tiers by age of data", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  const ago = (s: number) => new Date(now - s * 1000).toISOString();
  assert.equal(staleness(ago(60), now), "fresh");
  assert.equal(staleness(ago(300), now), "little_stale");
  assert.equal(staleness(ago(3600), now), "stale");
  assert.equal(staleness(null, now), "stale");
});
