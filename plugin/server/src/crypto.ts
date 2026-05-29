/**
 * Client-side E2EE for the plugin. The private key NEVER leaves this machine
 * and is never sent to the server. The server only stores ciphertext + the
 * public key (for join verification).
 *
 * Model (confirmed design):
 *   - The user generates ONE Ed25519 keypair with the provided keygen script,
 *     written to ~/.concord/keys/room_ed25519 (+ .pub). One key per user.
 *   - The PUBLIC key is pasted into Concord Settings; the room snapshots it.
 *   - This module reads the PRIVATE key from that fixed path and uses it to:
 *       (a) sign the server's join challenge (proof of possession), and
 *       (b) derive a symmetric AES-256 content key via HKDF, used to
 *           encrypt/decrypt message bodies. Everyone holding the same private
 *           key derives the same content key, so they can read each other.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEY_FILE = 'room_ed25519';
const HKDF_INFO = 'concord-content-v1';
const BLOB_PREFIX = 'e1:'; // version tag for the ciphertext envelope

/** Default key directory: $CONCORD_KEY_DIR or ~/.concord/keys. */
export function keyDir(): string {
  return process.env.CONCORD_KEY_DIR?.trim() || path.join(os.homedir(), '.concord', 'keys');
}

export function privateKeyPath(): string {
  return path.join(keyDir(), KEY_FILE);
}

/** Per-room key path: ~/.concord/keys/<roomId>. Used for cross-user
 * collaboration where each room has its own shared key. */
export function roomKeyPath(roomId: string): string {
  return path.join(keyDir(), roomId);
}

/** Load an Ed25519 private key from a specific path, or null. */
export function loadPrivateKeyAt(p: string): crypto.KeyObject | null {
  try {
    if (!fs.existsSync(p)) return null;
    const key = crypto.createPrivateKey(fs.readFileSync(p, 'utf8'));
    return key.asymmetricKeyType === 'ed25519' ? key : null;
  } catch {
    return null;
  }
}

/** Load the default account key (~/.concord/keys/room_ed25519), or null. */
export function loadPrivateKey(): crypto.KeyObject | null {
  return loadPrivateKeyAt(privateKeyPath());
}

/** True if `priv`'s public half equals the given PEM public key (compares the
 * raw SPKI DER bytes, so PEM whitespace/formatting differences don't matter). */
export function publicKeyMatches(priv: crypto.KeyObject, pubPem: string): boolean {
  try {
    const a = crypto.createPublicKey(priv).export({ type: 'spki', format: 'der' });
    const b = crypto.createPublicKey(pubPem).export({ type: 'spki', format: 'der' });
    return Buffer.from(a).equals(Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Find the private key for a room. Supports both models:
 *   - per-room key:  ~/.concord/keys/<roomId>   (cross-user collaboration)
 *   - account key:   ~/.concord/keys/room_ed25519 (your own agents)
 * Returns the first candidate whose PUBLIC half matches the room's stored
 * public key (so we never pick a key that would fail server verification),
 * or null if neither is present/matches.
 */
export function findRoomKey(roomId: string, roomPubkeyPem: string): { key: crypto.KeyObject; path: string } | null {
  for (const p of [roomKeyPath(roomId), privateKeyPath()]) {
    const key = loadPrivateKeyAt(p);
    if (key && publicKeyMatches(key, roomPubkeyPem)) return { key, path: p };
  }
  return null;
}

/** Sign a challenge nonce with the Ed25519 private key → base64 signature. */
export function signChallenge(challenge: string, key: crypto.KeyObject): string {
  return crypto.sign(null, Buffer.from(challenge, 'utf8'), key).toString('base64');
}

/**
 * Derive the AES-256 content key from the Ed25519 private key's 32-byte seed
 * (the JWK `d` parameter) via HKDF-SHA256. Deterministic: the same key file
 * always yields the same content key, across all participants.
 */
export function deriveContentKey(key: crypto.KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { d?: string };
  if (!jwk.d) throw new Error('private key has no seed (not an Ed25519 key?)');
  const seed = Buffer.from(jwk.d, 'base64url');
  const derived = crypto.hkdfSync('sha256', seed, Buffer.alloc(0), Buffer.from(HKDF_INFO, 'utf8'), 32);
  return Buffer.from(derived);
}

/** Encrypt UTF-8 plaintext → versioned base64 envelope (AES-256-GCM). */
export function encrypt(plaintext: string, contentKey: Buffer): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return BLOB_PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/** Encrypt raw bytes → envelope bytes (iv ‖ tag ‖ ciphertext), AES-256-GCM.
 * Used for binary file uploads; the server's X-Concord-Enc header tells the
 * reader when to call decryptBytes (no magic-byte sniffing — a plaintext file
 * could coincidentally start with any marker). */
export function encryptBytes(plain: Buffer, contentKey: Buffer): Buffer {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', contentKey, iv);
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]);
}

/** Decrypt envelope bytes produced by encryptBytes. Throws on tamper/wrong key. */
export function decryptBytes(blob: Buffer, contentKey: Buffer): Buffer {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', contentKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

/** True if a string is a Concord text ciphertext envelope (e1: prefix). */
export function isCiphertext(s: string): boolean {
  return typeof s === 'string' && s.startsWith(BLOB_PREFIX);
}

/** Decrypt a versioned base64 envelope back to UTF-8 plaintext. Throws on tamper/wrong key. */
export function decrypt(blob: string, contentKey: Buffer): string {
  if (!blob.startsWith(BLOB_PREFIX)) throw new Error('not a Concord ciphertext envelope');
  const raw = Buffer.from(blob.slice(BLOB_PREFIX.length), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', contentKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

/**
 * Walk a server response and decrypt any encrypted message bodies in-place.
 * Only touches objects with `enc === true`; human/system (plaintext) and
 * already-decrypted messages are left alone. A message that fails to decrypt
 * (wrong key / tampered) is replaced with a clear marker rather than throwing,
 * so one bad message doesn't break the whole poll.
 */
export function decryptResponseMessages(res: unknown, contentKey: Buffer): void {
  if (!res || typeof res !== 'object') return;
  const obj = res as Record<string, unknown>;
  const decryptOne = (m: unknown) => {
    if (!m || typeof m !== 'object') return;
    const msg = m as Record<string, unknown>;
    if (msg.enc === true && typeof msg.content === 'string') {
      try {
        msg.content = decrypt(msg.content, contentKey);
        msg.enc = false; // now plaintext for the reader
      } catch {
        msg.content = '[could not decrypt — wrong or missing room key]';
      }
    }
  };
  for (const field of ['message', 'messages', 'missedMessages', 'pinnedMessages']) {
    const v = obj[field];
    if (Array.isArray(v)) v.forEach(decryptOne);
    else if (v) decryptOne(v);
  }
}
