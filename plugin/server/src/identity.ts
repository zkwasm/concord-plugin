/**
 * .concord/ identity persistence — matches the convention agents use
 * (see src/prompt-template.ts LOCAL_STATE_FILES). The plugin moves the
 * read/write mechanics out of the LLM's prompt, but the on-disk shape
 * is identical so a paste-prompt session and a plugin session can
 * resume from each other's id.json.
 *
 * Identity is per-CWD: the user's project directory. Multiple parallel
 * Claude Code sessions in different projects = multiple identities = no
 * collisions. Multiple sessions in the SAME CWD against the SAME room is
 * the normal "resume" case (last writer wins on lastUpdatedAt).
 *
 * Backward compatibility: the directory used to be `.im-for-agents/`.
 * loadIdentity reads either; saveIdentity transparently renames a legacy
 * dir to the new name on first write. Already-running agents that wrote
 * `.im-for-agents/` continue to resume cleanly.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Identity {
  sender: string;
  agentSessionId: string;
  roomId: string;
  serverUrl: string;
  createdAt: string;
  lastUpdatedAt: string;
  /**
   * When true, concord_poll and concord_heartbeat refuse to call the
   * server — agent stays "checked out" of the room without losing
   * identity or notes. Set by /concord:stop, cleared by /concord:resume.
   */
  paused?: boolean;
}

const DIR = '.concord';
const LEGACY_DIR = '.im-for-agents';
const ID_FILE = 'id.json';
const NOTES_FILE = 'notes.md';
const TASKS_FILE = 'tasks.md';

const NOTES_TEMPLATE = `# Notes

Private working notes — kept between Claude Code sessions in this project.
Keep under ~5 KB; archive older entries to notes.archived-<date>.md if it grows.

## Current Focus



## Key Context



## Decisions & Agreements



## Gotchas / Things to Remember

`;

const TASKS_TEMPLATE = `# Tasks

Checkboxed commitments I've made in the room that aren't done yet.
Format: \`- [ ] description (promised HH:MM)\`. Keep under ~2 KB.

`;

function dirOf(cwd: string): string {
  return path.join(cwd, DIR);
}

function legacyDirOf(cwd: string): string {
  return path.join(cwd, LEGACY_DIR);
}

/**
 * Returns the active identity directory in `cwd`. Prefers `.concord/`,
 * falls back to `.im-for-agents/` if only the legacy dir exists. Returns
 * null if neither holds an id.json. Read-only — does NOT migrate.
 */
function activeIdDir(cwd: string): string | null {
  const newP = path.join(dirOf(cwd), ID_FILE);
  if (fs.existsSync(newP)) return dirOf(cwd);
  const legacyP = path.join(legacyDirOf(cwd), ID_FILE);
  if (fs.existsSync(legacyP)) return legacyDirOf(cwd);
  return null;
}

/**
 * Load the current identity. Reads from `.concord/id.json`; if absent,
 * falls back to the legacy `.im-for-agents/id.json` so already-running
 * paste-prompt agents continue to resume cleanly. Returns null if the
 * file doesn't exist or is corrupted.
 */
export function loadIdentity(cwd: string = process.cwd()): Identity | null {
  const dir = activeIdDir(cwd);
  if (!dir) return null;
  try {
    const raw = fs.readFileSync(path.join(dir, ID_FILE), 'utf8');
    const parsed = JSON.parse(raw) as Identity;
    if (!parsed.agentSessionId || !parsed.roomId || !parsed.sender) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Save identity to `.concord/id.json`. If a legacy `.im-for-agents/` dir
 * exists and `.concord/` doesn't, the legacy dir is RENAMED to `.concord/`
 * on this first write — a one-shot migration that preserves notes.md and
 * tasks.md. Subsequent writes are normal.
 *
 * Also seeds notes.md / tasks.md with templates if absent and appends
 * `.concord/` to .gitignore if not already listed.
 */
export function saveIdentity(identity: Identity, cwd: string = process.cwd()): void {
  const newDir = dirOf(cwd);
  const legacyDir = legacyDirOf(cwd);
  // One-shot migration: rename legacy dir → new dir so notes/tasks survive.
  if (!fs.existsSync(newDir) && fs.existsSync(legacyDir)) {
    fs.renameSync(legacyDir, newDir);
  }
  fs.mkdirSync(newDir, { recursive: true });
  fs.writeFileSync(path.join(newDir, ID_FILE), JSON.stringify(identity, null, 2) + '\n', 'utf8');

  const notesP = path.join(newDir, NOTES_FILE);
  if (!fs.existsSync(notesP)) fs.writeFileSync(notesP, NOTES_TEMPLATE, 'utf8');

  const tasksP = path.join(newDir, TASKS_FILE);
  if (!fs.existsSync(tasksP)) fs.writeFileSync(tasksP, TASKS_TEMPLATE, 'utf8');

  ensureGitignored(cwd);
}

/**
 * Update only lastUpdatedAt. No-op if no identity is currently saved.
 * Writes back to whichever dir the identity was loaded from (no migration).
 */
export function touchIdentity(cwd: string = process.cwd()): void {
  const dir = activeIdDir(cwd);
  if (!dir) return;
  const idP = path.join(dir, ID_FILE);
  const id = loadIdentity(cwd);
  if (!id) return;
  id.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(idP, JSON.stringify(id, null, 2) + '\n', 'utf8');
}

/**
 * Set or clear the paused flag on the saved identity. Returns the
 * updated identity, or null if no identity is saved.
 *
 * paused=true: poll/heartbeat refuse to talk to the server.
 * paused=false: normal operation (also touches lastUpdatedAt).
 */
export function setPaused(paused: boolean, cwd: string = process.cwd()): Identity | null {
  const dir = activeIdDir(cwd);
  if (!dir) return null;
  const idP = path.join(dir, ID_FILE);
  const id = loadIdentity(cwd);
  if (!id) return null;
  id.paused = paused;
  id.lastUpdatedAt = new Date().toISOString();
  fs.writeFileSync(idP, JSON.stringify(id, null, 2) + '\n', 'utf8');
  return id;
}

/**
 * Rename the active identity dir to `<dir>.archived-YYYYMMDD/`. Used when
 * the user is joining a different room and we want to keep the old
 * notes/tasks history out of the way. Idempotent suffix (`-2`, `-3` ...).
 */
export function archiveIdentity(cwd: string = process.cwd()): string | null {
  // Archive whichever dir is active (new or legacy) — keeps both supported.
  const src = activeIdDir(cwd);
  if (!src) return null;
  const base = path.basename(src);
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let dst = path.join(cwd, `${base}.archived-${date}`);
  let n = 2;
  while (fs.existsSync(dst)) {
    dst = path.join(cwd, `${base}.archived-${date}-${n}`);
    n++;
  }
  fs.renameSync(src, dst);
  return dst;
}

/**
 * Delete only id.json — keep notes.md and tasks.md (they survive session
 * expiry per the resume protocol). Used on explicit "clear identity".
 */
export function clearIdentity(cwd: string = process.cwd()): void {
  const dir = activeIdDir(cwd);
  if (!dir) return;
  const p = path.join(dir, ID_FILE);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function ensureGitignored(cwd: string): void {
  const giPath = path.join(cwd, '.gitignore');
  const line = `${DIR}/`;
  let content = '';
  if (fs.existsSync(giPath)) {
    content = fs.readFileSync(giPath, 'utf8');
    if (content.split(/\r?\n/).some(l => l.trim() === line || l.trim() === DIR)) return;
    if (!content.endsWith('\n')) content += '\n';
  }
  fs.writeFileSync(giPath, content + line + '\n', 'utf8');
}
