/**
 * Codex usage via ET's CLIProxyAPI server.
 *
 * CLIProxyAPI holds the OAuth-authenticated Codex account(s) and passively
 * captures OpenAI's rate-limit response headers on every real Codex call it
 * proxies (X-Codex-Primary-*, X-Codex-Secondary-*, and the Spark
 * "Bengalfox" pair). Window minutes classify five_hour vs. seven_day the
 * same way the old wham/usage-based fetcher did — OpenAI's primary/
 * secondary slot naming is positional, not semantic, so trust the window
 * length instead of the label. Reset credits aren't in those passive
 * headers, so that one field is still fetched live, but through
 * CLIProxyAPI's own /api-call proxy using its already-refreshed access
 * token instead of usage-api managing Codex OAuth credentials itself.
 */
import { callThroughCliProxy, CpaAuthFile, findAuthFile, isoFromRelativeSeconds, unixSecondsToIso } from "./cliproxyapi.js";

export interface CodexWindow {
  used_percent: number;
  resets_at: string | null;
  window_minutes: number;
}

export interface CodexAdditionalLimit {
  name: string;
  metered_feature: string | null;
  five_hour: CodexWindow | null;
  seven_day: CodexWindow | null;
  /** @deprecated Compatibility alias for five_hour. */
  primary: CodexWindow | null;
  /** @deprecated Compatibility alias for seven_day. */
  secondary: CodexWindow | null;
}

export interface CodexResetCredit {
  status: string | null;
  granted_at: string | null;
  expires_at: string | null;
}

export interface CodexResetCredits {
  available_count: number;
  next_expires_at: string | null;
  credits: CodexResetCredit[];
}

export interface CodexUsage {
  plan_type: string | null;
  five_hour: CodexWindow | null;
  seven_day: CodexWindow | null;
  /** @deprecated Compatibility alias for five_hour. */
  primary: CodexWindow | null;
  /** @deprecated Compatibility alias for seven_day. */
  secondary: CodexWindow | null;
  additional: CodexAdditionalLimit[];
  credits_balance: string | null;
  // null when reset-credits couldn't be fetched (best-effort call).
  reset_credits: CodexResetCredits | null;
}

const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

function rawWindow(
  signals: Record<string, string> | undefined,
  observedAt: string | undefined,
  prefix: string
): CodexWindow | null {
  if (!signals) return null;
  const usedRaw = signals[`X-Codex-${prefix}-Used-Percent`];
  const minutesRaw = signals[`X-Codex-${prefix}-Window-Minutes`];
  if (usedRaw === undefined || minutesRaw === undefined) return null;
  const windowMinutes = Number(minutesRaw);
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return null;
  const resetsAt =
    unixSecondsToIso(signals[`X-Codex-${prefix}-Reset-At`]) ??
    isoFromRelativeSeconds(observedAt, signals[`X-Codex-${prefix}-Reset-After-Seconds`]);
  return {
    used_percent: Number(usedRaw) || 0,
    resets_at: resetsAt,
    window_minutes: Math.round(windowMinutes),
  };
}

function classifyWindows(
  signals: Record<string, string> | undefined,
  observedAt: string | undefined,
  bengalfox: boolean
): { five_hour: CodexWindow | null; seven_day: CodexWindow | null } {
  const prefix = bengalfox ? "Bengalfox-" : "";
  const windows = [
    rawWindow(signals, observedAt, `${prefix}Primary`),
    rawWindow(signals, observedAt, `${prefix}Secondary`),
  ].filter((w): w is CodexWindow => w !== null);
  return {
    // Allow modest server-side duration changes without confusing a short
    // session window with the weekly window.
    five_hour: windows.find((w) => w.window_minutes > 0 && w.window_minutes <= 24 * 60) ?? null,
    seven_day: windows.find((w) => w.window_minutes > 24 * 60) ?? null,
  };
}

async function fetchResetCredits(entry: CpaAuthFile): Promise<CodexResetCredits | null> {
  try {
    const { status, body } = await callThroughCliProxy(entry.auth_index, "GET", RESET_CREDITS_URL, {
      Authorization: "Bearer $TOKEN$",
      "User-Agent": "codex-cli",
      Accept: "application/json",
    });
    if (status !== 200) return null;
    const json = JSON.parse(body) as {
      available_count?: number;
      credits?: Array<{ status?: string; granted_at?: string; expires_at?: string }>;
    };
    const credits: CodexResetCredit[] = (json.credits ?? []).map((c) => ({
      status: c.status ?? null,
      granted_at: c.granted_at ?? null,
      expires_at: c.expires_at ?? null,
    }));
    const nextExpiry =
      credits
        .filter((c) => c.status === "available" && c.expires_at)
        .map((c) => c.expires_at as string)
        .sort()[0] ?? null;
    return {
      available_count: json.available_count ?? credits.filter((c) => c.status === "available").length,
      next_expires_at: nextExpiry,
      credits,
    };
  } catch {
    return null;
  }
}

export async function fetchCodexUsage(email?: string): Promise<CodexUsage> {
  const entry = await findAuthFile("codex", email);
  const signals = entry.quota?.signals;
  const observedAt = entry.quota?.observed_at;
  const main = classifyWindows(signals, observedAt, false);
  const spark = classifyWindows(signals, observedAt, true);

  const sparkName = signals?.["X-Codex-Bengalfox-Limit-Name"];
  const additional: CodexAdditionalLimit[] = sparkName
    ? [
        {
          name: sparkName,
          metered_feature: "codex_bengalfox",
          five_hour: spark.five_hour,
          seven_day: spark.seven_day,
          primary: spark.five_hour,
          secondary: spark.seven_day,
        },
      ]
    : [];

  return {
    plan_type: signals?.["X-Codex-Plan-Type"] ?? null,
    five_hour: main.five_hour,
    seven_day: main.seven_day,
    primary: main.five_hour,
    secondary: main.seven_day,
    additional,
    credits_balance:
      signals?.["X-Codex-Credits-Unlimited"] === "True" ? "unlimited" : signals?.["X-Codex-Credits-Balance"] ?? null,
    reset_credits: await fetchResetCredits(entry),
  };
}
