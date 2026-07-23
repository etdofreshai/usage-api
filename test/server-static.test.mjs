import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

test("history records enriched provider data so expected_percent is persisted", () => {
  assert.match(server, /function enrichProviderData\(provider: string, data: unknown\)/);
  assert.match(server, /const enriched = enrichProviderData\(provider, data\)/);
  assert.match(server, /history\.recordProvider\(provider, enriched, fetchedAt\)/);
});

test("Codex history omits deprecated aliases to avoid duplicate series", () => {
  assert.match(server, /primary: _primary, secondary: _secondary/);
  assert.match(server, /primary: _p, secondary: _s/);
  assert.match(server, /history\.recordProvider\(provider, codexData, fetchedAt\)/);
});
