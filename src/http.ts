#!/usr/bin/env node
import "dotenv/config";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { AuthError, resolveApiKey } from "./auth.js";
import { CURSOR_ACCOUNT_API_URL, CURSOR_API_BASE_URL, extendedModeEnabled } from "./config.js";
import { TOOLS, makeContext, toolJsonResult } from "./tools.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function buildServer() {
  const apiKey = await resolveApiKey(arg("--api-key"));
  if (!apiKey) throw new Error("No Cursor API key (CURSOR_API_KEY / --api-key).");
  const extended =
    process.argv.includes("--extended") || extendedModeEnabled();
  const ctx = makeContext({
    apiKey,
    extendedEnabled: extended,
    apiBaseUrl: arg("--api-base-url") ?? CURSOR_API_BASE_URL,
    accountApiUrl: arg("--account-api-url") ?? CURSOR_ACCOUNT_API_URL,
  });
  const server = new McpServer({ name: "cursor-cloud-mcp", version: "0.1.0" });
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.schema },
      async (args: Record<string, unknown>) => {
        try {
          if (tool.extendedOnly && !ctx.extendedEnabled) {
            return {
              content: [
                {
                  type: "text",
                  text: "Needs Extended mode: set CURSOR_EXTENDED_MODE=1.",
                },
              ],
              isError: true,
            };
          }
          return toolJsonResult(await tool.handler(ctx, args ?? {}));
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          const code = e instanceof AuthError ? ` [${e.code}]` : "";
          return {
            content: [{ type: "text", text: `Error${code}: ${message}` }],
            isError: true,
          };
        }
      },
    );
  }
  return server;
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? arg("--port") ?? "8091");
  const server = await buildServer().catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/mcp") {
        res.writeHead(404).end("Not found (use /mcp)");
        return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await (server as McpServer).connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(e instanceof Error ? e.message : "error");
    }
  });
  http.listen(port, () => {
    console.log(`cursor-cloud-mcp HTTP listening on :${port}/mcp`);
  });
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
