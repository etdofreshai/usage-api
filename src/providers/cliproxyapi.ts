/**
 * Shared client for ET's CLIProxyAPI server's Management API.
 *
 * CLIProxyAPI (https://github.com/router-for-me/CLIProxyAPI) already owns
 * the OAuth-authenticated Claude and Codex accounts it proxies traffic for,
 * and it passively captures each provider's rate-limit response headers on
 * every real request it forwards — exposing the latest per-account snapshot
 * via GET /v0/management/auth-files (`quota` / `model_quotas`). Reading that
 * instead of usage-api independently polling Anthropic's/OpenAI's usage
 * endpoints with its own OAuth credential files means one fewer place a
 * refresh token can go stale, and it reflects exactly what real traffic
 * through that account is currently seeing.
 */

const BASE_URL = (process.env.CLIPROXYAPI_BASE_URL ?? "http://etzminisforumx1pro.lan:8317").replace(/\/+$/, "");
const MANAGEMENT_KEY = process.env.CLIPROXYAPI_MANAGEMENT_KEY;

export interface CpaQuotaSignals {
  observed_at?: string;
  signals?: Record<string, string>;
}

export interface CpaAuthFile {
  id: string;
  name: string;
  provider: string;
  email?: string;
  account?: string;
  auth_index: string;
  status: string;
  status_message?: string;
  disabled: boolean;
  unavailable: boolean;
  runtime_only: boolean;
  quota?: CpaQuotaSignals;
  model_quotas?: Record<string, CpaQuotaSignals>;
}

interface AuthFilesResponse {
  files: CpaAuthFile[];
}

function requireManagementKey(): string {
  if (!MANAGEMENT_KEY) {
    throw new Error("CLIPROXYAPI_MANAGEMENT_KEY is not set — cannot reach CLIProxyAPI's management API");
  }
  return MANAGEMENT_KEY;
}

async function managementFetch(path: string, init?: RequestInit): Promise<Response> {
  const key = requireManagementKey();
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

// The claude, claude2, codex, and codex2 pollers each ask for the account
// list within a few hundred ms of each other on every tick; a short cache
// collapses that into one HTTP round trip to CLIProxyAPI instead of four.
let cachedFiles: { at: number; files: CpaAuthFile[] } | null = null;
const AUTH_FILES_TTL_MS = 5_000;

export async function listAuthFiles(): Promise<CpaAuthFile[]> {
  if (cachedFiles && Date.now() - cachedFiles.at < AUTH_FILES_TTL_MS) return cachedFiles.files;
  const res = await managementFetch("/v0/management/auth-files");
  if (!res.ok) {
    throw new Error(`cliproxyapi auth-files HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as AuthFilesResponse;
  const files = json.files ?? [];
  cachedFiles = { at: Date.now(), files };
  return files;
}

export async function findAuthFile(provider: string, email: string | undefined): Promise<CpaAuthFile> {
  const files = (await listAuthFiles()).filter((f) => f.provider === provider);
  if (files.length === 0) {
    throw new Error(`cliproxyapi has no "${provider}" accounts registered`);
  }
  if (email) {
    const match = files.find((f) => f.email === email);
    if (!match) {
      throw new Error(
        `cliproxyapi has no "${provider}" account for ${email} (found: ${files.map((f) => f.email).join(", ") || "none"})`
      );
    }
    return match;
  }
  if (files.length > 1) {
    throw new Error(
      `multiple "${provider}" accounts in cliproxyapi (${files.map((f) => f.email).join(", ")}); set an explicit *_EMAIL env var to disambiguate`
    );
  }
  return files[0];
}

/**
 * Issues an outbound HTTP request through CLIProxyAPI's own credential store
 * (POST /v0/management/api-call), substituting $TOKEN$ in a header value
 * with the selected credential's live access token. Used only for the
 * handful of provider endpoints CLIProxyAPI doesn't already observe
 * passively (e.g. Codex's rate-limit reset credits) — everything else comes
 * straight off the auth-files quota snapshot above.
 */
export async function callThroughCliProxy(
  authIndex: string,
  method: string,
  url: string,
  headers: Record<string, string>
): Promise<{ status: number; body: string }> {
  const res = await managementFetch("/v0/management/api-call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ auth_index: authIndex, method, url, header: headers }),
  });
  if (!res.ok) {
    throw new Error(`cliproxyapi api-call HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  const json = (await res.json()) as { status_code: number; body: string };
  return { status: json.status_code, body: json.body };
}

export function unixSecondsToIso(value: string | undefined): string | null {
  if (!value) return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

export function isoFromRelativeSeconds(observedAtIso: string | undefined, relativeSeconds: string | undefined): string | null {
  if (relativeSeconds === undefined) return null;
  const seconds = Number(relativeSeconds);
  if (!Number.isFinite(seconds)) return null;
  const base = observedAtIso ? Date.parse(observedAtIso) : Date.now();
  if (!Number.isFinite(base)) return null;
  return new Date(base + seconds * 1000).toISOString();
}
