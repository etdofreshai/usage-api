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

test("history graph exposes all known provider series with preferred color families", () => {
  const options = [...html.matchAll(/\{ key: "([^"]+)", label: "([^"]+)", color: "(#[0-9a-fA-F]+)", default: (true|false) \}/g)]
    .map((match) => ({ key: match[1], label: match[2], color: match[3], default: match[4] === "true" }));

  assert.deepEqual(options, [
    { key: "claude:five_hour", label: "Claude Code 5-hour", color: "#f97316", default: true },
    { key: "claude:seven_day", label: "Claude Code 7-day", color: "#fb923c", default: true },
    { key: "claude:seven_day_sonnet", label: "Claude Sonnet 7-day", color: "#fdba74", default: false },
    { key: "claude:seven_day_opus", label: "Claude Opus 7-day", color: "#ea580c", default: false },
    { key: "claude:seven_day_design", label: "Claude Design 7-day", color: "#fed7aa", default: false },
    { key: "codex:primary", label: "Codex 5-hour", color: "#22c55e", default: true },
    { key: "codex:secondary", label: "Codex 7-day", color: "#86efac", default: true },
    { key: "codex:GPT-5.3-Codex-Spark primary", label: "Codex Spark 5-hour", color: "#06b6d4", default: false },
    { key: "codex:GPT-5.3-Codex-Spark secondary", label: "Codex Spark 7-day", color: "#67e8f9", default: false },
    { key: "zai:five_hour", label: "ZAI 5-hour", color: "#a855f7", default: true },
    { key: "zai:monthly", label: "ZAI monthly", color: "#d8b4fe", default: false },
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

test("history series menu supports per-series expected-line checkboxes with persistence", () => {
  assert.match(html, /EXPECTED_SERIES_STORAGE_KEY = "usage-api:expected-history-series"/);
  assert.match(html, /loadExpectedSeriesKeys\(\)/);
  assert.match(html, /saveExpectedSeriesKeys\(\)/);
  assert.match(html, /data-expected-series-key/);
  assert.match(html, /Show expected percentages/);
  assert.match(html, /expectedSeriesKeys\.has\(item\.key\)/);
});

test("dashboard remembers selected view and history granularity", () => {
  assert.match(html, /localStorage\.getItem\("usage-api:selected-view"\)/);
  assert.match(html, /localStorage\.setItem\("usage-api:selected-view", view\)/);
  assert.match(html, /localStorage\.getItem\("usage-api:history-granularity"\)/);
  assert.match(html, /localStorage\.setItem\("usage-api:history-granularity", granularity\)/);
  assert.match(html, /applySelectedView\(loadSelectedView\(\), \{ fetch: false \}\)/);
  assert.match(html, /applyHistoryGranularity\(historyGranularity, \{ fetch: false \}\)/);
});

test("history chart colors dots, range bars, and expected lines with each series color", () => {
  assert.match(html, /<polyline class="line" stroke="\$\{item\.color\}"/);
  assert.match(html, /<polyline class="expected-line" stroke="\$\{item\.color\}"/);
  assert.doesNotMatch(html, /<polyline class="expected-line" stroke="#fff"/);
  assert.match(html, /expectedCoords/);
  assert.match(html, /expected usage/);
  assert.match(html, /p\.expectedValue/);
  assert.match(html, /if \(latestHistory\) renderHistory\(latestHistory\)/);
  assert.match(html, /<circle class="point" fill="\$\{item\.color\}" stroke="\$\{item\.color\}"/);
  assert.match(html, /<line class="range" stroke="\$\{item\.color\}"/);
  assert.match(html, /\$\{ranges\}<polyline class="line"[\s\S]*\$\{expectedLine\}\$\{dots\}/);
  assert.match(html, /stroke-width: 2\.4/);
  assert.match(html, /stroke-linecap: round/);
});

test("history chart shows custom hover popup details for graph dots", () => {
  assert.match(html, /id="history-tooltip"/);
  assert.match(html, /class="history-tooltip hidden"/);
  assert.match(html, /data-tooltip="\$\{escapeHtml\(tooltip\)\}"/);
  assert.match(html, /showHistoryTooltip\(event\)/);
  assert.match(html, /hideHistoryTooltip\(\)/);
});

test("history chart includes readable axes, range bars, and rolling-window help text", () => {
  assert.match(html, /\[100, 75, 50, 25, 0\]/);
  assert.match(html, /class="range"/);
  assert.match(html, /class="grid-line"/);
  assert.match(html, /Codex 7-day is a rolling window/);
  assert.match(html, /Aggregated views show average dots plus min–max bars/);
});

test("history chart expected line uses per-point expected values without flat fallback", () => {
  assert.match(html, /p\.expectedValue != null/);
  assert.match(html, /y\(p\.expectedValue\)/);
  assert.doesNotMatch(html, /fallbackExpected/);
  assert.doesNotMatch(html, /currentExpectedForSeries/);
});
