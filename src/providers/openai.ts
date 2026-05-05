/**
 * OpenAI org-level cost (current month + today).
 * Requires an org admin key (sk-admin-...).
 *
 * Endpoint: GET https://api.openai.com/v1/organization/costs?start_time=...
 */
import { RateLimitError, parseRetryAfter } from "../cache.js";

export interface OpenAiUsage {
  spend_today: number;
  spend_month: number;
  currency: string;
}

async function fetchSpend(apiKey: string, startUnix: number): Promise<number> {
  const url = `https://api.openai.com/v1/organization/costs?start_time=${startUnix}&limit=180`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (res.status === 429) {
    throw new RateLimitError(parseRetryAfter(res.headers.get("retry-after")) || 60);
  }
  if (!res.ok) {
    throw new Error(`openai costs HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as {
    data?: Array<{ results?: Array<{ amount?: { value?: number } }> }>;
  };
  let total = 0;
  for (const bucket of json.data ?? []) {
    for (const r of bucket.results ?? []) {
      total += r.amount?.value ?? 0;
    }
  }
  return total;
}

export async function fetchOpenAiUsage(apiKey: string): Promise<OpenAiUsage> {
  const now = new Date();
  const monthStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) / 1000);
  const todayStart = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);

  const [month, today] = await Promise.all([
    fetchSpend(apiKey, monthStart),
    fetchSpend(apiKey, todayStart),
  ]);
  return { spend_today: today, spend_month: month, currency: "USD" };
}
