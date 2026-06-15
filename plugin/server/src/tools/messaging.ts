/**
 * Messaging tools: send, poll (long-poll), history, heartbeat.
 *
 * All read the ambient agentSessionId from `.concord/id.json` so Claude
 * doesn't have to thread it through every call.
 *
 * poll and heartbeat additionally respect the `paused` flag in id.json:
 * when set (via /concord:stop → concord_set_paused(true)), these refuse
 * to call the server. This is the kill-switch that makes /concord:stop
 * actually stop polling even when the skill is mid-loop.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConcordClient } from '../client.js';
import { touchIdentity } from '../identity.js';
import { loadPrivateKey, loadPrivateKeyAt, deriveContentKey, encrypt, decryptResponseMessages, privateKeyPath } from '../crypto.js';
import { ok, err, requireIdentity, fromError } from '../util.js';

/** Resolve the AES content key for an E2EE room from the per-room keyPath
 * recorded at join (falls back to the account key). Error if the file is gone. */
function resolveContentKey(keyPath?: string): { contentKey?: Buffer; error?: ReturnType<typeof err> } {
  const key = keyPath ? loadPrivateKeyAt(keyPath) : loadPrivateKey();
  if (!key) {
    const p = keyPath || privateKeyPath();
    return { error: err(`This room is end-to-end encrypted but its key (${p}) is missing or unreadable. Restore the shared key file and retry.`, { code: 'e2ee_key_missing', expectedPath: p }) };
  }
  return { contentKey: deriveContentKey(key) };
}

export function registerMessagingTools(server: McpServer, client: ConcordClient): void {
  server.registerTool(
    'concord_send',
    {
      description: 'Post a message to the room you joined. **This is also how you ask the human anything** — a decision, a clarification, a choice between options — instead of pausing in your own terminal/CLI; the human watches the room, not your terminal window. Optionally pin it (use sparingly — for durable decisions, API contracts, action items). Returns the created message plus any `missedMessages` that arrived while you were working — always process those before continuing the poll loop.',
      inputSchema: {
        content: z.string().min(1).max(50_000).describe('Message text. For anything over ~500 chars or any binary, use concord_file_write / concord_file_upload instead — files are cheaper than chat for big content.'),
        pin: z.boolean().optional().describe('Default false. Set true to pin the message as a durable room decision.'),
        level: z.enum(['info', 'milestone', 'blocked', 'needs_decision', 'done']).optional().describe('Report-room status level. In a report room use: milestone (a step completed), blocked / needs_decision (these PING the human — be specific and actionable, e.g. give the options), done (finished). Defaults to info; ignored in non-report rooms.'),
      },
    },
    async ({ content, pin, level }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      // In E2EE rooms, encrypt the body locally and flag enc=true. The server
      // stores only ciphertext; other key-holding agents decrypt on receipt.
      let outContent = content;
      let encFlag = false;
      let contentKey: Buffer | undefined;
      if (identity.e2ee) {
        const k = resolveContentKey(identity.keyPath);
        if (k.error) return k.error;
        contentKey = k.contentKey!;
        outContent = encrypt(content, contentKey);
        encFlag = true;
      }
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/messages`,
          body: {
            sender: identity.sender,
            agentSessionId: identity.agentSessionId,
            content: outContent,
            pin: pin ?? false,
            enc: encFlag,
            level,
          },
        });
        // Decrypt any missedMessages the server returned alongside our send.
        if (contentKey) decryptResponseMessages(res, contentKey);
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_poll',
    {
      description: 'Long-poll for new messages. The server holds the connection up to `wait` seconds and returns immediately when new messages arrive. Each message has a `mentions` array (who it @-mentions): if it names others but not you, let them answer (don\'t pile on); an un-mentioned agent message expects no reply; reply to an un-mentioned human message only if it\'s relevant to your role. CRITICAL: an empty response (`{ status: "no_new_messages_yet", keepPolling: true }`) is NORMAL — call this again immediately, do not exit the session. Silence of minutes-to-hours is expected.',
      inputSchema: {
        wait: z.number().int().min(0).max(180).optional().describe('Seconds to long-poll. Default 180 (max). Use 1-10 only in tests.'),
      },
    },
    async ({ wait }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      if (identity.paused) {
        return err('Polling is paused for this room. Run /concord:resume to come back.', { code: 'paused' });
      }
      const w = wait ?? 180;
      let contentKey: Buffer | undefined;
      if (identity.e2ee) {
        const k = resolveContentKey(identity.keyPath);
        if (k.error) return k.error;
        contentKey = k.contentKey!;
      }
      try {
        const res = await client.request({
          method: 'GET',
          path: `/rooms/${identity.roomId}/messages`,
          query: { session: identity.agentSessionId, wait: w },
          timeoutMs: (w + 30) * 1000,
        });
        if (contentKey) decryptResponseMessages(res, contentKey);
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
      let contentKey: Buffer | undefined;
      if (identity.e2ee) {
        const k = resolveContentKey(identity.keyPath);
        if (k.error) return k.error;
        contentKey = k.contentKey!;
      }
      try {
        const res = await client.request({
          method: 'GET',
          path: `/rooms/${identity.roomId}/history`,
          query: { limit: limit ?? 50 },
        });
        if (contentKey) decryptResponseMessages(res, contentKey);
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
      if (identity.paused) {
        return err('Heartbeat is paused for this room. Run /concord:resume to come back.', { code: 'paused' });
      }
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
