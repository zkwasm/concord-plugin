import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadPrivateKey, deriveContentKey, signChallenge, encrypt, decrypt,
  encryptBytes, decryptBytes, decryptResponseMessages, privateKeyPath,
  findRoomKey, roomKeyPath, publicKeyMatches,
} from '../src/crypto.js';

let tmpDir: string;
let pubPem: string;
const ORIGINAL = process.env.CONCORD_KEY_DIR;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concord-key-'));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(tmpDir, 'room_ed25519'), privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
  pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  process.env.CONCORD_KEY_DIR = tmpDir;
});

afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.CONCORD_KEY_DIR;
  else process.env.CONCORD_KEY_DIR = ORIGINAL;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('plugin crypto', () => {
  it('privateKeyPath honours CONCORD_KEY_DIR', () => {
    expect(privateKeyPath()).toBe(path.join(tmpDir, 'room_ed25519'));
  });

  it('loads the Ed25519 private key from disk', () => {
    const key = loadPrivateKey();
    expect(key).not.toBeNull();
    expect(key!.asymmetricKeyType).toBe('ed25519');
  });

  it('derives a deterministic 32-byte content key', () => {
    const k1 = deriveContentKey(loadPrivateKey()!);
    const k2 = deriveContentKey(loadPrivateKey()!);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it('round-trips encrypt → decrypt', () => {
    const key = deriveContentKey(loadPrivateKey()!);
    const msg = 'GET /users/:id → { id, email, status } — freeze as v1 ✅';
    const blob = encrypt(msg, key);
    expect(blob.startsWith('e1:')).toBe(true);
    expect(blob).not.toContain('users'); // not plaintext
    expect(decrypt(blob, key)).toBe(msg);
  });

  it('fails to decrypt with a different key', () => {
    const blob = encrypt('secret', deriveContentKey(loadPrivateKey()!));
    const otherSeed = crypto.generateKeyPairSync('ed25519').privateKey;
    const otherKey = deriveContentKey(otherSeed);
    expect(() => decrypt(blob, otherKey)).toThrow();
  });

  it('round-trips encryptBytes → decryptBytes (binary files)', () => {
    const key = deriveContentKey(loadPrivateKey()!);
    const data = crypto.randomBytes(2048);
    const blob = encryptBytes(data, key);
    expect(blob.equals(data)).toBe(false);
    expect(decryptBytes(blob, key).equals(data)).toBe(true);
    // wrong key fails the GCM auth tag
    const other = deriveContentKey(crypto.generateKeyPairSync('ed25519').privateKey);
    expect(() => decryptBytes(blob, other)).toThrow();
  });

  it('findRoomKey: per-room key wins, account key is the fallback, mismatch → null', () => {
    // Account key is at room_ed25519 (written in beforeAll); pubPem is its public half.
    // 1) account key resolves to the default path for any room whose pubkey is the account pubkey.
    const acct = findRoomKey('room-A', pubPem);
    expect(acct?.path).toBe(path.join(tmpDir, 'room_ed25519'));

    // 2) a per-room key file <roomId> is preferred and matched by its own public key.
    const roomId = 'room-B';
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(roomKeyPath(roomId), privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
    const roomPub = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const found = findRoomKey(roomId, roomPub);
    expect(found?.path).toBe(roomKeyPath(roomId)); // per-room file, not the default
    expect(publicKeyMatches(found!.key, roomPub)).toBe(true);

    // 3) no key matches the given public key → null.
    const strangerPub = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(findRoomKey('room-C', strangerPub)).toBeNull();
  });

  it('signChallenge produces a signature the public key verifies', () => {
    const challenge = crypto.randomBytes(32).toString('base64url');
    const sig = signChallenge(challenge, loadPrivateKey()!);
    const ok = crypto.verify(null, Buffer.from(challenge, 'utf8'), crypto.createPublicKey(pubPem), Buffer.from(sig, 'base64'));
    expect(ok).toBe(true);
  });

  it('decryptResponseMessages decrypts only enc=true items, leaves plaintext, marks failures', () => {
    const key = deriveContentKey(loadPrivateKey()!);
    const res = {
      messages: [
        { sender: 'agent-a', enc: true, content: encrypt('encrypted hello', key) },
        { sender: 'human', enc: false, content: 'plaintext chime-in' },
        { sender: 'agent-b', enc: true, content: 'e1:not-real-ciphertext' },
      ],
    };
    decryptResponseMessages(res, key);
    expect(res.messages[0].content).toBe('encrypted hello');
    expect(res.messages[0].enc).toBe(false);
    expect(res.messages[1].content).toBe('plaintext chime-in');
    expect(res.messages[2].content).toContain('could not decrypt');
  });
});
