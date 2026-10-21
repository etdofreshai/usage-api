export interface RecentExchange {
  startedAt: string; model: string; outcome: string;
  jev: { effort: string | null; resolved: string };
}

export function parseRecentExchanges(body: any): RecentExchange[] {
  if (!Array.isArray(body?.events?.items)) throw new Error("Invalid CPA request history");
  return body.events.items.filter((e: any) => Number.isFinite(e.timestamp_ms) && typeof e.model === "string")
    .sort((a: any, b: any) => b.timestamp_ms - a.timestamp_ms).slice(0, 20)
    .map((e: any) => ({
      startedAt: new Date(e.timestamp_ms).toISOString(),
      model: e.resolved_model || e.response_model || e.model,
      outcome: e.failed ? "error" : "ok",
      jev: { effort: typeof e.reasoning_effort === "string" ? e.reasoning_effort : null,
        resolved: e.resolved_model || e.response_model || e.model },
    }));
}

export class RecentRequests {
  private cached: { at: number; exchanges: RecentExchange[] } | null = null;
  private pending: Promise<RecentExchange[]> | null = null;
  constructor(private readonly url: string, private readonly key: string, private readonly fetcher: typeof fetch = fetch) {}
  async get(): Promise<RecentExchange[]> {
    if (this.cached && Date.now() - this.cached.at < 5000) return this.cached.exchanges;
    if (this.pending) return this.pending;
    this.pending = this.read().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async read() {
    const now = Date.now();
    const response = await this.fetcher(`${this.url.replace(/\/$/, "")}/v0/management/monitoring/analytics`, {
      method: "POST", headers: { Authorization: `Bearer ${this.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from_ms: now - 7 * 86400000, to_ms: now, include: { events_page: { limit: 20 } } }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`CPA history HTTP ${response.status}`);
    const exchanges = parseRecentExchanges(await response.json());
    this.cached = { at: Date.now(), exchanges };
    return exchanges;
  }
}
