/**
 * Join-time identity-overwrite policy.
 *
 * `concord_join` writes `.concord/id.json` for the cwd. If a DIFFERENT
 * identity is already saved there (a different room, or the same room but a
 * different sender), joining would overwrite it — and because every tool
 * resolves identity ambiently from that one file, a second agent started in
 * the SAME directory silently hijacks the first one's session. (Verified
 * against the live server: a join carrying the existing agentSessionId is
 * treated as a resume and the new sender is ignored, so the local id.json and
 * the server end up out of sync, both agents collapsed onto one session.)
 *
 * The right way to run several agents on one project is one git worktree each.
 *
 * `decideJoin` is a pure function so the policy is unit-tested without a
 * server or filesystem; `concord_join` calls it and, on `guard`, returns a
 * structured error that the /concord:join command turns into a consent prompt.
 */
import type { Identity } from './identity.js';

/** Public guide covering the worktree-per-agent workflow. */
export const MULTI_AGENT_DOCS_URL = 'https://concord.fenginwind.com/guide.html#multi-agent';

/**
 * Window within which the existing identity counts as "likely still running".
 * Agents heartbeat (touching lastUpdatedAt) about every 30 min, so a slightly
 * larger window catches an agent that is alive but between heartbeats.
 */
const RECENTLY_ACTIVE_MS = 35 * 60 * 1000;

export type JoinDecision =
  | { action: 'proceed' }
  | {
      action: 'guard';
      reason: 'different_room' | 'different_sender';
      existing: { sender: string; roomId: string; recentlyActive: boolean };
    };

/**
 * Decide whether a join may proceed or must first get the user's consent.
 *
 *  - no saved identity         → proceed (fresh join)
 *  - same room AND same sender → proceed (normal resume)
 *  - confirmed === true        → proceed (user agreed to overwrite)
 *  - otherwise (would replace
 *    a different identity)     → guard
 */
export function decideJoin(
  existing: Identity | null,
  roomId: string,
  sender: string,
  confirmed: boolean,
  nowMs: number,
): JoinDecision {
  if (!existing) return { action: 'proceed' };
  const sameRoom = existing.roomId === roomId;
  if (sameRoom && existing.sender === sender) return { action: 'proceed' };
  if (confirmed) return { action: 'proceed' };

  const lastMs = Date.parse(existing.lastUpdatedAt);
  const recentlyActive = Number.isFinite(lastMs) && nowMs - lastMs < RECENTLY_ACTIVE_MS;
  return {
    action: 'guard',
    reason: sameRoom ? 'different_sender' : 'different_room',
    existing: { sender: existing.sender, roomId: existing.roomId, recentlyActive },
  };
}

/** Turn a name into a safe worktree/branch slug. */
function slug(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
}

export interface GuardError {
  /** Human-readable, self-contained text the agent relays to the user. */
  message: string;
  /** Structured fields passed as the error payload. */
  data: Record<string, unknown>;
}

/**
 * Build the consent-required error for an overwrite the user hasn't approved.
 * The message is self-contained: it states the situation, spells out the
 * full worktree steps inline (so the user does NOT have to open the doc), and
 * lists the choices. `repoBaseName` is the cwd's basename, used to suggest a
 * concrete worktree path.
 */
export function buildOverwriteGuard(
  decision: Extract<JoinDecision, { action: 'guard' }>,
  incoming: { sender: string; roomId: string },
  repoBaseName: string,
): GuardError {
  const ex = decision.existing;
  const base = slug(repoBaseName) || 'project';
  const branch = slug(incoming.sender);
  const wtPath = `../${base}-${branch}`;
  const activeNote = ex.recentlyActive
    ? ' (active in the last ~30 min — most likely still running)'
    : '';
  const roomPhrase = decision.reason === 'different_room' ? 'a different room' : 'this room';

  const steps = [
    `git worktree add ${wtPath} -b ${branch}`,
    `cd ${wtPath} && claude`,
    `in that new agent, run: /concord:join <room-url>   (as "${incoming.sender}")`,
    `when finished, merge the branch back and run: git worktree remove ${wtPath}`,
  ];

  const message =
    `This directory already has an active Concord identity: "${ex.sender}" in room ${ex.roomId}${activeNote}. ` +
    `Joining ${roomPhrase} as "${incoming.sender}" here would OVERWRITE "${ex.sender}"'s identity (.concord/id.json), ` +
    `so "${ex.sender}" would lose its session and stop working.\n\n` +
    `To run more than one agent on a single project, give each agent its OWN git worktree — a separate folder backed ` +
    `by the same repo, so they stay isolated and collaborate through the room instead of the local disk:\n` +
    steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n') +
    `\n\nFull guide: ${MULTI_AGENT_DOCS_URL}\n\n` +
    `Present these options to the user and WAIT for their choice — never decide for them:\n` +
    `  • Keep them separate (recommended): set up the worktree above; do NOT overwrite here.\n` +
    (decision.reason === 'different_sender'
      ? `  • Resume "${ex.sender}" instead: if you meant to continue the existing agent, retry concord_join with sender="${ex.sender}".\n`
      : '') +
    `  • Switch this directory to "${incoming.sender}": only if you are done with "${ex.sender}" here — ` +
    `retry concord_join with archive_existing_identity=true (the old identity is archived, not deleted).\n` +
    `  • Cancel.`;

  const options = [
    { id: 'worktree', recommended: true, label: 'Set up a separate git worktree for the new agent' },
    ...(decision.reason === 'different_sender'
      ? [{ id: 'resume_existing', label: `Resume "${ex.sender}" instead` }]
      : []),
    { id: 'switch', label: `Switch this directory to "${incoming.sender}" (archives the old identity)` },
    { id: 'cancel', label: 'Cancel' },
  ];

  return {
    message,
    data: {
      code: 'identity_overwrite_guard',
      reason: decision.reason,
      existing: ex,
      incoming,
      docsUrl: MULTI_AGENT_DOCS_URL,
      remedy: { summary: 'Give each agent its own git worktree', steps, docsUrl: MULTI_AGENT_DOCS_URL },
      options,
    },
  };
}
