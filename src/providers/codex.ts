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
const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
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

interface AuthTokens {
  access_token?: string;
  refresh_token?: string;
  account_id?: string;
}
// Codex CLI has shipped two layouts: tokens nested under `tokens`, and tokens
// at the top level. Accept either.
interface AuthFile extends AuthTokens {
  tokens?: AuthTokens;
}

export interface CodexWindow {
  used_percent: number;
  resets_at: string | null;
  window_minutes: number;
}

export interface CodexAdditionalLimit {
  name: string;
  metered_feature: string | null;
  primary: CodexWindow;
  secondary: CodexWindow;
}

export interface CodexResetCredit {
  status: string | null;
  granted_at: string | null;
  expires_at: string | null;
}

// "Rate limit reset credits" — free full-reset grants (30-day expiry) listed by
// GET /backend-api/wham/rate-limit-reset-credits. The wham/usage summary only
// carries available_count; this block adds per-credit expiry dates.
export interface CodexResetCredits {
  available_count: number;
  // Soonest expires_at among still-available credits ("use it or lose it").
  next_expires_at: string | null;
  credits: CodexResetCredit[];
}

export interface CodexUsage {
  plan_type: string | null;
  primary: CodexWindow;
  secondary: CodexWindow;
  additional: CodexAdditionalLimit[];
  credits_balance: string | null;
  // null when the reset-credits endpoint is unavailable (best-effort fetch).
  reset_credits: CodexResetCredits | null;
}

export interface RawResetCreditsResponse {
  credits?: Array<{
    status?: string;
    granted_at?: string;
    expires_at?: string;
  }>;
  available_count?: number;
}

export function parseResetCredits(json: RawResetCreditsResponse): CodexResetCredits {
  const credits: CodexResetCredit[] = (json.credits ?? []).map((c) => ({
    status: c.status ?? null,
    granted_at: c.granted_at ?? null,
    expires_at: c.expires_at ?? null,
  }));
  const nextExpiry = credits
    .filter((c) => c.status === "available" && c.expires_at)
    .map((c) => c.expires_at as string)
    .sort()[0] ?? null;
  return {
    available_count: json.available_count ?? credits.filter((c) => c.status === "available").length,
    next_expires_at: nextExpiry,
    credits,
  };
}

async function readAuth(): Promise<CodexAuth | null> {
  try {
    const raw = await fs.readFile(AUTH_PATH, "utf8");
    const parsed = JSON.parse(raw) as AuthFile;
    const t: AuthTokens = parsed.tokens ?? parsed;
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
  // Preserve whichever layout the file uses on disk.
  const nested = existing.tokens !== undefined;
  const merged: AuthFile = nested
    ? { ...existing, tokens: { ...(existing.tokens ?? {}), access_token: accessToken } }
    : { ...existing, access_token: accessToken };
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

function authHeaders(accessToken: string, accountId: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": USER_AGENT,
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

async function callUsage(accessToken: string, accountId: string | undefined): Promise<Response> {
  return fetch(USAGE_URL, { headers: authHeaders(accessToken, accountId) });
}

// Best-effort: reset credits are a nice-to-have, so any failure here must not
// fail the whole codex poll. (Read-only list endpoint; redeeming is a separate
// POST .../consume that this service never calls.)
async function fetchResetCredits(accessToken: string, accountId: string | undefined): Promise<CodexResetCredits | null> {
  try {
    const res = await fetch(RESET_CREDITS_URL, { headers: authHeaders(accessToken, accountId) });
    if (!res.ok) return null;
    return parseResetCredits((await res.json()) as RawResetCreditsResponse);
  } catch {
    return null;
  }
}

export async function fetchCodexUsage(): Promise<CodexUsage> {
  const auth = await readAuth();
  if (!auth) throw new Error(`no codex auth at ${AUTH_PATH}`);

  let accessToken = auth.accessToken;
  let res = await callUsage(accessToken, auth.accountId);
  if (res.status === 401 && auth.refreshToken) {
    accessToken = await refresh(auth.refreshToken);
    res = await callUsage(accessToken, auth.accountId);
  }
  if (res.status === 429) {
    throw new RateLimitError(parseRetryAfter(res.headers.get("retry-after")) || 60);
  }
  if (!res.ok) {
    throw new Error(`codex usage HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  type RawWindow = { used_percent?: number; reset_at?: number; limit_window_seconds?: number } | undefined;
  type RawRateLimit = { primary_window?: RawWindow; secondary_window?: RawWindow } | undefined;
  const json = (await res.json()) as {
    plan_type?: string;
    rate_limit?: RawRateLimit;
    additional_rate_limits?: Array<{
      limit_name?: string;
      metered_feature?: string;
      rate_limit?: RawRateLimit;
    }>;
    credits?: { unlimited?: boolean; balance?: string };
  };
  const parseWin = (w: RawWindow): CodexWindow => ({
    used_percent: w?.used_percent ?? 0,
    resets_at: w?.reset_at ? new Date(w.reset_at * 1000).toISOString() : null,
    window_minutes: w?.limit_window_seconds ? Math.round(w.limit_window_seconds / 60) : 0,
  });
  const additional: CodexAdditionalLimit[] = (json.additional_rate_limits ?? []).map((a) => ({
    name: a.limit_name ?? "unknown",
    metered_feature: a.metered_feature ?? null,
    primary: parseWin(a.rate_limit?.primary_window),
    secondary: parseWin(a.rate_limit?.secondary_window),
  }));
  return {
    plan_type: json.plan_type ?? null,
    primary: parseWin(json.rate_limit?.primary_window),
    secondary: parseWin(json.rate_limit?.secondary_window),
    additional,
    credits_balance: json.credits?.unlimited ? "unlimited" : json.credits?.balance ?? null,
    reset_credits: await fetchResetCredits(accessToken, auth.accountId),
  };
}
