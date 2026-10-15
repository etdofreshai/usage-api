import assert from "node:assert/strict";
import test from "node:test";
import { assignAccounts } from "../src/accounts.js";

const connections = Array.from({ length: 6 }, (_, i) => ({ id: `id${i}`, provider: i < 4 ? "codex" : "claude", name: `account${i}` }));
test("account discovery preserves pinned first accounts and numbers all additional accounts", () => {
  const assigned = assignAccounts(connections, {}, { codex: "account1", codex2: "account0" });
  assert.equal(assigned.codex, "id1");
  assert.equal(assigned.codex2, "id0");
  assert.equal(assigned.codex3, "id2");
  assert.equal(assigned.codex4, "id3");
  assert.equal(assigned.claude, "id4");
  assert.equal(assigned.claude2, "id5");
  assert.deepEqual(assignAccounts([...connections].reverse(), assigned, {}), assigned);
});
test("removed accounts retain their numbers and newly added accounts do not inherit history", () => {
  const assigned = assignAccounts(connections, {}, {});
  const next = assignAccounts([...connections.slice(1), { id: "new", provider: "codex", name: "new" }], assigned, {});
  assert.equal(next.codex, "id0");
  assert.equal(next.codex5, "new");
});
