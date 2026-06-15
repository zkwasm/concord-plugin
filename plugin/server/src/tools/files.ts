/**
 * File tools: list / read / write (text) + binary upload / download.
 * Read/write are convenience wrappers for text files; upload/download
 * handle arbitrary bytes through multipart. (history/delete remain on the
 * server REST API but are not exposed as tools — rarely used by agents.)
 *
 * Local-disk semantics for upload/download:
 *   - upload reads `localPath` (absolute or CWD-relative) from disk
 *   - download writes to `localPath` if provided, else returns base64 bytes
 *     plus the server-suggested filename
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConcordClient } from '../client.js';
import { loadPrivateKey, loadPrivateKeyAt, deriveContentKey, encrypt, decrypt, isCiphertext, encryptBytes, decryptBytes, privateKeyPath } from '../crypto.js';
import { ok, err, requireIdentity, fromError } from '../util.js';

/** Resolve the AES content key for an E2EE room from the per-room keyPath
 * recorded at join (falls back to the account key). Mirrors messaging.ts. */
function resolveContentKey(keyPath?: string): { contentKey?: Buffer; error?: ReturnType<typeof err> } {
  const key = keyPath ? loadPrivateKeyAt(keyPath) : loadPrivateKey();
  if (!key) {
    const p = keyPath || privateKeyPath();
    return { error: err(`This room is end-to-end encrypted but its key (${p}) is missing or unreadable. Restore the shared key file and retry.`, { code: 'e2ee_key_missing', expectedPath: p }) };
  }
  return { contentKey: deriveContentKey(key) };
}

const EXT_MIME: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.py': 'text/x-python',
  '.js': 'text/javascript',
  '.ts': 'application/typescript',
};

function mimeOf(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXT_MIME[ext] ?? 'application/octet-stream';
}

/**
 * Jail a download target to the CWD subtree. Returns the absolute path to
 * write, or null if `localPath` would escape the project directory — so
 * room-supplied content (which an agent may be prompt-injected into saving)
 * can't overwrite sensitive files like ~/.ssh or shell rc files.
 */
export function jailDownloadPath(cwd: string, localPath: string): string | null {
  const resolved = path.resolve(cwd, localPath);
  const root = path.resolve(cwd);
  const rel = path.relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

export function registerFileTools(server: McpServer, client: ConcordClient): void {
  server.registerTool(
    'concord_file_list',
    {
      description: 'List all files in the room (path, size, headCommit, lastAuthor, lastUpdated). Check this when a human says they uploaded something, or before writing to avoid clobbering another agent\'s work.',
      inputSchema: {},
    },
    async () => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request({
          method: 'GET',
          path: `/rooms/${identity.roomId}/files/list`,
          query: { session: identity.agentSessionId },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_file_read',
    {
      description: 'Read a text file from the room\'s versioned store. Optionally pass `ref` to read a specific past commit. For binary content (PDFs, images, archives), use concord_file_download instead.',
      inputSchema: {
        path: z.string().min(1).max(500),
        ref: z.string().optional().describe('Optional git commit SHA for a past version. Defaults to HEAD.'),
      },
    },
    async ({ path: filePath, ref }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const res = await client.request<{ content?: string }>({
          method: 'GET',
          path: `/rooms/${identity.roomId}/files/read`,
          query: { session: identity.agentSessionId, path: filePath, ref },
        });
        // E2EE: agent-written text files are stored as ciphertext envelopes.
        // Decrypt in place; a plaintext (human) file won't match isCiphertext.
        if (identity.e2ee && res && typeof res.content === 'string' && isCiphertext(res.content)) {
          const k = resolveContentKey(identity.keyPath);
          if (k.error) return k.error;
          try { res.content = decrypt(res.content, k.contentKey!); }
          catch { res.content = '[could not decrypt — wrong or missing room key]'; }
        }
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_file_write',
    {
      description: 'Write (or overwrite) a text file in the room. Creates a commit under your author name; emits a [FILE] system message so the whole room sees the contribution. Use for reports, code, long specs, anything over ~500 chars you\'d otherwise paste into chat.',
      inputSchema: {
        path: z.string().min(1).max(500).describe('Relative path within the room. Nested paths like `reports/v1.md` work. Must not contain `..` or `.git`.'),
        content: z.string().max(10_000_000).describe('UTF-8 text content. Max 10 MB.'),
      },
    },
    async ({ path: filePath, content }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      let outContent = content;
      let encFlag = false;
      if (identity.e2ee) {
        const k = resolveContentKey(identity.keyPath);
        if (k.error) return k.error;
        outContent = encrypt(content, k.contentKey!);
        encFlag = true;
      }
      try {
        const res = await client.request({
          method: 'POST',
          path: `/rooms/${identity.roomId}/files/write`,
          body: { agentSessionId: identity.agentSessionId, path: filePath, content: outContent, enc: encFlag },
        });
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_file_upload',
    {
      description: 'Upload a local binary file (PDF, image, archive, dataset) to the room. Reads bytes from `localPath` on disk and POSTs as multipart. Max 10 MB per file. Use this for non-text artifacts; use concord_file_write for text.',
      inputSchema: {
        localPath: z.string().min(1).describe('Absolute or CWD-relative path to the file on disk.'),
        remotePath: z.string().min(1).max(500).optional().describe('Path inside the room. Defaults to basename(localPath).'),
      },
    },
    async ({ localPath, remotePath }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      const resolved = path.resolve(process.cwd(), localPath);
      if (!fs.existsSync(resolved)) {
        return err(`Local file not found: ${resolved}`, { code: 'local_file_not_found' });
      }
      const bytes = fs.readFileSync(resolved);
      const filename = path.basename(resolved);
      const remote = remotePath ?? filename;
      let outBytes = new Uint8Array(bytes);
      const fields: Record<string, string> = { agentSessionId: identity.agentSessionId, path: remote };
      if (identity.e2ee) {
        const k = resolveContentKey(identity.keyPath);
        if (k.error) return k.error;
        outBytes = new Uint8Array(encryptBytes(bytes, k.contentKey!));
        fields.enc = 'true';
      }
      try {
        const res = await client.upload(
          `/rooms/${identity.roomId}/files`,
          filename,
          outBytes,
          mimeOf(filename),
          fields,
        );
        return ok(res);
      } catch (e) {
        return fromError(e);
      }
    },
  );

  server.registerTool(
    'concord_file_download',
    {
      description: 'Download a binary file from the room. If `localPath` is given, writes bytes to disk and returns metadata. Otherwise returns the bytes base64-encoded plus the server-reported mime + filename.',
      inputSchema: {
        remotePath: z.string().min(1).max(500),
        localPath: z.string().min(1).optional().describe('If set, save the downloaded bytes here (absolute or CWD-relative). Parent dirs are created.'),
      },
    },
    async ({ remotePath, localPath }) => {
      const { identity, error } = requireIdentity();
      if (error) return error;
      try {
        const dl = await client.download(`/rooms/${identity.roomId}/files/download`, {
          session: identity.agentSessionId,
          path: remotePath,
        });
        // E2EE: the server marks encrypted files via X-Concord-Enc; decrypt the
        // bytes locally before saving/returning them.
        let bytes = dl.bytes;
        if (dl.enc) {
          const k = resolveContentKey(identity.keyPath);
          if (k.error) return k.error;
          bytes = new Uint8Array(decryptBytes(Buffer.from(dl.bytes), k.contentKey!));
        }
        if (localPath) {
          const resolved = jailDownloadPath(process.cwd(), localPath);
          if (!resolved) {
            return err(
              `Refusing to write outside the project directory: ${path.resolve(process.cwd(), localPath)}. Downloads are jailed to the current working directory so room content can't overwrite sensitive files (e.g. ~/.ssh, shell rc files). Use a path inside the project, or omit localPath to get the bytes back base64-encoded.`,
              { code: 'download_path_escape' },
            );
          }
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, bytes);
          return ok({ savedTo: resolved, bytes: bytes.length, mime: dl.mime, filename: dl.filename });
        }
        return ok({
          bytes: bytes.length,
          mime: dl.mime,
          filename: dl.filename,
          contentBase64: Buffer.from(bytes).toString('base64'),
        });
      } catch (e) {
        return fromError(e);
      }
    },
  );
}
