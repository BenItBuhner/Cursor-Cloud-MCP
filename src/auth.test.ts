import { describe, expect, it, vi, afterEach } from "vitest";
import {
  awaitTokens,
  exchangeSession,
  mintApiKey,
  resolveApiKey,
  startHandshake,
} from "../src/auth.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("startHandshake", () => {
  it("uses PKCE without leaking verifier + sdk params", () => {
    const hs = startHandshake("https://cursor.com");
    expect(hs.uuid).toMatch(/^[0-9a-f-]{36}$/i);
    expect(hs.verifier.length).toBeGreaterThan(20);
    expect(hs.loginUrl).toContain("/loginDeepControl?challenge=");
    expect(hs.loginUrl).toContain("redirectTarget=sdk");
    expect(hs.loginUrl).toContain("supportsSelectedTeamLogin=true");
    expect(hs.loginUrl).not.toContain(hs.verifier);
  });
});

describe("resolveApiKey", () => {
  it("prefers explicit over env", async () => {
    vi.stubEnv("CURSOR_API_KEY", "env-key");
    await expect(resolveApiKey("  flag-key ")).resolves.toBe("flag-key");
    await expect(resolveApiKey()).resolves.toBe("env-key");
  });
});

describe("awaitTokens", () => {
  it("polls 404 then returns tokens", async () => {
    const hs = { uuid: "u", verifier: "v", loginUrl: "x" };
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accessToken: "a", refreshToken: "r" }), {
          status: 200,
        }),
      ) as unknown as typeof fetch;
    const tokens = await awaitTokens(hs, {
      fetchFn,
      sleep: async () => {},
      baseDelayMs: 0,
      maxDelayMs: 0,
    });
    expect(tokens).toEqual({ accessToken: "a", refreshToken: "r" });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});

describe("mintApiKey", () => {
  it("accepts apiKey and api_key spellings", async () => {
    const f1 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ apiKey: "k1" }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(mintApiKey("sess", { fetchFn: f1 })).resolves.toBe("k1");
    const f2 = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ api_key: "k2" }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(mintApiKey("sess", { fetchFn: f2 })).resolves.toBe("k2");
  });
});

describe("exchangeSession", () => {
  it("rejects 401 as key_rejected", async () => {
    const f = vi.fn().mockResolvedValue(new Response("no", { status: 401 })) as unknown as typeof fetch;
    await expect(exchangeSession("bad", { fetchFn: f })).rejects.toMatchObject({
      code: "key_rejected",
    });
  });
  it("parses accessToken with default lifetime", async () => {
    const f = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accessToken: "not.a.jwt" }), { status: 200 }),
    ) as unknown as typeof fetch;
    const s = await exchangeSession("k", { fetchFn: f });
    expect(s.accessToken).toBe("not.a.jwt");
    expect(s.expiresAtMs).toBeGreaterThan(Date.now());
  });
});
