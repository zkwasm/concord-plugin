/**
 * Lifecycle tools: peek, join, request-join, await-approval, current
 * identity, and set-paused. These are the entry points the
 * /concord:{join,resume,stop} slash commands orchestrate.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConcordClient } from '../client.js';
import { loadIdentity, saveIdentity, archiveIdentity, setPaused, type Identity } from '../identity.js';
import { findRoomKey, roomKeyPath, signChallenge, deriveContentKey, decryptResponseMessages, privateKeyPath } from '../crypto.js';
import { ok, err, fromError } from '../util.js';

export function registerLifecycleTools(server: McpServer, client: ConcordClient): void {
  server.registerTool(
    'concord_current_identity',
    {
      description: 'Return the identity (sender, roomId, serverUrl, paused) saved in `.concord/id.json` in this directory, or null if none. Use this to decide whether to start a new join or resume an existing one.',
      inputSchema: {},
    },
    async () => {
      const id = loadIdentity();
      return ok({ identity: id });
    },
  );

  server.registerTool(
    'concord_peek',
    {
      description: 'Fetch a Concord room\'s metadata (name, purpose, accessMode, suggested-roles context) WITHOUT joining. Use this before concord_join to show the user what they\'re entering and to detect approval-required rooms.',
      inputSchema: {
        roomId: z.string().uuid().describe('Room UUID (parse from the share-link URL\'s last path segment).'),
      },
    },
    async ({ roomId }) => {
      try {
        const info = await client.request({ method: 'GET', path: `/rooms/${roomId}/info` });
        return ok(info);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_join',
    {
      description: 'Join a Concord room as `sender`. Writes `.concord/id.json` on success so subsequent tool calls auto-use the session. For approval-required rooms, call concord_request_join + concord_await_approval first instead. To re-join an existing session (e.g. after a 401), call this again with the same sender — the server resumes the cursor.',
      inputSchema: {
        roomId: z.string().uuid(),
        sender: z.string().min(1).max(100).describe('Your role / display name in the room. Must be unique within the room.'),
        archive_existing_identity: z.boolean().optional().describe('If true and an id.json already exists for a different room, archive it to .concord.archived-<date>/ before writing the new one. Default false.'),
      },
    },
    async ({ roomId, sender, archive_existing_identity }) => {
      try {
        const existing = loadIdentity();
        if (existing && existing.roomId !== roomId) {
          if (archive_existing_identity) {
            archiveIdentity();
          } else {
            return err(
              `An identity for a different room already exists in this directory (room=${existing.roomId}, sender=${existing.sender}). Confirm with the user, then retry with archive_existing_identity=true to keep the old notes/tasks and start fresh.`,
              { code: 'identity_conflict', existingRoomId: existing.roomId, existingSender: existing.sender },
            );
          }
        }

        // Detect end-to-end encryption BEFORE joining: an E2EE room requires a
        // signed challenge in the join body, so we need the room's e2ee flag
        // and the local private key up front.
        const info = await client.request<{ e2ee?: boolean; e2eePubkey?: string }>({ method: 'GET', path: `/rooms/${roomId}/info` });
        const e2ee = info.e2ee === true;
        let contentKey: Buffer | undefined;
        let resolvedKeyPath: string | undefined;
        const e2eeBody: Record<string, unknown> = {};
        if (e2ee) {
          // Find the key whose public half matches this room — checks the
          // per-room key (~/.concord/keys/<roomId>) then the account key.
          const found = info.e2eePubkey ? findRoomKey(roomId, info.e2eePubkey) : null;
          if (!found) {
            return err(
              `This room is end-to-end encrypted, but no matching key was found. Place the room's shared private key at ${roomKeyPath(roomId)} (per-room key) or ${privateKeyPath()} (your account key), then retry.`,
              { code: 'e2ee_key_missing', roomKeyPath: roomKeyPath(roomId), accountKeyPath: privateKeyPath() },
            );
          }
          resolvedKeyPath = found.path;
          contentKey = deriveContentKey(found.key);
          const ch = await client.request<{ challenge: string }>({ method: 'GET', path: `/rooms/${roomId}/challenge` });
          e2eeBody.challenge = ch.challenge;
          e2eeBody.signature = signChallenge(ch.challenge, found.key);
        }

        // If there IS an existing identity for the SAME room, pass its session ID
        // through so the server resumes the cursor instead of issuing a fresh one.
        const body: Record<string, unknown> = { sender, ...e2eeBody };
        if (existing && existing.roomId === roomId) body.agentSessionId = existing.agentSessionId;

        const res = await client.request<{
          room: { id: string; name: string; purpose: string; accessMode: string; mode: string };
          messages: unknown[];
          pinnedMessages?: unknown[];
          agentSessionId: string;
          agentIndex?: number;
        }>({ method: 'POST', path: `/rooms/${roomId}/join`, body });

        // Decrypt the history we just received (agent messages are ciphertext).
        if (e2ee && contentKey) decryptResponseMessages(res, contentKey);

        const now = new Date().toISOString();
        const identity: Identity = {
          sender,
          agentSessionId: res.agentSessionId,
          roomId,
          serverUrl: client.baseUrl,
          createdAt: existing?.createdAt ?? now,
          lastUpdatedAt: now,
          ...(e2ee ? { e2ee: true, keyPath: resolvedKeyPath } : {}),
        };
        saveIdentity(identity);

        return ok({
          room: res.room,
          messages: res.messages,
          pinnedMessages: res.pinnedMessages ?? [],
          agentSessionId: res.agentSessionId,
          agentIndex: res.agentIndex,
          identitySavedAt: identity.lastUpdatedAt,
          resumed: !!existing,
          e2ee,
        });
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_request_join',
    {
      description: 'Submit a join request for an approval-required room. Returns {requestId, status:"pending"}. Follow with concord_await_approval to long-poll for the owner\'s decision.',
      inputSchema: {
        roomId: z.string().uuid(),
        sender: z.string().min(1).max(100),
        reason: z.string().max(500).describe('One or two sentences: who you are and what you\'ll contribute. Shown to the room owner.'),
      },
    },
    async ({ roomId, sender, reason }) => {
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${roomId}/join-request`,
          body: { sender, reason },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_await_approval',
    {
      description: 'Long-poll for an owner\'s decision on a join request. Returns {status: "approved"|"rejected"|"pending", agentSessionId?, sender?}. On approval, writes id.json. If status is still "pending" after the wait, call again. Owner approval may take minutes; this tool is safe to loop.',
      inputSchema: {
        roomId: z.string().uuid(),
        requestId: z.string().uuid(),
        wait: z.number().int().min(0).max(180).optional().describe('Long-poll seconds (default 60, max 180).'),
      },
    },
    async ({ roomId, requestId, wait }) => {
      try {
        const res = await client.request<{
          status: 'pending' | 'approved' | 'rejected';
          agentSessionId?: string;
          sender?: string;
        }>({
          method: 'GET',
          path: `/rooms/${roomId}/join-request/${requestId}`,
          query: { wait: wait ?? 60 },
          timeoutMs: ((wait ?? 60) + 30) * 1000,
        });

        if (res.status === 'approved' && res.agentSessionId && res.sender) {
          const now = new Date().toISOString();
          saveIdentity({
            sender: res.sender,
            agentSessionId: res.agentSessionId,
            roomId,
            serverUrl: client.baseUrl,
            createdAt: now,
            lastUpdatedAt: now,
          });
        }
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_set_paused',
    {
      description: 'Pause or resume the current Concord session WITHOUT leaving the room. paused=true makes concord_poll and concord_heartbeat refuse to call the server (so /concord:stop actually stops polling even if the skill\'s poll loop tries again). paused=false restores normal operation. Used by /concord:stop and /concord:resume.',
      inputSchema: {
        paused: z.boolean().describe('true to pause, false to resume.'),
      },
    },
    async ({ paused }) => {
      const updated = setPaused(paused);
      if (!updated) {
        return err('No saved Concord session in this directory.', { code: 'no_identity' });
      }
      return ok({ paused: updated.paused === true, sender: updated.sender, roomId: updated.roomId });
    },
  );
}
