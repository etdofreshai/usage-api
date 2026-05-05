/**
 * Codex usage via the (browser-authenticated) wham endpoint.
 *
 * Reads ~/.codex/auth.json (mounted from host, shared with ai-sessions).
 * Refreshes the access token reactively on 401.
 *
 * Endpoint: GET https://chatgpt.com/backend-api/wham/usage
 *   → rate_limit.{primary_window, secondary_window}.{used_percent, reset_at, limit_window_seconds}
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { RateLimitError, parseRetryAfter } from "../cache.js";

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const USER_AGENT = "codex-cli";

const AUTH_PATH = process.env.CODEX_AUTH_PATH
  ?? path.join(homedir(), ".codex", "auth.json");

interface CodexAuth {
  accessToken: string;
  refreshToken?: string;
  accountId?: string;
}

interface AuthFile {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
}

export interface CodexUsage {
  plan_type: string | null;
  primary: { used_percent: number; resets_at: string | null; window_minutes: number };
  secondary: { used_percent: number; resets_at: string | null; window_minutes: number };
  credits_balance: string | null;
}

async function readAuth(): Promise<CodexAuth | null> {
  try {
    const raw = await fs.readFile(AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw) as AuthFile;
    const t = parsed.tokens;
    if (!t?.access_token) return null;
    return { accessToken: t.access_token, refreshToken: t.refresh_token, accountId: t.account_id };
  } catch {
    return null;
  }
}

async function writeAccessToken(accessToken: string): Promise<void> {
  let existing: AuthFile = {};
  try {
    existing = JSON.parse(await fs.readFile(AUTH_PATH, "utf8"));
  } catch {}
  const merged: AuthFile = {
    ...existing,
    tokens: { ...(existing.tokens ?? {}), access_token: accessToken },
  };
  const tmp = `${AUTH_PATH}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.rename(tmp, AUTH_PATH);
}

async function refresh(refreshToken: string): Promise<string> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`codex token refresh failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("codex token refresh: missing access_token");
  await writeAccessToken(json.access_token);
  return json.access_token;
}

async function callUsage(accessToken: string, accountId: string | undefined): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return fetch(USAGE_URL, { headers });
}

export async function fetchCodexUsage(): Promise<CodexUsage> {
  const auth = await readAuth();
  if (!auth) throw new Error(`no codex auth at ${AUTH_PATH}`);

  let res = await callUsage(auth.accessToken, auth.accountId);
  if (res.status === 401 && auth.refreshToken) {
    const newToken = await refresh(auth.refreshToken);
    res = await callUsage(newToken, auth.accountId);
  }
  if (res.status === 429) {
    throw new RateLimitError(parseRetryAfter(res.headers.get("retry-after")) || 60);
  }
  if (!res.ok) {
    throw new Error(`codex usage HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as {
    plan_type?: string;
    rate_limit?: {
      primary_window?: { used_percent?: number; reset_at?: number; limit_window_seconds?: number };
      secondary_window?: { used_percent?: number; reset_at?: number; limit_window_seconds?: number };
    };
    credits?: { unlimited?: boolean; balance?: string };
  };
  const parseWin = (w: { used_percent?: number; reset_at?: number; limit_window_seconds?: number } | undefined) => ({
    used_percent: w?.used_percent ?? 0,
    resets_at: w?.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
    window_minutes: w?.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : 0,
  });
  return {
    plan_type: json.plan_type ?? null,
    primary: parseWin(json.rate_limit?.primary_window),
    secondary: parseWin(json.rate_limit?.secondary_window),
    credits_balance: json.credits?.unlimited ? "unlimited" : json.credits?.balance ?? null,
  };
}
