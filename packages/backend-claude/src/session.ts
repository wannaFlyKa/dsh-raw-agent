// One live Claude Code session: a persistent SDK `query()` in streaming-input mode (D4).
// Stop is `interrupt()` only (rule 6); the process ends only on forceStop or dispose.

import { randomUUID } from 'node:crypto';
import {
  AsyncQueue,
  SentInputTracker,
  type AgentBackendSession,
  type BackendCapabilities,
  type BackendControls,
  type BackendEvent,
  type AgentInfo,
  type EffortState,
  type FileRewindResult,
  type ModelInfo,
  type TaskOutput,
  type UserInput,
} from '@dsh-raw-agent/core';
import { ClaudeMessageMapper } from './mapper.js';
import { UsageLedger, parseContextUsage } from './usage.js';
import type { Options, Query, SDKUserMessage } from './sdk.js';
import { planChoices } from './interactions.js';
import { AskContext } from './ask-context.js';
import { withSdkVersionEnvRestored } from './env.js';
import {
  describeExit,
  dropsTurnRefusal,
  refusalInText,
  refusalNote,
  withPreview,
  toFileRewindResult,
  type ProcessExit,
} from './lifecycle.js';
import type { WorkflowRunsOptions } from './workflows.js';
import {
  MCP_TOGGLE_NOTE,
  sideHistoryWire,
  skillList,
  slashCommandOf,
  toMcpAuthStart,
  toMcpServerList,
  toSideAnswer,
} from './commands.js';

export type QueryFn = (params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface ClaudeSessionInit {
  kind: string;
  sessionId: string;
  startedAs: AgentBackendSession['startedAs'];
  options: Options;
  queryFn: QueryFn;
  /** The plugin's bypass switch is on (D14): the process was started with the CLI's allow flag. */
  bypassOption: boolean;
  /** The mode ids the CLI knows (D38); `setPermissionMode` refuses others before calling it. */
  modeIds?: readonly string[];
  /** Called once the CLI has died, so the factory can clean up its process group (D8). */
  onExit?: (error?: string) => void;
  /**
   * The mode the process started in, when the CLI has not reported one yet. A mode set right
   * after the spawn (a restored choice, a pick before the first message) comes before the CLI's
   * first `init`, so without it the pre-plan mode of a plan begun there would be lost (D42).
   */
  startMode?: () => Promise<string | undefined>;
  /** Kills the CLI's process group (force stop). */
  killGroup?: () => void;
  now?: () => number;
  debug?: (note: string, detail: unknown) => void;
  /**
   * D49: the CLI's `projects` folder. Workflow transcript folders are read (tailed) only when
   * they lie under it. Absent: no live workflow-agent output.
   */
  projectsDir?: string;
  /** Test seams for the workflow transcript poll. */
  workflowFs?: WorkflowRunsOptions['fs'];
  workflowTimers?: WorkflowRunsOptions['timers'];
  /**
   * D29 (r3): the same start without `resumeDropsTurn`. Set only when `options` carries a
   * validated cut; used once, when the CLI refuses that cut (the plain cut at the same point).
   */
  fallbackOptions?: Options;
  /** D30: restore the files to before this input ran, on this process, before its first turn. */
  restoreFilesAt?: string;
  /** R3.6: how the CLI process ended (exit code, signal, the end of its stderr). */
  exitInfo?: () => Promise<ProcessExit | undefined>;
  /** M8: a new process replaces the old one (D29 plain restart); its exit is the one to report. */
  newProcess?: () => void;
}

/**
 * D37: the flag settings for an effort id, as the terminal app's `/effort` sets them (CLI
 * 2.1.318 binary; live M4 probe U). `ultracode` is the app's `/effort ultracode`: ultracode on,
 * effort unchanged. A level is `/effort <level>`: only the level; the CLI itself turns ultracode
 * off when the level changes ("· Ultracode off"). `null` (back to my settings) clears both from
 * the session's flag layer.
 */
export function effortFlags(effortId: string | null): Record<string, unknown> {
  if (effortId === null) return { effortLevel: null, ultracode: null };
  if (effortId === 'ultracode') return { ultracode: true };
  return { effortLevel: effortId };
}

/**
 * `@"<path>"` is the TUI's own attach mechanism (D23). The CLI's mention parser (CLI 2.1.318
 * binary, fn `k0r`) reads `@"…"` only at the start or after whitespace, and the quoted path cannot
 * hold `"`. A path with `"` but no whitespace uses the bare `@path` form (fn `CIn`); a path with
 * both cannot be referenced, so the send fails rather than drop the user's file.
 */
export function fileReference(hostPath: string): string {
  if (!hostPath.includes('"')) return `@"${hostPath}"`;
  if (!/\s/.test(hostPath) && !hostPath.startsWith('"')) return `@${hostPath}`;
  throw new Error(`cannot attach ${JSON.stringify(hostPath)}: its path holds both a space and a double quote`);
}

/**
 * Build the SDK user message for one input (D23, D27). Parts keep their order: text and file
 * references join into one text block (a file reference is set off by whitespace, as the CLI's
 * parser needs), and each image is a base64 image block, as the TUI sends a pasted image.
 */
export function toSdkUserMessage(input: UserInput, mode: 'next' | 'queue'): SDKUserMessage {
  const content: Array<Record<string, unknown>> = [];
  let text = '';
  let afterFile = false;
  const flushText = () => {
    if (text !== '') content.push({ type: 'text', text });
    text = '';
    afterFile = false;
  };
  for (const part of input.parts) {
    if (part.type === 'text') {
      if (afterFile && part.text !== '' && !/^\s/.test(part.text)) text += ' ';
      text += part.text;
      if (part.text !== '') afterFile = false;
    } else if (part.type === 'file') {
      text += (text === '' || /\s$/.test(text) ? '' : ' ') + fileReference(part.hostPath);
      afterFile = true;
    } else {
      flushText();
      content.push({ type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.base64 } });
    }
  }
  flushText();
  const msg: Record<string, unknown> = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: input.id,
    origin: { kind: 'human' },
  };
  if (mode === 'next') msg.priority = 'next'; // never 'now' (D27)
  return msg as unknown as SDKUserMessage;
}

type Loose = Record<string, unknown>;

/** The SDK's usage control (SDK/sdk.d.ts:3155-3172). Experimental: called only through `optionalControl`. */
const USAGE_CONTROL = 'usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET';

/** Call an optional control; `undefined` when this CLI or SDK lacks it (D9). */
async function optionalControl<T>(q: Query, name: string, ...args: unknown[]): Promise<T | undefined> {
  const fn = (q as unknown as Loose)[name];
  if (typeof fn !== 'function') return undefined;
  try {
    return (await (fn as (...a: unknown[]) => Promise<T>).apply(q, args)) as T;
  } catch (e) {
    if (isUnsupported(e)) return undefined;
    throw e;
  }
}

/** D9: an older CLI answers a control it does not know with this text (sdk-surface answer 1). */
function isUnsupported(e: unknown): boolean {
  return /Unsupported control request subtype/.test(String((e as Error)?.message ?? e));
}

/** Whether this SDK's Query has the method at all (D9: every control is optional). */
function hasControl(q: Query, name: string): boolean {
  return typeof (q as unknown as Loose)[name] === 'function';
}

export class ClaudeBackendSession implements AgentBackendSession {
  readonly kind: string;
  readonly startedAs: AgentBackendSession['startedAs'];
  readonly capabilities: BackendCapabilities;
  readonly controls: BackendControls;

  #sessionId: string;
  #input = new AsyncQueue<SDKUserMessage>();
  readonly #events = new AsyncQueue<BackendEvent>();
  readonly #tracker = new SentInputTracker();
  readonly #mapper: ClaudeMessageMapper;
  /** The live query. Replaced once at most, after a refused fork cut (D29). */
  #query: Query;
  /** Every control goes through this, so it follows a replaced query. */
  readonly #q: Query;
  /**
   * D29: while a validated fork cut may still be refused, the messages sent so far, so the plain
   * restart gets them again (the refused process never ran them). Undefined once disarmed.
   */
  #forkGuard: SDKUserMessage[] | undefined;
  /** D30: sends wait for the file restore, so the first turn sees the restored files. */
  #ready: Promise<void> = Promise.resolve();
  /**
   * M8: settles when a refusal restart replaces `#ready`. A send that waits on the refused
   * process's restore moves on at once, even when that control never answers.
   */
  #readyReplaced: Promise<void>;
  #replaceReady: () => void = () => {};
  /**
   * D29, D35 (M7 live): the session choices sent to this process (model, effort, ultracode,
   * mode), in order. A plain restart after a refused cut is a new process on the user's
   * settings, so it gets them again before any input.
   */
  #choices = new Map<string, () => Promise<void>>();
  #remember(key: string, again: () => Promise<void>): void {
    this.#choices.delete(key);
    this.#choices.set(key, again);
  }
  /** Why we ended the process, when we did (R3.6). */
  #asked: 'disposed' | 'force-stopped' | undefined;
  readonly #init: ClaudeSessionInit;
  readonly #asks = new AskContext();
  #cliVersion: string | undefined;
  #exited = false;
  readonly #pump: Promise<void>;

  constructor(init: ClaudeSessionInit) {
    this.#init = init;
    this.#readyReplaced = this.#nextReadyEpoch();
    this.kind = init.kind;
    this.#sessionId = init.sessionId;
    this.startedAs = init.startedAs;
    const mapperOpts: ConstructorParameters<typeof ClaudeMessageMapper>[1] = {};
    if (init.now) mapperOpts.now = init.now;
    if (init.debug) mapperOpts.debug = init.debug;
    // D49: live workflow-agent output is polled from the transcript files and pushed here.
    const projectsDir = init.projectsDir;
    const workflows: NonNullable<typeof mapperOpts.workflows> = {
      emit: (events) => {
        if (this.#exited) return;
        for (const e of events) this.#events.push(e);
      },
      projectsDir: () => projectsDir,
    };
    if (init.workflowFs) workflows.fs = init.workflowFs;
    if (init.workflowTimers) workflows.timers = init.workflowTimers;
    mapperOpts.workflows = workflows;
    const ledgerOpts: ConstructorParameters<typeof UsageLedger>[0] = { startedAs: init.startedAs };
    if (init.now) ledgerOpts.now = init.now;
    mapperOpts.usage = new UsageLedger(ledgerOpts);
    this.#mapper = new ClaudeMessageMapper(this.#tracker, mapperOpts);
    this.capabilities = {
      perTaskStop: true,
      sideQuestions: false,
      workflows: true,
      workflowAgentStop: false,
      teamMessaging: false,
      cancelQueued: true,
      fileRewind: init.options.enableFileCheckpointing === true,
      planChoices: planChoices({ canBypass: init.bypassOption }),
      toolViewPack: init.kind,
    };
    if (init.fallbackOptions) this.#forkGuard = [];
    this.#query = withSdkVersionEnvRestored(() => init.queryFn({ prompt: this.#input, options: init.options }));
    this.#q = new Proxy({} as Query, {
      get: (_t, key) => {
        const cur = this.#query as unknown as Record<string | symbol, unknown>;
        const v = cur[key];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(cur) : v;
      },
    });
    // D54, D9: `/btw` needs the undeclared `askSideQuestion`; an older CLI's refusal turns it off.
    this.capabilities.sideQuestions = hasControl(this.#query, 'askSideQuestion');
    this.controls = this.#makeControls();
    this.#pump = this.#run();
    void this.#prime();
    if (init.restoreFilesAt !== undefined) this.#ready = this.#restoreFiles(init.restoreFilesAt);
  }

  /**
   * D30: a rewind fork's "restore code". `rewindFiles` on this (new) process, before any input is
   * sent. The outcome is an event; a failure never blocks the conversation.
   */
  async #restoreFiles(inputId: string): Promise<void> {
    const query = this.#query;
    let result: FileRewindResult;
    if (!this.capabilities.fileRewind)
      result = { ok: false, filesChanged: [], error: 'file checkpoints are off for this session' };
    else
      try {
        result = await this.#rewindFiles(inputId, false);
      } catch (e) {
        result = { ok: false, filesChanged: [], error: String((e as Error)?.message ?? e) };
      }
    // A refused process's outcome is dropped (M8): the plain restart restores again and reports.
    if (!this.#exited && this.#query === query) this.#events.push({ type: 'files-rewound', inputId, result });
  }

  #nextReadyEpoch(): Promise<void> {
    return new Promise<void>((resolve) => (this.#replaceReady = resolve));
  }

  async #rewindFiles(inputId: string, dryRun: boolean): Promise<FileRewindResult> {
    const fn = (this.#q as unknown as Loose).rewindFiles;
    if (typeof fn !== 'function') throw new Error('this Claude Code version cannot restore files');
    const call = fn as (id: string, o?: { dryRun?: boolean }) => Promise<unknown>;
    try {
      if (dryRun) return toFileRewindResult(await call(inputId, { dryRun: true }), true);
      // The real restore names no files (CLI 2.1.318): a dry run first gives the list.
      let preview: FileRewindResult | undefined;
      try {
        preview = toFileRewindResult(await call(inputId, { dryRun: true }), true);
      } catch {
        preview = undefined;
      }
      const raw = await call(inputId, undefined);
      return withPreview(toFileRewindResult(raw, false), raw, preview);
    } catch (e) {
      if (isUnsupported(e)) throw new Error('this Claude Code version cannot restore files', { cause: e });
      throw e;
    }
  }

  /**
   * D58-D60, rule 9: read the auth type, the usage baseline (resumed totals) and the context
   * window from the live process right after spawn. Controls only: no model call, no extra
   * process. Each read is optional (D9); a failure only leaves that part unknown.
   */
  async #prime(): Promise<void> {
    const q = this.#q;
    const usage = this.#mapper.usage;
    const step = async (name: string, run: () => Promise<BackendEvent[] | void>) => {
      try {
        const evs = await run();
        if (evs && !this.#exited) for (const e of evs) this.#events.push(e);
      } catch (e) {
        this.#init.debug?.(`usage prime: ${name} failed`, String((e as Error)?.message ?? e));
      }
    };
    await step('initializationResult', async () => {
      const r = await optionalControl<Loose>(q, 'initializationResult');
      return r !== undefined && r.account !== undefined ? usage.account(r.account) : undefined;
    });
    await step('usage', async () => {
      const r = await optionalControl<Loose>(q, USAGE_CONTROL, { skipBehaviors: true });
      return r === undefined ? undefined : usage.usageControl(r);
    });
    await step('getContextUsage', async () => {
      const r = await optionalControl<Loose>(q, 'getContextUsage', { detail: 'summary' });
      if (r !== undefined) usage.contextReport(parseContextUsage(r));
    });
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  get cliVersion(): string | undefined {
    return this.#cliVersion;
  }

  /**
   * D77: the label of a child agent for an ask: the child's name or task description from the
   * spawning call (a teammate's name), else the frame's `subagent_type: task_description`.
   */
  agentLabel(agentId: string): string | undefined {
    return (
      this.#mapper.children.label(agentId) ?? this.#mapper.workflows.label(agentId) ?? this.#asks.agentLabel(agentId)
    );
  }

  /** What the interaction adapter reads about the live session (D42, D43, D44, D77). */
  get asks(): AskContext {
    return this.#asks;
  }

  /**
   * The CLI allows bypass when it was started with the allow flag (our switch) or started in
   * bypass mode (the user's settings `defaultMode`), D14 / sdk-surface answer 13.
   */
  get canBypass(): boolean {
    return this.#init.bypassOption || this.#asks.startMode === 'bypassPermissions';
  }

  events(): AsyncIterable<BackendEvent> {
    return this.#events;
  }

  async #run(): Promise<void> {
    let error: string | undefined;
    for (;;) {
      let refused: string | undefined;
      try {
        refused = await this.#drain(this.#query);
      } catch (e) {
        error = String((e as Error)?.message ?? e);
        // D29: a CLI that exits with the refusal instead of a result frame.
        if (this.#forkGuard !== undefined && this.#asked === undefined) {
          const proc = await this.#init.exitInfo?.();
          refused = refusalInText(error) ?? refusalInText(proc?.stderr);
        }
      }
      if (refused === undefined || this.#asked !== undefined) break;
      error = undefined;
      this.#restartPlain(refused);
    }
    this.#exited = true;
    const proc = this.#asked === undefined ? await this.#init.exitInfo?.() : undefined;
    const exit = describeExit({
      ...(this.#asked !== undefined ? { asked: this.#asked } : {}),
      ...(error !== undefined ? { sdkError: error } : {}),
      ...(proc !== undefined ? { proc } : {}),
    });
    for (const e of this.#mapper.exit(exit.error)) {
      if (e.type === 'exit') {
        e.reason = exit.reason;
        if (exit.code !== undefined) e.code = exit.code;
        if (exit.signal !== undefined) e.signal = exit.signal;
        if (exit.stderr !== undefined) e.stderr = exit.stderr;
      }
      this.#events.push(e);
    }
    this.#events.end();
    this.#input.end();
    this.#init.onExit?.(exit.error);
  }

  /**
   * D29 (r3): the CLI refused the validated cut. Never retried as is (the refusal is
   * deterministic): the same fork starts again with a plain cut at the same point, gets the
   * inputs the refused process never ran, and the user sees a note. The source is left alone.
   */
  #restartPlain(refusal: string): void {
    const sent = this.#forkGuard ?? [];
    this.#forkGuard = undefined;
    this.#init.debug?.('fork cut refused; restarting with a plain cut', refusal);
    this.#input.end();
    try {
      this.#query.close();
    } catch {
      // already closed
    }
    this.#input = new AsyncQueue<SDKUserMessage>();
    // The refused CLI's exit (it may close late) must never be reported as the new one's.
    this.#init.newProcess?.();
    const options = this.#init.fallbackOptions as Options;
    this.#query = withSdkVersionEnvRestored(() => this.#init.queryFn({ prompt: this.#input, options }));
    this.#events.push({ type: 'notice', level: 'warning', text: refusalNote(refusal) });
    void this.#prime();
    // The session choices go to the new process first, then the file restore, then the inputs
    // the refused process never ran (a later send waits on `#ready` and so comes after them).
    const again = [...this.#choices.values()];
    const restoreAt = this.#init.restoreFilesAt;
    this.#ready = (async () => {
      for (const f of again) {
        try {
          await f();
        } catch (e) {
          this.#init.debug?.('choice not applied again after the plain restart', String((e as Error)?.message ?? e));
        }
      }
      if (restoreAt !== undefined) await this.#restoreFiles(restoreAt);
    })();
    // A send waiting on the old `#ready` moves to the new one (set above) now.
    const replaced = this.#replaceReady;
    this.#readyReplaced = this.#nextReadyEpoch();
    replaced();
    const input = this.#input;
    void this.#ready.then(() => {
      for (const m of sent) input.push(m);
    });
  }

  /** Map one query's frames. Returns the refusal text when the CLI refused a validated cut. */
  async #drain(query: Query): Promise<string | undefined> {
    for await (const msg of query) {
      const m = msg as unknown as Loose;
      if (this.#forkGuard !== undefined) {
        const refusal = dropsTurnRefusal(msg);
        if (refusal !== undefined) return refusal;
        // The cut stood: a model reply or a turn result means the fork got past its boot check.
        if (m.type === 'result' || m.type === 'assistant') this.#forkGuard = undefined;
      }
      if (m.type === 'system' && m.subtype === 'init' && typeof m.claude_code_version === 'string') {
        this.#cliVersion = m.claude_code_version;
        this.capabilities.backendVersion = m.claude_code_version;
      }
      const closed = this.#asks.observe(msg);
      for (const e of this.#mapper.map(msg)) {
        // D70: the id the CLI now runs under (the mapper reads it from the frames, not the reset's).
        if (e.type === 'conversation-reset') this.#sessionId = e.newSessionId;
        this.#events.push(e);
      }
      for (const e of closed) this.#events.push(e);
    }
    return undefined;
  }

  async send(input: UserInput, mode: 'next' | 'queue'): Promise<void> {
    if (this.#exited) throw new Error('Claude Code is not running');
    // Build first: a message that cannot be built (an unreferenceable file path) must not stay
    // pending in the tracker, or every later turn end would wait for it (M1 verify 3-2).
    const message = toSdkUserMessage(input, mode);
    // D30: a rewind fork restores the files before the first turn sees them.
    // A refusal restart replaces `#ready` while we wait (the old one may never settle: a refused
    // process need not answer its controls); wait on the new one until it stays (M8).
    for (;;) {
      const ready = this.#ready;
      await Promise.race([ready.catch(() => undefined), this.#readyReplaced]);
      if (ready === this.#ready) break;
    }
    if (this.#exited) throw new Error('Claude Code is not running');
    this.#forkGuard?.push(message);
    // D52: a slash command is the plain text the user typed; only its name is noted, so a
    // local command output that carries no name of its own can be named (R7.2).
    this.#mapper.noteSlashCommand(slashCommandOf(input));
    this.#tracker.sent(input.id);
    this.#input.push(message);
  }

  /** A user answer that interrupts the turn (reject on the main agent): the next error result is a stop. */
  noteInterruptRequested(): void {
    this.#mapper.noteInterruptRequested();
  }

  async interrupt(opts?: { cancelQueued?: boolean }): Promise<{ cancelledInputIds: string[] }> {
    if (this.#exited) return { cancelledInputIds: [] };
    this.#mapper.noteInterruptRequested();
    const call = this.#q.interrupt as unknown as (o?: { cancelQueued?: boolean }) => Promise<unknown>;
    const receipt = (await call(opts?.cancelQueued ? { cancelQueued: true } : undefined)) as
      { still_queued?: string[]; cancelled?: string[] } | undefined;
    const cancelled = Array.isArray(receipt?.cancelled) ? receipt.cancelled : [];
    return { cancelledInputIds: this.#tracker.cancel(cancelled) };
  }

  async forceStop(): Promise<void> {
    this.#asked ??= 'force-stopped';
    this.#input.end();
    this.#query.close();
    this.#init.killGroup?.();
    await this.#pump;
  }

  async dispose(): Promise<void> {
    this.#asked ??= 'disposed';
    this.#mapper.workflows.dispose();
    this.#input.end();
    this.#query.close();
    await this.#pump;
  }

  #makeControls(): BackendControls {
    const q = this.#q;
    const controls: BackendControls = this.#baseControls();
    // D54, R7.3: `/btw`. Full context, no tools, nothing written to either transcript; answers
    // while a turn streams or a tool runs (sdk-surface §7.5). History is the caller's (D24).
    if (hasControl(q, 'askSideQuestion'))
      controls.askSideQuestion = async (question, history, signal) => {
        const ask = (q as unknown as Loose).askSideQuestion as (
          question: string,
          opts: { history?: unknown[]; signal?: AbortSignal },
        ) => Promise<unknown>;
        const opts: { history?: unknown[]; signal?: AbortSignal } = { signal };
        const wire = sideHistoryWire(history);
        if (wire.length > 0) opts.history = wire;
        try {
          return toSideAnswer(await ask.call(q, question, opts));
        } catch (e) {
          if (signal.aborted) return null;
          if (isUnsupported(e)) {
            this.capabilities.sideQuestions = false;
            throw new Error('this Claude Code version cannot answer side questions (/btw)', { cause: e });
          }
          throw e;
        }
      };
    // D55, R7.4: MCP status, reconnect and toggle (never `updateSettings`, rule 2).
    if (hasControl(q, 'mcpServerStatus'))
      controls.mcpStatus = async () => {
        const r = await optionalControl<unknown>(q, 'mcpServerStatus');
        if (r === undefined) throw new Error('this Claude Code version cannot report its MCP servers');
        return toMcpServerList(r);
      };
    if (hasControl(q, 'reconnectMcpServer'))
      controls.mcpReconnect = async (name) => {
        await this.#required('reconnectMcpServer', 'reconnect an MCP server', name);
      };
    if (hasControl(q, 'toggleMcpServer'))
      controls.mcpToggle = async (name, enabled) => {
        // The CLI saves `disabledMcpServers` for the project in ~/.claude.json, as /mcp does
        // (Phase 1 probe6 M): a CLI-owned write, like "always allow" (rule 2).
        await this.#required('toggleMcpServer', 'turn an MCP server on or off', name, enabled);
        return { note: MCP_TOGGLE_NOTE };
      };
    // Undeclared, not run live (**unverified**): no redirect address of ours, so the CLI uses its
    // own localhost callback, as the terminal app does.
    if (hasControl(q, 'mcpAuthenticate'))
      controls.mcpAuthenticate = async (name) =>
        toMcpAuthStart(await this.#required('mcpAuthenticate', 'sign in to an MCP server', name));
    if (hasControl(q, 'mcpSubmitOAuthCallbackUrl'))
      controls.mcpSubmitAuthCallback = async (name, callbackUrl) => {
        await this.#required('mcpSubmitOAuthCallbackUrl', 'finish an MCP sign-in', name, callbackUrl);
      };
    return controls;
  }

  /** Call a control this CLI must support; an older CLI's refusal becomes a plain error (D9). */
  async #required(name: string, what: string, ...args: unknown[]): Promise<unknown> {
    const fn = (this.#q as unknown as Loose)[name];
    if (typeof fn !== 'function') throw new Error(`this Claude Code version cannot ${what}`);
    try {
      return await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
    } catch (e) {
      if (isUnsupported(e)) throw new Error(`this Claude Code version cannot ${what}`, { cause: e });
      throw e;
    }
  }

  #baseControls(): BackendControls {
    const q = this.#q;
    return {
      // D30: the terminal app's "Restore code" (and its preview), on this process. Offered only
      // when the process keeps checkpoints (D16); the conversation is not touched.
      ...(this.capabilities.fileRewind
        ? {
            rewindFiles: async (inputId: string, opts?: { dryRun?: boolean }) =>
              this.#rewindFiles(inputId, opts?.dryRun === true),
          }
        : {}),
      stopTask: async (taskId) => {
        // D48: the CLI has no control to stop one workflow agent; `stopTask(<agent id>)` is
        // accepted and does nothing (live M4 probe X). Say so instead of a silent no-op.
        const run = this.#mapper.workflows.runOfAgent(taskId);
        if (run !== undefined)
          throw new Error('Claude Code cannot stop one agent of a workflow. Stop the whole workflow instead.');
        if (this.#mapper.workflows.isRun(taskId)) this.#mapper.workflows.noteStopRequested(taskId);
        await q.stopTask(taskId);
      },
      // D38: the CLI's `status.permissionMode` frame that follows is the truth; nothing here
      // reports a mode. Refused before the call: an unknown id, and bypass when this process
      // cannot bypass (the CLI would refuse it with "not launched with …").
      setPermissionMode: async (mode) => {
        const ids = this.#init.modeIds;
        if (ids && !ids.includes(mode)) throw new Error(`unknown permission mode: ${mode}`);
        if (mode === 'bypassPermissions' && !this.canBypass)
          throw new Error(
            'Bypass permissions is not available in this Claude Code process: it was started without the plugin option "Allow bypass permissions mode" (the same as `claude --allow-dangerously-skip-permissions`) and not in bypass mode. Turn the option on; it applies when Claude Code starts again.',
          );
        if (this.#asks.mode === undefined && this.#init.startMode)
          this.#asks.seedStartMode(await this.#init.startMode());
        // Remembered before the call: a process that refuses its fork cut never answers it.
        this.#remember('mode', () => q.setPermissionMode(mode as Parameters<Query['setPermissionMode']>[0]));
        await q.setPermissionMode(mode as Parameters<Query['setPermissionMode']>[0]);
      },
      setModel: async (model) => {
        this.#remember('model', () => q.setModel(model));
        await q.setModel(model); // never undefined (D35)
      },
      setEffort: async (effortId) => {
        const apply = () =>
          (q.applyFlagSettings as unknown as (s: Loose) => Promise<void>).call(q, effortFlags(effortId));
        this.#remember('effort', apply);
        await apply();
      },
      // D37: the terminal app's `/effort ultracode on|off` (and Tab in its effort slider): on or
      // off for this session, effort unchanged. The CLI refuses it when unavailable.
      setUltracode: async (on) => {
        const apply = () => (q.applyFlagSettings as unknown as (s: Loose) => Promise<void>).call(q, { ultracode: on });
        this.#remember('ultracode', apply);
        await apply();
      },
      // The CLI's own report (`getSettings().applied`, undeclared fields, D9). Read-only.
      effortState: async () => {
        const r = await optionalControl<Loose>(q, 'getSettings');
        if (r === undefined) throw new Error('this Claude Code version cannot report its settings');
        const applied = (r.applied ?? {}) as Loose;
        const state: EffortState = { ultracode: applied.ultracode === true };
        if (typeof applied.effort === 'string') state.effort = applied.effort;
        if (typeof applied.ultracodeRequested === 'boolean') state.ultracodeRequested = applied.ultracodeRequested;
        if (typeof applied.ultracodeAvailable === 'boolean') state.ultracodeAvailable = applied.ultracodeAvailable;
        return state;
      },
      models: async () => {
        const list = await q.supportedModels();
        return list.map((m) => {
          const info: ModelInfo = {
            value: m.value,
            displayName: m.displayName,
          };
          if (m.description) info.description = m.description;
          const efforts = (m as unknown as Loose).supportedEffortLevels;
          if (Array.isArray(efforts)) info.efforts = efforts.map(String);
          const auto = (m as unknown as Loose).supportsAutoMode;
          if (typeof auto === 'boolean') info.supportsAutoMode = auto;
          return info;
        });
      },
      agents: async () => {
        const list = await q.supportedAgents();
        return list.map((a) => {
          const info: AgentInfo = { name: a.name };
          if (a.description) info.description = a.description;
          if (typeof a.model === 'string' && a.model !== '') info.model = a.model;
          return info;
        });
      },
      // R7.1, D52: the CLI's own list (the latest `commands_changed` push, SDK/sdk.mjs), with
      // the `init` skill and terminal-only names marked. Names are kept byte for byte.
      commands: async () => this.#mapper.commands.rows(await q.supportedCommands()),
      // R7.5: the `init` skill names (or the `/context` skill rows before `init`) with their
      // command rows. The context read is 'summary': no token-count calls, no model turn (M5).
      skills: async () => {
        const catalog = this.#mapper.commands;
        const commands = catalog.rows(await q.supportedCommands());
        let fromContext: ReturnType<typeof parseContextUsage>['details'];
        try {
          const r = await optionalControl<Loose>(q, 'getContextUsage', { detail: 'summary' });
          if (r !== undefined) fromContext = parseContextUsage(r).details;
        } catch (e) {
          this.#init.debug?.('skills: getContextUsage failed', String((e as Error)?.message ?? e));
        }
        return skillList(catalog, commands, fromContext?.skills);
      },
      // The end of a background shell or Monitor output, as the TUI's /tasks view reads it
      // (undeclared `getTaskOutput`, D9; live M3 probe B). Read-only, no model turn.
      taskOutput: async (taskId) => {
        if (this.#mapper.workflows.isRun(taskId) || this.#mapper.workflows.isAgent(taskId))
          throw new Error(
            'Claude Code keeps task output only for background shells and monitors; a workflow shows its agents instead',
          );
        const r = await optionalControl<Loose>(q, 'getTaskOutput', taskId);
        if (r === undefined) throw new Error('this Claude Code version cannot read task output');
        const out: TaskOutput = {
          output: typeof r.output === 'string' ? r.output : '',
          totalBytes: typeof r.total_bytes === 'number' ? r.total_bytes : 0,
          truncated: r.truncated === true,
        };
        return out;
      },
      // D59: Claude's own breakdown (`/context`). 'summary' makes no token-count calls.
      contextUsage: async (detail) => {
        const r = await optionalControl<Loose>(q, 'getContextUsage', { detail });
        if (r === undefined) throw new Error('this Claude Code version cannot report its context usage');
        const out = parseContextUsage(r);
        this.#mapper.usage.contextReport(out);
        return out;
      },
      // D58, D60: totals, cost label, auth and plan limits. The usage control is experimental
      // (its name says so); without it the snapshot holds what the stream reported.
      usageSnapshot: async () => {
        const usage = this.#mapper.usage;
        const r = await optionalControl<Loose>(q, USAGE_CONTROL, { skipBehaviors: true });
        if (r !== undefined && !this.#exited) for (const e of usage.usageControl(r)) this.#events.push(e);
        return usage.snapshot();
      },
    };
  }
}

export const newRequestId = (): string => randomUUID();
