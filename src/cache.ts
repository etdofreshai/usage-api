/**
 * Adaptive background poller. Each provider has its own Poller that runs on
 * a self-tuned interval: starts at TARGET, walks toward FLOOR on success,
 * backs off toward CEILING on errors / Retry-After hints.
 */

const FLOOR = Number(process.env.POLL_FLOOR_SECONDS ?? 60);
const TARGET = Number(process.env.POLL_TARGET_SECONDS ?? 150);
const CEILING = Number(process.env.POLL_CEILING_SECONDS ?? 600);

export class RateLimitError extends Error {
  constructor(public retryAfterSec: number, message?: string) {
    super(message ?? `rate limited; retry after ${retryAfterSec}s`);
  }
}

export interface CacheEntry<T> {
  data: T | null;
  fetchedAt: string | null;
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
    return {
      data: this.data,
      fetchedAt: this.fetchedAt,
      error: this.error,
      intervalSec: this.intervalSec,
      nextFetchAt: this.nextFetchAt.toISOString(),
    };
  }

  private scheduleNext(delayMs: number) {
    this.nextFetchAt = new Date(Date.now() + delayMs);
    this.timer = setTimeout(() => void this.tick(), delayMs);
  }

  private async tick() {
    try {
      this.data = await this.fetcher();
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
        this.intervalSec = Math.min(CEILING, Math.max(err.retryAfterSec, this.intervalSec * 2));
        this.error = `rate-limited (retry after ${err.retryAfterSec}s)`;
      } else {
        this.intervalSec = Math.min(CEILING, this.intervalSec * 2);
        this.error = err instanceof Error ? err.message : String(err);
        console.error(`[${this.name}] fetch failed:`, this.error);
      }
    } finally {
      this.scheduleNext(this.intervalSec * 1000);
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
