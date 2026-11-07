// Pure view logic for the session controls and the settings preview. No React, no DSH.

import { nextPermissionMode } from '@dsh-raw-agent/core';
import { SETTINGS, type SessionInfo } from './api.js';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Tooltip: the agent's description, and why the option is greyed out. */
  hint?: string;
}

export interface SelectModel {
  value: string;
  options: SelectOption[];
  title: string;
}

/** Sentinel option: start the process to load the model list (D4). */
export const START_OPTION = '__raw-agent-start__';

/**
 * The model picker (D34, D35). "Your settings" is first; its label names what the user's settings
 * pick: the live process's model while no choice was applied to it, else the settings preview.
 */
export function modelSelect(info: SessionInfo): SelectModel {
  const v = info.view;
  const name = info.backend.displayName;
  const settingsModel =
    (v.choice.applied.model === undefined && !v.choice.resetPending ? v.live.model : undefined) ?? info.settings?.model;
  const settingsLabel = settingsModel ? `Your settings (${settingsModel})` : 'Your settings';
  const options: SelectOption[] = [{ value: SETTINGS, label: settingsLabel }];
  for (const m of info.models) options.push({ value: m.value, label: m.displayName || m.value });
  const chosen = v.choice.model;
  if (chosen !== undefined && chosen !== SETTINGS && !options.some((o) => o.value === chosen))
    options.push({ value: chosen, label: chosen });
  // The agent may run another model than the one chosen (it substitutes an unknown id): the
  // picker then names the model that really runs, as the agent's own status line does (R1.4).
  const running = v.live.model;
  const sent = v.choice.applied.model === chosen || v.choice.refused?.model === chosen;
  if (chosen !== undefined && chosen !== SETTINGS && running !== undefined && sent) {
    const opt = options.find((o) => o.value === chosen);
    const same = running === chosen || info.models.some((m) => m.value === chosen && m.displayName === running);
    if (opt && !same && !running.startsWith(chosen) && !chosen.startsWith(running))
      opt.label = `${opt.label} (running: ${running})`;
  }
  if (info.models.length === 0 && v.state.process === 'none')
    options.push({ value: START_OPTION, label: `Start ${name} to list models` });
  const title =
    info.modelsFrom === 'recent'
      ? `Model for this session only. The list is from another session and may differ for this folder.`
      : 'Model for this session only. Your settings files are not changed.';
  return { value: chosen ?? SETTINGS, options, title };
}

/**
 * The effort picker (D35, D37). Ids come from the backend; "Your settings" clears the choice. A
 * `mode` entry (Claude: ultracode) is a session mode at any effort level: a model's effort list does
 * not narrow it, and it is greyed out only when the live agent says it cannot be turned on (the
 * agent tells hosts to offer it only then). Picking a level after it turns it off, as the agent's
 * own `/effort <level>` does.
 */
export function effortSelect(info: SessionInfo): SelectModel | undefined {
  if (info.efforts.length === 0) return undefined;
  const v = info.view;
  const settingsEffort = info.settings?.effort;
  const ultra = v.live.ultracode;
  const modeEntry = info.efforts.find((e) => e.kind === 'mode');
  // The user's own settings may turn the mode on: name it, so "your settings" is not a surprise.
  const fromSettings = [
    settingsEffort,
    modeEntry && ultra?.on === true && v.choice.effort === undefined
      ? `${modeEntry.label.toLowerCase()} on`
      : undefined,
  ]
    .filter((x): x is string => x !== undefined && x !== '')
    .join(', ');
  const options: SelectOption[] = [
    { value: SETTINGS, label: fromSettings ? `Effort: your settings (${fromSettings})` : 'Effort: your settings' },
  ];
  // A model that lists its efforts narrows the levels (D34); otherwise every backend level shows.
  const modelId = v.choice.model ?? v.live.model;
  const supported = info.models.find((m) => m.value === modelId)?.efforts;
  for (const e of info.efforts) {
    const chosen = e.id === v.choice.effort;
    const isMode = e.kind === 'mode';
    const off = isMode
      ? ultra?.available === false && !chosen
      : supported !== undefined && !supported.includes(e.id) && !chosen;
    const o: SelectOption = { value: e.id, label: isMode ? `${e.label} (any effort)` : `Effort: ${e.label}` };
    const hint = [
      e.description,
      off && isMode ? `${info.backend.displayName} says it is not available for this session and model.` : undefined,
      chosen && isMode && ultra?.available === false
        ? `${info.backend.displayName} says it cannot take effect now.`
        : undefined,
    ]
      .filter((x): x is string => x !== undefined && x !== '')
      .join(' ');
    if (hint !== '') o.hint = hint;
    if (off) o.disabled = true;
    options.push(o);
  }
  const title = modeEntry
    ? `Effort for this session only. ${modeEntry.label} keeps the effort level; picking a level turns it off.`
    : 'Effort for this session only.';
  return { value: v.choice.effort ?? SETTINGS, options, title };
}

/** The mode the picker shows: a pending choice, else the agent's own report (R5.1). */
export function currentMode(info: SessionInfo): string {
  const v = info.view;
  return v.choice.pendingMode ?? v.live.mode ?? info.settings?.permissionMode ?? info.permissionModes[0]?.id ?? '';
}

/** The model the session runs or will run (for the auto-mode check, D38). */
function activeModel(info: SessionInfo) {
  const v = info.view;
  const id =
    v.choice.model !== undefined && v.choice.model !== SETTINGS
      ? v.choice.model
      : (v.live.model ?? info.settings?.model);
  return info.models.find((m) => m.value === id || m.displayName === id);
}

/**
 * Why a listed mode cannot be picked now, or undefined. D38: auto is greyed out when the model
 * says it has no auto mode; a mode that needs a backend option names that option.
 */
export function modeBlocked(info: SessionInfo, id: string): string | undefined {
  const off = info.unavailableModes?.find((m) => m.id === id);
  if (off)
    return off.optionLabel !== undefined
      ? `Needs the plugin option “${off.optionLabel}”.`
      : 'Not available in this session.';
  if (id === 'auto' && activeModel(info)?.supportsAutoMode === false && currentMode(info) !== id)
    return `${info.backend.displayName} says this model has no auto mode.`;
  return undefined;
}

/** The mode the agent's "next mode" key picks (Claude: Shift+Tab), or undefined. */
export function nextModeFor(info: SessionInfo): string | undefined {
  const cycle = info.permissionModeCycle;
  if (!cycle || cycle.length === 0) return undefined;
  const offered = new Set(info.permissionModes.map((m) => m.id));
  return nextPermissionMode(cycle, currentMode(info), (id) => offered.has(id) && modeBlocked(info, id) === undefined);
}

/**
 * The six-mode picker (D38, R5.1). It shows the agent's own mode once it reports one. The mode the
 * user's settings pick is marked "(your settings)", as the model and effort pickers name theirs,
 * so the user can tell a settings mode from a choice. Every mode of the backend is listed; one the
 * session cannot pick now (bypass without its option, auto on a model without it) is greyed out
 * with its reason in the option tooltip.
 */
export function modeSelect(info: SessionInfo): SelectModel {
  const v = info.view;
  const current = currentMode(info);
  const fromSettings = info.settings?.permissionMode;
  const listed = [...info.permissionModes, ...(info.unavailableModes ?? [])];
  const options: SelectOption[] = listed.map((m) => {
    const blocked = modeBlocked(info, m.id);
    const o: SelectOption = {
      value: m.id,
      label: m.id === fromSettings ? `${m.label} (your settings)` : m.label,
    };
    const hint = [m.description, blocked].filter((x): x is string => x !== undefined && x !== '').join(' ');
    if (hint !== '') o.hint = hint;
    if (blocked !== undefined && m.id !== current) o.disabled = true;
    return o;
  });
  if (current !== '' && !options.some((o) => o.value === current)) options.push({ value: current, label: current });
  const key = info.permissionModeCycle?.length ? ' Shift+Tab: next mode.' : '';
  const title =
    v.choice.pendingMode !== undefined
      ? `Applies when ${info.backend.displayName} starts.${key}`
      : `Permission mode for this session only.${key}`;
  return { value: current, options, title };
}

/** A one-line status for the controls. */
export function statusLine(info: SessionInfo, opts: { exitShown?: boolean } = {}): string | undefined {
  const v = info.view;
  if (v.choice.resetPending) return `Back to your settings after ${info.backend.displayName} restarts`;
  // M7: the lifecycle banner shows the exit with a Restart button; the line does not repeat it.
  if (v.state.lastExit && v.state.process === 'none' && !opts.exitShown)
    return `${info.backend.displayName} stopped${v.state.lastExit.error ? `: ${v.state.lastExit.error}` : ''}. Send a message to start it again.`;
  // The agent's own line (for example a model it refused and the model it used instead).
  if (v.live.notice) return `${info.backend.displayName}: ${v.live.notice.text}`;
  if (info.trust && (v.asks ?? []).every((a) => a.kind !== 'trust'))
    return info.trust.state === 'untrusted'
      ? `${info.backend.displayName} does not trust this folder yet${info.trust.effect ? ` (${info.trust.effect})` : ''}. It asks before it starts.`
      : `${info.backend.displayName} could not tell whether it trusts this folder${info.trust.effect ? ` (${info.trust.effect})` : ''}.`;
  return undefined;
}

/** Labels for one pending ask, ready to render. */
export interface AskModel {
  id: string;
  heading: string;
  detail?: string;
  choices: Array<{ id: string; label: string }>;
}

const ASK_HEADING: Record<string, string> = {
  permission: 'asks for permission',
  question: 'asks you',
  plan: 'has a plan',
  elicitation: 'asks for input',
  trust: 'asks whether you trust this folder',
};

/** Who asks: the subagent by its label (D77), else the agent's name. */
export function askWho(a: { agent: 'main' | 'child'; agentLabel?: string }, name: string): string {
  if (a.agent !== 'child') return name;
  return a.agentLabel ? `Subagent “${a.agentLabel}”` : `A ${name} subagent`;
}

/** The asks to show, oldest first. Every answer is the user's click (or Stop). */
export function askModels(info: SessionInfo): AskModel[] {
  const name = info.backend.displayName;
  return [...(info.view.asks ?? [])]
    .sort((a, b) => a.at - b.at)
    .map((a) => {
      const who = askWho(a, name);
      const m: AskModel = {
        id: a.id,
        heading: `${who} ${ASK_HEADING[a.kind] ?? 'asks'}: ${a.title}`,
        // The one-button row cannot fill a form: a choice that needs one waits for the full card.
        choices: a.choices.filter((c) => c.submits === undefined).map((c) => ({ id: c.id, label: c.label })),
      };
      if (a.detail !== undefined) m.detail = a.detail;
      return m;
    });
}

export interface TextSegment {
  kind: 'text' | 'secret';
  text: string;
  /** Index into the secret list (for reveal). */
  index?: number;
  key?: string;
}

/**
 * Split masked text into plain and hidden parts (D63). Secret ranges index the masked text; bad or
 * overlapping ranges are ignored, so the text is shown as it is.
 */
export function maskedSegments(
  masked: string,
  secrets: ReadonlyArray<{ start: number; end: number; key?: string }>,
): TextSegment[] {
  const order = secrets
    .map((s, index) => ({ ...s, index }))
    .filter(
      (s) =>
        Number.isInteger(s.start) &&
        Number.isInteger(s.end) &&
        s.start >= 0 &&
        s.end <= masked.length &&
        s.start < s.end,
    )
    .sort((a, b) => a.start - b.start);
  const out: TextSegment[] = [];
  let at = 0;
  for (const s of order) {
    if (s.start < at) continue;
    if (s.start > at) out.push({ kind: 'text', text: masked.slice(at, s.start) });
    const seg: TextSegment = { kind: 'secret', text: masked.slice(s.start, s.end), index: s.index };
    if (s.key !== undefined) seg.key = s.key;
    out.push(seg);
    at = s.end;
  }
  if (at < masked.length) out.push({ kind: 'text', text: masked.slice(at) });
  return out;
}

/** The folder of a file path (POSIX or Windows separators). */
export function folderOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  if (i < 0) return '.';
  if (i === 0) return path.slice(0, 1);
  // Keep a drive root such as `C:\`.
  return /^[A-Za-z]:$/.test(path.slice(0, i)) ? path.slice(0, i + 1) : path.slice(0, i);
}

/**
 * A `cd` command to the file's folder (D63 "Open in terminal"). DSH opens a terminal tab only in
 * the session folder, so the panel copies this for the user to paste; it is never run for them.
 * Double quotes work in sh, bash, zsh, fish, PowerShell and cmd; a path holding `"` gets single
 * quotes (POSIX shells only).
 */
export function cdCommand(path: string): string {
  const dir = folderOf(path);
  return dir.includes('"') ? `cd '${dir.replace(/'/g, "'\\''")}'` : `cd "${dir}"`;
}

/** One row of "which layer sets each key" (D63), with the layers named by their file labels. */
export interface KeyLayerRow {
  key: string;
  text: string;
}

export function keyLayerRows(
  keys: ReadonlyArray<{ key: string; scopes: string[]; merged?: boolean }> | undefined,
  labelOf: (scope: string) => string,
): KeyLayerRow[] {
  return (keys ?? []).map((k) => {
    const names = k.scopes.map(labelOf);
    if (k.merged) return { key: k.key, text: `combined from ${names.join(' + ')}` };
    if (names.length === 1) return { key: k.key, text: names[0]! };
    return { key: k.key, text: `${names[0]} (overrides ${names.slice(1).join(', ')})` };
  });
}
