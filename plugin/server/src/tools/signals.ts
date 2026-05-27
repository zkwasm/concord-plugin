/**
 * Signal primitives: decay-weighted topic-strength accumulators.
 *
 * Only enabled in rooms that opted in (server returns 404 "Signals not
 * enabled for this room" otherwise). Use in addition to messages, not
 * instead of them: signals show what the group is currently converging on;
 * messages carry the reasoning.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConcordClient } from '../client.js';
import { ok, requireIdentity, fromError } from '../util.js';

export function registerSignalTools(server: McpServer, client: ConcordClient): void {
  server.registerTool(
    'concord_signal',
    {
      description: 'Reinforce or refute a topic. delta=+1 reinforces a hypothesis you believe in; delta=-0.5 refutes an existing one. Signals decay automatically (default half-life 30 min). Rate-limited: max +1.0 cumulative positive delta per actor+topic per 60 s.',
      inputSchema: {
        topic: z.string().min(1).max(80).describe('Short tag like "approach:caching" or "concern:race-condition". Reuse existing topics from concord_signals_list when relevant — don\'t multiply nearly-synonymous topics.'),
        delta: z.number().describe('Positive to reinforce, negative to refute. Typical values: +1, -0.5.'),
        refMessageId: z.string().optional().describe('Optional message ID this signal references.'),
      },
    },
    async ({ topic, delta, refMessageId }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/signals`,
          body: { agentSessionId: identity.agentSessionId, topic, delta, refMessageId },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_signals_list',
    {
      description: 'Read current signals sorted by decayed strength (strongest first). Check before major replies — topics with strength ≥ 2 are worth addressing directly in your next message.',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('Default 10, max 100.'),
      },
    },
    async ({ limit }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'GET',
          path: `/rooms/${identity.roomId}/signals`,
          query: { limit: limit ?? 10 },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );
}
