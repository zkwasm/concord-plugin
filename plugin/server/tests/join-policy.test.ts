import { describe, it, expect } from 'vitest';
import { decideJoin, buildOverwriteGuard, MULTI_AGENT_DOCS_URL, type JoinDecision } from '../src/join-policy.js';
import type { Identity } from '../src/identity.js';

const NOW = Date.parse('2026-06-18T12:00:00.000Z');
const ROOM_A = '11111111-1111-1111-1111-111111111111';
const ROOM_B = '22222222-2222-2222-2222-222222222222';

function id(over: Partial<Identity> = {}): Identity {
  return {
    sender: 'Coder',
    agentSessionId: '00000000-0000-0000-0000-000000000001',
    roomId: ROOM_A,
    serverUrl: 'http://localhost:3009/agent',
    createdAt: '2026-06-18T11:00:00.000Z',
    lastUpdatedAt: '2026-06-18T11:55:00.000Z', // 5 min before NOW → recentlyActive
    ...over,
  };
}

const asGuard = (d: JoinDecision) => {
  if (d.action !== 'guard') throw new Error('expected a guard decision');
  return d;
};

describe('decideJoin', () => {
  it('proceeds on a fresh join (no existing identity)', () => {
    expect(decideJoin(null, ROOM_A, 'Coder', false, NOW)).toEqual({ action: 'proceed' });
  });

  it('proceeds on a normal resume (same room, same sender)', () => {
    expect(decideJoin(id(), ROOM_A, 'Coder', false, NOW)).toEqual({ action: 'proceed' });
  });

  it('guards same room + different sender (the same-dir multi-open case)', () => {
    expect(decideJoin(id(), ROOM_A, 'Reviewer', false, NOW)).toMatchObject({
      action: 'guard',
      reason: 'different_sender',
      existing: { sender: 'Coder', roomId: ROOM_A },
    });
  });

  it('guards a different room', () => {
    expect(decideJoin(id(), ROOM_B, 'Coder', false, NOW)).toMatchObject({
      action: 'guard',
      reason: 'different_room',
    });
  });

  it('proceeds when the user confirmed, even though it would overwrite', () => {
    expect(decideJoin(id(), ROOM_A, 'Reviewer', true, NOW)).toEqual({ action: 'proceed' });
    expect(decideJoin(id(), ROOM_B, 'Coder', true, NOW)).toEqual({ action: 'proceed' });
  });

  it('flags recentlyActive from lastUpdatedAt freshness (≈30 min ago → true, ≈50 → false)', () => {
    expect(decideJoin(id({ lastUpdatedAt: '2026-06-18T11:30:00.000Z' }), ROOM_A, 'Reviewer', false, NOW))
      .toMatchObject({ existing: { recentlyActive: true } });
    expect(decideJoin(id({ lastUpdatedAt: '2026-06-18T11:10:00.000Z' }), ROOM_A, 'Reviewer', false, NOW))
      .toMatchObject({ existing: { recentlyActive: false } });
  });
});

describe('buildOverwriteGuard', () => {
  const sameRoomGuard = asGuard(decideJoin(id(), ROOM_A, 'Reviewer', false, NOW));

  it('produces a self-contained message: names both identities, inline worktree steps, doc link', () => {
    const g = buildOverwriteGuard(sameRoomGuard, { sender: 'Reviewer', roomId: ROOM_A }, 'myrepo');
    expect(g.message).toContain('"Coder"');
    expect(g.message).toContain('"Reviewer"');
    // The actual commands appear inline — the user does not need to open the doc.
    expect(g.message).toContain('git worktree add ../myrepo-reviewer -b reviewer');
    expect(g.message).toContain('git worktree remove ../myrepo-reviewer');
    expect(g.message).toContain(MULTI_AGENT_DOCS_URL);
  });

  it('carries structured remedy + options for the agent', () => {
    const g = buildOverwriteGuard(sameRoomGuard, { sender: 'Reviewer', roomId: ROOM_A }, 'myrepo');
    expect(g.data.code).toBe('identity_overwrite_guard');
    expect(g.data.docsUrl).toBe(MULTI_AGENT_DOCS_URL);
    const remedy = g.data.remedy as { steps: string[] };
    expect(remedy.steps.length).toBeGreaterThanOrEqual(3);
    const options = g.data.options as { id: string; recommended?: boolean }[];
    expect(options.find(o => o.id === 'worktree')?.recommended).toBe(true);
    expect(options.map(o => o.id)).toEqual(expect.arrayContaining(['worktree', 'resume_existing', 'switch', 'cancel']));
  });

  it('omits the resume option for a different-room guard', () => {
    const diffRoom = asGuard(decideJoin(id(), ROOM_B, 'Coder', false, NOW));
    const g = buildOverwriteGuard(diffRoom, { sender: 'Coder', roomId: ROOM_B }, 'myrepo');
    const options = g.data.options as { id: string }[];
    expect(options.map(o => o.id)).not.toContain('resume_existing');
  });
});
