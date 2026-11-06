// Raw start options (rules 3 and 4; D12-D17a). Nothing else is passed: no model, effort,
// permissionMode, thinking, tools, settings, mcpServers, promptSuggestions,
// agentProgressSummaries or verbatimPrompts.

import type { CanUseTool, OnElicitation, Options, SpawnedProcess, SpawnOptions } from '@anthropic-ai/claude-agent-sdk';
import type { SessionStart } from '@dsh-raw-agent/core';

/** The backend-owned user option for the bypass switch (D14). Off by default. */
export const ALLOW_BYPASS_OPTION = 'allowDangerouslySkipPermissions';

export interface StartOptionsInput {
  executablePath: string;
  cwd: string;
  /** Already filtered by the env policy (D17a). */
  env: Record<string, string>;
  start: SessionStart;
  trustAccepted?: { directory: string };
  userOptions: Readonly<Record<string, unknown>>;
  /** From decideFileCheckpointing (D16). */
  fileCheckpointing: boolean;
  canUseTool: CanUseTool;
  onElicitation: OnElicitation;
  spawn: (options: SpawnOptions) => SpawnedProcess;
  abortController: AbortController;
}

/** Fields we pass that the SDK types do not declare yet (D9). */
interface UndeclaredStartOptions {
  workspaceTrust?: { accepted: true; directory: string };
}

export type ClaudeStartOptions = Options & UndeclaredStartOptions;

function hasEnv(env: Record<string, string>, name: string): boolean {
  const upper = name.toUpperCase();
  return Object.keys(env).some((k) => k.toUpperCase() === upper);
}

export function buildStartOptions(input: StartOptionsInput): ClaudeStartOptions {
  const o: ClaudeStartOptions = {
    pathToClaudeCodeExecutable: input.executablePath,
    cwd: input.cwd,
    env: input.env,
    // Omitting systemPrompt sends an empty prompt; the preset with no append is the CLI's own (rule 3).
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['user', 'project', 'local'],
    canUseTool: input.canUseTool,
    onElicitation: input.onElicitation,
    includePartialMessages: true,
    perTaskStopAffordance: true,
    forwardSubagentText: true,
    spawnClaudeCodeProcess: input.spawn,
    abortController: input.abortController,
  };

  // D13: the TUI's own preview format, unless the user's env already decides it.
  if (!hasEnv(input.env, 'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT')) {
    o.toolConfig = { askUserQuestion: { previewFormat: 'markdown' } };
  }
  // D16: the TUI checkpoints files by default.
  if (input.fileCheckpointing) o.enableFileCheckpointing = true;
  // D14: only the explicit plugin switch, never the user's settings.
  if (input.userOptions[ALLOW_BYPASS_OPTION] === true) o.allowDangerouslySkipPermissions = true;
  // D73: only after the user's click.
  if (input.trustAccepted) o.workspaceTrust = { accepted: true, directory: input.trustAccepted.directory };

  const start = input.start;
  switch (start.kind) {
    case 'new':
      if (start.sessionId !== undefined) o.sessionId = start.sessionId;
      if (start.mainAgent !== undefined) o.agent = start.mainAgent; // D15
      break;
    case 'resume':
      o.resume = start.sessionId;
      if (start.mainAgent !== undefined) o.agent = start.mainAgent; // D15 (r4)
      break;
    case 'fork':
      o.resume = start.fromSessionId;
      o.forkSession = true;
      if (start.newSessionId !== undefined) o.sessionId = start.newSessionId;
      if (start.atChainId !== undefined) o.resumeSessionAt = start.atChainId;
      if (start.mainAgent !== undefined) o.agent = start.mainAgent;
      // resumeDropsTurn (D29) needs the transcript turn count; not in the spike, so never passed.
      break;
  }
  return o;
}
