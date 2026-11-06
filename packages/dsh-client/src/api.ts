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
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  /** The response body as a byte stream (the interaction channel reads it line by line). */
  body?: ReadableStream<Uint8Array> | null;
}>;

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

/** One choice of an ask (mirrors dsh-host `AskChoice`). */
export interface AskChoiceWire {
  id: string;
  label: string;
  /** Permission option kind (`allow-once`, `allow-always`, `reject-once`, …). */
  kind?: string;
  /** Where an "always" choice is saved, in plain words. */
  destination?: string;
  /** What an "always" choice saves, one line each (the exact rule text). */
  effects?: string[];
  /** The choice takes an optional typed text (reject with feedback, keep planning). */
  feedback?: boolean;
  feedbackPlaceholder?: string;
  /** `submits`: the choice needs a filled form (question answers, elicitation content). */
  submits?: 'answers' | 'content';
  /** With `submits: 'answers'`: a partly filled or empty form is fine ("Chat about this"). */
  partial?: boolean;
  /** An "always" choice whose rule the user may edit first (the agent's own suggestion). */
  editable?: { value: string; placeholder?: string; toolName: string };
}

/** One question of an AskUserQuestion ask (core `QuestionItem`). */
export interface QuestionWire {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string; preview?: string }>;
  allowsOther: boolean;
}

/** The data a card renders (mirrors dsh-host `AskForm`). */
export type AskFormWire =
  | {
      type: 'permission';
      toolName: string;
      displayName?: string;
      input?: unknown;
      inputTruncated?: boolean;
      description?: string;
      reason?: string;
      blockedPath?: string;
      defaultToNo?: boolean;
      mcpServer?: { name: string; source: string };
    }
  | { type: 'question'; questions: QuestionWire[]; previewFormat: 'markdown' | 'html'; otherLabel: string }
  | { type: 'plan'; plan: string; planFilePath?: string }
  | {
      type: 'elicitation';
      serverName: string;
      message: string;
      mode: 'form' | 'url';
      url?: string;
      requestedSchema?: unknown;
      title?: string;
      displayName?: string;
      description?: string;
    }
  | { type: 'trust'; directory: string; body: string };

/** One pending ask (mirrors dsh-host `AskView`). */
export interface AskWire {
  id: string;
  kind: 'permission' | 'question' | 'plan' | 'elicitation' | 'trust';
  agent: 'main' | 'child';
  /** The subagent's id and label, when a subagent asked (D77). */
  agentId?: string;
  agentLabel?: string;
  /** The tool call the ask is about (D77). */
  callId?: string;
  title: string;
  detail?: string;
  choices: AskChoiceWire[];
  stopChoice: string;
  /** `waiting`: an accepted URL elicitation the agent has not finished yet (D43). */
  state?: 'waiting';
  form?: AskFormWire;
  at: number;
}

/** The user's answer to one ask (`POST …/answer`); only `choice` is required. */
export interface AskReplyWire {
  choice: string;
  feedback?: string;
  answers?: Record<string, string | string[]>;
  notes?: Record<string, string>;
  content?: Record<string, unknown>;
  /** The edited rule of an `editable` choice (only when changed). */
  rule?: string;
}

/** A mode the session cannot pick now, and the backend option that unlocks it (D38 r4). */
export interface UnavailableModeWire extends PermissionModeInfo {
  optionLabel?: string;
}

/** One line of `GET api/raw-agent/interactions` (D39). */
export type ChannelLine =
  | { type: 'asks'; asks: AskWire[]; state?: SessionViewWire['state']; live?: SessionViewWire['live'] }
  | { type: 'ping' };

/** `GET api/raw-agent/session` */
export interface SessionInfo {
  backend: { kind: string; displayName: string };
  permissionModes: PermissionModeInfo[];
  /** Modes the session cannot pick now (D38 r4); shown greyed out with their reason. */
  unavailableModes?: UnavailableModeWire[];
  /** The agent's "next mode" key order (D38; Claude: Shift+Tab). */
  permissionModeCycle?: string[];
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
  /** The user's answer to one pending ask: a bare choice id, or a reply with its form. */
  answer(
    sessionId: string,
    askId: string,
    reply: string | AskReplyWire,
  ): Promise<{ ok: boolean; error?: string; gone?: boolean; session?: SessionInfo }>;
  /**
   * Read the interaction channel (D39) until it ends or `signal` aborts. Each parsed line goes to
   * `onLine`. Rejects with a RouteError for a non-200 answer.
   */
  interactions(sessionId: string, signal: AbortSignal, onLine: (line: ChannelLine) => void): Promise<void>;
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
    async answer(id, ask, reply) {
      const r = await fetchFn(
        `${BASE}/answer?${q(id)}`,
        post(typeof reply === 'string' ? { ask, choice: reply } : { ...reply, ask }),
      );
      const body = (await r.json().catch(() => undefined)) as
        { ok?: boolean; error?: string; session?: SessionInfo } | undefined;
      // 409: another browser answered first, or the agent withdrew it; 400: the form does not fit.
      if ((r.status === 409 || r.status === 400) && body && body.ok === false)
        return {
          ok: false,
          error: body.error ?? 'that question is no longer open',
          ...(r.status === 409 ? { gone: true } : {}),
          ...(body.session ? { session: body.session } : {}),
        };
      if (r.status === 409 && body)
        return {
          ok: false,
          gone: true,
          error: body.error ?? 'that question is no longer open',
          ...(body.session ? { session: body.session } : {}),
        };
      if (!r.ok) throw new RouteError(r.status, body?.error ?? `request failed (${r.status})`);
      return { ok: true, ...(body?.session ? { session: body.session } : {}) };
    },
    async interactions(id, signal, onLine) {
      const r = await fetchFn(`${BASE}/interactions?${q(id)}`, { signal });
      if (!r.ok) {
        const body = (await r.json().catch(() => undefined)) as { error?: unknown } | undefined;
        throw new RouteError(r.status, typeof body?.error === 'string' ? body.error : `request failed (${r.status})`);
      }
      if (!r.body) throw new RouteError(r.status, 'the interaction channel has no body');
      await readLines(r.body, signal, (text) => {
        const line = parseChannelLine(text);
        if (line) onLine(line);
      });
    },
    configFiles: (id) => read(fetchFn, `${BASE}/config-files?${q(id)}`),
    configFile: (id, scope) => read(fetchFn, `${BASE}/config-file?${q(id)}&scope=${encodeURIComponent(scope)}`),
    reveal: (id, scope, index) =>
      read(fetchFn, `${BASE}/config-file?${q(id)}&scope=${encodeURIComponent(scope)}&reveal=${index}`),
  };
}

/** Parse one NDJSON line of the interaction channel; anything else is ignored. */
export function parseChannelLine(text: string): ChannelLine | undefined {
  const t = text.trim();
  if (t === '') return undefined;
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as { type?: unknown; asks?: unknown; state?: unknown };
  if (o.type === 'ping') return { type: 'ping' };
  if (o.type !== 'asks' || !Array.isArray(o.asks)) return undefined;
  const asks = o.asks.filter(
    (a): a is AskWire =>
      typeof a === 'object' &&
      a !== null &&
      typeof (a as AskWire).id === 'string' &&
      typeof (a as AskWire).kind === 'string' &&
      Array.isArray((a as AskWire).choices),
  );
  const line: ChannelLine = { type: 'asks', asks };
  if (typeof o.state === 'object' && o.state !== null) line.state = o.state as SessionViewWire['state'];
  // The live line (mode, notice): a command's answer shows without waiting for the next read.
  const live = (v as { live?: unknown }).live;
  if (typeof live === 'object' && live !== null && !Array.isArray(live)) line.live = live as SessionViewWire['live'];
  return line;
}

/** Split a byte stream into text lines. Ends when the stream ends or `signal` aborts. */
export async function readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onLine: (line: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener('abort', cancel, { once: true });
  let buf = '';
  try {
    for (;;) {
      if (signal.aborted) return;
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        onLine(line);
      }
    }
    buf += dec.decode();
    if (buf.trim() !== '') onLine(buf);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
