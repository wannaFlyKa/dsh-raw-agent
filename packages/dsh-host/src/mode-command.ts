// The `/permission` command in our sessions (R1.4 leftover, D38 r3, CLAUDE.md §4). DSH-neutral.
//
// DSH's own `/permission` switches DSH's sandbox and approval preset, which this agent never
// reads, so in our sessions it showed and set a level that was not applied (M1 verify 3-3). Our
// preset shadows the command name for its own agents only (the port registers it in the preset
// scope); this handler never touches DSH's preset. It shows the agent's real permission mode and,
// with a mode id or label, switches the agent's mode for this session only (D38, the same path as
// the mode picker: `setPermissionMode`, never a settings file). A DSH preset name gets a plain
// answer that names the agent's own way to more access (0.1.1); nothing changes and no mode is forced.

import type { AgentBackendFactory, PermissionModeInfo } from '@dsh-raw-agent/core';
import type { ChoiceResult, SessionView } from './driver.js';

export interface ModeCommandRuntime {
  view(): SessionView;
  choose(req: { mode: string }): Promise<ChoiceResult>;
  /** Show the answer in the plugin's status line (DSH does not show a command result in the chat). */
  showNotice?(level: 'info' | 'warning', text: string, topic?: 'mode'): void;
}

export type ModeCommandResult = { kind: 'success'; text: string } | { kind: 'error'; text: string };

/** The command's one-line description in the `/` menu. */
export function modeCommandDescription(factory: AgentBackendFactory): string {
  return `Show or switch the ${factory.displayName} permission mode for this session (DSH file access does not apply here)`;
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

/**
 * DSH's permission preset names and labels (`@deepseek-ai/dsh-permission-presets` 0.2.2-rc.1:
 * `read-only`, `workspace-write`, `danger-full-access`, labels "Read Only", "Workspace Write",
 * "Full access"). Compared after `norm`. DSH's `auto` preset (Auto review) is not here: `auto` is
 * also an agent mode, and the agent mode wins.
 */
const DSH_PRESETS = new Set(
  ['read-only', 'workspace-write', 'danger-full-access', 'full-access', 'full access', 'workspace', 'readonly'].map(
    norm,
  ),
);

/** Whether `text` names one of DSH's permission presets (not an agent mode). */
export function isDshPresetName(text: string): boolean {
  return DSH_PRESETS.has(norm(text));
}

function labelOf(modes: readonly PermissionModeInfo[], id: string | undefined): string {
  if (id === undefined) return 'not known yet (it is reported once the agent starts)';
  const m = modes.find((x) => x.id === id);
  return m ? `${m.label} (${m.id})` : id;
}

/**
 * The answer to a DSH preset name. The modes that let the agent work without asking are named,
 * with the option a mode needs (Claude: bypass needs `allowDangerouslySkipPermissions`, as the
 * CLI needs `--dangerously-skip-permissions`).
 */
export function presetAnswer(factory: AgentBackendFactory, preset: string): string {
  const name = factory.displayName;
  const modes = factory.staticCapabilities.permissionModes;
  // The "no checks" modes first, then auto (the agent's own checks, no prompts).
  const wide = [...modes.filter((m) => m.risk === 'danger'), ...modes.filter((m) => m.id === 'auto')];
  const optionFor = (m: PermissionModeInfo) =>
    m.requiresOption !== undefined
      ? ` (needs the plugin option ${m.requiresOption}${m.requiresNote ? `, ${m.requiresNote}` : ''})`
      : '';
  const ways = wide.map((m) => `${m.id}${optionFor(m)}`);
  const full = ways.length > 0 ? ` For full access use ${ways.join(', or ')}.` : '';
  return (
    `DSH file access ("${preset}") does not apply to ${name}, so nothing changed. ` +
    `${name} runs its own tools under its permission mode.${full} Modes: ${modes.map((m) => m.id).join(', ')}.`
  );
}

/** Run `/permission [mode]` for one of our sessions; the answer also shows in the status line. */
export async function runModeCommand(
  runtime: ModeCommandRuntime | undefined,
  factory: AgentBackendFactory,
  rawInput: string,
): Promise<ModeCommandResult> {
  const r = await modeCommand(runtime, factory, rawInput);
  try {
    runtime?.showNotice?.(r.kind === 'error' ? 'warning' : 'info', r.text, 'mode');
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
    const now = `Permission mode: ${labelOf(modes, view.live.mode)}.`;
    const next = pending !== undefined ? ` Chosen for the next start: ${labelOf(modes, pending)}.` : '';
    return {
      kind: 'success',
      text: `${now}${next} DSH file access does not apply to ${name}. Switch with /permission <mode> (${list}) or the mode chip.`,
    };
  }
  const mode = findMode(modes, arg);
  if (!mode) {
    if (isDshPresetName(arg)) return { kind: 'error', text: presetAnswer(factory, arg) };
    return {
      kind: 'error',
      text: `"${arg}" is not a ${name} permission mode, so nothing changed. Modes: ${list}.`,
    };
  }
  const r = await runtime.choose({ mode: mode.id });
  if (!r.ok) return { kind: 'error', text: r.error ?? `${name} did not switch to ${mode.label}.` };
  // "applied" is what a switch does; only a later start is worth saying.
  const notes = (r.note ?? '')
    .split('; ')
    .filter((n) => n !== '' && n !== 'applied')
    .join('; ');
  return { kind: 'success', text: `Permission mode: ${mode.label} (this session${notes ? `; ${notes}` : ''}).` };
}
