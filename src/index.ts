#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuthError, resolveApiKey } from "./auth.js";
import { CURSOR_ACCOUNT_API_URL, CURSOR_API_BASE_URL, extendedModeEnabled } from "./config.js";
import { TOOLS, makeContext, toolJsonResult } from "./tools.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(name);
}

async function main(): Promise<void> {
  const apiKey = await resolveApiKey(arg("--api-key")).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
  if (!apiKey) {
    console.error(
      "No Cursor API key. Set CURSOR_API_KEY, pass --api-key, or run `cursor-cloud-mcp login`.",
    );
    process.exit(1);
  }
  const extended =
    has("--extended") || has("--extended-mode") || extendedModeEnabled();
  const ctx = makeContext({
    apiKey,
    extendedEnabled: extended,
    apiBaseUrl: arg("--api-base-url") ?? CURSOR_API_BASE_URL,
    accountApiUrl: arg("--account-api-url") ?? CURSOR_ACCOUNT_API_URL,
  });

  const server = new McpServer({
    name: "cursor-cloud-mcp",
    version: "0.1.0",
  });

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
                  text: "Needs Extended mode: set CURSOR_EXTENDED_MODE=1 or pass --extended. This tool reads Cursor's account service (api2.cursor.sh), which is off by default.",
                },
              ],
              isError: true,
            };
          }
          const data = await tool.handler(ctx, args ?? {});
          return toolJsonResult(data);
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
