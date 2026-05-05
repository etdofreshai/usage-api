/**
 * Z.ai (GLM Coding Plan) quota.
 *
 * Endpoint: GET https://api.z.ai/api/monitor/usage/quota/limit
 *   → data.limits[] with type ∈ { TOKENS_LIMIT (5h tokens), TIME_LIMIT (monthly prompts) }
 */
import { RateLimitError, parseRetryAfter } from "../cache.js";

const URL = "https://api.z.ai/api/monitor/usage/quota/limit";

export interface ZaiUsage {
  five_hour: { used_percent: number; resets_at: string | null } | null;
  monthly: { used_percent: number; current: number; limit: number; resets_at: string | null } | null;
  level: string | null;
}

interface ZaiQuotaItem {
  type?: string;
  usage?: number;
  currentValue?: number;
  remaining?: number;
  percentage?: number;
  nextResetTime?: number;
}

interface ZaiResponse {
  data?: { limits?: ZaiQuotaItem[]; level?: string };
}

function pct(item: ZaiQuotaItem | undefined): number {
  if (!item) return 0;
  if (typeof item.percentage === "number") return item.percentage;
  if (typeof item.usage === "number" && item.usage > 0 && typeof item.currentValue === "number") {
    return Math.min(100, Math.max(0, (item.currentValue / item.usage) * 100));
  }
  return 0;
}

function resetIso(item: ZaiQuotaItem | undefined): string | null {
  return item?.nextResetTime ? new Date(item.nextResetTime).toISOString() : null;
}

export async function fetchZaiUsage(apiKey: string): Promise<ZaiUsage> {
  const res = await fetch(URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 429) {
    throw new RateLimitError(parseRetryAfter(res.headers.get("retry-after")) || 60);
  }
  if (!res.ok) {
    throw new Error(`zai usage HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as ZaiResponse;
  const limits = json.data?.limits ?? [];
  const tokens = limits.find((q) => q.type?.toUpperCase() === "TOKENS_LIMIT");
  const monthly = limits.find((q) => q.type?.toUpperCase() === "TIME_LIMIT");

  return {
    five_hour: tokens
      ? { used_percent: pct(tokens), resets_at: resetIso(tokens) }
      : null,
    monthly: monthly
      ? {
          used_percent: pct(monthly),
          current: monthly.currentValue ?? 0,
          limit: monthly.usage ?? 0,
          resets_at: resetIso(monthly),
        }
      : null,
    level: json.data?.level ?? null,
  };
}
