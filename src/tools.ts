import { z } from "zod";
import { AuthError, SessionCache } from "./auth.js";
import { EXTENDED_MODE_OFF_MESSAGE } from "./auth.js";
import { CursorApiClient, isInjectedTurn, parseSseEvents } from "./cursorApi.js";
import { ExtendedApiClient } from "./extendedApi.js";

export interface TriageContext {
  /** Resolved per call, so the server can start before a key exists. */
  apiKey: () => Promise<string>;
  extendedEnabled: boolean;
  apiBaseUrl?: string;
  accountApiUrl?: string;
  fetchFn?: typeof fetch;
  cursor: CursorApiClient;
  extended: ExtendedApiClient | null;
}

export function makeContext(opts: {
  /** Static key or a resolver; a null resolver means "auth not configured yet". */
  apiKey: string | (() => Promise<string | null>);
  extendedEnabled: boolean;
  apiBaseUrl?: string;
  accountApiUrl?: string;
  fetchFn?: typeof fetch;
  missingMessage?: string;
}): TriageContext {
  const missing =
    opts.missingMessage ??
    "No Cursor API key available. Set CURSOR_API_KEY, pass --api-key, or run `cursor-cloud-mcp login` (browser OAuth). Get one at https://cursor.com/dashboard/api";
  const resolveKey = async (): Promise<string> => {
    const v =
      typeof opts.apiKey === "function" ? await opts.apiKey() : opts.apiKey;
    if (!v) throw new AuthError(missing, "missing_api_key", true);
    return v;
  };
  const cursor = new CursorApiClient({
    apiKey: resolveKey,
    baseUrl: opts.apiBaseUrl,
    fetchFn: opts.fetchFn,
  });
  let extended: ExtendedApiClient | null = null;
  if (opts.extendedEnabled) {
    const cache = new SessionCache(resolveKey, {
      fetchFn: opts.fetchFn,
      apiUrl: opts.accountApiUrl,
    });
    extended = new ExtendedApiClient({
      apiUrl: opts.accountApiUrl,
      fetchFn: opts.fetchFn,
      getSessionToken: () => cache.accessToken(),
    });
  }
  return {
    apiKey: resolveKey,
    extendedEnabled: opts.extendedEnabled,
    apiBaseUrl: opts.apiBaseUrl,
    accountApiUrl: opts.accountApiUrl,
    fetchFn: opts.fetchFn,
    cursor,
    extended,
  };
}

function requireExtended(ctx: TriageContext): ExtendedApiClient {
  if (!ctx.extendedEnabled || !ctx.extended) {
    throw new AuthError(EXTENDED_MODE_OFF_MESSAGE, "extended_mode_off", true);
  }
  return ctx.extended;
}

function jsonResult(data: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2).slice(0, 120_000) }],
  };
}

export interface ToolDef {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  extendedOnly?: boolean;
  handler: (ctx: TriageContext, args: Record<string, unknown>) => Promise<unknown>;
}

const str = (desc: string) => z.string().describe(desc);
const optStr = (desc: string) => z.string().optional().describe(desc);
const optNum = (desc: string) => z.number().optional().describe(desc);
const optBool = (desc: string) => z.boolean().optional().describe(desc);

export const TOOLS: ToolDef[] = [
  {
    name: "cursor_status",
    description:
      "Check auth (v1/me) and report documented vs Extended-mode availability. Start here.",
    schema: {},
    handler: async (ctx) => {
      const me = await ctx.cursor.me().catch((e: Error) => ({ error: e.message }));
      const authenticated =
        !("error" in (me as Record<string, unknown>)) &&
        me !== undefined &&
        me !== null;
      return {
        authenticated,
        me: authenticated ? me : { error: (me as { error?: string }).error },
        extendedMode: ctx.extendedEnabled,
        webBase: "https://cursor.com/agents",
        note: ctx.extendedEnabled
          ? "Extended endpoints enabled (api2.cursor.sh, Bearer session from exchange_user_api_key)."
          : "Documented API only. Set CURSOR_EXTENDED_MODE=1 for workspace/diff/side-chats/stores/PR-via-account.",
      };
    },
  },
  {
    name: "list_agents",
    description: "List Cloud Agents (v1, newest first). Filter triage queue.",
    schema: {
      limit: optNum("Max agents (default 20, max 100)"),
      cursor: optStr("Pagination cursor (nextCursor)"),
      includeArchived: optBool("Include archived (default true)"),
    },
    handler: async (ctx, a) =>
      ctx.cursor.listAgents({
        limit: (a.limit as number) ?? 20,
        cursor: a.cursor as string | undefined,
        includeArchived: (a.includeArchived as boolean) ?? true,
      }),
  },
  {
    name: "list_agents_v0",
    description:
      "Legacy v0 list with repo/branch/PR/summary in one round-trip. Best for PR triage.",
    schema: {
      limit: optNum("Max agents (default 20)"),
      cursor: optStr("Pagination cursor"),
    },
    handler: async (ctx, a) =>
      ctx.cursor.listAgentsV0({
        limit: (a.limit as number) ?? 20,
        cursor: a.cursor as string | undefined,
      }),
  },
  {
    name: "get_agent",
    description: "Durable metadata for one agent (repos, autoCreatePR, latestRunId).",
    schema: { id: str("Agent id, e.g. bc-...") },
    handler: async (ctx, a) => ctx.cursor.getAgent(a.id as string),
  },
  {
    name: "get_conversation",
    description:
      "Full verbatim user/assistant transcript (v0/conversation). v1 has no equivalent.",
    schema: { id: str("Agent id") },
    handler: async (ctx, a) => {
      const raw = (await ctx.cursor.conversationV0(a.id as string)) as {
        messages?: { type?: string; text?: string }[];
      };
      const messages = raw.messages ?? [];
      return {
        ...raw,
        injectedTurns: messages.filter((m) => m.text && isInjectedTurn(m.text)).length,
        hint: "Injected <system_notification> turns are coordinator/subagent completions, not user prompts.",
      };
    },
  },
  {
    name: "list_runs",
    description: "List runs (turns) for an agent, newest first.",
    schema: {
      id: str("Agent id"),
      limit: optNum("Max runs (default 20)"),
      cursor: optStr("Pagination cursor"),
    },
    handler: async (ctx, a) =>
      ctx.cursor.listRuns(a.id as string, {
        limit: (a.limit as number) ?? 20,
        cursor: a.cursor as string | undefined,
      }),
  },
  {
    name: "get_run",
    description: "One run: status, result text, durationMs, pushed git branches/PRs.",
    schema: { id: str("Agent id"), runId: str("Run id") },
    handler: async (ctx, a) =>
      ctx.cursor.getRun(a.id as string, a.runId as string),
  },
  {
    name: "get_run_stream",
    description:
      "Fetch SSE run stream and summarize: status/assistant/thinking/tool_call/result events, tail text.",
    schema: {
      id: str("Agent id"),
      runId: str("Run id"),
      maxChars: optNum("Max assistant text chars (default 8000)"),
    },
    handler: async (ctx, a) => {
      const text = await ctx.cursor.fetchRunStream(a.id as string, a.runId as string);
      const events = parseSseEvents(text);
      let assistant = "";
      let thinking = "";
      const toolCalls: unknown[] = [];
      let result: unknown = null;
      for (const e of events) {
        try {
          const d = JSON.parse(e.data) as Record<string, unknown>;
          if (e.event === "assistant" && typeof d.text === "string") assistant += d.text;
          else if (e.event === "thinking" && typeof d.text === "string") thinking += d.text;
          else if (e.event === "tool_call") toolCalls.push(d);
          else if (e.event === "result") result = d;
        } catch {
          // keep raw
        }
      }
      const max = ((a.maxChars as number) ?? 8000) as number;
      return {
        eventCount: events.length,
        assistantChars: assistant.length,
        assistantTail: assistant.slice(-max),
        thinkingChars: thinking.length,
        toolCallCount: toolCalls.length,
        toolCalls: toolCalls.slice(0, 50),
        result,
        webUrl: ctx.cursor.webUrl(a.id as string),
      };
    },
  },
  {
    name: "get_usage",
    description: "Token usage for an agent, total + per run.",
    schema: { id: str("Agent id"), runId: optStr("Scope to one run") },
    handler: async (ctx, a) =>
      ctx.cursor.usage(a.id as string, a.runId as string | undefined),
  },
  {
    name: "list_artifacts",
    description: "List screenshots/videos/logs under artifacts/.",
    schema: { id: str("Agent id") },
    handler: async (ctx, a) => ctx.cursor.artifacts(a.id as string),
  },
  {
    name: "get_artifact_url",
    description: "15-minute presigned URL for one artifact path.",
    schema: { id: str("Agent id"), path: str("Relative path, e.g. artifacts/screenshot.png") },
    handler: async (ctx, a) =>
      ctx.cursor.artifactUrl(a.id as string, a.path as string),
  },
  {
    name: "list_models",
    description: "Recommended model ids for create_agent.",
    schema: {},
    handler: async (ctx) => ctx.cursor.models(),
  },
  {
    name: "create_followup_run",
    description: "Send a follow-up prompt to an existing agent (new run).",
    schema: {
      id: str("Agent id"),
      text: str("Follow-up instruction"),
      mode: optStr("agent | plan"),
    },
    handler: async (ctx, a) =>
      ctx.cursor.createRun(a.id as string, {
        prompt: { text: a.text },
        ...(a.mode ? { mode: a.mode } : {}),
      }),
  },
  {
    name: "cancel_run",
    description: "Cancel the active run (terminal, cannot resume).",
    schema: { id: str("Agent id"), runId: str("Run id") },
    handler: async (ctx, a) =>
      ctx.cursor.cancelRun(a.id as string, a.runId as string),
  },
  {
    name: "archive_agent",
    description: "Archive (soft-delete). Idempotent.",
    schema: { id: str("Agent id") },
    handler: async (ctx, a) => ctx.cursor.archiveAgent(a.id as string),
  },
  // ---- Extended ----
  {
    name: "project_lineage",
    description:
      "Extended: Project lineage = ListWorkersForManager + ListBackgroundComposerChildren. Workers, side chats, subagents.",
    schema: { managerBcId: str("Project/root bc id") },
    extendedOnly: true,
    handler: async (ctx, a) => {
      const ext = requireExtended(ctx);
      const id = a.managerBcId as string;
      const [workers, children] = await Promise.all([
        ext.listWorkersForManager(id),
        ext.listChildren(id),
      ]);
      return { managerBcId: id, workers, children };
    },
  },
  {
    name: "start_side_chat",
    description: "Extended: StartSideChatBackgroundComposer.",
    schema: { parentBcId: str("Parent bc id"), name: optStr("Side chat name") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).startSideChat(a.parentBcId as string, a.name as string | undefined),
  },
  {
    name: "steer_agent",
    description: "Extended: InjectBackgroundComposerContext (steer / queue message).",
    schema: {
      bcId: str("Agent bc id"),
      text: str("Steering text"),
      expectedRunId: optStr("Expected run id"),
    },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).steer(
        a.bcId as string,
        a.text as string,
        a.expectedRunId as string | undefined,
      ),
  },
  {
    name: "agent_lifecycle",
    description: "Extended: pause | resume | wake | cancel_tool_call.",
    schema: {
      bcId: str("Agent bc id"),
      action: str("pause | resume | wake | cancel_tool_call"),
      runId: optStr("Run id (pause)"),
      toolCallId: optStr("Tool call id (cancel_tool_call)"),
    },
    extendedOnly: true,
    handler: async (ctx, a) => {
      const ext = requireExtended(ctx);
      const bcId = a.bcId as string;
      switch (a.action) {
        case "pause":
          return ext.pause(bcId, a.runId as string | undefined);
        case "resume":
          return ext.resume(bcId);
        case "wake":
          return ext.wake(bcId);
        case "cancel_tool_call":
          return ext.cancelToolCall(bcId, a.toolCallId as string | undefined);
        default:
          throw new Error("action must be pause | resume | wake | cancel_tool_call");
      }
    },
  },
  {
    name: "list_pending_followups",
    description: "Extended: account queue (ListPendingFollowups).",
    schema: { bcId: str("Agent bc id") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).listPendingFollowups(a.bcId as string),
  },
  {
    name: "list_agent_stores",
    description: "Extended: Project Context stores (ListAgentStores).",
    schema: { pageToken: optStr("Page token") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).listAgentStores(a.pageToken as string | undefined),
  },
  {
    name: "read_store_file",
    description: "Extended: ReadAgentStoreFile (Project Context / shared notes).",
    schema: { storeId: str("Store id"), relativePath: str("e.g. notes/plan.md") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).readStoreFile(a.storeId as string, a.relativePath as string),
  },
  {
    name: "list_workspace_files",
    description: "Extended: live VM workspace (ListWorkspaceFiles).",
    schema: { bcId: str("Agent bc id") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).listWorkspaceFiles(a.bcId as string),
  },
  {
    name: "get_diff_details",
    description: "Extended: branch diff (GetBackgroundComposerDiffDetails).",
    schema: { bcId: str("Agent bc id") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).getDiffDetails(a.bcId as string),
  },
  {
    name: "get_pr",
    description: "Extended: account view of any PR (SCMService/GetPullRequest).",
    schema: { prUrl: str("PR URL") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).getPullRequest(a.prUrl as string),
  },
  {
    name: "get_pr_diff",
    description: "Extended: PR file diffs (SCMService/GetPullRequestDiff).",
    schema: { prUrl: str("PR URL") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).getPullRequestDiff(a.prUrl as string),
  },
  {
    name: "get_pr_status",
    description: "Extended: checks + review decision + counts.",
    schema: { prUrl: str("PR URL") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).getDetailedPullRequestStatus(a.prUrl as string),
  },
  {
    name: "prewarm_transcript",
    description:
      "Extended: StreamConversation PREWARM initial_state + blob ids. Raw record behind the transcript viewer.",
    schema: { bcId: str("Agent bc id") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).streamConversationPrewarm(a.bcId as string),
  },
  {
    name: "get_blob",
    description: "Extended: GetBlobForAgentKV one record blob (base64 blob_data).",
    schema: { bcId: str("Agent bc id"), blobId: str("Blob id") },
    extendedOnly: true,
    handler: async (ctx, a) =>
      requireExtended(ctx).getBlobForAgentKV(a.bcId as string, a.blobId as string),
  },
];

export function toolJsonResult(data: unknown): {
  content: { type: "text"; text: string }[];
} {
  return jsonResult(data);
}
