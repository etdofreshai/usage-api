import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8");

test("history records enriched provider data so expected_percent is persisted", () => {
  assert.match(server, /function enrichProviderData\(provider: string, data: unknown\)/);
  assert.match(server, /history\.recordProvider\(provider, enrichProviderData\(provider, data\), fetchedAt\)/);
});
