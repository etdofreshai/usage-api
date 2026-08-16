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

Codex usage exposes semantic `five_hour` and `seven_day` windows. Either may be
`null` when OpenAI is not reporting that limit. The deprecated `primary` and
`secondary` fields remain as compatibility aliases for `five_hour` and
`seven_day`; they do not mirror OpenAI's variable raw slot positions.

## Adaptive polling

Each provider runs an independent `Poller`:

- starts at `POLL_TARGET_SECONDS` (default 2.5 min)
- after 3 consecutive successes, walks toward `POLL_FLOOR_SECONDS` (1 min)
- on 429: honors `Retry-After` (or doubles)
- on other errors: doubles, capped at `POLL_CEILING_SECONDS` (10 min)

## Auth

API keys load from the shared `/home/node/workspace/.env` on startup. Override
the path with `SHARED_ENV_FILE`. Existing `process.env` values win, so Dokploy
env vars still override the file.

| Provider     | Source                                                  |
|--------------|---------------------------------------------------------|
| Claude Max   | `/home/node/auth/.claude/.credentials.json` (OAuth, auto-refreshes)   |
| Claude Max #2 (optional) | `/home/node/auth/.claude2/.credentials.json` (OAuth, auto-refreshes) |
| Codex        | `/home/node/auth/.codex/auth.json` (OAuth, refreshes on 401)          |
| Codex #2 (optional) | `/home/node/auth/.codex2/auth.json` (separate OAuth, refreshes on 401) |
| Z.ai         | `ZAI_API_KEY` env                                       |
| OpenRouter   | `OPENROUTER_API_KEY` env                                |
| OpenAI       | `OPENAI_ADMIN_KEY` env                                  |

OAuth credentials live in the dedicated `usage-api-auth` Docker volume mounted
at `/home/node/auth`. During migration, the entrypoint seeds an empty volume
from the former `ai-sessions-date` bind mounts:

```
-v $HOME/.claude:/home/node/.claude
-v $HOME/.claude2:/home/node/.claude2
-v $HOME/.codex:/home/node/.codex
-v $HOME/.codex2:/home/node/.codex2
```

After the initial copy, Usage API refreshes and atomically rewrites its own
credential files without sharing token state with other containers.

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
- `CLAUDE2_ENABLED=false` (or `0`/`no`/`off`) → hard kill switch: the account is
  fully disabled and absent even when its credentials file exists. Use this to
  turn the second account off from the environment without removing the file.

### Second Codex account

A second Codex account is opt-in and never shares tokens or usage totals with
the primary account. At startup the server checks for `.codex2/auth.json` next
to the primary `CODEX_AUTH_PATH` (override with `CODEX2_AUTH_PATH`):

- File exists (or the path is explicitly set) → `/api/usage` includes a
  separate `codex2` provider and the dashboard labels both Codex accounts.
- Unconfigured → `codex2` is absent from the API, dashboard, and monitor.
- `CODEX2_AUTH_PATH` explicitly set → a missing or invalid file appears as a
  labeled `codex2` error in the API response for diagnosis, while the website
  and monitor stay free of empty/disabled account cards.
- `CODEX2_ENABLED=false` (or `0`/`no`/`off`) → hard kill switch.
- A path that resolves to the primary `CODEX_AUTH_PATH` is rejected to prevent
  the two refresh-token lifecycles from overwriting each other.

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
Named volumes:

- `usage-api-auth` mounted at `/home/node/auth` for OAuth credentials
- `usage-api-data` mounted at `/home/node/data` for usage history

### Renew OAuth credentials

The main Usage API image includes the Claude and Codex CLIs. Open the Usage API
application's Dokploy terminal and use:

```sh
usage-auth status
usage-auth claude
usage-auth claude2
usage-auth codex
usage-auth codex2
```

The helper reads and writes the existing `usage-api-auth` volume. The Codex
commands use separate `CODEX_HOME` directories and device-code authentication
for the headless container. Run `usage-auth codex2` and complete the login as
the second account; the helper never prints or copies tokens.
