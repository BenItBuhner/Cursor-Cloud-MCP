import { createHash, randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  CURSOR_ACCOUNT_API_URL,
  CURSOR_WEBSITE_URL,
  credentialsPath,
  type StoredCredentials,
} from "./config.js";
import { connectUrl, throwForConnectResponse } from "./connectRpc.js";
import { DASHBOARD_SERVICE } from "./config.js";

export const API_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const SESSION_DEFAULT_LIFETIME_MS = 30 * 60 * 1000;
export const SESSION_EXPIRY_MARGIN_MS = 60 * 1000;
export const EXTENDED_MODE_OFF_MESSAGE =
  "Extended mode is off, so Cursor's account service isn't used.";
export const EXTENDED_MODE_OFF_CODE = "extended_mode_off";

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly permanent = false,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function base64Url(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export interface LoginHandshake {
  uuid: string;
  verifier: string;
  loginUrl: string;
}

export function startHandshake(
  websiteUrl = CURSOR_WEBSITE_URL,
): LoginHandshake {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(
    createHash("sha256").update(verifier, "ascii").digest(),
  );
  const uuid = randomUUID();
  const url =
    `${websiteUrl.replace(/\/+$/, "")}/loginDeepControl` +
    `?challenge=${encodeURIComponent(challenge)}` +
    `&uuid=${encodeURIComponent(uuid)}` +
    `&mode=login&redirectTarget=sdk&supportsSelectedTeamLogin=true`;
  return { uuid, verifier, loginUrl: url };
}

const PENDING_BODY = "Not found";

function isRouteNotFound(body: string): boolean {
  return (
    body.includes("Route POST:/auth/poll not found") ||
    body.includes("not found") ||
    body.includes("NOT_FOUND")
  ) && body.trim() !== PENDING_BODY;
}

export interface PollOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchFn?: typeof fetch;
  apiUrl?: string;
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
}

/** Poll POST /auth/poll until the browser confirms. 404 = pending. */
export async function awaitTokens(
  handshake: LoginHandshake,
  opts: PollOptions = {},
): Promise<SessionTokens> {
  const {
    maxAttempts = 150,
    baseDelayMs = 1000,
    maxDelayMs = 10_000,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    fetchFn = fetch,
    apiUrl = CURSOR_ACCOUNT_API_URL,
  } = opts;
  let useGet = false;
  let pendingSeen = false;
  let consecutiveErrors = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const wait = Math.min(baseDelayMs * Math.pow(1.2, attempt), maxDelayMs);
    let res: Response;
    try {
      if (useGet) {
        const u =
          `${apiUrl.replace(/\/+$/, "")}/auth/poll` +
          `?uuid=${encodeURIComponent(handshake.uuid)}` +
          `&verifier=${encodeURIComponent(handshake.verifier)}`;
        res = await fetchFn(u, { method: "GET", headers: { Accept: "application/json" } });
      } else {
        res = await fetchFn(`${apiUrl.replace(/\/+$/, "")}/auth/poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ uuid: handshake.uuid, verifier: handshake.verifier }),
        });
      }
    } catch (e) {
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw new AuthError(
          "Couldn't reach Cursor to finish signing in. Check your connection and try again.",
          "network",
        );
      }
      await sleep(wait);
      continue;
    }
    if (res.status === 404) {
      const body = await res.text().catch(() => "");
      if (!pendingSeen) {
        if (!useGet && body.trim() !== PENDING_BODY && isRouteNotFound(body)) {
          useGet = true;
          continue;
        }
        if (useGet && isRouteNotFound(body)) {
          throw new AuthError(
            "Cursor's sign-in service is unavailable right now. Try again later.",
            "unavailable",
          );
        }
        pendingSeen = true;
      }
      consecutiveErrors = 0;
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      consecutiveErrors++;
      if (consecutiveErrors >= 3) {
        throw new AuthError(
          `Sign-in failed (HTTP ${res.status}): ${text.slice(0, 200)}`,
          "poll_failed",
        );
      }
      await sleep(wait);
      continue;
    }
    const json = (await res.json().catch(() => null)) as {
      accessToken?: unknown;
      access_token?: unknown;
      refreshToken?: unknown;
      refresh_token?: unknown;
    } | null;
    const accessToken =
      typeof json?.accessToken === "string"
        ? json.accessToken
        : typeof json?.access_token === "string"
          ? json.access_token
          : null;
    const refreshToken =
      typeof json?.refreshToken === "string"
        ? json.refreshToken
        : typeof json?.refresh_token === "string"
          ? json.refresh_token
          : "";
    if (!accessToken) {
      throw new AuthError("Sign-in returned no session token.", "bad_response", true);
    }
    return { accessToken, refreshToken: refreshToken ?? "" };
  }
  throw new AuthError("Sign-in timed out waiting for the browser.", "timeout");
}

/** Spend a session token once on DashboardService/CreateUserApiKey. Returns the API key. */
export async function mintApiKey(
  accessToken: string,
  opts: {
    name?: string;
    expiresAtMs?: number | null;
    fetchFn?: typeof fetch;
    apiUrl?: string;
  } = {},
): Promise<string> {
  const {
    name = "cursor-cloud-mcp",
    expiresAtMs = Date.now() + API_KEY_TTL_MS,
    fetchFn = fetch,
    apiUrl = CURSOR_ACCOUNT_API_URL,
  } = opts;
  const body = JSON.stringify({
    name,
    ...(expiresAtMs != null ? { expiresAt: String(expiresAtMs) } : {}),
  });
  const res = await fetchFn(connectUrl(apiUrl, DASHBOARD_SERVICE, "CreateUserApiKey"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      "Connect-Protocol-Version": "1",
    },
    body,
  });
  if (!res.ok) await throwForConnectResponse(res, "/CreateUserApiKey");
  const json = (await res.json().catch(() => null)) as {
    apiKey?: unknown;
    api_key?: unknown;
  } | null;
  const key =
    typeof json?.apiKey === "string"
      ? json.apiKey
      : typeof json?.api_key === "string"
        ? json.api_key
        : null;
  if (!key) throw new AuthError("Minting an API key returned no key.", "bad_response", true);
  return key;
}

function jwtExpiryMs(token: string): number | null {
  try {
    const part = token.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(
      Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    ) as { exp?: unknown };
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface SessionInfo {
  accessToken: string;
  expiresAtMs: number;
}

/**
 * Exchange a user API key for a short-lived account session,
 * the CLI's `--api-key` login. Refresh tokens are dropped; re-exchange is the refresh.
 */
export async function exchangeSession(
  apiKey: string,
  opts: { fetchFn?: typeof fetch; apiUrl?: string } = {},
): Promise<SessionInfo> {
  const { fetchFn = fetch, apiUrl = CURSOR_ACCOUNT_API_URL } = opts;
  const res = await fetchFn(`${apiUrl.replace(/\/+$/, "")}/auth/exchange_user_api_key`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new AuthError(`API key rejected (HTTP ${res.status}).`, "key_rejected", true);
    }
    throw new AuthError(`Session exchange failed (HTTP ${res.status}): ${text.slice(0, 200)}`, "exchange_failed");
  }
  const json = (await res.json().catch(() => null)) as {
    accessToken?: unknown;
    access_token?: unknown;
  } | null;
  const token =
    typeof json?.accessToken === "string"
      ? json.accessToken
      : typeof json?.access_token === "string"
        ? json.access_token
        : null;
  if (!token) throw new AuthError("Session exchange returned no token.", "bad_response", true);
  return {
    accessToken: token,
    expiresAtMs: jwtExpiryMs(token) ?? Date.now() + SESSION_DEFAULT_LIFETIME_MS,
  };
}

/** Single-flight session cache with 60s margin. */
export class SessionCache {
  private current: SessionInfo | null = null;
  private inflight: Promise<SessionInfo> | null = null;
  constructor(
    private getApiKey: () => Promise<string | null>,
    private exchangeOpts: { fetchFn?: typeof fetch; apiUrl?: string } = {},
  ) {}

  async accessToken(): Promise<string> {
    const key = await this.getApiKey();
    if (!key) {
      throw new AuthError(EXTENDED_MODE_OFF_MESSAGE, EXTENDED_MODE_OFF_CODE, true);
    }
    const now = Date.now();
    if (this.current && now + SESSION_EXPIRY_MARGIN_MS < this.current.expiresAtMs) {
      return this.current.accessToken;
    }
    if (!this.inflight) {
      this.inflight = exchangeSession(key, this.exchangeOpts).finally(() => {
        this.inflight = null;
      });
      this.current = await this.inflight;
    } else {
      this.current = await this.inflight;
    }
    return this.current.accessToken;
  }

  invalidate(): void {
    this.current = null;
  }
}

export async function loadStoredCredentials(
  file = credentialsPath(),
): Promise<StoredCredentials> {
  try {
    const text = await fs.readFile(file, "utf8");
    return JSON.parse(text) as StoredCredentials;
  } catch {
    return {};
  }
}

export async function saveStoredCredentials(
  creds: StoredCredentials,
  file = credentialsPath(),
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ ...creds, updatedAtMs: Date.now() }, null, 2), {
    mode: 0o600,
  });
}

export async function clearStoredCredentials(file = credentialsPath()): Promise<void> {
  try {
    await fs.rm(file, { force: true });
  } catch {
    // ignore
  }
}

/** API key precedence: explicit > CURSOR_API_KEY env > stored credentials file. */
export async function resolveApiKey(explicit?: string): Promise<string | null> {
  if (explicit?.trim()) return explicit.trim();
  const env = process.env.CURSOR_API_KEY?.trim();
  if (env) return env;
  const stored = await loadStoredCredentials();
  if (stored.apiKey?.trim()) {
    if (
      typeof stored.expiresAtMs === "number" &&
      Date.now() >= stored.expiresAtMs
    ) {
      return null;
    }
    return stored.apiKey.trim();
  }
  return null;
}

export async function requireApiKey(explicit?: string): Promise<string> {
  const key = await resolveApiKey(explicit);
  if (!key) {
    throw new AuthError(
      "No Cursor API key. Set CURSOR_API_KEY, pass --api-key, or run `cursor-cloud-mcp login`. Get a key at https://cursor.com/dashboard/api",
      "missing_api_key",
      true,
    );
  }
  return key;
}
