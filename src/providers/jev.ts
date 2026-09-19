const ANALYTICS_URL = "https://openrouter.ai/api/v1/analytics/query";

export interface JevUsage {
  spend_1d: number;
  spend_3d: number;
  spend_7d: number;
  requests_1d: number;
  requests_3d: number;
  requests_7d: number;
  models: string[];
  currency: string;
  fetched_at: string;
}

interface JevSummary {
  spend: number;
  requests: number;
  models: string[];
}

function summarize(rows: any[]): JevSummary {
  const jev = rows.filter((row) => typeof row?.model === "string" && /^typesafe\/jev-/i.test(row.model));
  const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    spend: jev.reduce((sum, row) => sum + number(row.total_usage), 0),
    requests: jev.reduce((sum, row) => sum + number(row.request_count), 0),
    models: [...new Set<string>(jev.map((row) => row.model))].sort(),
  };
}

async function fetchWindow(apiKey: string, days: number, end: Date): Promise<JevSummary> {
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const res = await fetch(ANALYTICS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      metrics: ["total_usage", "request_count"],
      dimensions: ["model"],
      time_range: { start: start.toISOString(), end: end.toISOString() },
      limit: 100,
    }),
  });
  const json = await res.json().catch(() => ({})) as any;
  if (!res.ok) throw new Error(`OpenRouter analytics HTTP ${res.status}: ${json?.error?.message ?? "unknown error"}`);
  if (json?.data?.metadata?.truncated) throw new Error(`OpenRouter analytics truncated the ${days}-day Jev query`);
  return summarize(json?.data?.data ?? []);
}

export async function fetchJevUsage(apiKey: string): Promise<JevUsage> {
  const end = new Date();
  const [oneDay, threeDays, sevenDays] = await Promise.all([
    fetchWindow(apiKey, 1, end),
    fetchWindow(apiKey, 3, end),
    fetchWindow(apiKey, 7, end),
  ]);
  return {
    spend_1d: oneDay.spend,
    spend_3d: threeDays.spend,
    spend_7d: sevenDays.spend,
    requests_1d: oneDay.requests,
    requests_3d: threeDays.requests,
    requests_7d: sevenDays.requests,
    models: [...new Set([...oneDay.models, ...threeDays.models, ...sevenDays.models])].sort(),
    currency: "USD",
    fetched_at: end.toISOString(),
  };
}
