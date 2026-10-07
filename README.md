# Cursor Cloud MCP

Unofficial MCP server for [Cursor Cloud Agents](https://cursor.com/agents). Same sign-in and API handling as [Cursor for Android](https://github.com/BenItBuhner/Cursor-for-Android). Not affiliated with Anysphere, Inc.

List agents, read transcripts, follow runs, and send follow-ups from any MCP client.

## Install

Node 20+.

```bash
npm install
npm run build
```

## Auth

Paste an API key from [cursor.com/dashboard/api](https://cursor.com/dashboard/api):

```bash
export CURSOR_API_KEY=key_...
```

Or sign in in the browser. That stores a key at `~/.config/cursor-cloud-mcp/credentials.json`.

```bash
npm run login
npm run status
npm run logout
```

## Run

```bash
npm start
```

`~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "cursor-cloud": {
      "command": "node",
      "args": ["/absolute/path/to/Cursor-Cloud-MCP/build/index.js"],
      "env": {
        "CURSOR_API_KEY": "${env:CURSOR_API_KEY}"
      }
    }
  }
}
```

`npm run http` serves `POST /mcp` on port 8091.

Set `CURSOR_EXTENDED_MODE=1` for the same unofficial account endpoints [Cursor for Android](https://github.com/BenItBuhner/Cursor-for-Android) keeps behind Extended mode. Off by default. Call `cursor_status` first. The server describes its own tools.

## License

[MIT](LICENSE) © 2026 Bennett Buhner
