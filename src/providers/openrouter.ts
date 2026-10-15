/** Read-only OpenRouter account credits, key allowance and exact trailing seven-day spend. */
import { throwIfRateLimited } from "../cache.js";

function amount(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
}
async function read(url: string, key: string, options: RequestInit = {}): Promise<any> {
  const res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${key}`, Accept: "application/json", ...options.headers }, signal: AbortSignal.timeout(15000) });
  throwIfRateLimited(res);
  if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
  return res.json();
}
export interface OpenRouterUsage {
  usage: number | null; limit: number | null; limit_remaining: number | null;
  is_free_tier: boolean | null; label: string | null;
  credits_balance: number | null; spend_7d: number | null; currency: string;
  spend_start: string; spend_end: string; balance_error: boolean; spend_error: boolean;
}
export async function fetchOpenRouterUsage(apiKey: string, managementKey?: string): Promise<OpenRouterUsage> {
  const json = await read("https://openrouter.ai/api/v1/key", apiKey);
  const d = json.data ?? {};
  const end = new Date(), start = new Date(end.getTime() - 7 * 86400000);
  const [credits, spend] = await Promise.allSettled([
    read("https://openrouter.ai/api/v1/credits", managementKey ?? apiKey),
    managementKey ? read("https://openrouter.ai/api/v1/analytics/query", managementKey, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ metrics: ["total_usage"], dimensions: ["model"], time_range: { start: start.toISOString(), end: end.toISOString() }, limit: 100 }),
    }) : Promise.reject(new Error("Management key required for trailing seven-day spend")),
  ]);
  let balance: number | null = null, spent: number | null = null;
  if (credits.status === "fulfilled") {
    const total = amount(credits.value.data?.total_credits), used = amount(credits.value.data?.total_usage);
    if (total != null && used != null) balance = Math.max(0, total - used);
  }
  if (spend.status === "fulfilled" && !spend.value.data?.metadata?.truncated) {
    const rows = spend.value.data?.data;
    if (Array.isArray(rows) && rows.length > 0 && rows.every(row => amount(row?.total_usage) != null)) {
      spent = amount(rows.reduce((sum, row) => sum + amount(row.total_usage)!, 0));
    }
    // Empty analytics rows are unknown: never invent zero spending from a missing result.
  }
  return { usage: amount(d.usage), limit: amount(d.limit), limit_remaining: amount(d.limit_remaining),
    is_free_tier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null, label: typeof d.label === "string" ? d.label : null,
    credits_balance: balance, spend_7d: spent, currency: "USD", spend_start: start.toISOString(), spend_end: end.toISOString(),
    balance_error: balance == null, spend_error: spent == null };
}
