// The `/permission` command in our sessions (R1.4 leftover, D38 r3, CLAUDE.md §4). DSH-neutral.
//
// DSH's own `/permission` switches DSH's sandbox and approval preset, which this agent never
// reads, so in our sessions it showed and set a level that was not applied (M1 verify 3-3). Our
// preset shadows the command name for its own agents only (the port registers it in the preset
// scope); this handler never touches DSH's preset. It shows the agent's real permission mode and,
// with a mode id or label, switches the agent's mode for this session only (D38, the same path as
// the mode picker: `setPermissionMode`, never a settings file).

import type { AgentBackendFactory, PermissionModeInfo } from '@dsh-raw-agent/core';
import type { ChoiceResult, SessionView } from './driver.js';

export interface ModeCommandRuntime {
  view(): SessionView;
  choose(req: { mode: string }): Promise<ChoiceResult>;
  /** Show the answer in the plugin's status line (DSH does not show a command result in the chat). */
  showNotice?(level: 'info' | 'warning', text: string): void;
}

export type ModeCommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string };

/** The command's one-line description in the `/` menu. */
export function modeCommandDescription(factory: AgentBackendFactory): string {
  return `Show or switch the ${factory.displayName} permission mode for this session (DSH presets do not apply here)`;
}

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');

/** Find a mode by id or label, ignoring case, spaces, `-` and `_`. */
export function findMode(modes: readonly PermissionModeInfo[], text: string): PermissionModeInfo | undefined {
  const want = norm(text);
  if (want === '') return undefined;
  return modes.find((m) => norm(m.id) === want) ?? modes.find((m) => norm(m.label) === want);
}

function labelOf(modes: readonly PermissionModeInfo[], id: string | undefined): string {
  if (id === undefined) return 'not known yet (it is reported once the agent starts)';
  const m = modes.find((x) => x.id === id);
  return m ? `${m.label} (${m.id})` : id;
}

/** Run `/permission [mode]` for one of our sessions; the answer also shows in the status line. */
export async function runModeCommand(
  runtime: ModeCommandRuntime | undefined,
  factory: AgentBackendFactory,
  rawInput: string,
): Promise<ModeCommandResult> {
  const r = await modeCommand(runtime, factory, rawInput);
  try {
    runtime?.showNotice?.(r.kind === 'error' ? 'warning' : 'info', r.text);
  } catch {
    // the status line is a courtesy; the command result stands
  }
  return r;
}

async function modeCommand(
  runtime: ModeCommandRuntime | undefined,
  factory: AgentBackendFactory,
  rawInput: string,
): Promise<ModeCommandResult> {
  const name = factory.displayName;
  const modes = factory.staticCapabilities.permissionModes;
  const list = modes.map((m) => m.id).join(', ');
  if (!runtime) return { kind: 'error', text: `${name} is not attached to this session yet; try again in a moment.` };
  const view = runtime.view();
  const arg = rawInput.trim();
  if (arg === '') {
    const pending = view.choice.pendingMode;
    const now = `${name} permission mode: ${labelOf(modes, view.live.mode)}.`;
    const next = pending !== undefined ? ` Chosen for the next start: ${labelOf(modes, pending)}.` : '';
    return {
      kind: 'success',
      text: `${now}${next} DSH permission presets do not apply to ${name}. Switch with /permission <mode> (${list}) or the mode picker.`,
    };
  }
  const mode = findMode(modes, arg);
  if (!mode)
    return {
      kind: 'error',
      text: `"${arg}" is not a ${name} permission mode, so nothing changed. DSH permission presets do not apply to ${name}. Modes: ${list}.`,
    };
  const r = await runtime.choose({ mode: mode.id });
  if (!r.ok) return { kind: 'error', text: r.error ?? `${name} did not switch to ${mode.label}.` };
  const note = r.note ? ` (${r.note})` : '';
  return { kind: 'success', text: `${name} permission mode: ${mode.label} for this session${note}.` };
}
