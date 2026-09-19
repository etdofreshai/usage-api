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

export async function fetchJevUsage(nineGateUrl: string): Promise<JevUsage> {
  const url = `${nineGateUrl.replace(/\/+$/, "")}/_9gate/jev-spend`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const json = await res.json().catch(() => ({})) as Partial<JevUsage> & { error?: string };
  if (!res.ok) throw new Error(`9gate Jev spend HTTP ${res.status}: ${json.error ?? "unknown error"}`);
  return {
    spend_1d: Number(json.spend_1d) || 0,
    spend_3d: Number(json.spend_3d) || 0,
    spend_7d: Number(json.spend_7d) || 0,
    requests_1d: Number(json.requests_1d) || 0,
    requests_3d: Number(json.requests_3d) || 0,
    requests_7d: Number(json.requests_7d) || 0,
    models: Array.isArray(json.models) ? json.models : [],
    currency: json.currency ?? "USD",
    fetched_at: json.fetched_at ?? new Date().toISOString(),
  };
}
