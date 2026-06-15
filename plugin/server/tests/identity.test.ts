import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadIdentity, saveIdentity, touchIdentity, archiveIdentity, clearIdentity, setPaused, type Identity } from '../src/identity.js';

let tmp: string;
const NEW = '.concord';
const LEGACY = '.im-for-agents';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-identity-'));
});

afterEach(() => {
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
});

const sample = (): Identity => ({
  sender: 'Researcher',
  agentSessionId: '00000000-0000-0000-0000-000000000001',
  roomId: '11111111-1111-1111-1111-111111111111',
  serverUrl: 'http://localhost:3009/agent',
  createdAt: '2026-05-27T00:00:00.000Z',
  lastUpdatedAt: '2026-05-27T00:00:00.000Z',
});

function writeLegacyId(): void {
  fs.mkdirSync(path.join(tmp, LEGACY), { recursive: true });
  fs.writeFileSync(path.join(tmp, LEGACY, 'id.json'), JSON.stringify(sample(), null, 2) + '\n', 'utf8');
}

describe('identity: load/save round-trip (new .concord/ dir)', () => {
  it('returns null when nothing saved', () => {
    expect(loadIdentity(tmp)).toBeNull();
  });

  it('save then load round-trips the full record into .concord/', () => {
    saveIdentity(sample(), tmp);
    const loaded = loadIdentity(tmp);
    expect(loaded).toEqual(sample());
    // Active dir is .concord/, not legacy
    expect(fs.existsSync(path.join(tmp, NEW, 'id.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, LEGACY, 'id.json'))).toBe(false);
  });

  it('seeds notes.md and tasks.md with section templates', () => {
    saveIdentity(sample(), tmp);
    const notes = fs.readFileSync(path.join(tmp, NEW, 'notes.md'), 'utf8');
    const tasks = fs.readFileSync(path.join(tmp, NEW, 'tasks.md'), 'utf8');
    expect(notes).toContain('Current Focus');
    expect(notes).toContain('Decisions & Agreements');
    expect(tasks).toContain('Tasks');
  });

  it('does NOT overwrite existing notes.md / tasks.md on subsequent saves', () => {
    saveIdentity(sample(), tmp);
    fs.writeFileSync(path.join(tmp, NEW, 'notes.md'), 'my own notes', 'utf8');
    saveIdentity({ ...sample(), agentSessionId: 'new-session' }, tmp);
    expect(fs.readFileSync(path.join(tmp, NEW, 'notes.md'), 'utf8')).toBe('my own notes');
  });

  it('appends .concord/ to .gitignore if missing', () => {
    saveIdentity(sample(), tmp);
    expect(fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8')).toContain('.concord/');
  });

  it('does NOT duplicate the .gitignore entry on subsequent saves', () => {
    fs.writeFileSync(path.join(tmp, '.gitignore'), '.concord/\nnode_modules\n', 'utf8');
    saveIdentity(sample(), tmp);
    const gi = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
    const occurrences = gi.split('\n').filter(l => l.trim() === '.concord/').length;
    expect(occurrences).toBe(1);
  });

  it('returns null for a corrupted id.json', () => {
    fs.mkdirSync(path.join(tmp, NEW), { recursive: true });
    fs.writeFileSync(path.join(tmp, NEW, 'id.json'), '{ not json', 'utf8');
    expect(loadIdentity(tmp)).toBeNull();
  });

  it('returns null when id.json is missing required fields', () => {
    fs.mkdirSync(path.join(tmp, NEW), { recursive: true });
    fs.writeFileSync(path.join(tmp, NEW, 'id.json'), JSON.stringify({ sender: 'x' }), 'utf8');
    expect(loadIdentity(tmp)).toBeNull();
  });
});

describe('identity: legacy .im-for-agents/ backward compatibility', () => {
  it('loadIdentity reads legacy .im-for-agents/id.json when .concord/ absent', () => {
    writeLegacyId();
    const loaded = loadIdentity(tmp);
    expect(loaded).toEqual(sample());
  });

  it('loadIdentity prefers .concord/ over .im-for-agents/ when both exist', () => {
    writeLegacyId();
    // Now write a different id into .concord/
    fs.mkdirSync(path.join(tmp, NEW), { recursive: true });
    const newer = { ...sample(), sender: 'NewerSender' };
    fs.writeFileSync(path.join(tmp, NEW, 'id.json'), JSON.stringify(newer), 'utf8');
    const loaded = loadIdentity(tmp);
    expect(loaded?.sender).toBe('NewerSender');
  });

  it('saveIdentity migrates legacy dir → .concord/ on first write (preserves notes + tasks)', () => {
    fs.mkdirSync(path.join(tmp, LEGACY), { recursive: true });
    fs.writeFileSync(path.join(tmp, LEGACY, 'id.json'), JSON.stringify(sample()), 'utf8');
    fs.writeFileSync(path.join(tmp, LEGACY, 'notes.md'), '# preserved notes\n', 'utf8');
    fs.writeFileSync(path.join(tmp, LEGACY, 'tasks.md'), '- [ ] preserved task\n', 'utf8');

    saveIdentity({ ...sample(), agentSessionId: 'after-migration' }, tmp);

    // Old dir is gone, new dir has everything
    expect(fs.existsSync(path.join(tmp, LEGACY))).toBe(false);
    expect(fs.existsSync(path.join(tmp, NEW))).toBe(true);
    expect(fs.readFileSync(path.join(tmp, NEW, 'notes.md'), 'utf8')).toContain('preserved notes');
    expect(fs.readFileSync(path.join(tmp, NEW, 'tasks.md'), 'utf8')).toContain('preserved task');
    expect(loadIdentity(tmp)?.agentSessionId).toBe('after-migration');
  });

  it('saveIdentity does NOT migrate when .concord/ already exists (legacy stays put as archival)', () => {
    fs.mkdirSync(path.join(tmp, NEW), { recursive: true });
    fs.writeFileSync(path.join(tmp, NEW, 'id.json'), JSON.stringify({ ...sample(), sender: 'fresh' }), 'utf8');
    fs.mkdirSync(path.join(tmp, LEGACY), { recursive: true });
    fs.writeFileSync(path.join(tmp, LEGACY, 'id.json'), JSON.stringify({ ...sample(), sender: 'old' }), 'utf8');

    saveIdentity(sample(), tmp);

    // Both still exist
    expect(fs.existsSync(path.join(tmp, NEW, 'id.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmp, LEGACY, 'id.json'))).toBe(true);
  });
});

describe('identity: touchIdentity', () => {
  it('updates lastUpdatedAt without changing other fields', () => {
    const original = sample();
    saveIdentity(original, tmp);
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      const before = loadIdentity(tmp)!.lastUpdatedAt;
      touchIdentity();
      const after = loadIdentity(tmp)!;
      expect(after.sender).toBe(original.sender);
      expect(after.roomId).toBe(original.roomId);
      expect(after.agentSessionId).toBe(original.agentSessionId);
      expect(after.lastUpdatedAt >= before).toBe(true);
    } finally {
      process.chdir(prev);
    }
  });

  it('touches legacy .im-for-agents/id.json in place (does NOT migrate on touch)', () => {
    writeLegacyId();
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      touchIdentity();
      // Still in legacy dir — only saveIdentity migrates
      expect(fs.existsSync(path.join(tmp, LEGACY, 'id.json'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, NEW))).toBe(false);
    } finally { process.chdir(prev); }
  });

  it('is a no-op when no identity is saved', () => {
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      expect(() => touchIdentity()).not.toThrow();
    } finally { process.chdir(prev); }
  });
});

describe('identity: archive + clear', () => {
  it('archive renames .concord to .concord.archived-<date>', () => {
    saveIdentity(sample(), tmp);
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      const dst = archiveIdentity();
      expect(dst).toMatch(/\.concord\.archived-\d{8}/);
      expect(fs.existsSync(path.join(tmp, NEW))).toBe(false);
      expect(fs.existsSync(dst!)).toBe(true);
    } finally { process.chdir(prev); }
  });

  it('archive of legacy dir uses legacy name', () => {
    writeLegacyId();
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      const dst = archiveIdentity()!;
      // Archived as .im-for-agents.archived-... preserving the original prefix
      expect(dst).toMatch(/\.im-for-agents\.archived-\d{8}/);
    } finally { process.chdir(prev); }
  });

  it('archive disambiguates with -2, -3 suffix when called twice the same day', () => {
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      saveIdentity(sample(), tmp);
      const a = archiveIdentity()!;
      saveIdentity(sample(), tmp);
      const b = archiveIdentity()!;
      expect(a).not.toBe(b);
      expect(b).toMatch(/-2$/);
    } finally { process.chdir(prev); }
  });

  it('archive returns null if no identity dir exists', () => {
    const prev = process.cwd();
    try { process.chdir(tmp); expect(archiveIdentity()).toBeNull(); }
    finally { process.chdir(prev); }
  });

  it('clear removes id.json but preserves notes.md and tasks.md', () => {
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      saveIdentity(sample(), tmp);
      clearIdentity();
      expect(loadIdentity(tmp)).toBeNull();
      expect(fs.existsSync(path.join(tmp, NEW, 'notes.md'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, NEW, 'tasks.md'))).toBe(true);
    } finally { process.chdir(prev); }
  });

  it('clear works on legacy dir too (without migration)', () => {
    writeLegacyId();
    fs.writeFileSync(path.join(tmp, LEGACY, 'notes.md'), '# notes\n', 'utf8');
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      clearIdentity();
      expect(fs.existsSync(path.join(tmp, LEGACY, 'id.json'))).toBe(false);
      expect(fs.existsSync(path.join(tmp, LEGACY, 'notes.md'))).toBe(true);
    } finally { process.chdir(prev); }
  });
});

describe('identity: setPaused', () => {
  it('returns null when no identity saved', () => {
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      expect(setPaused(true)).toBeNull();
    } finally { process.chdir(prev); }
  });

  it('sets paused=true and persists it', () => {
    saveIdentity(sample(), tmp);
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      const updated = setPaused(true);
      expect(updated?.paused).toBe(true);
      // Reload from disk to confirm persistence
      expect(loadIdentity(tmp)?.paused).toBe(true);
    } finally { process.chdir(prev); }
  });

  it('clears paused=false and persists it', () => {
    saveIdentity({ ...sample(), paused: true }, tmp);
    expect(loadIdentity(tmp)?.paused).toBe(true);
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      const updated = setPaused(false);
      expect(updated?.paused).toBe(false);
      expect(loadIdentity(tmp)?.paused).toBe(false);
    } finally { process.chdir(prev); }
  });

  it('bumps lastUpdatedAt when toggling paused', () => {
    saveIdentity({ ...sample(), lastUpdatedAt: '2020-01-01T00:00:00.000Z' }, tmp);
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      const updated = setPaused(true);
      expect(updated?.lastUpdatedAt > '2020-01-01').toBe(true);
    } finally { process.chdir(prev); }
  });

  it('preserves other identity fields when toggling paused', () => {
    saveIdentity(sample(), tmp);
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      setPaused(true);
      const after = loadIdentity(tmp)!;
      expect(after.sender).toBe(sample().sender);
      expect(after.roomId).toBe(sample().roomId);
      expect(after.agentSessionId).toBe(sample().agentSessionId);
    } finally { process.chdir(prev); }
  });
});

// POSIX file modes only — skip on Windows where chmod is a no-op.
const itPosix = process.platform === 'win32' ? it.skip : it;

describe('identity: owner-only permissions (M9)', () => {
  itPosix('creates .concord/ as 0700 and id.json as 0600', () => {
    saveIdentity(sample(), tmp);
    const dirMode = fs.statSync(path.join(tmp, NEW)).mode & 0o777;
    const idMode = fs.statSync(path.join(tmp, NEW, 'id.json')).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(idMode).toBe(0o600);
  });

  itPosix('seeds notes.md and tasks.md as 0600', () => {
    saveIdentity(sample(), tmp);
    expect(fs.statSync(path.join(tmp, NEW, 'notes.md')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(tmp, NEW, 'tasks.md')).mode & 0o777).toBe(0o600);
  });

  itPosix('keeps id.json 0600 after touch and setPaused rewrites', () => {
    saveIdentity(sample(), tmp);
    const prev = process.cwd();
    try {
      process.chdir(tmp);
      touchIdentity();
      expect(fs.statSync(path.join(tmp, NEW, 'id.json')).mode & 0o777).toBe(0o600);
      setPaused(true);
      expect(fs.statSync(path.join(tmp, NEW, 'id.json')).mode & 0o777).toBe(0o600);
    } finally { process.chdir(prev); }
  });
});
