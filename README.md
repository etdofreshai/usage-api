# usage-api

Public, no-auth, always-cached aggregator for AI service usage. Polls
Claude / Codex / Z.ai / OpenRouter / OpenAI in the background and serves
the latest snapshot from memory — every request is O(0) network.

Claude and Codex usage is read from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI),
the proxy server that already owns those OAuth accounts and passively
captures each provider's rate-limit response headers on real traffic. This
service no longer manages its own Claude/Codex OAuth credential files or
token refresh — see [CLIProxyAPI source](#cliproxyapi-source-for-claudecodex)
below. Z.ai, OpenRouter, and OpenAI are unaffected and still poll directly
with their own API keys.

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
| Claude Max   | CLIProxyAPI `claude` account (email set via `CLIPROXYAPI_CLAUDE_EMAIL`, or auto-picked if only one exists) |
| Claude Max #2 (optional) | CLIProxyAPI `claude` account matching `CLIPROXYAPI_CLAUDE2_EMAIL` |
| Codex        | CLIProxyAPI `codex` account matching `CLIPROXYAPI_CODEX_EMAIL` |
| Codex #2 (optional) | CLIProxyAPI `codex` account matching `CLIPROXYAPI_CODEX2_EMAIL` |
| Z.ai         | `ZAI_API_KEY` env                                       |
| OpenRouter   | `OPENROUTER_API_KEY` env                                |
| OpenAI       | `OPENAI_ADMIN_KEY` env                                  |

### CLIProxyAPI source for Claude/Codex

`src/providers/cliproxyapi.ts` talks to CLIProxyAPI's Management API instead
of holding OAuth credentials directly:

- `GET /v0/management/auth-files` lists CLIProxyAPI's registered accounts and
  the rate-limit headers (`quota` / `model_quotas`) it has already captured
  from real Claude/Codex traffic — no separate poll against
  `api.anthropic.com`/`chatgpt.com` is needed for the headline utilization
  numbers.
- `POST /v0/management/api-call` is used only for the one field CLIProxyAPI
  doesn't observe passively: Codex's rate-limit reset credits. It runs the
  request through CLIProxyAPI using the account's own already-refreshed
  access token (`$TOKEN$` substitution), so this service still never
  touches a raw OAuth token.

Required env vars:

```
CLIPROXYAPI_BASE_URL=http://etzminisforumx1pro.lan:8317   # default shown
CLIPROXYAPI_MANAGEMENT_KEY=...                              # from ~/.config/cliproxyapi/management-key on that host
```

Optional account-selection overrides (only needed when CLIProxyAPI has more
than one account per provider, or the defaults below don't match):

```
CLIPROXYAPI_CLAUDE_EMAIL=       # unset = auto-pick the sole "claude" account
CLIPROXYAPI_CLAUDE2_EMAIL=      # unset = claude2 stays disabled
CLIPROXYAPI_CODEX_EMAIL=etdofresh@gmail.com
CLIPROXYAPI_CODEX2_EMAIL=etdofresh+dev@gmail.com
```

`CLAUDE2_ENABLED=false` / `CODEX2_ENABLED=false` still work as hard kill
switches, same as before.

### Second Claude account

A second Claude account is opt-in. At startup the server asks CLIProxyAPI for
its registered accounts and checks for a `claude` entry matching
`CLIPROXYAPI_CLAUDE2_EMAIL`:

- A matching account exists in CLIProxyAPI → a `claude2` poller runs and `/api/usage`
  includes a `claude2` key right after `claude`, same shape. The dashboard
  shows a "claude #2" card and "Claude #2 …" history series.
- `CLIPROXYAPI_CLAUDE2_EMAIL` unset, or no matching CLIProxyAPI account → the `claude2` key is entirely absent from the response (not
  null, not an error) and nothing about a second account appears in the UI.
- `CLAUDE2_ENABLED=false` (or `0`/`no`/`off`) → hard kill switch: the account is
  fully disabled and absent even when a matching CLIProxyAPI account exists. Use this to
  turn the second account off from the environment without removing the file.

### Second Codex account

A second Codex account is opt-in and never shares tokens or usage totals with
the primary account. At startup the server checks CLIProxyAPI for a `codex`
entry matching `CLIPROXYAPI_CODEX2_EMAIL` (default `etdofresh+dev@gmail.com`):

- A matching account exists in CLIProxyAPI → `/api/usage` includes a
  separate `codex2` provider and the dashboard labels both Codex accounts.
- No matching CLIProxyAPI account → `codex2` is absent from the API, dashboard, and monitor.
- `CODEX2_ENABLED=false` (or `0`/`no`/`off`) → hard kill switch.

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

- `usage-api-auth`, previously mounted at `/home/node/auth` — **no longer
  used.** The image no longer declares this path as a volume and nothing in
  the app reads or writes it now that Claude/Codex go through CLIProxyAPI.
  Dokploy's own mount config for this volume can be removed at any time;
  leaving it in place is harmless (the container just gets an empty,
  ignored mount).
- `usage-api-data` mounted at `/home/node/data` for usage history

### Renewing OAuth credentials (moved to CLIProxyAPI)

This container used to bundle the Claude Code and Codex CLIs and a
`usage-auth status|claude|claude2|codex|codex2` helper script so its own
Dokploy terminal could renew the OAuth files it read directly. Both are
removed: Claude/Codex accounts now live entirely in CLIProxyAPI, and
renewing them is CLIProxyAPI's job (`-claude-login` / `-codex-login` /
`-codex-device-login` on that server, or its own management UI/API). This
also dropped the slowest, most failure-prone layer of this image's build —
the global `npm install -g` of both CLIs.
