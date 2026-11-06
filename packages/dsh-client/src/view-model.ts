// Pure view logic for the session controls and the settings preview. No React, no DSH.

import { SETTINGS, type SessionInfo } from './api.js';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
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

/** The effort picker (D35, D37). Ids come from the backend; "Your settings" clears the choice. */
export function effortSelect(info: SessionInfo): SelectModel | undefined {
  if (info.efforts.length === 0) return undefined;
  const v = info.view;
  const settingsEffort = info.settings?.effort;
  const options: SelectOption[] = [
    { value: SETTINGS, label: settingsEffort ? `Effort: your settings (${settingsEffort})` : 'Effort: your settings' },
  ];
  // A model that lists its efforts narrows the list (D34); otherwise every backend effort shows.
  const modelId = v.choice.model ?? v.live.model;
  const supported = info.models.find((m) => m.value === modelId)?.efforts;
  for (const e of info.efforts) {
    const off = supported !== undefined && !supported.includes(e.id) && e.id !== v.choice.effort;
    options.push(
      off ? { value: e.id, label: `Effort: ${e.label}`, disabled: true } : { value: e.id, label: `Effort: ${e.label}` },
    );
  }
  return { value: v.choice.effort ?? SETTINGS, options, title: 'Effort for this session only.' };
}

/**
 * The six-mode picker (D38). It shows the agent's own mode once it reports one. The mode the
 * user's settings pick is marked "(your settings)", as the model and effort pickers name theirs,
 * so the user can tell a settings mode from a choice. The Host lists only the modes the session
 * may use (D38 r4: bypass only when allowed).
 */
export function modeSelect(info: SessionInfo): SelectModel {
  const v = info.view;
  const current =
    v.choice.pendingMode ?? v.live.mode ?? info.settings?.permissionMode ?? info.permissionModes[0]?.id ?? '';
  const fromSettings = info.settings?.permissionMode;
  const options: SelectOption[] = info.permissionModes.map((m) => ({
    value: m.id,
    label: m.id === fromSettings ? `${m.label} (your settings)` : m.label,
  }));
  if (current !== '' && !options.some((o) => o.value === current)) options.push({ value: current, label: current });
  const title =
    v.choice.pendingMode !== undefined
      ? `Applies when ${info.backend.displayName} starts.`
      : 'Permission mode for this session only.';
  return { value: current, options, title };
}

/** A one-line status for the controls. */
export function statusLine(info: SessionInfo): string | undefined {
  const v = info.view;
  if (v.choice.resetPending) return `Back to your settings after ${info.backend.displayName} restarts`;
  if (v.state.lastExit && v.state.process === 'none')
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

/** The asks to show, oldest first. Every answer is the user's click (or Stop). */
export function askModels(info: SessionInfo): AskModel[] {
  const name = info.backend.displayName;
  return [...(info.view.asks ?? [])]
    .sort((a, b) => a.at - b.at)
    .map((a) => {
      const who = a.agent === 'child' ? `A ${name} subagent` : name;
      const m: AskModel = {
        id: a.id,
        heading: `${who} ${ASK_HEADING[a.kind] ?? 'asks'}: ${a.title}`,
        choices: a.choices.map((c) => ({ ...c })),
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
