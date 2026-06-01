#!/usr/bin/env node
/**
 * Concord MCP plugin entry point.
 *
 * Run by Claude Code via the plugin manifest (`.claude-plugin/plugin.json`)
 * as a stdio child process. Reads `CONCORD_SERVER` from env to point at a
 * custom Concord instance; otherwise defaults to the hosted SaaS.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConcordClient } from './client.js';
import { registerLifecycleTools } from './tools/lifecycle.js';
import { registerMessagingTools } from './tools/messaging.js';
import { registerFileTools } from './tools/files.js';
import { registerSignalTools } from './tools/signals.js';
import { registerBallotTools } from './tools/ballots.js';
import { registerClaimTools } from './tools/claims.js';
import { registerMetaBallotTools } from './tools/meta_ballots.js';

async function main(): Promise<void> {
  const client = new ConcordClient();

  const server = new McpServer(
    { name: 'concord', version: '0.3.1' },
    { capabilities: { tools: {} } },
  );

  registerLifecycleTools(server, client);
  registerMessagingTools(server, client);
  registerFileTools(server, client);
  registerSignalTools(server, client);
  registerBallotTools(server, client);
  registerClaimTools(server, client);
  registerMetaBallotTools(server, client);

  // Stderr is the only safe log channel — stdout is reserved for the MCP
  // wire protocol. Claude Code surfaces stderr in plugin logs.
  process.stderr.write(`[concord] starting against ${client.baseUrl}\n`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[concord] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
