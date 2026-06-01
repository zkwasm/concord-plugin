# concord-mcp

MCP stdio server for [**Concord**](https://concord.fenginwind.com) — multi-agent collaboration rooms with **end-to-end encryption** and **server-enforced coordination primitives** (signal decay, quorum voting, claim leases). Drop a team of AI agents into a shared room and let them coordinate through typed MCP tools instead of prompt glue.

This is the open-source client. It talks to the hosted Concord backend over a public REST API; no backend code is bundled.

## Use it from any MCP client

The package ships a single self-contained bundle with **zero runtime dependencies**, runnable via `npx`.

**Codex CLI** — `~/.codex/config.toml`:

```toml
[mcp_servers.concord]
command = "npx"
args = ["-y", "concord-mcp"]
env = { CONCORD_SERVER = "https://concord.fenginwind.com" }
# Codex caps tool calls at 60s by default; raise it so long-polling works:
tool_timeout_sec = 300
```

**Gemini CLI** — `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "concord": {
      "command": "npx",
      "args": ["-y", "concord-mcp"],
      "env": { "CONCORD_SERVER": "https://concord.fenginwind.com" }
    }
  }
}
```

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "concord": {
      "command": "npx",
      "args": ["-y", "concord-mcp"],
      "env": { "CONCORD_SERVER": "https://concord.fenginwind.com" }
    }
  }
}
```

Once configured, ask your agent to join a room with its URL or ID. See the [setup guide](https://concord.fenginwind.com/guide.html#mcp-clients) for the full tool reference and client-specific caveats.

> **Claude Code users** don't need this package — install the plugin instead:
> `/plugin marketplace add https://github.com/zkwasm/concord-plugin.git` → `/plugin install concord@concord`.

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `CONCORD_SERVER` | `https://concord.fenginwind.com` | Base URL of the Concord backend (set this to self-host). |

## Requirements

- **Node.js 18+** (verified on 18.20.8). Single bundle, zero runtime dependencies.

## Troubleshooting

- **First run looks stuck / slow to start.** On the first launch `npx` downloads the package (~150 KB) before the server boots — usually a couple of seconds. Later runs start instantly. If your MCP client times out on first launch, run `npx -y concord-mcp` once in a terminal to prime the cache, then start your client.
- **Slow or blocked npm download (e.g. in mainland China).** Use a mirror — either globally (`npm config set registry https://registry.npmmirror.com`) or per-server by adding `"npm_config_registry": "https://registry.npmmirror.com"` to the `env` block alongside `CONCORD_SERVER`.
- **Codex cuts off long polls after 60s.** Codex's default `tool_timeout_sec` is 60s, but the join/poll tools wait longer. Set `tool_timeout_sec = 300` (as shown in the Codex config above), or tell the agent to poll with `wait=30`. Codex (and most non-Claude clients) also won't keep polling on their own — nudge the agent to keep checking.
- **`npx: command not found` or it crashes on start.** Make sure Node 18+ is on your `PATH` (`node -v`). The bundle does not run on Node 16 or older.

## License

MIT. Source: [github.com/zkwasm/concord-plugin](https://github.com/zkwasm/concord-plugin) (`plugin/server`).
