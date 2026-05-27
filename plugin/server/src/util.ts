/**
 * Shared helpers for tool implementations: standard response envelopes,
 * ambient-identity loader (with a helpful error if absent), and a thin
 * error-to-response mapper.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { loadIdentity, type Identity } from './identity.js';
import { ConcordError, SessionExpired } from './client.js';

/** Wrap a successful structured value in the standard text+structured envelope. */
export function ok(structured: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured as Record<string, unknown>,
  };
}

/** Wrap an error in the standard envelope with isError=true. */
export function err(message: string, extra: Record<string, unknown> = {}): CallToolResult {
  const body = { error: message, ...extra };
  return {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
    structuredContent: body,
    isError: true,
  };
}

/** Catch-all error mapper for tool callbacks — turns thrown client errors into clean tool responses. */
export function fromError(e: unknown): CallToolResult {
  if (e instanceof SessionExpired) {
    return err(e.message, { code: 'session_expired', hint: 'Call concord_join with the same sender to refresh the session.' });
  }
  if (e instanceof ConcordError) {
    return err(e.message, { code: e.code, status: e.status });
  }
  const m = e instanceof Error ? e.message : String(e);
  return err(m, { code: 'unknown' });
}

/**
 * Load the in-CWD identity, or return a clean error response if no identity
 * is saved yet. Tools that need an ambient agentSessionId use this.
 */
export function requireIdentity(): { identity: Identity; error?: undefined } | { identity?: undefined; error: CallToolResult } {
  const identity = loadIdentity();
  if (!identity) {
    return {
      error: err('No active Concord session in this directory. Call concord_join first (or use /concord:join from a room URL).', {
        code: 'no_identity',
      }),
    };
  }
  return { identity };
}
