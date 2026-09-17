# usage-api

Public, no-auth, always-cached aggregator for AI service usage. Polls
Claude / Codex / Z.ai / OpenRouter / OpenAI in the background and serves
the latest snapshot from memory — every request is O(0) network.

Claude and Codex usage comes straight from Anthropic and OpenAI, using the
OAuth token [9router](https://github.com/9cat/9router) already holds and
refreshes for those accounts. This service manages no Claude/Codex
credential of its own: it reads the current token out of 9router's
connection store and calls the providers' own usage endpoints — see
[9router source](#9router-source-for-claudecodex) below. Z.ai, OpenRouter,
and OpenAI are unaffected and still poll directly with their own API keys.

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
| Claude Max   | 9router `claude` connection (named via `NINEROUTER_CLAUDE_ACCOUNT`, or auto-picked if only one exists) |
| Claude Max #2 (optional) | 9router `claude` connection matching `NINEROUTER_CLAUDE2_ACCOUNT` |
| Codex        | 9router `codex` connection matching `NINEROUTER_CODEX_ACCOUNT` |
| Codex #2 (optional) | 9router `codex` connection matching `NINEROUTER_CODEX2_ACCOUNT` |
| Z.ai         | `ZAI_API_KEY` env                                       |
| OpenRouter   | `OPENROUTER_API_KEY` env                                |
| OpenAI       | `OPENAI_ADMIN_KEY` env                                  |

### 9router source for Claude/Codex

`src/providers/ninerouter.ts` reads 9router's SQLite connection store and
returns the access token it currently holds for an account. Nothing else is
taken from 9router; the usage numbers come from the providers themselves:

- Claude: `GET https://api.anthropic.com/api/oauth/usage`, the same endpoint
  Claude Code calls. Per-model weekly limits (Fable) arrive as
  `weekly_scoped` entries in `limits[]`, which is a genuinely different
  figure from the account-wide weekly window.
- Codex: `GET https://chatgpt.com/backend-api/wham/usage`. Five-hour vs.
  seven-day is decided by `limit_window_seconds`, never by slot order —
  OpenAI routinely puts a seven-day window in `primary_window` with
  `secondary_window` null.
- Claude's subscription tier needs a second call to
  `api/oauth/profile`, since the usage payload carries no tier at all. It is
  cached for 30 minutes because the tier changes about never.

Deliberately *not* read: 9router's own `/api/usage/<connectionId>`. It maps
OpenAI's positional window slots to names like `session` and drops
`limit_window_seconds`, so a seven-day window at 100% would be reported as a
five-hour one with nothing left in the payload to catch the error.

The database is opened read-only, which SQLite's WAL mode permits from a
separate process without disturbing 9router.

Required env var:

```
NINEROUTER_DB_PATH=/mnt/9router/data.sqlite   # default shown
```

On the Dokploy host this is a read-only bind mount of `~/.9router/db`.

Optional account-selection overrides (only needed when 9router has more than
one connection per provider, or the defaults below don't match). An account
is named by whichever identifier 9router records for it — Codex connections
carry an email, Claude ones may only have a display name:

```
NINEROUTER_CLAUDE_ACCOUNT=      # unset = auto-pick the sole "claude" connection
NINEROUTER_CLAUDE2_ACCOUNT=     # unset = claude2 stays disabled
NINEROUTER_CODEX_ACCOUNT=etdofresh@gmail.com
NINEROUTER_CODEX2_ACCOUNT=etdofresh+dev@gmail.com
```

`CLAUDE2_ENABLED=false` / `CODEX2_ENABLED=false` still work as hard kill
switches, same as before.

### Second Claude account

A second Claude account is opt-in. At startup the server reads 9router's
connections and checks for a `claude` one matching
`NINEROUTER_CLAUDE2_ACCOUNT`:

- A matching connection exists in 9router → a `claude2` poller runs and `/api/usage`
  includes a `claude2` key right after `claude`, same shape. The dashboard
  shows a "claude #2" card and "Claude #2 …" history series.
- `NINEROUTER_CLAUDE2_ACCOUNT` unset, or no matching 9router connection → the `claude2` key is entirely absent from the response (not
  null, not an error) and nothing about a second account appears in the UI.
- `CLAUDE2_ENABLED=false` (or `0`/`no`/`off`) → hard kill switch: the account is
  fully disabled and absent even when a matching 9router connection exists. Use this to
  turn the second account off from the environment without removing the connection.

### Second Codex account

A second Codex account is opt-in and never shares tokens or usage totals with
the primary account. At startup the server checks 9router for a `codex`
connection matching `NINEROUTER_CODEX2_ACCOUNT` (default `etdofresh+dev@gmail.com`):

- A matching connection exists in 9router → `/api/usage` includes a
  separate `codex2` provider and the dashboard labels both Codex accounts.
- No matching 9router connection → `codex2` is absent from the API, dashboard, and monitor.
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
Mounts:

- `usage-api-auth`, previously mounted at `/home/node/auth` — **no longer
  used.** The image no longer declares this path as a volume and nothing in
  the app reads or writes it now that Claude/Codex go through 9router.
  Dokploy's own mount config for this volume can be removed at any time;
  leaving it in place is harmless (the container just gets an empty,
  ignored mount).
- `usage-api-data` mounted at `/home/node/data` for usage history
- `~/.9router/db` bind-mounted **read-only** at `/mnt/9router`, so the app
  can read the access token 9router keeps refreshed. Read-only is enough:
  SQLite's WAL mode lets a separate process read a live database without
  disturbing the writer.

### Renewing OAuth credentials (moved to 9router)

This container used to bundle the Claude Code and Codex CLIs and a
`usage-auth status|claude|claude2|codex|codex2` helper script so its own
Dokploy terminal could renew the OAuth files it read directly. Both are
removed: Claude/Codex accounts live entirely in 9router, and renewing them
is 9router's job (its Providers page, or the OAuth flows behind it). This
also dropped the slowest, most failure-prone layer of this image's build —
the global `npm install -g` of both CLIs.

If a token ever goes stale, the symptom is an `anthropic oauth/usage HTTP
401` or `codex usage HTTP 401` in the poller's error field; re-authorising
that connection in 9router is the fix, and the next poll picks the new token
up on its own.
