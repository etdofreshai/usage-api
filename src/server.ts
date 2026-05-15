import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Poller } from "./cache.js";

// Load env from the shared volume (same .env that ai-sessions uses) so secrets
// live alongside the OAuth credentials instead of in Dokploy. Run before any
// `process.env.*` reads below.
const ENV_FILE = process.env.SHARED_ENV_FILE ?? "/home/node/workspace/.env";
try {
  const raw = await fs.readFile(ENV_FILE, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
  console.log(`loaded env from ${ENV_FILE}`);
} catch (err: any) {
  if (err?.code !== "ENOENT") console.warn(`could not read ${ENV_FILE}: ${err?.message ?? err}`);
}
import { fetchClaudeUsage } from "./providers/anthropic.js";
import { fetchCodexUsage } from "./providers/codex.js";
import { fetchZaiUsage } from "./providers/zai.js";
import { fetchOpenRouterUsage } from "./providers/openrouter.js";
import { fetchOpenAiUsage } from "./providers/openai.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

// Accept the workspace .env's existing names as fallbacks.
const ZAI_KEY = process.env.ZAI_API_KEY ?? process.env.ZAI_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_TOKEN;
const OPENAI_KEY = process.env.OPENAI_ADMIN_KEY; // requires sk-admin-* — keep explicit

const claude = new Poller("claude", fetchClaudeUsage);
const codex = new Poller("codex", fetchCodexUsage);
const zai = ZAI_KEY ? new Poller("zai", () => fetchZaiUsage(ZAI_KEY)) : null;
const openrouter = OPENROUTER_KEY ? new Poller("openrouter", () => fetchOpenRouterUsage(OPENROUTER_KEY)) : null;
const openai = OPENAI_KEY ? new Poller("openai", () => fetchOpenAiUsage(OPENAI_KEY)) : null;

claude.start();
codex.start();
zai?.start();
openrouter?.start();
openai?.start();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

// Pacing math: given a window of length windowMs ending at resetAt, compute
// what used% would be on a perfectly linear burn from windowStart to now.
// slack = expected − used (positive = under pace, negative = over pace).
function pacing(usedPct: number, resetIso: string | null, windowMs: number) {
  if (!resetIso) return { expected_percent: null, slack: null };
  const reset = Date.parse(resetIso);
  if (!Number.isFinite(reset)) return { expected_percent: null, slack: null };
  const elapsedMs = Date.now() - (reset - windowMs);
  const expected = Math.max(0, Math.min(100, (elapsedMs / windowMs) * 100));
  return { expected_percent: expected, slack: expected - usedPct };
}

const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;
const THIRTY_DAY_MS = 30 * 24 * 60 * 60 * 1000;

function enrichClaude(snap: ReturnType<typeof claude.snapshot>) {
  if (!snap.data) return snap;
  const d = snap.data;
  const enrichSeven = <T extends { utilization: number; resets_at: string | null } | null>(w: T): T =>
    (w ? { ...w, ...pacing(w.utilization, w.resets_at, SEVEN_DAY_MS) } : w) as T;
  return {
    ...snap,
    data: {
      ...d,
      five_hour: { ...d.five_hour, ...pacing(d.five_hour.utilization, d.five_hour.resets_at, FIVE_HOUR_MS) },
      seven_day: { ...d.seven_day, ...pacing(d.seven_day.utilization, d.seven_day.resets_at, SEVEN_DAY_MS) },
      seven_day_sonnet: enrichSeven(d.seven_day_sonnet),
      seven_day_opus: enrichSeven(d.seven_day_opus),
      seven_day_design: enrichSeven(d.seven_day_design),
    },
  };
}

function enrichCodex(snap: ReturnType<typeof codex.snapshot>) {
  if (!snap.data) return snap;
  const d = snap.data;
  const enrichWin = (w: { used_percent: number; resets_at: string | null; window_minutes: number }, fallbackMin: number) => {
    const ms = (w.window_minutes || fallbackMin) * 60 * 1000;
    return { ...w, ...pacing(w.used_percent, w.resets_at, ms) };
  };
  return {
    ...snap,
    data: {
      ...d,
      primary: enrichWin(d.primary, 300),
      secondary: enrichWin(d.secondary, 10080),
      additional: d.additional.map((a) => ({
        ...a,
        primary: enrichWin(a.primary, 300),
        secondary: enrichWin(a.secondary, 10080),
      })),
    },
  };
}

function enrichZai(snap: ReturnType<NonNullable<typeof zai>["snapshot"]> | { data: null; error: string }) {
  if (!("data" in snap) || !snap.data) return snap;
  const d = snap.data;
  return {
    ...snap,
    data: {
      ...d,
      five_hour: d.five_hour
        ? { ...d.five_hour, ...pacing(d.five_hour.used_percent, d.five_hour.resets_at, FIVE_HOUR_MS) }
        : null,
      monthly: d.monthly
        ? { ...d.monthly, ...pacing(d.monthly.used_percent, d.monthly.resets_at, THIRTY_DAY_MS) }
        : null,
    },
  };
}

app.get("/api/usage", (_req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    providers: {
      claude: enrichClaude(claude.snapshot()),
      codex: enrichCodex(codex.snapshot()),
      zai: zai ? enrichZai(zai.snapshot()) : { data: null, error: "ZAI_API_KEY not set" },
      openrouter: openrouter?.snapshot() ?? { data: null, error: "OPENROUTER_API_KEY not set" },
      openai: openai?.snapshot() ?? { data: null, error: "OPENAI_ADMIN_KEY not set" },
    },
  });
});

// Serve the dashboard UI from /public.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/server.js -> ../public ; src/server.ts (tsx) -> ../public
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR, { index: "index.html" }));

app.listen(PORT, () => {
  console.log(`usage-api listening on http://localhost:${PORT}`);
});
