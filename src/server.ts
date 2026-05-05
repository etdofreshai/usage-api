import express from "express";
import { Poller } from "./cache.js";
import { fetchClaudeUsage } from "./providers/anthropic.js";
import { fetchCodexUsage } from "./providers/codex.js";
import { fetchZaiUsage } from "./providers/zai.js";
import { fetchOpenRouterUsage } from "./providers/openrouter.js";
import { fetchOpenAiUsage } from "./providers/openai.js";

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

const ZAI_KEY = process.env.ZAI_API_KEY;
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const OPENAI_KEY = process.env.OPENAI_ADMIN_KEY;

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
