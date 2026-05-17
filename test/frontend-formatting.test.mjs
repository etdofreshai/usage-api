import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const match = html.match(/function fmtRel\(iso\) \{[\s\S]*?\n\}/);
assert.ok(match, "fmtRel function should exist in public/index.html");

function loadFmtRel(nowIso = "2026-01-01T00:00:00.000Z") {
  const sandbox = {
    Date: class extends Date {
      constructor(...args) {
        super(...args);
      }
      static now() {
        return new Date(nowIso).getTime();
      }
    },
    Number,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${match[0]}; globalThis.fmtRel = fmtRel;`, sandbox);
  return sandbox.fmtRel;
}

test("fmtRel shows days plus hours for reset times more than a day away", () => {
  const fmtRel = loadFmtRel();

  assert.equal(fmtRel("2026-01-03T03:00:00.000Z"), "in 2d 3h");
});

test("fmtRel keeps hour and minute precision for sub-day reset times", () => {
  const fmtRel = loadFmtRel();

  assert.equal(fmtRel("2026-01-01T02:15:00.000Z"), "in 2h 15m");
});
