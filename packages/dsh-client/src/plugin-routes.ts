// The routes behind the Client service `rawAgentClient` and the plugin access panel (R9.2, D62,
// D66). Relative URLs (`api/raw-agent/…`), POST with a JSON body, so DSH's cookie auth and its
// trusted-host fence apply. A refusal comes back as a `RawAgentServiceError` with the Host's code.

import { RawAgentServiceError, type RawAgentErrorCode, type RawAgentSessionInfo } from '@dsh-raw-agent/core';
import type { FetchFn } from './api.js';

const BASE = 'api/raw-agent';

/** One grant as the panel shows it (mirrors dsh-host `GrantView`). The token is never listed. */
export interface GrantWire {
  id: string;
  label: string;
  created: number;
  /** false: kept in memory only; it ends with this DSH run. */
  saved: boolean;
  uses: number;
  lastUsed?: number;
}

export interface PluginApi {
  sessionInfo(sessionId: string): Promise<RawAgentSessionInfo | undefined>;
  interrupt(sessionId: string): Promise<void>;
  send(sessionId: string, text: string, grant: string, mode: 'send' | 'steer'): Promise<{ messageId: string }>;
  askSideQuestion(sessionId: string, question: string, grant: string): Promise<string | null>;
  grants(): Promise<GrantWire[]>;
  /** The token is in this answer only; show it once. */
  createGrant(label: string): Promise<{ grant: GrantWire; token: string; grants: GrantWire[] }>;
  revokeGrant(id: string): Promise<{ saved: boolean; grants: GrantWire[] }>;
}

const CODES: readonly RawAgentErrorCode[] = [
  'not-our-session',
  'no-grant',
  'bad-grant',
  'not-running',
  'empty',
  'too-long',
  'busy',
  'unsupported',
  'failed',
];

function codeOf(status: number, code: unknown): RawAgentErrorCode {
  if (typeof code === 'string' && (CODES as readonly string[]).includes(code)) return code as RawAgentErrorCode;
  return status === 404 ? 'not-our-session' : 'failed';
}

const isGrant = (g: unknown): g is GrantWire =>
  typeof g === 'object' &&
  g !== null &&
  typeof (g as GrantWire).id === 'string' &&
  typeof (g as GrantWire).label === 'string';

const grantList = (v: unknown): GrantWire[] => (Array.isArray(v) ? v.filter(isGrant) : []);

export function createPluginApi(fetchFn: FetchFn): PluginApi {
  const call = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const r = await fetchFn(`${BASE}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const out = (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    if (!r.ok) {
      const message = typeof out?.error === 'string' ? out.error : `request failed (${r.status})`;
      throw new RawAgentServiceError(codeOf(r.status, out?.code), message);
    }
    return out ?? {};
  };
  return {
    async sessionInfo(session) {
      try {
        return (await call('plugin/session-info', { session })) as unknown as RawAgentSessionInfo;
      } catch (e) {
        if (e instanceof RawAgentServiceError && e.code === 'not-our-session') return undefined;
        throw e;
      }
    },
    async interrupt(session) {
      await call('plugin/interrupt', { session });
    },
    async send(session, text, grant, mode) {
      const r = await call('plugin/send', { session, text, grant, mode });
      return { messageId: typeof r.messageId === 'string' ? r.messageId : '' };
    },
    async askSideQuestion(session, question, grant) {
      const r = await call('plugin/side-question', { session, question, grant });
      return typeof r.answer === 'string' ? r.answer : null;
    },
    async grants() {
      return grantList((await call('grants', {})).grants);
    },
    async createGrant(label) {
      const r = await call('grants/create', { label });
      if (!isGrant(r.grant) || typeof r.token !== 'string')
        throw new RawAgentServiceError('failed', 'the grant answer could not be read');
      return { grant: r.grant, token: r.token, grants: grantList(r.grants) };
    },
    async revokeGrant(id) {
      const r = await call('grants/revoke', { id });
      return { saved: r.saved === true, grants: grantList(r.grants) };
    },
  };
}
