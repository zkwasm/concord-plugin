/**
 * Ballot primitives: server-enforced group decisions with auto-commit at
 * quorum. Use when discussion has identified 2+ concrete options and
 * further talking is unlikely to change minds; the room has a cap on
 * concurrent open ballots (default 5).
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConcordClient } from '../client.js';
import { ok, requireIdentity, fromError } from '../util.js';

export function registerBallotTools(server: McpServer, client: ConcordClient): void {
  server.registerTool(
    'concord_ballot_open',
    {
      description: 'Open a ballot for a discrete decision. Any agent can open one when an outcome is ready for a formal commit. Auto-commits when any option reaches the quorum threshold.',
      inputSchema: {
        topic: z.string().min(1).max(200).describe('What is being decided.'),
        options: z.array(z.string().min(1).max(200)).min(2).max(20).describe('2–20 distinct non-empty choices.'),
        quorumThreshold: z.number().positive().optional().describe('Weight needed to auto-commit. Defaults to the room\'s default (typically 3).'),
        timeoutSeconds: z.number().int().min(60).max(86400).optional().describe('Ballot lifetime. Defaults to the room\'s default (typically 600 = 10 min). Capped to 24 h.'),
      },
    },
    async ({ topic, options, quorumThreshold, timeoutSeconds }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/ballots`,
          body: { agentSessionId: identity.agentSessionId, topic, options, quorumThreshold, timeoutSeconds },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_ballot_vote',
    {
      description: 'Cast (or re-cast) a vote on an open ballot. You may change your vote until the ballot commits — latest write wins. When any option reaches quorum, the ballot auto-commits (tally.committed=true).',
      inputSchema: {
        ballotId: z.string().uuid(),
        option: z.string().min(1).max(200).describe('Must match one of the ballot\'s options exactly.'),
      },
    },
    async ({ ballotId, option }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/ballots/${ballotId}/vote`,
          body: { agentSessionId: identity.agentSessionId, option },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_ballot_list',
    {
      description: 'List currently OPEN ballots in the room. Check this before opening a new one to avoid duplicating an active vote on the same topic.',
      inputSchema: {},
    },
    async () => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({ method: 'GET', path: `/rooms/${identity.roomId}/ballots` });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_ballot_tally',
    {
      description: 'Get the current tally for a specific ballot: per-option weights, total votes, committed status, and (if committed) the winning option.',
      inputSchema: {
        ballotId: z.string().uuid(),
      },
    },
    async ({ ballotId }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'GET',
          path: `/rooms/${identity.roomId}/ballots/${ballotId}`,
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );
}
