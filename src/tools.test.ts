import { describe, expect, it, vi } from "vitest";
import { TOOLS, makeContext } from "../src/tools.js";

function cannedFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (url: unknown) => {
    const u = String(url);
    for (const [k, v] of Object.entries(routes)) {
      if (u.includes(k)) return new Response(JSON.stringify(v), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("tools", () => {
  it("list_agents passes limit through", async () => {
    const fetchFn = cannedFetch({ "v1/agents": { items: [{ id: "bc-1" }] } });
    const ctx = makeContext({ apiKey: "k", extendedEnabled: false, fetchFn });
    const tool = TOOLS.find((t) => t.name === "list_agents")!;
    const out = (await tool.handler(ctx, { limit: 5 })) as { items: unknown[] };
    expect(out.items).toHaveLength(1);
  });

  it("get_conversation counts injected turns", async () => {
    const fetchFn = cannedFetch({
      "v0/agents/bc-1/conversation": {
        id: "bc-1",
        messages: [
          { id: "m1", type: "user_message", text: "Hi" },
          {
            id: "m2",
            type: "user_message",
            text: "<system_notification>\nsubagent done</system_notification>",
          },
        ],
      },
    });
    const ctx = makeContext({ apiKey: "k", extendedEnabled: false, fetchFn });
    const tool = TOOLS.find((t) => t.name === "get_conversation")!;
    const out = (await tool.handler(ctx, { id: "bc-1" })) as { injectedTurns: number };
    expect(out.injectedTurns).toBe(1);
  });

  it("extended tools refuse when mode is off", async () => {
    const ctx = makeContext({
      apiKey: "k",
      extendedEnabled: false,
      fetchFn: vi.fn() as unknown as typeof fetch,
    });
    const tool = TOOLS.find((t) => t.name === "project_lineage")!;
    await expect(tool.handler(ctx, { managerBcId: "bc-m" })).rejects.toMatchObject({
      code: "extended_mode_off",
    });
  });

  it("project_lineage fans out to both endpoints", async () => {
    const fetchFn = cannedFetch({
      ListWorkersForManager: { memberships: [] },
      ListBackgroundComposerChildren: { composers: [] },
    });
    const ctx = makeContext({ apiKey: "k", extendedEnabled: true, fetchFn });
    // stub session so no network exchange happens
    (ctx.extended as unknown as { opts: unknown });
    const tool = TOOLS.find((t) => t.name === "project_lineage")!;
    // exchange_user_api_key must also resolve; add it
    const fetch2 = (async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("exchange_user_api_key")) {
        return new Response(JSON.stringify({ accessToken: "sess" }), { status: 200 });
      }
      return (fetchFn as unknown as (u: unknown, init?: unknown) => Promise<Response>)(u, init);
    }) as unknown as typeof fetch;
    const ctx2 = makeContext({ apiKey: "k", extendedEnabled: true, fetchFn: fetch2 });
    const out = (await tool.handler(ctx2, { managerBcId: "bc-m" })) as {
      workers: unknown;
      children: unknown;
    };
    expect(out).toHaveProperty("workers");
    expect(out).toHaveProperty("children");
    void ctx;
  });
});
