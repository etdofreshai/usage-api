/**
 * Claude usage via ET's CLIProxyAPI server.
 *
 * CLIProxyAPI already holds the OAuth-authenticated Claude account(s) and
 * passively captures Anthropic's rate-limit response headers on every real
 * request it proxies. Reading that cached snapshot from
 * GET /v0/management/auth-files avoids usage-api managing its own Claude
 * OAuth credential file and token refresh.
 */
import { callThroughCliProxy, CpaAuthFile, findAuthFile, unixSecondsToIso } from "./cliproxyapi.js";

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
  // Per-model weekly limit (scope.model "Fable").
  seven_day_fable: ClaudeWindow | null;
  subscription_type: string | null;
}

// CLIProxyAPI exposes Anthropic's unified rate-limit headers verbatim, e.g.
// Anthropic-Ratelimit-Unified-5h-Utilization / -5h-Reset (and 7d-*). The
// utilization value is a 0-1 fraction; the public API keeps the legacy 0-100
// percentage shape.
function windowFromSignals(signals: Record<string, string> | undefined, prefix: "5h" | "7d"): ClaudeWindow | null {
  if (!signals) return null;
  const utilRaw = signals[`Anthropic-Ratelimit-Unified-${prefix}-Utilization`];
  if (utilRaw === undefined) return null;
  const fraction = Number(utilRaw);
  return {
    utilization: Number.isFinite(fraction) ? fraction * 100 : 0,
    resets_at: unixSecondsToIso(signals[`Anthropic-Ratelimit-Unified-${prefix}-Reset`]),
  };
}

function accountWindow(signals: Record<string, string> | undefined, prefix: "5h" | "7d"): ClaudeWindow {
  return windowFromSignals(signals, prefix) ?? { utilization: 0, resets_at: null };
}

// Model IDs are whatever CLIProxyAPI's own model catalog calls them; try a
// couple of plausible spellings and degrade to null (not an error) if a
// model simply hasn't been used through the proxy recently enough to have a
// cached header snapshot.
function modelWindow(entry: CpaAuthFile, modelIds: string[], prefix: "5h" | "7d"): ClaudeWindow | null {
  for (const id of modelIds) {
    const win = windowFromSignals(entry.model_quotas?.[id]?.signals, prefix);
    if (win) return win;
  }
  return null;
}

const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
// Subscription tier changes about never, so this is cached far beyond the
// poll interval; a stale label is much cheaper than a round trip per tick.
const PROFILE_TTL_MS = 30 * 60_000;

interface AnthropicProfile {
  account?: { has_claude_max?: boolean; has_claude_pro?: boolean };
  organization?: { organization_type?: string; rate_limit_tier?: string };
}

const profileCache = new Map<string, { at: number; label: string | null }>();

// Anthropic spreads the plan across three fields and none of them is a display
// string: has_claude_max/has_claude_pro pick the family, while rate_limit_tier
// is the only place the Max multiplier appears (e.g. "...claude_max_20x").
// Match on the multiplier substring so a prefix change upstream doesn't matter.
function planLabel(profile: AnthropicProfile): string | null {
  const account = profile.account ?? {};
  const tier = profile.organization?.rate_limit_tier ?? "";
  if (account.has_claude_max) {
    if (/20x/i.test(tier)) return "Max 20x";
    if (/5x/i.test(tier)) return "Max 5x";
    return "Max";
  }
  if (account.has_claude_pro) return "Pro";
  const orgType = profile.organization?.organization_type ?? "";
  if (/enterprise/i.test(orgType)) return "Enterprise";
  if (/team/i.test(orgType)) return "Team";
  return null;
}

// Best-effort: the tier is a label, never a measurement, so a failure here
// degrades to null (or the last known value) instead of failing the poll.
async function fetchSubscriptionType(entry: CpaAuthFile): Promise<string | null> {
  const cached = profileCache.get(entry.auth_index);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.label;
  try {
    const { status, body } = await callThroughCliProxy(entry.auth_index, "GET", PROFILE_URL, {
      Authorization: "Bearer $TOKEN$",
      "anthropic-beta": "oauth-2025-04-20",
      Accept: "application/json",
    });
    if (status !== 200) return cached?.label ?? null;
    const label = planLabel(JSON.parse(body) as AnthropicProfile);
    profileCache.set(entry.auth_index, { at: Date.now(), label });
    return label;
  } catch {
    return cached?.label ?? null;
  }
}

export async function fetchClaudeUsage(email?: string): Promise<ClaudeUsage> {
  const entry = await findAuthFile("claude", email);
  const signals = entry.quota?.signals;
  return {
    five_hour: accountWindow(signals, "5h"),
    seven_day: accountWindow(signals, "7d"),
    seven_day_sonnet: modelWindow(entry, ["claude-sonnet-5"], "7d"),
    seven_day_opus: modelWindow(entry, ["claude-opus-5"], "7d"),
    seven_day_design: modelWindow(entry, ["claude-design", "claude-omelette"], "7d"),
    seven_day_fable: modelWindow(entry, ["claude-fable-5-1", "claude-fable-5"], "7d"),
    // CLIProxyAPI's auth-files snapshot has no tier field, so this is the
    // one extra (cached) call Claude needs.
    subscription_type: await fetchSubscriptionType(entry),
  };
}
