// The Claude Code backend factory (D80). Pre-spawn capabilities are static data here (r4).

import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import type {
  AgentBackendFactory,
  AgentBackendSession,
  ConfigFileInfo,
  FactoryCapabilities,
  MaskedConfig,
  OpenSessionOptions,
  SettingsDefaults,
  TrustState,
} from '@dsh-raw-agent/core';
import { uuidv5 } from '@dsh-raw-agent/core/node';
import { resolveClaudeBinary, type BinaryResolveDeps } from './binary.js';
import { decideFileCheckpointing } from './checkpoint.js';
import { claudeConfigFiles, maskClaudeSettings } from './config-files.js';
import { buildClaudeEnv } from './env.js';
import { createCanUseTool, createOnElicitation } from './interactions.js';
import { loadSdk } from './sdk.js';
import { ClaudeBackendSession, newRequestId, type QueryFn } from './session.js';
import { createSpawner } from './spawn.js';
import { ALLOW_BYPASS_OPTION, buildStartOptions } from './start-options.js';
import { readSettingsDefaults } from './settings-defaults.js';
import { readTrustState } from './trust.js';

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
      default: false,
    },
  ],
  needsProcess: ['agents', 'commands', 'side-question', 'mcp', 'context', 'usage', 'task-actions'],
  sideQuestionCommand: 'btw',
  permissionModes: [
    { id: 'default', label: 'Ask before edits' },
    { id: 'acceptEdits', label: 'Accept edits' },
    { id: 'plan', label: 'Plan mode' },
    { id: 'auto', label: 'Auto' },
    { id: 'dontAsk', label: "Don't ask" },
    { id: 'bypassPermissions', label: 'Bypass permissions', requiresOption: ALLOW_BYPASS_OPTION },
  ],
  mainAgentPicker: 'new-session-only',
  efforts: [
    { id: 'low', label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high', label: 'High' },
    { id: 'xhigh', label: 'Extra high' },
    { id: 'max', label: 'Max' },
    { id: 'ultracode', label: 'Ultracode' },
  ],
  steer: 'native',
}) as FactoryCapabilities;

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
  fs?: { readText(p: string): string | undefined; realpath(p: string): string; exists(p: string): boolean };
  homedir?: string;
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
};

export function createClaudeFactory(factoryOptions: ClaudeFactoryOptions = {}): AgentBackendFactory {
  const readEnv = () => buildClaudeEnv(factoryOptions.env ? factoryOptions.env() : process.env).env;
  const fs = factoryOptions.fs ?? nodeFs;
  const home = () => factoryOptions.homedir ?? homedir();
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
      const env = readEnv();
      const files = claudeConfigFiles(cwd, { env, platform: process.platform, homedir: home() });
      return readSettingsDefaults(files, (p) => fs.readText(p), env);
    },
    async trustState(cwd: string): Promise<TrustState> {
      return readTrustState(cwd, { env: readEnv(), platform: process.platform, homedir: home(), ...fs });
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
      const spawner = createSpawner(env);
      const abortController = new AbortController();
      o.signal.addEventListener('abort', () => abortController.abort(), { once: true });

      const queryFn = factoryOptions.queryFn ?? ((await loadSdk()).query as unknown as QueryFn);
      const ref: { session?: ClaudeBackendSession } = {};
      // Pre-spawn view only: a settings `defaultMode: bypassPermissions` also allows bypass (D14).
      const canBypass = o.userConfig.options[ALLOW_BYPASS_OPTION] === true;
      const adapter = {
        handler: o.interactions,
        cliVersion: () => ref.session?.cliVersion,
        canBypass: () => canBypass,
        newId: newRequestId,
        onInterruptingDeny: () => ref.session?.noteInterruptRequested(),
      };
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
      const options = buildStartOptions(startInput);

      const start = o.start;
      const sessionId =
        start.kind === 'new'
          ? (start.sessionId ?? newRequestId())
          : start.kind === 'resume'
            ? start.sessionId
            : (start.newSessionId ?? newRequestId());
      if (start.kind === 'new' && start.sessionId === undefined) options.sessionId = sessionId;
      if (start.kind === 'fork' && start.newSessionId === undefined) options.sessionId = sessionId;

      const init: ConstructorParameters<typeof ClaudeBackendSession>[0] = {
        kind: CLAUDE_KIND,
        sessionId,
        startedAs: start.kind === 'new' ? 'new' : start.kind === 'resume' ? 'resumed' : 'forked',
        options,
        queryFn,
        canBypass,
        // D8: when the CLI dies, end what is left of its process group.
        onExit: () => spawner.killGroup('SIGTERM'),
        killGroup: () => spawner.killGroup('SIGKILL'),
      };
      if (factoryOptions.debug) init.debug = factoryOptions.debug;
      ref.session = new ClaudeBackendSession(init);
      return ref.session;
    },
  };
}
