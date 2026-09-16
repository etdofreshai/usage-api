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
  // An unreadable number is absent data, not zero usage. Returning null lets the
  // caller fall back to what it already knows instead of inventing a figure.
  if (!Number.isFinite(fraction)) return null;
  return {
    utilization: fraction * 100,
    resets_at: unixSecondsToIso(signals[`Anthropic-Ratelimit-Unified-${prefix}-Reset`]),
  };
}

// CLIProxyAPI rewrites the auth file every time it refreshes the OAuth token,
// and the cached header snapshot does not survive that rewrite. Until the next
// real request repopulates it, `quota.signals` is simply absent — which is not
// remotely the same thing as "zero percent used", though that is what the old
// `?? 0` fallback reported. Idle accounts therefore read 0% until they were
// used again.
//
// Anthropic's utilization only ever climbs within a window, so the previous
// reading stays true for the rest of that window. Carrying it forward is a
// sound floor rather than a guess. Once the window's own reset passes, the
// spend really is gone and zero becomes the honest answer.
export function carryForwardWindow(
  fresh: ClaudeWindow | null,
  cached: ClaudeWindow | undefined,
  nowMs: number,
): ClaudeWindow {
  if (fresh) return fresh;
  if (cached?.resets_at) {
    const resetMs = Date.parse(cached.resets_at);
    if (Number.isFinite(resetMs) && resetMs > nowMs) return cached;
  }
  return { utilization: 0, resets_at: null };
}

// Keyed by account and window, so a second Claude account cannot inherit the
// first one's numbers.
const lastGoodWindows = new Map<string, ClaudeWindow>();

function accountWindow(
  accountKey: string,
  signals: Record<string, string> | undefined,
  prefix: "5h" | "7d",
  nowMs: number,
): ClaudeWindow {
  const cacheKey = `${accountKey}:${prefix}`;
  const result = carryForwardWindow(windowFromSignals(signals, prefix), lastGoodWindows.get(cacheKey), nowMs);
  // Remember only real readings; a rolled-over window must not be resurrected
  // by the next gap.
  if (result.resets_at) lastGoodWindows.set(cacheKey, result);
  else lastGoodWindows.delete(cacheKey);
  return result;
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
  const accountKey = entry.auth_index || email || "claude";
  const nowMs = Date.now();
  return {
    five_hour: accountWindow(accountKey, signals, "5h", nowMs),
    seven_day: accountWindow(accountKey, signals, "7d", nowMs),
    seven_day_sonnet: modelWindow(entry, ["claude-sonnet-5"], "7d"),
    seven_day_opus: modelWindow(entry, ["claude-opus-5"], "7d"),
    seven_day_design: modelWindow(entry, ["claude-design", "claude-omelette"], "7d"),
    seven_day_fable: modelWindow(entry, ["claude-fable-5-1", "claude-fable-5"], "7d"),
    // CLIProxyAPI's auth-files snapshot has no tier field, so this is the
    // one extra (cached) call Claude needs.
    subscription_type: await fetchSubscriptionType(entry),
  };
}
