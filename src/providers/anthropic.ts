/**
 * Claude Max usage via the OAuth endpoint.
 *
 * Reads a credentials file — default ~/.claude/.credentials.json (mounted from
 * host, shared with ai-sessions); pass a path to poll another account.
 * Refreshes the access token in-place when it's within 5 min of expiry.
 *
 * Endpoint: GET https://api.anthropic.com/api/oauth/usage
 *   → { five_hour: { utilization, resets_at }, seven_day: {...} }
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { RateLimitError, parseRetryAfter } from "../cache.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const OAUTH_BETA = "oauth-2025-04-20";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USER_AGENT = "usage-api/1.0";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const DEFAULT_CREDS_PATH = process.env.CLAUDE_CREDENTIALS_PATH
  ?? path.join(homedir(), ".claude", ".credentials.json");

interface OauthState {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
}

interface CredsFile {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number | string;
    scopes?: string[] | string;
    subscriptionType?: string;
  };
}

export interface ClaudeWindow {
  utilization: number;
  resets_at: string | null;
}

export interface ClaudeUsage {
  five_hour: ClaudeWindow;
  seven_day: ClaudeWindow;
  seven_day_sonnet: ClaudeWindow | null;
  seven_day_opus: ClaudeWindow | null;
  // "Claude Design" in the web UI; the API ships it under the `omelette` codename.
  seven_day_design: ClaudeWindow | null;
  // Per-model weekly limit from the newer `limits[]` array (scope.model "Fable").
  seven_day_fable: ClaudeWindow | null;
  subscription_type: string | null;
}

// Newer responses carry per-model usage in a `limits` array instead of the
// legacy `seven_day_<model>` fields (which now come back null): entries with
// kind "weekly_scoped" scope a weekly window to one model via
// scope.model.display_name (e.g. "Fable").
interface RawLimit {
  kind?: string;
  group?: string;
  percent?: number;
  resets_at?: string;
  is_active?: boolean;
  scope?: { model?: { display_name?: string | null } | null } | null;
}

type RawWindow = { utilization?: number; resets_at?: string } | null;

export interface RawUsageResponse {
  five_hour?: RawWindow;
  seven_day?: RawWindow;
  seven_day_sonnet?: RawWindow;
  seven_day_opus?: RawWindow;
  seven_day_omelette?: RawWindow;
  limits?: RawLimit[];
}

export function parseClaudeUsage(json: RawUsageResponse, subscriptionType: string | null): ClaudeUsage {
  const win = (w: RawWindow): ClaudeWindow => ({
    utilization: w?.utilization ?? 0,
    resets_at: w?.resets_at ?? null,
  });
  const optWin = (w: RawWindow): ClaudeWindow | null => (w ? win(w) : null);

  // Model-scoped weekly windows, keyed by lowercased display name.
  const scoped = new Map<string, ClaudeWindow>();
  for (const limit of json.limits ?? []) {
    if (limit?.kind !== "weekly_scoped") continue;
    if (typeof limit.percent !== "number") continue;
    const name = limit.scope?.model?.display_name;
    if (typeof name !== "string" || !name) continue;
    scoped.set(name.toLowerCase(), {
      utilization: limit.percent,
      resets_at: limit.resets_at ?? null,
    });
  }

  return {
    five_hour: win(json.five_hour ?? null),
    seven_day: win(json.seven_day ?? null),
    seven_day_sonnet: optWin(json.seven_day_sonnet ?? null) ?? scoped.get("sonnet") ?? null,
    seven_day_opus: optWin(json.seven_day_opus ?? null) ?? scoped.get("opus") ?? null,
    seven_day_design: optWin(json.seven_day_omelette ?? null)
      ?? scoped.get("claude design") ?? scoped.get("design") ?? null,
    seven_day_fable: scoped.get("fable") ?? null,
    subscription_type: subscriptionType,
  };
}

async function readCreds(credsPath: string): Promise<OauthState | null> {
  try {
    const raw = await fs.readFile(credsPath, "utf8");
    const parsed = JSON.parse(raw) as CredsFile;
    const oauth = parsed.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    let expiresAt: number | undefined;
    if (typeof oauth.expiresAt === "number") expiresAt = oauth.expiresAt;
    else if (typeof oauth.expiresAt === "string") expiresAt = Date.parse(oauth.expiresAt) || undefined;
    let scopes: string[] | undefined;
    if (Array.isArray(oauth.scopes)) scopes = oauth.scopes;
    else if (typeof oauth.scopes === "string") scopes = oauth.scopes.split(/[ ,]+/).filter(Boolean);
    return {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken,
      expiresAt,
      scopes,
      subscriptionType: oauth.subscriptionType,
    };
  } catch {
    return null;
  }
}

async function writeCreds(state: OauthState, credsPath: string): Promise<void> {
  let existing: CredsFile = {};
  try {
    existing = JSON.parse(await fs.readFile(credsPath, "utf8"));
  } catch {}
  const merged: CredsFile = {
    ...existing,
    claudeAiOauth: {
      ...(existing.claudeAiOauth ?? {}),
      accessToken: state.accessToken,
      refreshToken: state.refreshToken ?? existing.claudeAiOauth?.refreshToken,
      expiresAt: state.expiresAt ?? existing.claudeAiOauth?.expiresAt,
      scopes: state.scopes ?? existing.claudeAiOauth?.scopes,
    },
  };
  const tmp = `${credsPath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.rename(tmp, credsPath);
}

async function refreshIfNeeded(state: OauthState, credsPath: string): Promise<OauthState> {
  if (!state.refreshToken) return state;
  if (state.expiresAt && state.expiresAt - EXPIRY_BUFFER_MS > Date.now()) return state;

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: state.refreshToken,
      client_id: CLIENT_ID,
      scope: state.scopes && state.scopes.length > 0 ? state.scopes.join(" ") : undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`claude token refresh failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!json.access_token) throw new Error("claude token refresh: missing access_token");

  const refreshed: OauthState = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? state.refreshToken,
    expiresAt: json.expires_in ? Date.now() + json.expires_in * 1000 : state.expiresAt,
    scopes: json.scope ? json.scope.split(" ") : state.scopes,
    subscriptionType: state.subscriptionType,
  };
  await writeCreds(refreshed, credsPath);
  return refreshed;
}

export async function fetchClaudeUsage(credsPath: string = DEFAULT_CREDS_PATH): Promise<ClaudeUsage> {
  const state = await readCreds(credsPath);
  if (!state) throw new Error(`no claude credentials at ${credsPath}`);
  const fresh = await refreshIfNeeded(state, credsPath);

  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${fresh.accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
  });
  if (res.status === 429) {
    throw new RateLimitError(parseRetryAfter(res.headers.get("retry-after")) || 60);
  }
  if (!res.ok) {
    throw new Error(`claude usage HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as RawUsageResponse;
  return parseClaudeUsage(json, fresh.subscriptionType ?? null);
}
