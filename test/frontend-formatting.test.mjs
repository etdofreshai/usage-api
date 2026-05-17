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

test("dashboard defaults to cards with a tab for switching to history graph", () => {
  assert.match(html, /<button[^>]+data-view="cards"[^>]*class="[^"]*active[^"]*"[^>]*>cards<\/button>/);
  assert.match(html, /<button[^>]+data-view="history"[^>]*>graph<\/button>/);
  assert.match(html, /<main id="grid" class="view">/);
  assert.match(html, /<section class="history view hidden">/);
});

test("history graph exposes all known provider series but defaults to common ones", () => {
  const options = [...html.matchAll(/\{ key: "([^"]+)", label: "([^"]+)", color: "#[0-9a-fA-F]+", default: (true|false) \}/g)]
    .map((match) => ({ key: match[1], label: match[2], default: match[3] === "true" }));

  assert.deepEqual(options, [
    { key: "claude:five_hour", label: "Claude 5-hour", default: true },
    { key: "claude:seven_day", label: "Claude 7-day", default: true },
    { key: "claude:seven_day_sonnet", label: "Claude Sonnet 7-day", default: false },
    { key: "claude:seven_day_opus", label: "Claude Opus 7-day", default: false },
    { key: "claude:seven_day_design", label: "Claude Design 7-day", default: false },
    { key: "codex:primary", label: "Codex 5-hour", default: true },
    { key: "codex:secondary", label: "Codex 7-day", default: true },
    { key: "zai:five_hour", label: "ZAI 5-hour", default: true },
    { key: "zai:monthly", label: "ZAI monthly", default: false },
  ]);
  assert.match(html, /id="history-series-menu"/);
  assert.match(html, /selectedSeriesKeys\.has/);
});

test("history series menu supports bulk actions and localStorage persistence", () => {
  assert.match(html, /data-series-action="all"/);
  assert.match(html, /data-series-action="none"/);
  assert.match(html, /data-series-action="default"/);
  assert.match(html, /localStorage\.getItem\("usage-api:selected-history-series"\)/);
  assert.match(html, /localStorage\.setItem\("usage-api:selected-history-series"/);
});

test("history chart includes readable axes, range bars, and rolling-window help text", () => {
  assert.match(html, /\[100, 75, 50, 25, 0\]/);
  assert.match(html, /class="range"/);
  assert.match(html, /class="grid-line"/);
  assert.match(html, /Codex 7-day is a rolling window/);
  assert.match(html, /Aggregated views show average dots plus min–max bars/);
});
