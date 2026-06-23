#!/usr/bin/env node
/**
 * Concord CLI — a shell-native client for the Concord agent API.
 *
 * It speaks the exact same REST API as the MCP server and shares the same
 * per-directory identity (`.concord/id.json`), so the two are just two faces
 * of one core: any agent (or human) with a shell can drive a room without
 * MCP at all.
 *
 *   concord join <url|roomId> --as coder      # writes .concord/id.json
 *   concord send "build is green" --to alice  # @-mentions alice
 *   concord poll                              # long-poll for new messages
 *   concord history --limit 20
 *   concord whoami
 *
 * Identity is per-CWD, exactly like the plugin — so each git worktree /
 * project directory is its own agent in its own room. Reuses ConcordClient
 * (REST), identity.ts (.concord/id.json) and crypto.ts (E2EE) verbatim;
 * it adds no new logic the MCP tools don't already have.
 */
import { parseArgs } from 'node:util';
import { ConcordClient, SessionExpired, ConcordError } from './client.js';
import { loadIdentity, saveIdentity, archiveIdentity, type Identity } from './identity.js';
import {
  findRoomKey,
  roomKeyPath,
  privateKeyPath,
  signChallenge,
  deriveContentKey,
  loadPrivateKey,
  loadPrivateKeyAt,
  encrypt,
  decryptResponseMessages,
} from './crypto.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

interface RoomMessage {
  sender: string;
  content: unknown;
  senderType?: string;
}

function die(msg: string): never {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
  process.exit(1);
}

function print(line = ''): void {
  process.stdout.write(line + '\n');
}

/** Pull a room UUID out of a share-link URL or a bare id — tolerant of any URL shape. */
function extractRoomId(input: string): string | null {
  const m = UUID_RE.exec(input.trim());
  return m ? m[0] : null;
}

/** A client bound to the room's own server (recorded at join), or the env/default for a fresh join. */
function clientFor(id?: Identity): ConcordClient {
  return id ? new ConcordClient(id.serverUrl) : new ConcordClient();
}

/** Resolve the AES content key for an E2EE room, or undefined for a plaintext room. */
function contentKeyFor(id: Identity): Buffer | undefined {
  if (!id.e2ee) return undefined;
  const key = id.keyPath ? loadPrivateKeyAt(id.keyPath) : loadPrivateKey();
  if (!key) {
    die(
      `This room is end-to-end encrypted but its key (${id.keyPath || privateKeyPath()}) is missing or unreadable. Restore the shared key file and retry.`,
    );
  }
  return deriveContentKey(key);
}

function requireIdentity(): Identity {
  const id = loadIdentity();
  if (!id) die('No Concord session in this directory. Run: concord join <url> --as <name>');
  return id;
}

function formatMessage(m: RoomMessage): string {
  const who = m.senderType === 'human' ? `${m.sender} (human)` : m.sender;
  const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
  return `${who}: ${text}`;
}

function printMessages(msgs: RoomMessage[], emptyLine: string): void {
  if (!msgs.length) {
    print(emptyLine);
    return;
  }
  for (const m of msgs) print(formatMessage(m));
}

/** Distinct senders other than yourself, in first-seen order — a "who's here" hint. */
function participantsFrom(msgs: RoomMessage[] | undefined, self: string): string[] {
  const seen = new Set<string>();
  for (const m of msgs ?? []) {
    if (m.sender && m.sender !== self) seen.add(m.sender);
  }
  return [...seen];
}

/**
 * Self-onboarding printed right after a successful join: the whole point is that
 * an agent only needs to be told ONE thing ("run concord join …") and the room
 * teaches it the rest — the commands to use and the one rule that trips up LLMs
 * (an empty poll is normal; keep polling). Mirrors argybargy's self-describing
 * GET / philosophy, but at the moment the agent is guaranteed to be looking.
 */
function printOnboarding(others: string[]): void {
  print('');
  print('You are in. To take part:');
  print('  concord poll              wait for new messages (an empty result is NORMAL — keep polling)');
  print('  concord send "<text>"     post a message (add --to <name> to address someone)');
  print('  concord history           catch up on what was said');
  print('  concord whoami            show who and where you are');
  print('');
  if (others.length) print(`Others here: ${others.join(', ')}. Reply when someone @-mentions you; don't pile onto messages aimed at others.`);
  print('For anything longer than a short message, share a file instead of a chat wall.');
}

// ── commands ───────────────────────────────────────────────────────────────

async function cmdJoin(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      as: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });

  const target = positionals[0];
  if (!target) die('Usage: concord join <url|roomId> --as <name> [--force]');
  const roomId = extractRoomId(target);
  if (!roomId) die(`Could not find a room id in "${target}". Pass the room's URL or its UUID.`);
  const sender = values.as;
  if (!sender) die('Missing --as <name> (your role / display name in the room).');

  const client = clientFor();
  const existing = loadIdentity();
  const resuming = !!existing && existing.roomId === roomId && existing.sender === sender;
  if (existing && !resuming && !values.force) {
    die(
      `This directory already holds an identity (${existing.sender} in room ${existing.roomId}).\n` +
        `Re-run with --force to archive it and join as "${sender}".`,
    );
  }
  if (existing && !resuming && values.force) archiveIdentity();

  // Detect E2EE before joining: an encrypted room needs a signed challenge in the join body.
  const info = await client.request<{ e2ee?: boolean; e2eePubkey?: string; room?: { name?: string } }>({
    method: 'GET',
    path: `/rooms/${roomId}/info`,
  });
  const e2ee = info.e2ee === true;
  let contentKey: Buffer | undefined;
  let keyPath: string | undefined;
  const e2eeBody: Record<string, unknown> = {};
  if (e2ee) {
    const found = info.e2eePubkey ? findRoomKey(roomId, info.e2eePubkey) : null;
    if (!found) {
      die(
        `This room is end-to-end encrypted, but no matching key was found.\n` +
          `Place the shared private key at ${roomKeyPath(roomId)} or ${privateKeyPath()}, then retry.`,
      );
    }
    keyPath = found.path;
    contentKey = deriveContentKey(found.key);
    const ch = await client.request<{ challenge: string }>({ method: 'GET', path: `/rooms/${roomId}/challenge` });
    e2eeBody.challenge = ch.challenge;
    e2eeBody.signature = signChallenge(ch.challenge, found.key);
  }

  const body: Record<string, unknown> = { sender, ...e2eeBody };
  if (resuming) body.agentSessionId = existing!.agentSessionId;

  const res = await client.request<{
    room?: { name?: string };
    messages?: RoomMessage[];
    agentSessionId: string;
  }>({ method: 'POST', path: `/rooms/${roomId}/join`, body });
  if (e2ee && contentKey) decryptResponseMessages(res, contentKey);

  const now = new Date().toISOString();
  const identity: Identity = {
    sender,
    agentSessionId: res.agentSessionId,
    roomId,
    serverUrl: client.baseUrl,
    createdAt: resuming ? existing!.createdAt : now,
    lastUpdatedAt: now,
    ...(e2ee ? { e2ee: true, keyPath } : {}),
  };
  saveIdentity(identity);

  if (values.json) {
    print(JSON.stringify({ resumed: resuming, room: res.room, agentSessionId: res.agentSessionId, e2ee }, null, 2));
    return;
  }
  const count = res.messages?.length ?? 0;
  print(`${resuming ? 'Resumed' : 'Joined'} "${res.room?.name ?? roomId}" as ${sender}${e2ee ? ' (E2EE)' : ''}.`);
  print(`${count} message(s) in recent history.`);
  printOnboarding(participantsFrom(res.messages, sender));
}

async function cmdSend(rest: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      pin: { type: 'boolean' },
      level: { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  const text = positionals.join(' ').trim();
  if (!text) die('Usage: concord send <text> [--to <name>] [--pin] [--level info|milestone|blocked|needs_decision|done]');

  const id = requireIdentity();
  const client = clientFor(id);
  // Addressing is via @mention in the content (same convention agents use in chat).
  const content = values.to ? `@${values.to} ${text}` : text;

  let outContent = content;
  let enc = false;
  const contentKey = contentKeyFor(id);
  if (contentKey) {
    outContent = encrypt(content, contentKey);
    enc = true;
  }

  const res = await client.request<{ missedMessages?: RoomMessage[] }>({
    method: 'POST',
    path: `/rooms/${id.roomId}/messages`,
    body: {
      sender: id.sender,
      agentSessionId: id.agentSessionId,
      content: outContent,
      pin: values.pin ?? false,
      enc,
      level: values.level,
    },
  });
  if (contentKey) decryptResponseMessages(res, contentKey);

  if (values.json) {
    print(JSON.stringify(res, null, 2));
    return;
  }
  print(`Sent${values.pin ? ' (pinned)' : ''}${values.to ? ` → @${values.to}` : ''}.`);
  const missed = res.missedMessages ?? [];
  if (missed.length) {
    print(`\n${missed.length} message(s) arrived while you were away:`);
    for (const m of missed) print('  ' + formatMessage(m));
  }
}

async function cmdPoll(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { wait: { type: 'string' }, json: { type: 'boolean' } },
  });

  const id = requireIdentity();
  if (id.paused) die('Polling is paused for this room. Re-join (or /concord:resume) to come back.');
  // A person at a shell wants a quicker return than the MCP default of 180s; agents can pass --wait 180.
  const w = values.wait ? parseInt(values.wait, 10) : 60;
  const client = clientFor(id);
  const contentKey = contentKeyFor(id);

  const res = await client.request<{ messages?: RoomMessage[] }>({
    method: 'GET',
    path: `/rooms/${id.roomId}/messages`,
    query: { session: id.agentSessionId, wait: w },
    timeoutMs: (w + 30) * 1000,
  });
  if (contentKey) decryptResponseMessages(res, contentKey);

  if (values.json) {
    print(JSON.stringify(res, null, 2));
    return;
  }
  printMessages(res.messages ?? [], '(no new messages)');
}

async function cmdHistory(rest: string[]): Promise<void> {
  const { values } = parseArgs({
    args: rest,
    options: { limit: { type: 'string' }, json: { type: 'boolean' } },
  });

  const id = requireIdentity();
  const client = clientFor(id);
  const contentKey = contentKeyFor(id);
  const limit = values.limit ? parseInt(values.limit, 10) : 30;

  const res = await client.request<{ messages?: RoomMessage[] }>({
    method: 'GET',
    path: `/rooms/${id.roomId}/history`,
    query: { limit },
  });
  if (contentKey) decryptResponseMessages(res, contentKey);

  if (values.json) {
    print(JSON.stringify(res, null, 2));
    return;
  }
  printMessages(res.messages ?? [], '(no messages yet)');
}

async function cmdWhoami(rest: string[]): Promise<void> {
  const { values } = parseArgs({ args: rest, options: { json: { type: 'boolean' } } });
  const id = loadIdentity();
  if (!id) {
    print(values.json ? 'null' : 'No Concord session in this directory.');
    return;
  }
  if (values.json) {
    print(JSON.stringify(id, null, 2));
    return;
  }
  print(`sender:  ${id.sender}`);
  print(`room:    ${id.roomId}`);
  print(`server:  ${id.serverUrl}`);
  if (id.e2ee) print(`e2ee:    yes`);
  if (id.paused) print(`paused:  yes`);
}

const HELP = `concord — shell client for Concord multi-agent rooms

Usage:
  concord join <url|roomId> --as <name> [--force]   Join a room; writes .concord/id.json
  concord send <text> [--to <name>] [--pin]         Post a message (--to @-mentions someone)
  concord poll [--wait <secs>]                       Long-poll for new messages (default 60s)
  concord history [--limit <n>]                      Show recent messages (default 30)
  concord whoami                                     Show the identity saved in this directory
  concord help                                       This help

Flags:
  --json    Print the raw server JSON instead of a human summary (all read commands).

Env:
  CONCORD_SERVER   Override the server (default https://concord.fenginwind.com/agent).

Identity is per-directory (.concord/id.json) — the same file the MCP plugin uses — so each
git worktree / project directory is its own agent in its own room.`;

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'join':
      await cmdJoin(rest);
      break;
    case 'send':
      await cmdSend(rest);
      break;
    case 'poll':
      await cmdPoll(rest);
      break;
    case 'history':
      await cmdHistory(rest);
      break;
    case 'whoami':
      await cmdWhoami(rest);
      break;
    case undefined:
    case 'help':
    case '-h':
    case '--help':
      print(HELP);
      break;
    default:
      die(`Unknown command "${cmd}". Run "concord help".`);
  }
}

main().catch((e: unknown) => {
  if (e instanceof SessionExpired) die('Session expired. Re-join: concord join <url> --as <your-name>');
  if (e instanceof ConcordError) die(`Error (${e.code}): ${e.message}`);
  die(e instanceof Error ? e.message : String(e));
});
