/**
 * Shared reader for ET's 9router connection store.
 *
 * 9router owns the OAuth-authenticated Claude and Codex accounts and, most
 * importantly, keeps their access tokens refreshed. usage-api borrows the
 * current token out of 9router's SQLite database and calls Anthropic/OpenAI
 * directly, so it never manages a refresh token of its own — the reason the
 * previous CLIProxyAPI-backed version existed at all.
 *
 * The database is opened read-only. SQLite in WAL mode allows that from a
 * separate process (and from a read-only bind mount) without disturbing the
 * writer, so this cannot interfere with 9router itself.
 *
 * Only the token is taken from here. Quota numbers are deliberately fetched
 * from the provider APIs rather than 9router's /api/usage endpoint, because
 * that endpoint drops OpenAI's `limit_window_seconds` and names windows by
 * position — which mislabels a seven-day window as a "session" one. See
 * providers/codex.ts.
 */
import { DatabaseSync } from "node:sqlite";

const DB_PATH = process.env.NINEROUTER_DB_PATH ?? "/mnt/9router/data.sqlite";

export interface RouterConnection {
  id: string;
  provider: string;
  name: string;
  email: string | null;
  accessToken: string;
  expiresAt: string | null;
}

interface ConnectionRow {
  id: string;
  provider: string;
  name: string;
  email: string | null;
  data: string;
}

// The claude, claude2, codex, and codex2 pollers each resolve their account
// within a few hundred ms of one another on every tick; a short cache
// collapses that into one database open instead of four.
let cached: { at: number; connections: RouterConnection[] } | null = null;
const CONNECTIONS_TTL_MS = 5_000;

// Opened and closed per read rather than held open. The cost is around a
// millisecond, and it guarantees each refresh observes 9router's latest
// committed token instead of a long-lived snapshot.
function readConnections(): RouterConnection[] {
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT id, provider, name, email, data FROM providerConnections WHERE isActive = 1 ORDER BY priority DESC, createdAt ASC",
      )
      .all() as unknown as ConnectionRow[];
    const connections: RouterConnection[] = [];
    for (const row of rows) {
      let parsed: { accessToken?: string; expiresAt?: string };
      try {
        parsed = JSON.parse(row.data ?? "{}");
      } catch {
        continue;
      }
      // API-key providers (glm and friends) have no OAuth token; they are not
      // errors, they simply are not what this module is for.
      if (!parsed.accessToken) continue;
      connections.push({
        id: row.id,
        provider: row.provider,
        name: row.name,
        email: row.email ?? null,
        accessToken: parsed.accessToken,
        expiresAt: parsed.expiresAt ?? null,
      });
    }
    return connections;
  } finally {
    db.close();
  }
}

export function listConnections(): RouterConnection[] {
  if (cached && Date.now() - cached.at < CONNECTIONS_TTL_MS) return cached.connections;
  const connections = readConnections();
  cached = { at: Date.now(), connections };
  return connections;
}

/**
 * Resolves one account for a provider. 9router records an email for Codex
 * connections but not necessarily for Claude ones, where the display name
 * ("Account 1") is the only identifier, so an identifier is matched against
 * either field.
 */
export function findConnection(provider: string, identifier: string | undefined): RouterConnection {
  const matches = listConnections().filter((c) => c.provider === provider);
  if (matches.length === 0) {
    throw new Error(`9router has no authenticated "${provider}" connection`);
  }
  if (identifier) {
    const match = matches.find((c) => c.email === identifier || c.name === identifier);
    if (!match) {
      const known = matches.map((c) => c.email ?? c.name).join(", ");
      throw new Error(`9router has no "${provider}" connection for ${identifier} (found: ${known || "none"})`);
    }
    return match;
  }
  if (matches.length > 1) {
    const known = matches.map((c) => c.email ?? c.name).join(", ");
    throw new Error(
      `multiple "${provider}" connections in 9router (${known}); set an explicit *_ACCOUNT env var to disambiguate`,
    );
  }
  return matches[0];
}

export function hasConnection(provider: string, identifier: string | undefined): boolean {
  try {
    findConnection(provider, identifier);
    return true;
  } catch {
    return false;
  }
}
