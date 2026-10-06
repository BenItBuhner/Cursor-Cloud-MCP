#!/usr/bin/env node
import "dotenv/config";
import {
  API_KEY_TTL_MS,
  AuthError,
  awaitTokens,
  clearStoredCredentials,
  exchangeSession,
  loadStoredCredentials,
  mintApiKey,
  resolveApiKey,
  saveStoredCredentials,
  startHandshake,
} from "./auth.js";
import { CursorApiClient } from "./cursorApi.js";
import { extendedModeEnabled } from "./config.js";

async function cmdLogin(): Promise<void> {
  const hs = startHandshake();
  console.log("Open this URL in your browser (same flow as the Android app / CLI):\n");
  console.log(hs.loginUrl + "\n");
  console.log("Waiting for confirmation (up to ~20 min, Ctrl-C to cancel)...");
  const tokens = await awaitTokens(hs);
  const name = `cursor-cloud-mcp (${process.platform})`;
  const key = await mintApiKey(tokens.accessToken, {
    name,
    expiresAtMs: Date.now() + API_KEY_TTL_MS,
  });
  await saveStoredCredentials({
    apiKey: key,
    signInMethod: "Cursor",
    expiresAtMs: Date.now() + API_KEY_TTL_MS,
  });
  console.log("\nSigned in. API key saved (90d TTL). Session tokens are never stored.");
  console.log("Now run: npm start  (or set CURSOR_API_KEY)");
}

async function cmdLogout(): Promise<void> {
  await clearStoredCredentials();
  console.log("Signed out (local credentials cleared).");
}

async function cmdStatus(): Promise<void> {
  const stored = await loadStoredCredentials();
  const key = await resolveApiKey();
  console.log(`apiKey: ${key ? "present" : "missing"} (method=${stored.signInMethod ?? "env/flag"})`);
  console.log(`extendedMode: ${extendedModeEnabled()}`);
  if (!key) return;
  try {
    const me = (await new CursorApiClient({ apiKey: key }).me()) as Record<string, unknown>;
    console.log(`me: ${JSON.stringify(me).slice(0, 300)}`);
  } catch (e) {
    console.log(`me: FAILED ${(e as Error).message}`);
  }
  if (extendedModeEnabled()) {
    try {
      const s = await exchangeSession(key);
      console.log(`session: ok (expires ${new Date(s.expiresAtMs).toISOString()})`);
    } catch (e) {
      console.log(`session: FAILED ${(e as Error).message}`);
    }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "status";
  try {
    if (cmd === "login") await cmdLogin();
    else if (cmd === "logout") await cmdLogout();
    else await cmdStatus();
  } catch (e) {
    if (e instanceof AuthError) {
      console.error(`Error [${e.code}]: ${e.message}`);
    } else {
      console.error(e instanceof Error ? e.message : e);
    }
    process.exit(1);
  }
}

main();
