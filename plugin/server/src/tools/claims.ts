/**
 * Claim primitives: ownership slots. One agent per slot, server-enforced.
 *
 * Use for "I am the implementer" / "I am the critic this round" — anything
 * where exactly one agent should be doing the work. Distinct from signals
 * (group opinion, accumulative) and ballots (group decision, formal).
 * Gated by the same enablement flag as signals.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConcordClient } from '../client.js';
import { ok, requireIdentity, fromError } from '../util.js';

export function registerClaimTools(server: McpServer, client: ConcordClient): void {
  server.registerTool(
    'concord_claim',
    {
      description: 'Claim ownership of a slot like "implementing:dscr" or "critic:round-2". Returns 409 with currentClaimant if someone else holds it. Re-claiming your own slot refreshes the TTL (idempotent). Default TTL 1800 s = 30 min.',
      inputSchema: {
        slot: z.string().min(1).max(120).describe('Slot identifier. Use `role:scope` form for clarity (e.g. "implementing:auth", "critic:design-review").'),
        expiresInSeconds: z.number().int().min(60).max(86400).optional().describe('Default 1800 (30 min), max 86400 (24 h).'),
      },
    },
    async ({ slot, expiresInSeconds }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/claims`,
          body: { agentSessionId: identity.agentSessionId, slot, expiresInSeconds },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_release',
    {
      description: 'Release a slot you currently hold. 404 if you don\'t hold it (someone else does, or it expired). Releasing lets another agent claim it immediately.',
      inputSchema: {
        slot: z.string().min(1).max(120),
      },
    },
    async ({ slot }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'DELETE',
          path: `/rooms/${identity.roomId}/claims/${encodeURIComponent(slot)}`,
          body: { agentSessionId: identity.agentSessionId },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_handoff',
    {
      description: 'Hand a slot you currently hold directly to a successor agent — atomic transfer, the slot never goes free (no race where a third agent grabs it in between). 409 not_owner if you are not the current holder; 404 no_claim if the slot is unheld/expired. Use when passing a role to whoever takes over.',
      inputSchema: {
        slot: z.string().min(1).max(120).describe('The slot you currently hold.'),
        to: z.string().min(1).max(100).describe('The successor agent name (their sender).'),
        expiresInSeconds: z.number().int().min(60).max(86400).optional().describe('TTL for the transferred claim. Default 1800 (30 min).'),
      },
    },
    async ({ slot, to, expiresInSeconds }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/claims/${encodeURIComponent(slot)}/handoff`,
          body: { agentSessionId: identity.agentSessionId, to, expiresInSeconds },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_claims_list',
    {
      description: 'List all active (unexpired) claims in the room with their slot, claimant, and expiry. Call BEFORE starting work to avoid duplicating a claimed role.',
      inputSchema: {},
    },
    async () => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({ method: 'GET', path: `/rooms/${identity.roomId}/claims` });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );
}
