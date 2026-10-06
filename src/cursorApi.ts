import { CURSOR_API_BASE_URL } from "./config.js";

export class CursorApiError extends Error {
  constructor(
    message: string,
    readonly httpCode: number,
    readonly path: string,
  ) {
    super(message);
    this.name = "CursorApiError";
  }
}

export interface CursorApiClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

function join(base: string, p: string): string {
  return `${base.replace(/\/+$/, "")}/${p.replace(/^\/+/, "")}`;
}

/** Documented Cloud Agents API (api.cursor.com), Bearer API key. Mirrors CursorApi.kt. */
export class CursorApiClient {
  private baseUrl: string;
  private fetchFn: typeof fetch;
  constructor(private opts: CursorApiClientOptions) {
    this.baseUrl = (opts.baseUrl ?? CURSOR_API_BASE_URL).trim() || CURSOR_API_BASE_URL;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.opts.apiKey}`,
      Accept: "application/json",
      ...extra,
    };
  }

  private async request<T>(method: string, p: string, init: { query?: Record<string, string | number | boolean | undefined | null>; body?: unknown } = {}): Promise<T> {
    const url = new URL(join(this.baseUrl, p));
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const res = await this.fetchFn(url.toString(), {
      method,
      headers: {
        ...this.headers(
          init.body !== undefined
            ? { "Content-Type": "application/json" }
            : {},
        ),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CursorApiError(
        `Cursor API ${method} ${p} failed with HTTP ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        p,
      );
    }
    return (await res.json()) as T;
  }

  me(): Promise<unknown> {
    return this.request("GET", "v1/me");
  }
  models(): Promise<unknown> {
    return this.request("GET", "v1/models");
  }
  repositories(): Promise<unknown> {
    return this.request("GET", "v1/repositories");
  }
  listWorkers(params: { status?: string; scope?: string; limit?: number; nextPageToken?: string } = {}): Promise<unknown> {
    return this.request("GET", "v0/private-workers", {
      query: { status: params.status ?? "all", scope: params.scope, limit: params.limit ?? 100, nextPageToken: params.nextPageToken },
    });
  }
  listPools(scope?: string): Promise<unknown> {
    return this.request("GET", "v0/private-workers/pools", { query: { scope } });
  }
  listAgents(params: { limit?: number; cursor?: string; includeArchived?: boolean } = {}): Promise<unknown> {
    return this.request("GET", "v1/agents", {
      query: { limit: params.limit ?? 20, cursor: params.cursor, includeArchived: params.includeArchived ?? true },
    });
  }
  getAgent(id: string): Promise<unknown> {
    return this.request("GET", `v1/agents/${encodeURIComponent(id)}`);
  }
  createAgent(body: unknown): Promise<unknown> {
    return this.request("POST", "v1/agents", { body });
  }
  archiveAgent(id: string): Promise<unknown> {
    return this.request("POST", `v1/agents/${encodeURIComponent(id)}/archive`);
  }
  unarchiveAgent(id: string): Promise<unknown> {
    return this.request("POST", `v1/agents/${encodeURIComponent(id)}/unarchive`);
  }
  deleteAgent(id: string): Promise<unknown> {
    return this.request("DELETE", `v1/agents/${encodeURIComponent(id)}`);
  }
  usage(id: string, runId?: string): Promise<unknown> {
    return this.request("GET", `v1/agents/${encodeURIComponent(id)}/usage`, {
      query: { runId },
    });
  }
  artifacts(id: string): Promise<unknown> {
    return this.request("GET", `v1/agents/${encodeURIComponent(id)}/artifacts`);
  }
  artifactUrl(id: string, artifactPath: string): Promise<unknown> {
    return this.request("GET", `v1/agents/${encodeURIComponent(id)}/artifacts/download`, {
      query: { path: artifactPath },
    });
  }
  listRuns(id: string, params: { limit?: number; cursor?: string } = {}): Promise<unknown> {
    return this.request("GET", `v1/agents/${encodeURIComponent(id)}/runs`, {
      query: { limit: params.limit ?? 20, cursor: params.cursor },
    });
  }
  getRun(id: string, runId: string): Promise<unknown> {
    return this.request("GET", `v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}`);
  }
  createRun(id: string, body: unknown): Promise<unknown> {
    return this.request("POST", `v1/agents/${encodeURIComponent(id)}/runs`, { body });
  }
  cancelRun(id: string, runId: string): Promise<unknown> {
    return this.request("POST", `v1/agents/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/cancel`);
  }
  listAgentsV0(params: { limit?: number; cursor?: string } = {}): Promise<unknown> {
    return this.request("GET", "v0/agents", {
      query: { limit: params.limit ?? 20, cursor: params.cursor },
    });
  }
  /** Verbatim user/assistant transcript. v1 has no equivalent. */
  conversationV0(id: string): Promise<unknown> {
    return this.request("GET", `v0/agents/${encodeURIComponent(id)}/conversation`);
  }

  streamUrl(agentId: string, runId: string): string {
    return join(this.baseUrl, `v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/stream`);
  }
  webUrl(agentId: string): string {
    return `https://cursor.com/agents/${encodeURIComponent(agentId)}`;
  }

  /** Fetch an SSE run stream and return raw text (caller parses with parseSseEvents). */
  async fetchRunStream(agentId: string, runId: string, lastEventId?: string): Promise<string> {
    const res = await this.fetchFn(this.streamUrl(agentId, runId), {
      headers: {
        ...this.headers({ Accept: "text/event-stream" }),
        ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new CursorApiError(
        `Stream fetch failed with HTTP ${res.status}: ${text.slice(0, 300)}`,
        res.status,
        "stream",
      );
    }
    return await res.text();
  }
}

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

/** Parse SSE `event:`/`data:`/`id:` frames. Matches RunStream.kt event names. */
export function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    let event = "";
    let data = "";
    let id: string | undefined;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).trimStart();
      else if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith(":")) continue;
    }
    if (event || data) events.push({ event: event || "message", data, id });
  }
  return events;
}

/** True for `<system_notification>...</system_notification>` injected turns (SystemNotifications.isInjected). */
export function isInjectedTurn(text: string): boolean {
  return text.includes("<system_notification>");
}
