import { promises as fs } from "node:fs";
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

app.get("/api/usage", (_req, res) => {
  res.json({
    timestamp: new Date().toISOString(),
    providers: {
      claude: claude.snapshot(),
      codex: codex.snapshot(),
      zai: zai?.snapshot() ?? { data: null, error: "ZAI_API_KEY not set" },
      openrouter: openrouter?.snapshot() ?? { data: null, error: "OPENROUTER_API_KEY not set" },
      openai: openai?.snapshot() ?? { data: null, error: "OPENAI_ADMIN_KEY not set" },
    },
  });
});

app.get("/", (_req, res) => {
  res.json({
    name: "usage-api",
    endpoints: ["/api/usage", "/api/health"],
  });
});

app.listen(PORT, () => {
  console.log(`usage-api listening on http://localhost:${PORT}`);
});
