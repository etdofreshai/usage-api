# usage-api

Public, no-auth, always-cached aggregator for AI service usage. Polls
Claude / Codex / Z.ai / OpenRouter / OpenAI in the background and serves
the latest snapshot from memory — every request is O(0) network.

## Endpoint

```
GET /api/usage
```

Returns per-provider:

- `data` — provider-specific shape (utilization %, reset times, credits, etc.)
- `fetchedAt` — when this snapshot was last refreshed
- `error` — null on success
- `intervalSec` — current polling interval (self-tunes)
- `nextFetchAt` — when the next refresh fires

## Adaptive polling

Each provider runs an independent `Poller`:

- starts at `POLL_TARGET_SECONDS` (default 30s)
- after 3 consecutive successes, walks toward `POLL_FLOOR_SECONDS` (10s)
- on 429: honors `Retry-After` (or doubles)
- on other errors: doubles, capped at `POLL_CEILING_SECONDS` (5 min)

## Auth

| Provider     | Source                                                  |
|--------------|---------------------------------------------------------|
| Claude Max   | `~/.claude/.credentials.json` (OAuth, auto-refreshes)   |
| Codex        | `~/.codex/auth.json` (OAuth, refreshes on 401)          |
| Z.ai         | `ZAI_API_KEY` env                                       |
| OpenRouter   | `OPENROUTER_API_KEY` env                                |
| OpenAI       | `OPENAI_ADMIN_KEY` env                                  |

The two OAuth credential files are mounted from the host — same as `ai-sessions`:

```
-v $HOME/.claude:/home/node/.claude
-v $HOME/.codex:/home/node/.codex
```

This is a deliberate share: when `ai-sessions` (or anything else on the host)
refreshes the token, `usage-api` sees it on the next read; vice versa. Token
files are atomically rewritten via `tmp + rename`.

## Run locally

```bash
npm install
cp .env.example .env   # edit
npm run dev
curl http://localhost:3000/api/usage
```

## Dokploy

App: `usage-api`
Domain: `usage.etdofresh.com`
Volumes: same `~/.claude` and `~/.codex` host paths used by `ai-sessions`.
