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

test("optional second Codex account uses an isolated poller and provider key", () => {
  assert.match(server, /async function sameCredentialFile\(left: string, right: string\)/);
  assert.match(server, /CODEX2_AUTH_PATH resolves to account 1's auth file/);
  assert.match(server, /new Poller\("codex2", createCodexUsageFetcher\(\{ authPath: CODEX2_AUTH_PATH \}\), remember\("codex2"\)\)/);
  assert.match(server, /if \(codex2\) providers\.codex2 = enrichCodex\(codex2\.snapshot\(\)\)/);
});
