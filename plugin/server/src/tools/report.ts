/**
 * Report-room tools: device-flow authorization + report-room creation.
 *
 * concord_authorize runs the OAuth 2.0 device flow (RFC 8628): the first call
 * starts a request and returns a URL + short code for the user to approve in a
 * browser; subsequent calls poll for the approval and store an account-level
 * report token at ~/.concord/report-token.json. concord_report then creates a
 * report room owned by that human and binds this directory to it.
 */
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ConcordClient, ConcordError } from '../client.js';
import { ok, err, fromError } from '../util.js';
import { saveIdentity, type Identity } from '../identity.js';

function concordHome(): string {
  const dir = path.join(os.homedir(), '.concord');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const tokenFile = () => path.join(concordHome(), 'report-token.json');
const pendingFile = () => path.join(concordHome(), 'report-auth-pending.json');

function readJson<T>(p: string): T | null {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as T; } catch { return null; }
}
function writeJson(p: string, v: unknown): void {
  fs.writeFileSync(p, JSON.stringify(v, null, 2), { mode: 0o600 });
}
function removeFile(p: string): void { try { fs.unlinkSync(p); } catch { /* gone */ } }

interface Pending { deviceCode: string; userCode: string; verificationUri: string; interval: number; }

export function registerReportTools(server: McpServer, client: ConcordClient): void {
  server.registerTool(
    'concord_authorize',
    {
      description: 'Authorize this agent to create progress-report rooms for a human (one-time per machine). Device flow: the FIRST call returns a URL + short code — show them to the user and ask them to approve in their browser. Then call concord_authorize AGAIN to finish; it polls for the approval and stores the token. Repeat the "again" call until it reports authorized.',
      inputSchema: {
        client_name: z.string().max(80).optional().describe('Label shown on the approval screen and in the user\'s "Authorized agents" list, e.g. "claude-code@my-laptop".'),
      },
    },
    async ({ client_name }) => {
      if (readJson<{ token: string }>(tokenFile())?.token) {
        return ok({ status: 'already_authorized', message: 'A report token is already stored. Call concord_report to create a report room.' });
      }
      const pending = readJson<Pending>(pendingFile());
      if (!pending) {
        // START — request a device code.
        try {
          const r = await client.request<{ device_code: string; user_code: string; verification_uri_complete: string; interval: number }>({
            method: 'POST', path: '/authorize/device', body: { client_name: client_name ?? '' },
          });
          writeJson(pendingFile(), { deviceCode: r.device_code, userCode: r.user_code, verificationUri: r.verification_uri_complete, interval: r.interval });
          return ok({
            status: 'pending_user_approval',
            user_code: r.user_code,
            approve_url: r.verification_uri_complete,
            message: `Show the user this and wait: "Open ${r.verification_uri_complete} and click Approve (code ${r.user_code})." Then call concord_authorize again to finish.`,
          });
        } catch (e) { return fromError(e); }
      }
      // FINISH — poll for the token (bounded loop; re-callable if still pending).
      let lastCode = 'authorization_pending';
      for (let i = 0; i < 6; i++) {
        try {
          const r = await client.request<{ access_token?: string }>({ method: 'POST', path: '/authorize/token', body: { device_code: pending.deviceCode } });
          if (r.access_token) {
            writeJson(tokenFile(), { token: r.access_token, authorizedAt: new Date().toISOString() });
            removeFile(pendingFile());
            return ok({ status: 'authorized', message: 'Authorized. Now call concord_report to create your report room.' });
          }
        } catch (e) {
          lastCode = e instanceof ConcordError ? e.code : 'error';
          if (lastCode === 'access_denied') { removeFile(pendingFile()); return err('The user denied the authorization.', { code: 'access_denied' }); }
          if (lastCode === 'expired_token') { removeFile(pendingFile()); return err('The authorization code expired. Call concord_authorize again to restart.', { code: 'expired_token' }); }
          // authorization_pending / slow_down → wait and retry
        }
        await new Promise<void>(res => setTimeout(res, Math.max(1, pending.interval) * 1000));
      }
      return ok({
        status: 'still_pending',
        user_code: pending.userCode,
        approve_url: pending.verificationUri,
        message: `Still waiting for approval. Confirm the user approved at ${pending.verificationUri} (code ${pending.userCode}), then call concord_authorize again.`,
      });
    },
  );

  server.registerTool(
    'concord_report',
    {
      description: 'Create a progress-report room (owned by the human who authorized you) and bind this directory to it. Requires a prior concord_authorize. After this, report with concord_send (set level: milestone / blocked / needs_decision / done) and read the human\'s replies with concord_poll.',
      inputSchema: {
        name: z.string().min(1).max(160).describe('Short, human-meaningful title for what you are reporting on, e.g. "Auth module refactor". A 📊 prefix is added automatically.'),
        sender: z.string().min(1).max(100).optional().describe('Your display name in the room. Defaults to "reporter".'),
        purpose: z.string().max(2000).optional().describe('Optional one-line description of the task you are reporting on.'),
      },
    },
    async ({ name, sender, purpose }) => {
      const tok = readJson<{ token: string }>(tokenFile());
      if (!tok?.token) return err('Not authorized yet. Call concord_authorize first.', { code: 'not_authorized' });
      const who = sender ?? 'reporter';
      try {
        const r = await client.request<{ room: { id: string; name: string; purpose: string }; agentSessionId: string }>({
          method: 'POST', path: '/report-rooms',
          headers: { Authorization: `Bearer ${tok.token}` },
          body: { name, sender: who, purpose },
        });
        const now = new Date().toISOString();
        const identity: Identity = { sender: who, agentSessionId: r.agentSessionId, roomId: r.room.id, serverUrl: client.baseUrl, createdAt: now, lastUpdatedAt: now };
        saveIdentity(identity);
        return ok({
          room: r.room,
          agentSessionId: r.agentSessionId,
          message: 'Report room created and bound to this directory. Report progress with concord_send (use the level field); read the human\'s replies with concord_poll.',
        });
      } catch (e) {
        if (e instanceof ConcordError && e.status === 401) {
          removeFile(tokenFile());
          return err('Your report token was rejected (revoked or expired). Call concord_authorize again.', { code: 'report_token_invalid' });
        }
        return fromError(e);
      }
    },
  );
}
