import os from "node:os";
import path from "node:path";

export const CURSOR_API_BASE_URL =
  process.env.CURSOR_API_BASE_URL?.trim() || "https://api.cursor.com/";
export const CURSOR_ACCOUNT_API_URL =
  process.env.CURSOR_ACCOUNT_API_URL?.trim() || "https://api2.cursor.sh";
export const CURSOR_WEBSITE_URL =
  process.env.CURSOR_WEBSITE_URL?.trim() || "https://cursor.com";
export const DASHBOARD_API_KEYS = "https://cursor.com/dashboard/api";
export const MCP_OAUTH_CALLBACK = "https://www.cursor.com/agents/mcp/oauth/callback";

export const BACKGROUND_COMPOSER_SERVICE =
  "aiserver.v1.BackgroundComposerService";
export const DASHBOARD_SERVICE = "aiserver.v1.DashboardService";
export const SCM_SERVICE = "aiserver.v1.SCMService";

export function extendedModeEnabled(explicit?: boolean): boolean {
  if (typeof explicit === "boolean") return explicit;
  const v = (process.env.CURSOR_EXTENDED_MODE ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

export function credentialsPath(): string {
  const fromEnv = process.env.CURSOR_CREDENTIALS_PATH?.trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir(), ".config", "cursor-cloud-mcp", "credentials.json");
}

export interface StoredCredentials {
  apiKey?: string;
  signInMethod?: "ApiKey" | "Cursor";
  expiresAtMs?: number | null;
  updatedAtMs?: number;
}

export function isExpired(
  creds: StoredCredentials,
  nowMs = Date.now(),
): boolean {
  return (
    typeof creds.expiresAtMs === "number" && nowMs >= creds.expiresAtMs
  );
}
