/**
 * Claude usage, read straight from Anthropic with a token borrowed from
 * 9router.
 *
 * GET /api/oauth/usage is the same endpoint Claude Code itself calls, so the
 * numbers here are Anthropic's own rather than anything inferred. That
 * matters most for the per-model weekly limit: Anthropic reports it as a
 * `weekly_scoped` entry in `limits[]`, which is a different figure from the
 * account-wide weekly window. The previous CLIProxyAPI-backed version read a
 * model's cached `Anthropic-Ratelimit-Unified-7d-Utilization` header and
 * labelled it "fable", but that header is the account-wide weekly value as
 * it stood when that model last ran — so Fable read roughly double its real
 * usage.
 *
 * usage-api still owns no Claude credential: 9router holds the OAuth account
 * and refreshes the token, and this module only reads it.
 */
import { findConnection } from "./ninerouter.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const OAUTH_BETA = "oauth-2025-04-20";

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
  // Per-model weekly limit from the `limits[]` array (scope.model "Fable").
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
export function planLabel(profile: AnthropicProfile): string | null {
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

// The usage endpoint carries no tier at all, so the label needs this second
// request. Best-effort: the tier is a label, never a measurement, so a
// failure here degrades to the last known value (or null) rather than
// failing the whole poll.
async function fetchSubscriptionType(connectionId: string, token: string): Promise<string | null> {
  const cached = profileCache.get(connectionId);
  if (cached && Date.now() - cached.at < PROFILE_TTL_MS) return cached.label;
  try {
    const res = await fetch(PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": OAUTH_BETA,
        Accept: "application/json",
      },
    });
    if (!res.ok) return cached?.label ?? null;
    const label = planLabel((await res.json()) as AnthropicProfile);
    profileCache.set(connectionId, { at: Date.now(), label });
    return label;
  } catch {
    return cached?.label ?? null;
  }
}

export async function fetchClaudeUsage(account?: string): Promise<ClaudeUsage> {
  const connection = findConnection("claude", account);
  const res = await fetch(USAGE_URL, {
    headers: {
      Authorization: `Bearer ${connection.accessToken}`,
      "anthropic-beta": OAUTH_BETA,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`anthropic oauth/usage HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as RawUsageResponse;
  return parseClaudeUsage(json, await fetchSubscriptionType(connection.id, connection.accessToken));
}
