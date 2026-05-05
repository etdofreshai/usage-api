/**
 * OpenRouter credits.
 *
 * Endpoint: GET https://openrouter.ai/api/v1/key
 *   → { data: { label, usage, limit, limit_remaining, is_free_tier, ... } }
 */
import { RateLimitError, parseRetryAfter } from "../cache.js";

const URL = "https://openrouter.ai/api/v1/key";

export interface OpenRouterUsage {
  usage: number;
  limit: number | null;
  limit_remaining: number | null;
  is_free_tier: boolean | null;
  label: string | null;
}

export async function fetchOpenRouterUsage(apiKey: string): Promise<OpenRouterUsage> {
  const res = await fetch(URL, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 429) {
    throw new RateLimitError(parseRetryAfter(res.headers.get("retry-after")) || 60);
  }
  if (!res.ok) {
    throw new Error(`openrouter HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as {
    data?: {
      usage?: number;
      limit?: number | null;
      limit_remaining?: number | null;
      is_free_tier?: boolean;
      label?: string;
    };
  };
  const d = json.data ?? {};
  return {
    usage: d.usage ?? 0,
    limit: d.limit ?? null,
    limit_remaining: d.limit_remaining ?? null,
    is_free_tier: d.is_free_tier ?? null,
    label: d.label ?? null,
  };
}
