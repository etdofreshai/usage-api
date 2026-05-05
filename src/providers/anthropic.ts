/**
 * Claude Max usage via the OAuth endpoint.
 *
 * Reads ~/.claude/.credentials.json (mounted from host, shared with ai-sessions).
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

const CREDS_PATH = process.env.CLAUDE_CREDENTIALS_PATH
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

export interface ClaudeUsage {
  five_hour: { utilization: number; resets_at: string | null };
  seven_day: { utilization: number; resets_at: string | null };
  subscription_type: string | null;
}

async function readCreds(): Promise<OauthState | null> {
  try {
    const raw = await fs.readFile(CREDS_PATH, "utf8");
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

async function writeCreds(state: OauthState): Promise<void> {
  let existing: CredsFile = {};
  try {
    existing = JSON.parse(await fs.readFile(CREDS_PATH, "utf8"));
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
  const tmp = `${CREDS_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.rename(tmp, CREDS_PATH);
}

async function refreshIfNeeded(state: OauthState): Promise<OauthState> {
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
  await writeCreds(refreshed);
  return refreshed;
}

export async function fetchClaudeUsage(): Promise<ClaudeUsage> {
  const state = await readCreds();
  if (!state) throw new Error(`no claude credentials at ${CREDS_PATH}`);
  const fresh = await refreshIfNeeded(state);

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
  const json = (await res.json()) as {
    five_hour?: { utilization?: number; resets_at?: string };
    seven_day?: { utilization?: number; resets_at?: string };
  };
  return {
    five_hour: {
      utilization: json.five_hour?.utilization ?? 0,
      resets_at: json.five_hour?.resets_at ?? null,
    },
    seven_day: {
      utilization: json.seven_day?.utilization ?? 0,
      resets_at: json.seven_day?.resets_at ?? null,
    },
    subscription_type: fresh.subscriptionType ?? null,
  };
}
