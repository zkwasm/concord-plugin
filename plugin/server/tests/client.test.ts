import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ConcordClient, SessionExpired, ConcordError, resolveBaseUrl } from '../src/client.js';

let fetchMock: ReturnType<typeof vi.fn>;
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('resolveBaseUrl', () => {
  it('defaults to im.fengdeagents.site when env is unset', () => {
    delete process.env.CONCORD_SERVER;
    expect(resolveBaseUrl()).toBe('https://im.fengdeagents.site/agent');
  });

  it('uses CONCORD_SERVER env if set, stripping trailing slashes', () => {
    process.env.CONCORD_SERVER = 'http://localhost:3009/agent/';
    expect(resolveBaseUrl()).toBe('http://localhost:3009/agent');
  });
});

describe('ConcordClient.request', () => {
  it('builds URL from baseUrl + path + query and parses JSON', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { messages: [{ id: 'm1' }] }));
    const c = new ConcordClient('http://localhost:3009/agent');
    const out = await c.request<{ messages: unknown[] }>({
      method: 'GET',
      path: '/rooms/r1/messages',
      query: { session: 's1', wait: 180 },
    });
    expect(out.messages).toHaveLength(1);
    const calledUrl = String(fetchMock.mock.calls[0][0]);
    expect(calledUrl).toBe('http://localhost:3009/agent/rooms/r1/messages?session=s1&wait=180');
  });

  it('serializes JSON body and sets Content-Type', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true }));
    const c = new ConcordClient('http://x');
    await c.request({ method: 'POST', path: '/y', body: { a: 1 } });
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"a":1}');
    expect(init.headers['Content-Type']).toBe('application/json');
  });

  it('maps 401 to SessionExpired', async () => {
    fetchMock.mockResolvedValue(jsonResponse(401, { error: 'Session expired' }));
    const c = new ConcordClient('http://x');
    await expect(c.request({ method: 'GET', path: '/p' })).rejects.toBeInstanceOf(SessionExpired);
  });

  it('maps 409 to ConcordError with code derived from server error string', async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: 'Name already taken in this room. Pick a different role.' }));
    const c = new ConcordClient('http://x');
    try {
      await c.request({ method: 'POST', path: '/p', body: {} });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConcordError);
      const ce = e as ConcordError;
      expect(ce.status).toBe(409);
      expect(ce.code).toContain('name_already_taken');
    }
  });

  it('maps 413 to ConcordError with status 413', async () => {
    fetchMock.mockResolvedValue(jsonResponse(413, { error: 'File too big' }));
    const c = new ConcordClient('http://x');
    await expect(c.request({ method: 'POST', path: '/p' })).rejects.toMatchObject({ status: 413 });
  });

  it('maps network failure to ConcordError with code "network"', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const c = new ConcordClient('http://x');
    await expect(c.request({ method: 'GET', path: '/p' })).rejects.toMatchObject({ code: 'network' });
  });

  it('maps timeout to ConcordError with code "timeout"', async () => {
    // Simulate an aborted fetch
    fetchMock.mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError';
          reject(e);
        });
      });
    });
    const c = new ConcordClient('http://x');
    await expect(c.request({ method: 'GET', path: '/p', timeoutMs: 30 })).rejects.toMatchObject({ code: 'timeout' });
  });
});

describe('ConcordClient.upload', () => {
  it('sends multipart with extra fields + file part', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { path: 'x.bin', size: 4 }));
    const c = new ConcordClient('http://x');
    const out = await c.upload<{ path: string }>('/rooms/r/files', 'note.txt', new Uint8Array([1, 2, 3, 4]), 'text/plain', {
      agentSessionId: 'sess',
      path: 'note.txt',
    });
    expect(out.path).toBe('x.bin');
    const init = fetchMock.mock.calls[0][1];
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    const fd = init.body as FormData;
    expect(fd.get('agentSessionId')).toBe('sess');
    expect(fd.get('path')).toBe('note.txt');
    expect(fd.get('file')).toBeInstanceOf(Blob);
  });
});

describe('ConcordClient.download', () => {
  it('returns bytes + mime + parses filename from Content-Disposition', async () => {
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]);
    fetchMock.mockResolvedValue(new Response(payload, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': 'attachment; filename="diagram.png"',
      },
    }));
    const c = new ConcordClient('http://x');
    const out = await c.download('/rooms/r/files/download', { session: 's', path: 'diagram.png' });
    expect(out.mime).toBe('image/png');
    expect(out.filename).toBe('diagram.png');
    expect(Buffer.from(out.bytes).equals(Buffer.from(payload))).toBe(true);
  });

  it('falls back to download.bin when no Content-Disposition', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1]), {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    }));
    const c = new ConcordClient('http://x');
    const out = await c.download('/p', {});
    expect(out.filename).toBe('download.bin');
  });

  it('throws ConcordError on HTTP error during download', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: 'Not found' }));
    const c = new ConcordClient('http://x');
    await expect(c.download('/p', {})).rejects.toBeInstanceOf(ConcordError);
  });
});
