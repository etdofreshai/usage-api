import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Poller } from "./cache.js";
import { HistoryGranularity, HistoryStore } from "./history.js";

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
function parseHistoryRetentionMs(value: string | undefined) {
  if (value == null || value === "" || value === "forever" || value === "infinite" || value === "0") return Infinity;
  const days = Number(value);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : Infinity;
}
const HISTORY_RETENTION_MS = parseHistoryRetentionMs(process.env.USAGE_HISTORY_RETENTION_DAYS);
const HISTORY_FILE = process.env.USAGE_HISTORY_FILE ?? "/home/node/workspace/usage-history.jsonl";
const history = new HistoryStore({ retentionMs: HISTORY_RETENTION_MS, filePath: HISTORY_FILE });
await history.load();

function remember<T>(provider: string): (data: T, fetchedAt: Date) => void {
  return (data: T, fetchedAt: Date) => history.recordProvider(provider, enrichProviderData(provider, data), fetchedAt);
}

// Accept the workspace .env's existing names as fallbacks.
const ZAI_KEY = process.env.ZAI_API_KEY ?? process.env.ZAI_TOKEN;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? process.env.OPENROUTER_TOKEN;
const OPENAI_KEY = process.env.OPENAI_ADMIN_KEY; // requires sk-admin-* — keep explicit

// Optional second Claude account. CLAUDE2_ENABLED=false (or 0/no/off) is a hard
// kill switch that disables it regardless of any credentials file. Otherwise an
// explicit CLAUDE2_CREDENTIALS_PATH always enables the poller (so a bad path
// surfaces as a visible error); failing that it is enabled only when the default
// credentials file exists. Resolved here, in body code, so the values can come
// from the shared env file loaded above.
const CLAUDE2_OFF = /^(0|false|no|off)$/i.test((process.env.CLAUDE2_ENABLED ?? "").trim());
const CLAUDE2_PATH = process.env.CLAUDE2_CREDENTIALS_PATH?.trim() || undefined;
const CLAUDE2_DEFAULT_PATH = path.join(homedir(), ".claude2", ".credentials.json");
const CLAUDE2_CANDIDATE = CLAUDE2_OFF
  ? null
  : (CLAUDE2_PATH ?? (await fs.access(CLAUDE2_DEFAULT_PATH).then(() => CLAUDE2_DEFAULT_PATH, () => null)));
// Refuse to point both accounts at one file: concurrent token refreshes would
// clobber each other's rotated refresh tokens.
const CLAUDE1_CREDS_PATH = process.env.CLAUDE_CREDENTIALS_PATH ?? path.join(homedir(), ".claude", ".credentials.json");
const CLAUDE2_SAME_AS_1 = CLAUDE2_CANDIDATE != null && path.resolve(CLAUDE2_CANDIDATE) === path.resolve(CLAUDE1_CREDS_PATH);
const CLAUDE2_CREDS_PATH = CLAUDE2_SAME_AS_1 ? null : CLAUDE2_CANDIDATE;
console.log(CLAUDE2_OFF
  ? "claude2 disabled (CLAUDE2_ENABLED=false)"
  : CLAUDE2_SAME_AS_1
    ? `claude2 disabled: CLAUDE2_CREDENTIALS_PATH resolves to account 1's credentials file (${CLAUDE2_CANDIDATE})`
    : CLAUDE2_CREDS_PATH
      ? `claude2 enabled (credentials: ${CLAUDE2_CREDS_PATH})`
      : `claude2 disabled (CLAUDE2_CREDENTIALS_PATH unset, no file at ${CLAUDE2_DEFAULT_PATH})`);

const claude = new Poller("claude", fetchClaudeUsage, remember("claude"));
const claude2 = CLAUDE2_CREDS_PATH ? new Poller("claude2", () => fetchClaudeUsage(CLAUDE2_CREDS_PATH), remember("claude2")) : null;
const codex = new Poller("codex", fetchCodexUsage, remember("codex"));
const zai = ZAI_KEY ? new Poller("zai", () => fetchZaiUsage(ZAI_KEY), remember("zai")) : null;
const openrouter = OPENROUTER_KEY ? new Poller("openrouter", () => fetchOpenRouterUsage(OPENROUTER_KEY), remember("openrouter")) : null;
const openai = OPENAI_KEY ? new Poller("openai", () => fetchOpenAiUsage(OPENAI_KEY), remember("openai")) : null;

claude.start();
claude2?.start();
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

function enrichClaude(snap: { data?: any }) {
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
      seven_day_fable: enrichSeven(d.seven_day_fable),
    },
  };
}

function enrichCodex(snap: { data?: any }) {
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
      additional: d.additional.map((a: any) => ({
        ...a,
        primary: enrichWin(a.primary, 300),
        secondary: enrichWin(a.secondary, 10080),
      })),
    },
  };
}

function enrichZai(snap: { data?: any }) {
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

function enrichProviderData(provider: string, data: unknown): unknown {
  if (provider === "claude" || provider === "claude2") return enrichClaude({ data }).data;
  if (provider === "codex") return enrichCodex({ data }).data;
  if (provider === "zai") return enrichZai({ data }).data;
  return data;
}

app.get("/api/usage", (_req, res) => {
  const providers: Record<string, unknown> = { claude: enrichClaude(claude.snapshot()) };
  if (claude2) providers.claude2 = enrichClaude(claude2.snapshot());
  providers.codex = enrichCodex(codex.snapshot());
  providers.zai = zai ? enrichZai(zai.snapshot()) : { data: null, error: "ZAI_API_KEY not set" };
  providers.openrouter = openrouter?.snapshot() ?? { data: null, error: "OPENROUTER_API_KEY not set" };
  providers.openai = openai?.snapshot() ?? { data: null, error: "OPENAI_ADMIN_KEY not set" };
  res.json({
    timestamp: new Date().toISOString(),
    providers,
  });
});

app.get("/api/history", (req, res) => {
  const requested = typeof req.query.granularity === "string" ? req.query.granularity : "daily";
  const granularity: HistoryGranularity = requested === "fine" || requested === "hourly" || requested === "daily"
    ? requested
    : "daily";
  res.json(history.toSeries(granularity));
});

// Serve the dashboard UI from /public.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/server.js -> ../public ; src/server.ts (tsx) -> ../public
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR, { index: "index.html" }));

app.listen(PORT, () => {
  console.log(`usage-api listening on http://localhost:${PORT}`);
});
