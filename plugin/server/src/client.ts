/**
 * REST client wrapping the Concord agent API.
 *
 * Base URL resolves from `CONCORD_SERVER` env var (set via the plugin
 * manifest's mcpServers env block) and falls back to the hosted SaaS at
 * https://concord.fenginwind.com/agent.
 *
 * Error mapping:
 *   - 401 Unauthorized      → SessionExpired (caller re-joins via concord_join)
 *   - 4xx / 5xx with JSON   → ConcordError { status, code, hint?, body }
 *   - Network failure       → ConcordError { status: 0, code: "network" }
 */

const DEFAULT_BASE = 'https://concord.fenginwind.com/agent';

export class SessionExpired extends Error {
  readonly status = 401;
  constructor(message = 'Session expired — call concord_join with the existing sender to re-join.') {
    super(message);
    this.name = 'SessionExpired';
  }
}

export class ConcordError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'ConcordError';
  }
}

export function resolveBaseUrl(): string {
  const env = process.env.CONCORD_SERVER?.trim();
  if (!env) return DEFAULT_BASE;
  const base = env.replace(/\/+$/, '');
  assertSafeServerUrl(base);
  return base;
}

/**
 * Reject a CONCORD_SERVER that could leak the session token. Plaintext http to
 * a remote host (or a non-http(s) scheme) would expose the bearer token in
 * transit / to an attacker-controlled origin. https is required; http is
 * allowed only for localhost dev.
 */
export function assertSafeServerUrl(raw: string): void {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`CONCORD_SERVER is not a valid URL: ${raw}`);
  }
  const isLocal =
    u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === '::1';
  const allowed = u.protocol === 'https:' || (u.protocol === 'http:' && isLocal);
  if (!allowed) {
    throw new Error(
      `CONCORD_SERVER must use https:// (got "${raw}"). Plaintext http to a non-localhost host could expose your session token; only http://localhost is allowed for local dev.`,
    );
  }
}

interface RequestOptions {
  /** Path under the agent base, beginning with `/`. e.g. `/rooms/<id>/messages`. */
  path: string;
  method: 'GET' | 'POST' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Extra request headers (e.g. Authorization for the report-token flow). */
  headers?: Record<string, string>;
  /** Override the default 30 s timeout (long-poll uses ~200 s). */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ConcordClient {
  constructor(public readonly baseUrl: string = resolveBaseUrl()) {}

  /** JSON request → parsed JSON response. Throws SessionExpired / ConcordError. */
  async request<T = unknown>(opts: RequestOptions): Promise<T> {
    const url = this.urlFor(opts.path, opts.query);
    const init: RequestInit = { method: opts.method, headers: { ...(opts.headers ?? {}) } };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
      (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
    }
    const res = await this.doFetch(url, init, opts.timeoutMs);
    return this.parseJson<T>(res);
  }

  /** multipart/form-data upload. `extraFields` are sent as form fields alongside the file. */
  async upload<T = unknown>(
    path: string,
    fileName: string,
    bytes: Uint8Array,
    mime: string,
    extraFields: Record<string, string>,
  ): Promise<T> {
    const url = this.urlFor(path);
    const fd = new FormData();
    for (const [k, v] of Object.entries(extraFields)) fd.append(k, v);
    fd.append('file', new Blob([bytes as BlobPart], { type: mime }), fileName);
    const res = await this.doFetch(url, { method: 'POST', body: fd });
    return this.parseJson<T>(res);
  }

  /** Binary download. Returns raw bytes plus the suggested filename + mime. */
  async download(
    path: string,
    query: Record<string, string | number | undefined>,
  ): Promise<{ bytes: Uint8Array; mime: string; filename: string; enc: boolean }> {
    const url = this.urlFor(path, query);
    const res = await this.doFetch(url, { method: 'GET' });
    if (!res.ok) await this.throwHttpError(res);
    const buf = new Uint8Array(await res.arrayBuffer());
    const mime = res.headers.get('content-type') ?? 'application/octet-stream';
    const cd = res.headers.get('content-disposition') ?? '';
    const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(cd);
    const filename = match ? decodeURIComponent(match[1]) : 'download.bin';
    // Server marks E2EE-room files so the caller knows to decrypt the bytes.
    const enc = res.headers.get('x-concord-enc') === '1';
    return { bytes: buf, mime, filename, enc };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private urlFor(path: string, query?: Record<string, string | number | undefined>): string {
    let url = this.baseUrl + (path.startsWith('/') ? path : `/${path}`);
    if (query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) qs.set(k, String(v));
      }
      const qss = qs.toString();
      if (qss) url += (url.includes('?') ? '&' : '?') + qss;
    }
    return url;
  }

  private async doFetch(url: string, init: RequestInit, timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new ConcordError(0, 'timeout', `Request to ${url} timed out after ${timeoutMs} ms`);
      }
      throw new ConcordError(0, 'network', `Network error talking to ${url}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private async parseJson<T>(res: Response): Promise<T> {
    if (!res.ok) await this.throwHttpError(res);
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      throw new ConcordError(res.status, 'unexpected_content_type', `Expected JSON, got ${ct}`);
    }
    return (await res.json()) as T;
  }

  private async throwHttpError(res: Response): Promise<never> {
    let body: unknown;
    let bodyText = '';
    try {
      bodyText = await res.text();
      body = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      body = bodyText;
    }
    if (res.status === 401) throw new SessionExpired(extractMessage(body) ?? undefined);
    const code = extractCode(body) ?? `http_${res.status}`;
    const message = extractMessage(body) ?? `Concord returned ${res.status}`;
    throw new ConcordError(res.status, code, message, body);
  }
}

function extractMessage(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (typeof obj.error === 'string') return obj.error;
    if (typeof obj.hint === 'string') return obj.hint;
  }
  return null;
}

function extractCode(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    if (typeof obj.code === 'string') return obj.code;
    if (typeof obj.error === 'string') {
      // Use a slug of the error string as a stable code.
      return obj.error.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40);
    }
  }
  return null;
}
