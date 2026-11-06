// The plugin's own Host routes, seen from the browser (D62). Relative URLs (`api/raw-agent/…`),
// so DSH's `--public-url` prefixes and its cookie auth apply. No backend names here (D80): labels
// come from the Host.

import type {
  ConfigFileInfo,
  EffortInfo,
  ModelInfo,
  PermissionModeInfo,
  SessionChoiceRequest,
  SettingsDefaults,
} from '@dsh-raw-agent/core';

export type FetchFn = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;

/** Mirrors dsh-host `SessionView` (wire shape; kept structural on purpose). */
export interface SessionViewWire {
  state: {
    process: 'none' | 'starting' | 'running';
    turn: boolean;
    backgroundTasks: number;
    waiting?: number;
    lastExit?: { error?: string; at: number; duringTurn: boolean };
  };
  live: { model?: string; mode?: string; version?: string; notice?: { level: string; text: string; at: number } };
  choice: {
    model?: string;
    effort?: string;
    pendingMode?: string;
    applied: { model?: string; effort?: string };
    refused?: { model: string };
    resetPending: boolean;
  };
  models?: ModelInfo[];
  cwd?: string;
  /** Asks waiting for the user's answer; the Host never answers them itself. */
  asks?: AskWire[];
}

/** One pending ask (mirrors dsh-host `AskView`). */
export interface AskWire {
  id: string;
  kind: 'permission' | 'question' | 'plan' | 'elicitation' | 'trust';
  agent: 'main' | 'child';
  title: string;
  detail?: string;
  choices: Array<{ id: string; label: string }>;
  stopChoice: string;
  at: number;
}

/** `GET api/raw-agent/session` */
export interface SessionInfo {
  backend: { kind: string; displayName: string };
  permissionModes: PermissionModeInfo[];
  efforts: EffortInfo[];
  needsProcess: string[];
  models: ModelInfo[];
  modelsFrom: 'session' | 'recent' | 'none';
  settings?: SettingsDefaults;
  /** Present when the agent does not trust the session folder yet (R1.2, D73). */
  trust?: { state: string; directory: string; effect?: string };
  view: SessionViewWire;
}

/** `POST api/raw-agent/choice` */
export interface ChoiceResponse {
  ok: boolean;
  note?: string;
  error?: string;
  session?: SessionInfo;
}

export interface ConfigFileItem extends ConfigFileInfo {
  exists: boolean;
}

export interface ConfigFilePreviewWire extends ConfigFileInfo {
  exists: boolean;
  masked?: string;
  secrets?: Array<{ start: number; end: number; key?: string }>;
  mtimeMs?: number;
  size?: number;
  tooLarge?: boolean;
  error?: string;
}

/** The value `"settings"` means "your own settings" for model and effort (D35). */
export const SETTINGS = 'settings';

const BASE = 'api/raw-agent';

export class RouteError extends Error {
  override readonly name = 'RouteError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function read<T>(fetchFn: FetchFn, url: string, init?: Parameters<FetchFn>[1]): Promise<T> {
  const r = await fetchFn(url, init);
  const body = (await r.json().catch(() => undefined)) as { error?: unknown } | undefined;
  if (!r.ok) {
    const message = typeof body?.error === 'string' ? body.error : `request failed (${r.status})`;
    throw new RouteError(r.status, message);
  }
  return body as T;
}

const q = (sessionId: string) => `session=${encodeURIComponent(sessionId)}`;

/** A steer the agent did not run after Stop (D25); its text goes back to the composer. */
export interface ReturnedDraftWire {
  messageId: string;
  text: string;
  at: number;
  /** Images and files of the message; they cannot go back into the composer. */
  attachments?: number;
}

export interface RawAgentApi {
  session(sessionId: string): Promise<SessionInfo>;
  /** `GET api/raw-agent/state`: the returned drafts are handed out once. */
  state(sessionId: string): Promise<{ returnedDrafts: ReturnedDraftWire[] }>;
  choose(sessionId: string, choice: SessionChoiceRequest): Promise<ChoiceResponse>;
  start(sessionId: string): Promise<void>;
  /** The user's answer to one pending ask. */
  answer(
    sessionId: string,
    askId: string,
    choiceId: string,
  ): Promise<{ ok: boolean; error?: string; session?: SessionInfo }>;
  configFiles(sessionId: string): Promise<{ backend: string; files: ConfigFileItem[] }>;
  configFile(sessionId: string, scope: string): Promise<ConfigFilePreviewWire>;
  reveal(sessionId: string, scope: string, index: number): Promise<{ index: number; key?: string; value: string }>;
}

export function createApi(fetchFn: FetchFn): RawAgentApi {
  const post = (body?: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return {
    session: (id) => read<SessionInfo>(fetchFn, `${BASE}/session?${q(id)}`),
    async state(id) {
      const body = await read<{ returnedDrafts?: unknown }>(fetchFn, `${BASE}/state?${q(id)}`);
      const list = Array.isArray(body?.returnedDrafts) ? body.returnedDrafts : [];
      return {
        returnedDrafts: list.filter(
          (d): d is ReturnedDraftWire => typeof d === 'object' && d !== null && typeof d.text === 'string',
        ),
      };
    },
    async choose(id, choice) {
      const r = await fetchFn(`${BASE}/choice?${q(id)}`, post(choice));
      const body = (await r.json().catch(() => undefined)) as ChoiceResponse | { error?: string } | undefined;
      if (r.status === 409 && body && 'ok' in body) return body;
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      return body as ChoiceResponse;
    },
    async start(id) {
      await read(fetchFn, `${BASE}/start?${q(id)}`, post());
    },
    async answer(id, ask, choice) {
      const r = await fetchFn(`${BASE}/answer?${q(id)}`, post({ ask, choice }));
      const body = (await r.json().catch(() => undefined)) as
        { ok?: boolean; error?: string; session?: SessionInfo } | undefined;
      if (r.status === 409 && body)
        return {
          ok: false,
          error: body.error ?? 'that question is no longer open',
          ...(body.session ? { session: body.session } : {}),
        };
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      return { ok: true, ...(body?.session ? { session: body.session } : {}) };
    },
    configFiles: (id) => read(fetchFn, `${BASE}/config-files?${q(id)}`),
    configFile: (id, scope) => read(fetchFn, `${BASE}/config-file?${q(id)}&scope=${encodeURIComponent(scope)}`),
    reveal: (id, scope, index) =>
      read(fetchFn, `${BASE}/config-file?${q(id)}&scope=${encodeURIComponent(scope)}&reveal=${index}`),
  };
}
