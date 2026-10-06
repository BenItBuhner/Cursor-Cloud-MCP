# cursor-cloud-mcp

MCP server for triaging **Cursor Cloud Agents, Projects, conversations, transcripts, PRs, files, and runs** — grounded in the [Cursor-for-Android](https://github.com/BenItBuhner/Cursor-for-Android) app's proven API handling (documented `api.cursor.com` + opt-in Extended-mode `api2.cursor.sh` account endpoints).

- **Documented mode (default):** `v1` agents/runs/usage/artifacts + legacy `v0/conversation` verbatim transcripts. Same surface as [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints).
- **Extended mode (`CURSOR_EXTENDED_MODE=1`):** Projects lineage, side chats, steering/queue, Agent Stores (Project Context), live workspace files, diffs, account PR views — exactly the RPCs the Android app gates behind Extended mode (`BackgroundComposerService`, `SCMService`, `DashboardService` on `api2.cursor.sh`).
- **Auth — API key and OAuth, just like the app:**
  - API key: paste from `https://cursor.com/dashboard/api` (`CURSOR_API_KEY` / `--api-key` / stored credentials).
  - OAuth: `npm run login` opens `cursor.com/loginDeepControl` (PKCE, `redirectTarget=sdk`), polls `/auth/poll`, mints a 90-day `CreateUserApiKey`, stores only the key. Extended sessions come from `POST /auth/exchange_user_api_key` on demand (30 min, 60 s margin) — refresh tokens are dropped, re-exchange is the refresh.

## Install

Node 20+.

```bash
npm install
npm run build
npm test
```

## Auth

```bash
# Option A: API key
export CURSOR_API_KEY=key_...

# Option B: OAuth browser login (mints + stores a key, like the app)
npm run login
npm run status   # me + session check
npm run logout
```

Credentials live in `~/.config/cursor-cloud-mcp/credentials.json` (0600). Never committed (see `.gitignore`).

## Run

Stdio (Cursor / Claude / inspector):

```bash
npm start
# with Extended mode:
CURSOR_EXTENDED_MODE=1 npm start
```

HTTP (`POST/GET/DELETE /mcp`, default `:8091/mcp`):

```bash
npm run http
PORT=8091 npm run http
```

Cursor `~/.cursor/mcp.json` (local):

```json
{
  "mcpServers": {
    "cursor-cloud": {
      "command": "node",
      "args": ["/abs/path/cursor-cloud-mcp/build/index.js"],
      "env": { "CURSOR_API_KEY": "${env:CURSOR_API_KEY}", "CURSOR_EXTENDED_MODE": "1" }
    }
  }
}
```

## Triage recipes

1. `cursor_status` → auth + mode.
2. `list_agents_v0` (repo/branch/PR/summary in one trip) or `list_agents`.
3. `get_conversation` (verbatim, counts injected `<system_notification>` turns) → `list_runs` → `get_run` / `get_run_stream`.
4. `list_artifacts` → `get_artifact_url`.
5. Extended: `project_lineage` → `prewarm_transcript` → `get_blob` → `list_workspace_files` → `get_diff_details` → `get_pr` / `get_pr_diff` / `get_pr_status` → `steer_agent` / `create_followup_run`.

## Tools (28)

Documented: `cursor_status, list_agents, list_agents_v0, get_agent, get_conversation, list_runs, get_run, get_run_stream, get_usage, list_artifacts, get_artifact_url, list_models, create_followup_run, cancel_run, archive_agent`.

Extended (`--extended` / `CURSOR_EXTENDED_MODE=1`): `project_lineage, start_side_chat, steer_agent, agent_lifecycle, list_pending_followups, list_agent_stores, read_store_file, list_workspace_files, get_diff_details, get_pr, get_pr_diff, get_pr_status, prewarm_transcript, get_blob`.

Extended calls use Connect-JSON (`POST /<Service>/<Method>`, `Bearer <session>`, `Connect-Protocol-Version: 1`); streaming uses `application/connect+json` envelopes. Verbatim strings match the app (`"Needs Extended mode..."`, `"Extended mode is off, so Cursor's account service isn't used."`).

## Grounding

Logic mirrors `Cursor-for-Android` (`Capabilities.kt`, `ExtendedMode.kt`, `SessionTokenProvider.kt`, `CursorLogin.kt`, `ConnectRpc.kt`, `CursorApi.kt`, `BackgroundComposerApi.kt`, `ProjectApi.kt`, `ConversationRecordApi.kt`, `PullRequestApi.kt`, `AgentFilesApi.kt`, `SteeringApi.kt`, fixtures `coordinator_run.sse` / `coordinator_shapes.json` / `injected_turns.json`). Client template patterns follow `MCP-Base` (`StreamableHTTPClientTransport`, bearer/OAuth auth providers).

## License

MIT © 2026 Bennett Buhner. Unofficial; not affiliated with Anysphere, Inc.
