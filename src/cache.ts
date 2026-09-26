/**
 * Adaptive background poller. Each provider has its own Poller that runs on
 * a self-tuned interval: starts at TARGET, walks toward FLOOR on success,
 * backs off toward CEILING on errors / Retry-After hints.
 */

const FLOOR = Number(process.env.POLL_FLOOR_SECONDS ?? 60);
const TARGET = Number(process.env.POLL_TARGET_SECONDS ?? 150);
const CEILING = Number(process.env.POLL_CEILING_SECONDS ?? 600);
// Age of `data` at which clients should flag it. Default 5 min / 1 h.
const LITTLE_STALE_SEC = Number(process.env.STALE_LITTLE_SECONDS ?? 300);
const STALE_SEC = Number(process.env.STALE_SECONDS ?? 3600);

export type Staleness = "fresh" | "little_stale" | "stale";

export function staleness(fetchedAt: string | null, now = Date.now()): Staleness {
  const at = fetchedAt ? Date.parse(fetchedAt) : NaN;
  if (!Number.isFinite(at)) return "stale";
  const ageSec = (now - at) / 1000;
  return ageSec >= STALE_SEC ? "stale" : ageSec >= LITTLE_STALE_SEC ? "little_stale" : "fresh";
}

export class RateLimitError extends Error {
  // retryAfterSec 0 = provider gave no hint; Poller then backs off on its own.
  constructor(public retryAfterSec: number, message?: string) {
    super(message ?? (retryAfterSec > 0 ? `rate limited; retry after ${retryAfterSec}s` : "rate limited"));
  }
}

/** Throws RateLimitError on 429, carrying the provider's Retry-After (0 if absent). */
export function throwIfRateLimited(res: Response) {
  if (res.status === 429) throw new RateLimitError(parseRetryAfter(res.headers.get("retry-after")));
}

export interface CacheEntry<T> {
  /** Last successful value; kept (not cleared) when later polls fail. */
  data: T | null;
  /** ISO date-time of the fetch that produced `data`. */
  fetchedAt: string | null;
  /** ISO date-time of the latest poll, success or failure. */
  lastAttemptAt: string | null;
  /** Seconds since `fetchedAt` (null if never fetched). */
  ageSec: number | null;
  /** Age tier of `data`: fresh < 5 min <= little_stale < 1 h <= stale. */
  staleness: Staleness;
  error: string | null;
  intervalSec: number;
  nextFetchAt: string;
}

export class Poller<T> {
  private timer: NodeJS.Timeout | null = null;
  private intervalSec: number = TARGET;
  private successStreak = 0;
  private nextFetchAt = new Date();

  data: T | null = null;
  fetchedAt: string | null = null;
  lastAttemptAt: string | null = null;
  error: string | null = null;

  constructor(
    public readonly name: string,
    private readonly fetcher: () => Promise<T>,
    private readonly onSuccess?: (data: T, fetchedAt: Date) => void
  ) {}

  start() {
    this.scheduleNext(0);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  snapshot(): CacheEntry<T> {
    const at = this.fetchedAt ? Date.parse(this.fetchedAt) : NaN;
    return {
      data: this.data,
      fetchedAt: this.fetchedAt,
      lastAttemptAt: this.lastAttemptAt,
      ageSec: Number.isFinite(at) ? Math.round((Date.now() - at) / 1000) : null,
      staleness: staleness(this.fetchedAt),
      error: this.error,
      intervalSec: this.intervalSec,
      nextFetchAt: this.nextFetchAt.toISOString(),
    };
  }

  private scheduleNext(delayMs: number) {
    if (this.timer) clearTimeout(this.timer);
    this.nextFetchAt = new Date(Date.now() + delayMs);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick() {
    let delaySec: number | null = null;
    this.lastAttemptAt = new Date().toISOString();
    try {
      const data = await this.fetcher();
      this.data = data;
      const fetchedAt = new Date();
      this.fetchedAt = fetchedAt.toISOString();
      this.onSuccess?.(this.data, fetchedAt);
      this.error = null;
      this.successStreak++;
      // After 3 successful fetches, walk one step toward the floor.
      if (this.successStreak >= 3 && this.intervalSec > FLOOR) {
        this.intervalSec = Math.max(FLOOR, Math.floor(this.intervalSec * 0.75));
        this.successStreak = 0;
      }
    } catch (err) {
      this.successStreak = 0;
      if (err instanceof RateLimitError) {
        if (err.retryAfterSec > 0) {
          // Provider said exactly when: retry then (+1s slack), even past CEILING.
          // Normal cadence resumes afterwards, so one 429 doesn't slow every later poll.
          delaySec = err.retryAfterSec + 1;
        } else {
          this.intervalSec = Math.min(CEILING, this.intervalSec * 2);
        }
        this.error = `rate-limited (retry in ${delaySec ?? this.intervalSec}s)`;
        console.warn(`[${this.name}] ${this.error}`);
      } else {
        this.intervalSec = Math.min(CEILING, this.intervalSec * 2);
        this.error = err instanceof Error ? err.message : String(err);
        console.error(`[${this.name}] fetch failed:`, this.error);
      }
    } finally {
      this.scheduleNext((delaySec ?? this.intervalSec) * 1000);
    }
  }
}

export function parseRetryAfter(header: string | null): number {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds;
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
  return 0;
}
