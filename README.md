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

- starts at `POLL_TARGET_SECONDS` (default 2.5 min)
- after 3 consecutive successes, walks toward `POLL_FLOOR_SECONDS` (1 min)
- on 429: honors `Retry-After` (or doubles)
- on other errors: doubles, capped at `POLL_CEILING_SECONDS` (10 min)

## Auth

API keys load from the shared `/home/node/workspace/.env` (same volume as
`ai-sessions`) on startup. Override the path with `SHARED_ENV_FILE`. Existing
`process.env` values win, so Dokploy env vars still override the file.

| Provider     | Source                                                  |
|--------------|---------------------------------------------------------|
| Claude Max   | `~/.claude/.credentials.json` (OAuth, auto-refreshes)   |
| Claude Max #2 (optional) | `~/.claude2/.credentials.json` (OAuth, auto-refreshes) |
| Codex        | `~/.codex/auth.json` (OAuth, refreshes on 401)          |
| Z.ai         | `ZAI_API_KEY` env                                       |
| OpenRouter   | `OPENROUTER_API_KEY` env                                |
| OpenAI       | `OPENAI_ADMIN_KEY` env                                  |

The OAuth credential files are mounted from the host — same as `ai-sessions`:

```
-v $HOME/.claude:/home/node/.claude
-v $HOME/.claude2:/home/node/.claude2
-v $HOME/.codex:/home/node/.codex
```

This is a deliberate share: when `ai-sessions` (or anything else on the host)
refreshes the token, `usage-api` sees it on the next read; vice versa. Token
files are atomically rewritten via `tmp + rename`.

### Second Claude account

A second Claude account is opt-in. At startup the server checks
`~/.claude2/.credentials.json` (override with `CLAUDE2_CREDENTIALS_PATH`):

- File exists (or env var set) → a `claude2` poller runs and `/api/usage`
  includes a `claude2` key right after `claude`, same shape. The dashboard
  shows a "claude #2" card and "Claude #2 …" history series.
- Unconfigured → the `claude2` key is entirely absent from the response (not
  null, not an error) and nothing about a second account appears in the UI.
- `CLAUDE2_CREDENTIALS_PATH` explicitly set → the key is always present, so a
  bad path/mount surfaces as a visible error entry instead of silently
  disappearing.

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
Volumes: same `~/.claude` and `~/.codex` host paths used by `ai-sessions`,
plus `~/.claude2` when the second Claude account is enabled.
