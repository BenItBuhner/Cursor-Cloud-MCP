import {
  BACKGROUND_COMPOSER_SERVICE,
  CURSOR_ACCOUNT_API_URL,
  DASHBOARD_SERVICE,
  SCM_SERVICE,
} from "./config.js";
import {
  ConnectRpcError,
  connectUrl,
  envelope,
  parseConnectErrorBody,
  readFrame,
} from "./connectRpc.js";

export interface ExtendedClientOptions {
  getSessionToken: () => Promise<string>;
  apiUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Unofficial account endpoints on api2.cursor.sh (Connect-JSON).
 * Mirrors BackgroundComposerApi / ProjectApi / SteeringApi / AgentFilesApi /
 * PullRequestApi / AccountApi / SlashCommandApi / McpConnectorApi.
 * Every call carries the account session from POST /auth/exchange_user_api_key.
 */
export class ExtendedApiClient {
  private apiUrl: string;
  private fetchFn: typeof fetch;
  constructor(private opts: ExtendedClientOptions) {
    this.apiUrl = (opts.apiUrl ?? CURSOR_ACCOUNT_API_URL).trim() || CURSOR_ACCOUNT_API_URL;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async unary<T = unknown>(service: string, method: string, body: unknown): Promise<T> {
    const token = await this.opts.getSessionToken();
    const url = connectUrl(this.apiUrl, service, method);
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const parsed = parseConnectErrorBody(text);
      throw new ConnectRpcError(
        parsed.message || `${service}/${method} failed with HTTP ${res.status}.`,
        res.status,
        parsed.code,
        `/${service}/${method}`,
      );
    }
    return (await res.json()) as T;
  }

  /** Server-streaming call; returns decoded JSON messages + end-stream envelope. */
  async serverStream(
    service: string,
    method: string,
    body: unknown,
  ): Promise<{ messages: unknown[]; endStream: unknown | null }> {
    const token = await this.opts.getSessionToken();
    const url = connectUrl(this.apiUrl, service, method);
    const payload = new TextEncoder().encode(JSON.stringify(body ?? {}));
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Connect-Protocol-Version": "1",
        "Content-Type": "application/connect+json",
        Accept: "application/connect+json",
      },
      body: envelope(0, payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const parsed = parseConnectErrorBody(text);
      throw new ConnectRpcError(
        parsed.message || `${service}/${method} failed with HTTP ${res.status}.`,
        res.status,
        parsed.code,
        `/${service}/${method}`,
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    const messages: unknown[] = [];
    let endStream: unknown | null = null;
    let offset = 0;
    const text = new TextDecoder();
    for (;;) {
      if (offset >= buf.length) break;
      const next = readFrame(buf, offset);
      if (!next) break;
      offset = next.nextOffset;
      const frameText = text.decode(next.frame.data);
      if (next.frame.isEndStream) {
        endStream = frameText ? JSON.parse(frameText) : null;
      } else if (frameText.trim()) {
        messages.push(JSON.parse(frameText));
      }
    }
    return { messages, endStream };
  }

  // -- account --
  getMeAccount(): Promise<unknown> {
    return this.unary(DASHBOARD_SERVICE, "GetMe", {});
  }

  // -- pins / lifecycle --
  listBackgroundComposers(body: Record<string, unknown> = {}): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ListBackgroundComposers", body);
  }
  pinComposers(bcIds: string[]): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "PinBackgroundComposers", { bcIds });
  }
  unpinComposers(bcIds: string[]): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "UnpinBackgroundComposers", { bcIds });
  }
  archiveComposer(bcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ArchiveBackgroundComposer", { bcId });
  }
  renameComposer(bcId: string, newName: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "RenameBackgroundComposer", { bcId, newName });
  }

  // -- Projects / lineage --
  listWorkersForManager(managerBcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ListWorkersForManager", { managerBcId });
  }
  listChildren(parentBcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ListBackgroundComposerChildren", { parentBcId });
  }
  createProjectWorker(body: Record<string, unknown>): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "CreateProjectWorker", body);
  }
  setWorkerManager(workerBcId: string, managerBcId: string, spawnKind = "MANAGER_SPAWN_KIND_ADOPTED"): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "SetWorkerManager", { workerBcId, managerBcId, spawnKind });
  }
  clearWorkerManager(workerBcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ClearWorkerManager", { workerBcId });
  }
  reparent(bcId: string, parentAgentId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ReparentBackgroundComposer", {
      bcId,
      parentAgentId,
      parentAgentType: "CLOUD_SUBAGENT_PARENT_AGENT_TYPE_CLOUD",
    });
  }
  updateProjectAppearance(bcId: string, icon?: string, colorId?: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "UpdateProjectAppearance", {
      bcId,
      appearance: { ...(icon ? { icon } : {}), ...(colorId ? { colorId } : {}) },
    });
  }
  startSideChat(parentBcId: string, name?: string, creationId?: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "StartSideChatBackgroundComposer", {
      parentBcId,
      ...(name?.trim() ? { name } : {}),
      creationSource: "BACKGROUND_COMPOSER_SOURCE_GLASS",
      creationId: creationId ?? crypto.randomUUID(),
    });
  }

  // -- steering / queue / interactions --
  steer(bcId: string, text: string, expectedRunId?: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "InjectBackgroundComposerContext", {
      bcId,
      source: "BACKGROUND_COMPOSER_SOURCE_API",
      injectContextAction: {
        injectionId: `inj-${crypto.randomUUID()}`,
        ...(expectedRunId ? { expectedRunId } : {}),
        userContext: {
          userMessage: { text, messageId: `msg-${crypto.randomUUID()}` },
        },
      },
    });
  }
  pause(bcId: string, runId?: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "PauseBackgroundComposer", {
      bcId,
      source: "BACKGROUND_COMPOSER_SOURCE_API",
      ...(runId ? { runId } : {}),
    });
  }
  resume(bcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ResumeBackgroundComposer", { bcId });
  }
  wake(bcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "WakeBackgroundComposer", { bcId });
  }
  cancelToolCall(bcId: string, toolCallId?: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "CancelBackgroundComposerToolCall", {
      bcId,
      ...(toolCallId ? { toolCallId } : {}),
    });
  }
  submitInteractionResponse(bcId: string, body: Record<string, unknown>): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "SubmitInteractionResponseBackgroundComposer", {
      bcId,
      ...body,
    });
  }
  listPendingFollowups(bcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ListPendingFollowups", { bcId });
  }
  addFollowup(bcId: string, text: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "AddAsyncFollowupBackgroundComposer", {
      bcId,
      prompt: { text },
    });
  }

  // -- Agent Stores (Project Context) --
  listAgentStores(pageToken?: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ListAgentStores", {
      n: "50",
      ...(pageToken ? { pageToken } : {}),
    });
  }
  listStoreEntries(storeId: string, relativePath = ""): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ListAgentStoreEntries", { storeId, relativePath });
  }
  readStoreFile(storeId: string, relativePath: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ReadAgentStoreFile", { storeId, relativePath });
  }
  presignStoreReads(storeId: string, relPaths: string[]): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "PresignAgentStoreReads", { storeId, relPaths });
  }

  // -- workspace / diff --
  listWorkspaceFiles(bcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ListWorkspaceFiles", { bcId });
  }
  readWorkspaceFile(bcId: string, path: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ReadBinaryFile", { bcId, path });
  }
  getDiffDetails(bcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "GetBackgroundComposerDiffDetails", { bcId });
  }

  // -- PRs --
  getPullRequest(prUrl: string): Promise<unknown> {
    return this.unary(SCM_SERVICE, "GetPullRequest", { prUrl, skipCache: false });
  }
  getPullRequestDiff(prUrl: string): Promise<unknown> {
    return this.unary(SCM_SERVICE, "GetPullRequestDiff", { prUrl });
  }
  getDetailedPullRequestStatus(prUrl: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "GetDetailedPullRequestStatus", { prUrl });
  }
  getPullRequestDiscussions(prUrl: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "GetPullRequestDiscussions", { prUrl });
  }
  makePr(bcId: string, branchName?: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "MakePRBackgroundComposer", {
      bcId,
      ...(branchName ? { branchName } : {}),
    });
  }
  openPr(bcId: string, opts: { title?: string; body?: string; baseBranch?: string; draft?: boolean } = {}): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "OpenPRBackgroundComposer", {
      bcId,
      ...(opts.title ? { title: opts.title } : {}),
      ...(opts.body ? { body: opts.body } : {}),
      ...(opts.baseBranch ? { baseBranch: opts.baseBranch } : {}),
      draft: opts.draft === true ? "true" : "false",
    });
  }
  getPullRequestMergeStatus(bcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "GetPullRequestMergeStatus", { bcId });
  }
  getRepositoryBranches(repoUrl: string, page = 1): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "GetRepositoryBranches", { repoUrl, page });
  }

  // -- record / transcript (blob-backed) --
  getBlobForAgentKV(bcId: string, blobId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "GetBlobForAgentKV", {
      bcId,
      bc_id: bcId,
      blobId,
      blob_id: blobId,
    });
  }
  /**
   * Prewarm StreamConversation: returns initial_state + blob messages without holding
   * the stream open. Mirrors ConversationStateReader purpose=PREWARM.
   */
  streamConversationPrewarm(bcId: string, preFetchedBlobIds: string[] = []): Promise<unknown> {
    return this.serverStream(BACKGROUND_COMPOSER_SERVICE, "StreamConversation", {
      bcId,
      bc_id: bcId,
      purpose: "STREAM_CONVERSATION_PURPOSE_PREWARM",
      preFetchedBlobIds,
      pre_fetched_blob_ids: preFetchedBlobIds,
    });
  }

  // -- misc --
  getMachine(bcId: string): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "GetMachine", { bcId });
  }
  listEnvironments(): Promise<unknown> {
    return this.unary(BACKGROUND_COMPOSER_SERVICE, "ListEnvironments", { includeEnvironmentJson: "true" });
  }
  getAvailableMcpServers(): Promise<unknown> {
    return this.unary(DASHBOARD_SERVICE, "GetAvailableMcpServers", {});
  }
}
