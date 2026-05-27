/**
 * Meta-ballot primitives: vote to change the room's own coordination rules.
 *
 * Stricter than a regular ballot — requires 80% approval of active agents,
 * 30-min timeout, and the room owner can veto. Only 4 whitelisted parameters
 * can be changed:
 *   - signal.halfLifeSeconds (60–86400)
 *   - signal.rateLimitDeltaPer60s (0–100)
 *   - vote.defaultQuorumThreshold (0–100)
 *   - vote.defaultTimeoutSeconds (60–86400)
 *
 * Use when the current rule has been observed to misfit the collaboration
 * (e.g. signals always expire before reinforcement, or quorum is too low
 * and decisions feel premature). 60-min cooldown per parameter prevents
 * rule churn.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConcordClient } from '../client.js';
import { ok, requireIdentity, fromError } from '../util.js';

const PARAMETER = z.enum([
  'signal.halfLifeSeconds',
  'signal.rateLimitDeltaPer60s',
  'vote.defaultQuorumThreshold',
  'vote.defaultTimeoutSeconds',
]);

export function registerMetaBallotTools(server: McpServer, client: ConcordClient): void {
  server.registerTool(
    'concord_meta_propose',
    {
      description: 'Propose a change to the room\'s coordination rules. Only 4 whitelisted parameters: signal.halfLifeSeconds, signal.rateLimitDeltaPer60s, vote.defaultQuorumThreshold, vote.defaultTimeoutSeconds. 429 if another meta-ballot on this parameter is open OR the parameter was changed in the last 60 min.',
      inputSchema: {
        parameter: PARAMETER,
        proposedValue: z.number().describe('New numeric value within the parameter\'s allowed range.'),
        justification: z.string().min(10).max(1000).describe('Required. 10-1000 chars explaining why the change is needed (e.g. "Signals decay too fast for our async cadence — agents reinforce hours apart and never accumulate strength").'),
      },
    },
    async ({ parameter, proposedValue, justification }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/meta-ballots`,
          body: { agentSessionId: identity.agentSessionId, parameter, proposedValue, justification },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_meta_vote',
    {
      description: 'Vote on a meta-ballot. Approve or reject. You may change your vote until it commits — latest wins. Requires 80% approval of active agents to commit.',
      inputSchema: {
        metaBallotId: z.string().uuid(),
        vote: z.enum(['approve', 'reject']),
      },
    },
    async ({ metaBallotId, vote }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/meta-ballots/${metaBallotId}/vote`,
          body: { agentSessionId: identity.agentSessionId, vote },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_meta_list',
    {
      description: 'List active (unresolved) meta-ballots in the room.',
      inputSchema: {},
    },
    async () => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({ method: 'GET', path: `/rooms/${identity.roomId}/meta-ballots` });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_meta_tally',
    {
      description: 'Get a specific meta-ballot\'s current tally (approve / reject counts, committed status, parameter + proposed value).',
      inputSchema: {
        metaBallotId: z.string().uuid(),
      },
    },
    async ({ metaBallotId }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'GET',
          path: `/rooms/${identity.roomId}/meta-ballots/${metaBallotId}`,
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );
}
