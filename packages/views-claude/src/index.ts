// Claude tool views keyed by wire tool name (D19). Imports only @dsh-raw-agent/core (and React).
// The client port registers each one for our sessions only; it never registers an `mcp__*` name
// or a key a DSH package uses.

import type * as React from 'react';
import type { ToolView, ToolViewPack } from '@dsh-raw-agent/core';
import {
  AgentView,
  AskUserQuestionView,
  BashView,
  EditView,
  ExitPlanModeView,
  GlobView,
  GrepView,
  ReadView,
  SkillView,
  TodoWriteView,
  WebFetchView,
  WebSearchView,
  WriteView,
} from './views.js';

export * from './model.js';
export * from './views.js';

/** The Claude tool names this pack draws, byte for byte (D19). */
export const CLAUDE_TOOL_VIEWS: Readonly<Record<string, ToolView<React.ReactElement>>> = Object.freeze({
  Bash: BashView,
  Read: ReadView,
  Edit: EditView,
  MultiEdit: EditView,
  Write: WriteView,
  Grep: GrepView,
  Glob: GlobView,
  Agent: AgentView,
  Task: AgentView,
  TodoWrite: TodoWriteView,
  WebFetch: WebFetchView,
  WebSearch: WebSearchView,
  Skill: SkillView,
  ExitPlanMode: ExitPlanModeView,
  AskUserQuestion: AskUserQuestionView,
});

export const toolViewPack: ToolViewPack<React.ReactElement> = { kind: 'claude-code', views: CLAUDE_TOOL_VIEWS };
