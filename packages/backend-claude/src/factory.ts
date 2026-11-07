// The Claude Code backend factory (D80). Pre-spawn capabilities are static data here (r4).

import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type {
  AgentBackendFactory,
  AgentRef,
  BackendEvent,
  AgentBackendSession,
  ConfigFileInfo,
  FactoryCapabilities,
  MaskedConfig,
  OpenSessionOptions,
  SessionTail,
  SettingsDefaults,
  TrustState,
} from '@dsh-raw-agent/core';
import { uuidv5 } from '@dsh-raw-agent/core/node';
import { resolveClaudeBinary, type BinaryResolveDeps } from './binary.js';
import { claudeConfigDir, decideFileCheckpointing } from './checkpoint.js';
import { claudeConfigFiles, maskClaudeSettings } from './config-files.js';
import { buildClaudeEnv } from './env.js';
import {
  createCanUseTool,
  createOnElicitation,
  MODE_DESCRIPTIONS,
  type InteractionAdapterOptions,
} from './interactions.js';
import { loadSdk } from './sdk.js';
import { ClaudeBackendSession, newRequestId, type QueryFn } from './session.js';
import { createSpawner } from './spawn.js';
import { ALLOW_BYPASS_OPTION, buildStartOptions } from './start-options.js';
import { readSettingsDefaults } from './settings-defaults.js';
import { readTrustState } from './trust.js';
import {
  readSessionMainAgent,
  transcriptEvents,
  transcriptPaths,
  type TranscriptMessage,
  type TranscriptReadDeps,
} from './transcripts.js';
import { checkDropsTurn, FORK_SCAN_LIMIT_BYTES } from './lifecycle.js';
import type { SpawnerOptions } from './spawn.js';
import { sessionTail } from './session-tail.js';

export const CLAUDE_KIND = 'claude-code';

/** Fixed namespace for D5 ids. Never change it: existing sessions are found by it. */
export const ID_NAMESPACE = '5f0c3b9e-6f1d-5a8e-9c42-7d2e1a4b8c60';

export const CLAUDE_STATIC_CAPABILITIES: FactoryCapabilities = Object.freeze({
  ids: 'host-chosen',
  resume: true,
  fork: 'at-chain-point',
  userOptions: [
    {
      key: ALLOW_BYPASS_OPTION,
      type: 'boolean',
      label: 'Allow bypass permissions mode (same as `claude --allow-dangerously-skip-permissions`)',
      description:
        'Off by default. Lets you switch a session to bypass permissions (no further prompts). As with the terminal flag, plan mode then no longer asks before edits. Applies when Claude Code starts.',
      default: false,
    },
  ],
  needsProcess: ['agents', 'commands', 'side-question', 'mcp', 'context', 'usage', 'task-actions'],
  sideQuestionCommand: 'btw',
  mcpCommand: 'mcp',
  rewindCommand: 'rewind',
  // Labels are ours (short picker names); descriptions are the CLI's own (MODE_DESCRIPTIONS).
  permissionModes: [
    { id: 'default', label: 'Ask before edits', description: MODE_DESCRIPTIONS.default },
    { id: 'acceptEdits', label: 'Accept edits', description: MODE_DESCRIPTIONS.acceptEdits },
    { id: 'plan', label: 'Plan mode', description: MODE_DESCRIPTIONS.plan },
    { id: 'auto', label: 'Auto', description: MODE_DESCRIPTIONS.auto },
    { id: 'dontAsk', label: "Don't ask", description: MODE_DESCRIPTIONS.dontAsk },
    {
      id: 'bypassPermissions',
      label: 'Bypass permissions',
      description: MODE_DESCRIPTIONS.bypassPermissions,
      requiresOption: ALLOW_BYPASS_OPTION,
    },
  ],
  // The TUI's Shift+Tab ring (CLI 2.1.318 binary fn `uhn`): default → acceptEdits → plan →
  // bypassPermissions (when available) → auto (when available) → default; dontAsk → default.
  permissionModeCycle: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'],
  mainAgentPicker: 'new-session-only',
  efforts: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max' },
    // D37: the TUI's `/effort ultracode`: a session mode at any effort level (CLI 2.1.318 binary:
    // "Ultracode (any effort level, this session only)", "Enable ultracode for the session:
    // standing dynamic-workflow orchestration at any effort level").
    {
      id: 'ultracode',
      label: 'Ultracode',
      kind: 'mode',
      description: 'Standing dynamic-workflow orchestration, at any effort level. This session only.',
    },
  ],
  steer: 'native',
}) as FactoryCapabilities;

/** D13: what the CLI writes previews in. The user's own env value wins; never html by us. */
export function questionPreviewFormat(env: Readonly<Record<string, string | undefined>>): 'markdown' | 'html' {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT');
  return key !== undefined && env[key]?.trim().toLowerCase() === 'html' ? 'html' : 'markdown';
}

export const nodeBinaryDeps = (env: OpenSessionOptions['env']): BinaryResolveDeps => ({
  env,
  platform: process.platform,
  homedir: homedir(),
  isExecutable(p) {
    try {
      if (!statSync(p).isFile()) return false;
      if (process.platform !== 'win32') accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readText(p) {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
});

export interface ClaudeFactoryOptions {
  /** Test seam; defaults to the SDK's `query`, loaded on the first spawn (`loadSdk`). */
  queryFn?: QueryFn;
  debug?: (note: string, detail: unknown) => void;
  /**
   * The env the no-process reads use (config folder, sandbox marker). Defaults to the DSH
   * process env at call time, filtered by the env policy, as the CLI would see it.
   */
  env?: () => Readonly<Record<string, string | undefined>>;
  /** Test seam for the no-process reads. */
  fs?: {
    readText(p: string): string | undefined;
    realpath(p: string): string;
    exists(p: string): boolean;
    readHead?(p: string, maxBytes: number): string | undefined;
    listDir?(p: string): string[];
    /** File size in bytes, or undefined when missing. */
    size?(p: string): number | undefined;
  };
  /** D75 orphan guard and spawn seams (tests). */
  spawner?: SpawnerOptions;
  homedir?: string;
  /** Test seam for `readAgentTranscript`; defaults to the SDK's `getSubagentMessages` (a file read). */
  subagentMessages?: (sessionId: string, agentId: string, cwd: string) => Promise<TranscriptMessage[]>;
}

/** The first `maxBytes` of a file, without reading the rest (transcripts can be large). */
export function readFileHead(p: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(Math.max(0, maxBytes));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function listDir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}

const nodeFs = {
  readText(p: string): string | undefined {
    try {
      return readFileSync(p, 'utf8');
    } catch {
      return undefined;
    }
  },
  realpath(p: string): string {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  },
  exists(p: string): boolean {
    return existsSync(p);
  },
  size(p: string): number | undefined {
    try {
      return statSync(p).size;
    } catch {
      return undefined;
    }
  },
};

/** D70 (M7): how many of a folder's newest transcripts `sessionHoldingInput` reads at most. */
const INPUT_SCAN_FILES = 64;

export function createClaudeFactory(factoryOptions: ClaudeFactoryOptions = {}): AgentBackendFactory {
  const readEnv = () => buildClaudeEnv(factoryOptions.env ? factoryOptions.env() : process.env).env;
  const fs: NonNullable<ClaudeFactoryOptions['fs']> = factoryOptions.fs ?? nodeFs;
  const home = () => factoryOptions.homedir ?? homedir();
  const readDefaults = async (cwd: string): Promise<SettingsDefaults> => {
    const env = readEnv();
    const files = claudeConfigFiles(cwd, { env, platform: process.platform, homedir: home() });
    return readSettingsDefaults(files, (p) => fs.readText(p), env);
  };
  const transcriptDeps = (env: TranscriptReadDeps['env'] = readEnv()): TranscriptReadDeps => ({
    env,
    platform: process.platform,
    homedir: home(),
    realpath: (p) => fs.realpath(p),
    exists: (p) => fs.exists(p),
    readHead: fs.readHead ?? readFileHead,
    listDir: fs.listDir ?? listDir,
  });
  /** D28: the CLI's transcript for a session, when one exists (a file check, no process). */
  const transcriptFile = (sessionId: string, cwd: string, env?: TranscriptReadDeps['env']): string | undefined =>
    transcriptPaths(sessionId, cwd, transcriptDeps(env)).find((p) => fs.exists(p));
  /**
   * D29 (r3): pass the hint as `resumeDropsTurn` only when the source transcript shows exactly
   * that one turn past the cut. A missing, too large or unreadable transcript gives a plain cut.
   */
  const validatedDropsTurn = (
    start: Extract<OpenSessionOptions['start'], { kind: 'fork' }>,
    cwd: string,
    env: TranscriptReadDeps['env'],
  ): string | undefined => {
    const hint = start.dropsTurnHint;
    if (start.atChainId === undefined || hint === undefined) return undefined;
    const file = transcriptFile(start.fromSessionId, cwd, env);
    if (file === undefined) return undefined;
    const size = (fs.size ?? nodeFs.size)(file);
    if (size !== undefined && size > FORK_SCAN_LIMIT_BYTES) return undefined;
    const text = fs.readText(file);
    if (text === undefined) return undefined;
    const check = checkDropsTurn(text, start.atChainId, hint);
    factoryOptions.debug?.('fork cut check', check);
    return check.validated ? hint : undefined;
  };
  return {
    kind: CLAUDE_KIND,
    displayName: 'Claude Code',
    staticCapabilities: CLAUDE_STATIC_CAPABILITIES,
    sessionIdFor: (hostSessionId) => uuidv5(ID_NAMESPACE, `session:${hostSessionId}`),
    inputIdFor: (hostMessageId) => uuidv5(ID_NAMESPACE, `input:${hostMessageId}`),

    // No-process reads (D83). None starts a process or writes a file.
    async configFiles(cwd: string): Promise<ConfigFileInfo[]> {
      return claudeConfigFiles(cwd, { env: readEnv(), platform: process.platform, homedir: home() });
    },
    maskConfig(file: { path: string; format: string }, text: string): MaskedConfig {
      return maskClaudeSettings(file, text);
    },
    async settingsDefaults(cwd: string): Promise<SettingsDefaults> {
      return readDefaults(cwd);
    },
    async trustState(cwd: string): Promise<TrustState> {
      return readTrustState(cwd, { env: readEnv(), platform: process.platform, homedir: home(), ...fs });
    },
    // D15 (r4): the agent the session was started with, so a resume passes the same `agent`.
    async sessionMainAgent(sessionId: string, cwd: string): Promise<string | undefined> {
      return readSessionMainAgent(sessionId, cwd, transcriptDeps());
    },
    // D28 (r3): a resume candidate is real only when the CLI wrote its transcript (D5 derived
    // ids, a /clear id after a restart, D70). A plain file check, as `getSessionInfo` does.
    async sessionExists(sessionId: string, cwd: string): Promise<boolean> {
      return transcriptFile(sessionId, cwd) !== undefined;
    },
    // D28, D70 (M7 live): after `/clear` the CLI runs under a new id whose transcript starts with
    // the typed command (its `uuid` is our input id); the host has no step to bind that id to.
    // A file read: the preferred transcript first, then the newest ones in the same folder.
    async sessionHoldingInput(inputId: string, cwd: string, prefer?: string): Promise<string | undefined> {
      const needle = `"uuid":"${inputId}"`;
      const holds = (file: string): string | undefined => {
        const size = (fs.size ?? nodeFs.size)(file);
        if (size !== undefined && size > FORK_SCAN_LIMIT_BYTES) return undefined;
        const text = fs.readText(file);
        if (text === undefined || !text.includes(needle)) return undefined;
        for (const line of text.split('\n')) {
          if (!line.includes(needle)) continue;
          try {
            const d = JSON.parse(line) as { type?: unknown; uuid?: unknown; sessionId?: unknown };
            if (d.type === 'user' && d.uuid === inputId)
              return typeof d.sessionId === 'string' ? d.sessionId : path.basename(file, '.jsonl');
          } catch {
            // a half-written line
          }
        }
        return undefined;
      };
      const preferred = prefer === undefined ? undefined : transcriptFile(prefer, cwd);
      if (preferred !== undefined) {
        const hit = holds(preferred);
        if (hit !== undefined) return hit;
      }
      const deps = transcriptDeps();
      const dirs = [...new Set(transcriptPaths(prefer ?? inputId, cwd, deps).map((p) => path.dirname(p)))];
      for (const dir of dirs) {
        const files = deps
          .listDir(dir)
          .filter((n) => n.endsWith('.jsonl'))
          .map((n) => path.join(dir, n))
          .filter((p) => p !== preferred);
        const mtime = (p: string) => {
          try {
            return statSync(p).mtimeMs;
          } catch {
            return 0;
          }
        };
        files.sort((a, b) => mtime(b) - mtime(a));
        for (const file of files.slice(0, INPUT_SCAN_FILES)) {
          const hit = holds(file);
          if (hit !== undefined) return hit;
        }
      }
      return undefined;
    },
    // M7 (R3.6): the main-thread entries past the host log's chain point, from the CLI's own
    // transcript (a file read, no process). The host shows what it never got.
    async readSessionTail(sessionId: string, cwd: string, afterChainId: string): Promise<SessionTail> {
      const empty = { events: [], prompts: [], notes: [], orphanResults: 0 };
      const file = transcriptFile(sessionId, cwd);
      if (file === undefined) return { status: 'no-record', ...empty };
      const size = (fs.size ?? nodeFs.size)(file);
      if (size !== undefined && size > FORK_SCAN_LIMIT_BYTES) return { status: 'too-large', ...empty };
      const text = fs.readText(file);
      if (text === undefined) return { status: 'no-record', ...empty };
      const { found, ...rest } = sessionTail(text, afterChainId, Date.now());
      return found ? { status: 'found', ...rest } : { status: 'no-cut', ...empty };
    },
    // D16, D30: what `open()` would decide for checkpoints, for the rewind dialog.
    async fileRewindAvailable(cwd: string): Promise<boolean> {
      const env = readEnv();
      return decideFileCheckpointing({
        env,
        platform: process.platform,
        homedir: home(),
        cwd,
        readText: (p) => fs.readText(p),
      }).enabled;
    },
    // D49, D50: a child's transcript (SDK `getSubagentMessages`, a file read; no process).
    async readAgentTranscript(sessionId: string, ref: AgentRef, cwd: string): Promise<BackendEvent[]> {
      if (ref.kind !== 'child') return [];
      const read =
        factoryOptions.subagentMessages ??
        (async (sid: string, agentId: string, dir: string) =>
          (await (await loadSdk()).getSubagentMessages(sid, agentId, { dir })) as unknown as TranscriptMessage[]);
      return transcriptEvents(ref, await read(sessionId, ref.id, cwd), Date.now());
    },

    async open(o: OpenSessionOptions): Promise<AgentBackendSession> {
      // Read at every spawn, so a changed path applies to the next spawn only (D87).
      const bin = resolveClaudeBinary(o.userConfig.executablePath, nodeBinaryDeps(o.env));
      const { env } = buildClaudeEnv(o.env);
      const deps = nodeBinaryDeps(o.env);
      const checkpoint = decideFileCheckpointing({
        env,
        platform: process.platform,
        homedir: deps.homedir,
        cwd: o.cwd,
        readText: deps.readText,
      });
      const spawner = createSpawner(env, process.platform, factoryOptions.spawner);
      const abortController = new AbortController();
      o.signal.addEventListener('abort', () => abortController.abort(), { once: true });

      const queryFn = factoryOptions.queryFn ?? ((await loadSdk()).query as unknown as QueryFn);
      const ref: { session?: ClaudeBackendSession } = {};
      const bypassOption = o.userConfig.options[ALLOW_BYPASS_OPTION] === true;
      const adapter: InteractionAdapterOptions = {
        handler: o.interactions,
        cliVersion: () => ref.session?.cliVersion,
        // The option, or a process that started in bypass (the user's settings), D14.
        canBypass: () => ref.session?.canBypass ?? bypassOption,
        newId: newRequestId,
        prePlanMode: () => ref.session?.asks.prePlanMode,
        agentLabel: (id) => ref.session?.agentLabel(id),
        elicitationAgent: (server) => ref.session?.asks.elicitationAgent(server),
        rememberElicitation: (eid, id) => ref.session?.asks.rememberElicitation(eid, id),
        forgetElicitation: (eid) => ref.session?.asks.forgetElicitation(eid),
        previewFormat: () => questionPreviewFormat(env),
        onInterruptingDeny: () => ref.session?.noteInterruptRequested(),
      };
      if (factoryOptions.debug) {
        const debug = factoryOptions.debug;
        adapter.warn = (text) => debug('interaction', text);
      }
      const startInput: Parameters<typeof buildStartOptions>[0] = {
        executablePath: bin.path,
        cwd: o.cwd,
        env,
        start: o.start,
        userOptions: o.userConfig.options,
        fileCheckpointing: checkpoint.enabled,
        canUseTool: createCanUseTool(adapter),
        onElicitation: createOnElicitation(adapter),
        spawn: spawner.spawn,
        abortController,
      };
      if (o.trustAccepted) startInput.trustAccepted = o.trustAccepted;
      let start = o.start;
      // D28, D70: a resume candidate without a transcript (a /clear id the CLI has not written
      // yet, a first turn that failed before any reply) starts as a new session under that id,
      // so the binding stays right. `startedAs` then says 'new' (D82 r4).
      if (start.kind === 'resume' && transcriptFile(start.sessionId, o.cwd, env) === undefined) {
        const fresh: OpenSessionOptions['start'] = { kind: 'new', sessionId: start.sessionId };
        if (start.mainAgent !== undefined) fresh.mainAgent = start.mainAgent;
        factoryOptions.debug?.('resume candidate has no transcript; starting new under its id', start.sessionId);
        start = fresh;
      }
      startInput.start = start;
      // D29: the validated cut, and the plain cut to fall back to if the CLI refuses it.
      let fallbackOptions: ReturnType<typeof buildStartOptions> | undefined;
      if (start.kind === 'fork') {
        const drops = validatedDropsTurn(start, o.cwd, env);
        if (drops !== undefined) {
          // Its own abort controller: closing the refused query aborts that query's controller,
          // and a shared one would abort the plain restart before it starts (M7 live).
          const fallbackAbort = new AbortController();
          o.signal.addEventListener('abort', () => fallbackAbort.abort(), { once: true });
          fallbackOptions = buildStartOptions({ ...startInput, abortController: fallbackAbort });
          startInput.resumeDropsTurn = drops;
        }
      }
      const options = buildStartOptions(startInput);

      const sessionId =
        start.kind === 'new'
          ? (start.sessionId ?? newRequestId())
          : start.kind === 'resume'
            ? start.sessionId
            : (start.newSessionId ?? newRequestId());
      for (const opts of fallbackOptions ? [options, fallbackOptions] : [options]) {
        if (start.kind === 'new' && start.sessionId === undefined) opts.sessionId = sessionId;
        if (start.kind === 'fork' && start.newSessionId === undefined) opts.sessionId = sessionId;
      }

      const init: ConstructorParameters<typeof ClaudeBackendSession>[0] = {
        kind: CLAUDE_KIND,
        sessionId,
        startedAs: start.kind === 'new' ? 'new' : start.kind === 'resume' ? 'resumed' : 'forked',
        options,
        queryFn,
        bypassOption,
        modeIds: CLAUDE_STATIC_CAPABILITIES.permissionModes.map((m) => m.id),
        // The mode the process starts in: we pass none, so the user's settings `defaultMode`
        // (else the CLI's default). Read only when a mode is set before the CLI reported one.
        startMode: async () => {
          if (typeof options.permissionMode === 'string') return options.permissionMode;
          try {
            return (await readDefaults(o.cwd)).permissionMode ?? 'default';
          } catch {
            return undefined;
          }
        },
        // D8: when the CLI dies, end what is left of its process group.
        onExit: () => spawner.killGroup('SIGTERM'),
        killGroup: () => spawner.killGroup('SIGKILL'),
        // R3.6: the exit code, signal and the end of stderr for a clear exit reason.
        exitInfo: () => spawner.exitInfo(),
      };
      if (fallbackOptions) init.fallbackOptions = fallbackOptions;
      // D30: "restore code" with a rewind fork; only when this process keeps checkpoints.
      if (start.kind === 'fork' && start.restoreFilesAt !== undefined) init.restoreFilesAt = start.restoreFilesAt;
      if (factoryOptions.debug) init.debug = factoryOptions.debug;
      // D49: workflow transcript folders are read only under the CLI's own projects folder.
      init.projectsDir = path.join(claudeConfigDir(env, deps.homedir, process.platform), 'projects');
      ref.session = new ClaudeBackendSession(init);
      return ref.session;
    },
  };
}
