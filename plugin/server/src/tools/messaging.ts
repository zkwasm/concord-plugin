/**
 * Messaging tools: send, poll (long-poll), history, heartbeat.
 *
 * All read the ambient agentSessionId from `.im-for-agents/id.json` so
 * Claude doesn't have to thread it through every call.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConcordClient } from '../client.js';
import { touchIdentity } from '../identity.js';
import { ok, requireIdentity, fromError } from '../util.js';

export function registerMessagingTools(server: McpServer, client: ConcordClient): void {
  server.registerTool(
    'concord_send',
    {
      description: 'Post a message to the room you joined. Optionally pin it (use sparingly — for durable decisions, API contracts, action items). Returns the created message plus any `missedMessages` that arrived while you were working — always process those before continuing the poll loop.',
      inputSchema: {
        content: z.string().min(1).max(50_000).describe('Message text. For anything over ~500 chars or any binary, use concord_file_write / concord_file_upload instead — files are cheaper than chat for big content.'),
        pin: z.boolean().optional().describe('Default false. Set true to pin the message as a durable room decision.'),
      },
    },
    async ({ content, pin }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/messages`,
          body: {
            sender: identity.sender,
            agentSessionId: identity.agentSessionId,
            content,
            pin: pin ?? false,
          },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_poll',
    {
      description: 'Long-poll for new messages. The server holds the connection up to `wait` seconds and returns immediately when new messages arrive. CRITICAL: an empty response (`{ status: "no_new_messages_yet", keepPolling: true }`) is NORMAL — call this again immediately, do not exit the session. Silence of minutes-to-hours is expected.',
      inputSchema: {
        wait: z.number().int().min(0).max(180).optional().describe('Seconds to long-poll. Default 180 (max). Use 1-10 only in tests.'),
      },
    },
    async ({ wait }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      const w = wait ?? 180;
      try {
        const res = await client.request({
          method: 'GET',
          path: `/rooms/${identity.roomId}/messages`,
          query: { session: identity.agentSessionId, wait: w },
          timeoutMs: (w + 30) * 1000,
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_history',
    {
      description: 'Fetch the most recent N messages from the room\'s history. Use to catch up on context when resuming; the poll loop covers everything new.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Default 50, max 200.'),
      },
    },
    async ({ limit }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'GET',
          path: `/rooms/${identity.roomId}/history`,
          query: { limit: limit ?? 50 },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_heartbeat',
    {
      description: 'Re-anchor: tells the server you\'re still active, returns a `reminder` restating your role + the room\'s objective + who else is in the room. Call every ~10 poll responses (≈30 min). On 401, the session expired — call concord_join with the same sender to refresh. Reading the reminder is the antidote to drift.',
      inputSchema: {},
    },
    async () => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/heartbeat`,
          body: { agentSessionId: identity.agentSessionId },
        });
        touchIdentity();
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );
}
