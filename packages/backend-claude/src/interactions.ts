// SDK callbacks → InteractionHandler (D39-D44, D77). Permissions with allow once, the CLI's own
// "always" suggestions with their rule text, and reject with the CLI's constants (D40);
// AskUserQuestion with single and multi select, "Other" and previews (D41, D13); ExitPlanMode with
// the TUI's mode choices and "keep planning" (D42); MCP elicitation forms and URLs (D43). The DSH
// layer renders options by `kind` and returns ids; it never builds deny text or rules.

import type { CanUseTool, OnElicitation, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type {
  AgentRef,
  ElicitationRequest,
  InteractionHandler,
  PermissionOption,
  PermissionRequest,
  PlanChoiceInfo,
  PlanRequest,
  QuestionAnswer,
  QuestionItem,
  QuestionRequest,
} from '@dsh-raw-agent/core';

/**
 * Reject texts, as the TUI sends them (D40). Keyed by CLI version; an unknown newer CLI uses the
 * newest entry. Source: CLI 2.1.318 binary strings; `pnpm test:cli-constants` checks them.
 */
export const REJECT_CONSTANTS = {
  '2.1.318': {
    mainNoFeedback:
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.",
    mainFeedbackPrefix:
      "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n",
    subagentNoFeedback:
      'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). Try a different approach or report the limitation to complete your task.',
    subagentFeedbackPrefix:
      'Permission for this tool use was denied. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). The user said:\n',
    /** AskUserQuestion "Chat about this" (binary fn `tht`): this text, then one block per question. */
    clarifyIntro:
      'The user wants to clarify these questions.\n    This means they may have additional information, context or questions for you.\n    Take their response into account and then reformulate the questions if appropriate.\n    Start by asking them what they would like to clarify.\n\n    Questions asked:\n',
    clarifyNoAnswer: '  (No answer provided)',
  },
} as const;

export type RejectConstants = (typeof REJECT_CONSTANTS)['2.1.318'];

/**
 * The TUI's own words for the choices we show (CLI 2.1.318 binary: the permission, plan and
 * question dialogs). Only labels; nothing here reaches the model. Checked by `test:cli-constants`.
 */
export const TUI_TEXT = {
  yes: 'Yes',
  no: 'No',
  rejectPlaceholder: 'and tell Claude what to do differently',
  dontAskAgainFor: "Yes, and don't ask again for ",
  allowAccessTo: 'Yes, and always allow access to ',
  forThisSession: ' for this session',
  switchTo: 'Yes, and switch to ',
  planUseAuto: 'Yes, and use auto mode',
  planAcceptEdits: 'Yes, auto-accept edits',
  planManual: 'Yes, manually approve edits',
  planKeepPlanning: 'No, keep planning',
  planKeepPlanningPlaceholder: 'Tell Claude what to change',
  questionOther: 'Other',
  questionChat: 'Chat about this',
  prefixPlaceholder: 'command prefix (e.g., npm run *)',
} as const;

/** The CLI's one-line description of each mode (binary table used by "Yes, and switch to …"). */
export const MODE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  default: 'default (ask each time)',
  acceptEdits: 'accept edits (auto-approve file edits and common file commands)',
  auto: 'auto (no routine prompts; a reviewer model screens actions)',
  dontAsk: "don't ask (auto-deny anything that would prompt)",
  plan: 'plan mode (research and propose changes without making them)',
  bypassPermissions: 'BYPASS PERMISSIONS (no further prompts)',
};

export function rejectConstantsFor(cliVersion: string | undefined, warn?: (text: string) => void): RejectConstants {
  const table = REJECT_CONSTANTS as Record<string, RejectConstants>;
  if (cliVersion !== undefined && table[cliVersion]) return table[cliVersion];
  const newest = Object.keys(table).at(-1)!;
  if (cliVersion !== undefined) warn?.(`no reject-text entry for Claude Code ${cliVersion}; using ${newest} (D40)`);
  return table[newest]!;
}

export function rejectMessage(
  c: RejectConstants,
  isSubagent: boolean,
  feedback: string | undefined,
): { message: string; interrupt: boolean } {
  const fb = feedback?.trim();
  if (isSubagent) {
    return { message: fb ? c.subagentFeedbackPrefix + fb : c.subagentNoFeedback, interrupt: false };
  }
  // Main thread with no feedback stops the turn, as the TUI's cancelAndAbort path does.
  return fb ? { message: c.mainFeedbackPrefix + fb, interrupt: false } : { message: c.mainNoFeedback, interrupt: true };
}

// ---- plan choices (D42) ----

export interface PlanChoiceContext {
  /** The session can switch to bypass (the plugin option, or it started in bypass, D14). */
  canBypass: boolean;
  /** The mode before plan mode; a plain "Yes" makes the CLI restore it. */
  prePlanMode?: string | undefined;
}

/**
 * The TUI's plan choices (CLI 2.1.318 binary, plan dialog without "clear context"): first
 * "switch to bypass" when bypass is available, else "use auto mode" when the plan began in auto
 * mode, else "auto-accept edits"; then "manually approve edits". D42 also keeps "auto-accept
 * edits" when it is not first. Each id maps to one reply in `planReply`.
 */
export function planChoices(ctx: PlanChoiceContext | boolean): PlanChoiceInfo[] {
  const c: PlanChoiceContext = typeof ctx === 'boolean' ? { canBypass: ctx } : ctx;
  const acceptEdits: PlanChoiceInfo = { id: 'accept-edits', label: TUI_TEXT.planAcceptEdits, mode: 'acceptEdits' };
  const out: PlanChoiceInfo[] = [];
  if (c.canBypass)
    out.push({
      id: 'bypass',
      label: `${TUI_TEXT.switchTo}${MODE_DESCRIPTIONS.bypassPermissions}${TUI_TEXT.forThisSession}`,
      mode: 'bypassPermissions',
    });
  else if (c.prePlanMode === 'auto') out.push({ id: 'yes', label: TUI_TEXT.planUseAuto, mode: 'auto' });
  else out.push(acceptEdits);
  out.push({ id: 'default', label: TUI_TEXT.planManual, mode: 'default' });
  if (out[0] !== acceptEdits) out.push(acceptEdits);
  return out;
}

const PLAN_MODES: Readonly<Record<string, string>> = {
  'accept-edits': 'acceptEdits',
  default: 'default',
  bypass: 'bypassPermissions',
};

// ---- permission suggestions (D40) ----

type Suggestion = PermissionUpdate;

/** Where a suggestion is saved, in plain words. `.claude/` paths only here (backend-owned). */
export function destinationLabel(d: string | undefined): string | undefined {
  switch (d) {
    case 'localSettings':
      return 'project local settings (.claude/settings.local.json)';
    case 'projectSettings':
      return 'project settings (.claude/settings.json)';
    case 'userSettings':
      return 'user settings (~/.claude/settings.json)';
    case 'session':
      return 'this session only';
    case 'cliArg':
      return 'this session only (command-line rules)';
    default:
      return d;
  }
}

/** A rule as the settings file writes it: `Bash(rm:*)`, or the bare tool name. */
export function ruleText(r: { toolName: string; ruleContent?: string }): string {
  return r.ruleContent === undefined ? r.toolName : `${r.toolName}(${r.ruleContent})`;
}

function rulesOf(s: Suggestion): string[] {
  return 'rules' in s && Array.isArray(s.rules) ? s.rules.map(ruleText) : [];
}

function dirsOf(s: Suggestion): string[] {
  return 'directories' in s && Array.isArray(s.directories) ? s.directories.map(String) : [];
}

/** One line per thing the suggestion saves, with where it goes. */
export function suggestionEffects(s: Suggestion): string[] {
  const where = destinationLabel(s.destination);
  const at = where ? ` (${where})` : '';
  switch (s.type) {
    case 'addRules':
    case 'replaceRules':
    case 'removeRules': {
      const verb = s.type === 'addRules' ? 'add' : s.type === 'replaceRules' ? 'replace with' : 'remove';
      return rulesOf(s).map((r) => `${verb} ${s.behavior} rule ${r}${at}`);
    }
    case 'addDirectories':
    case 'removeDirectories':
      return dirsOf(s).map((d) => `${s.type === 'addDirectories' ? 'allow' : 'remove'} directory ${d}${at}`);
    case 'setMode':
      return [`switch to ${MODE_DESCRIPTIONS[s.mode] ?? s.mode}${at}`];
    default:
      return [];
  }
}

function sessionSuffix(dest: string | undefined): string {
  return dest === 'session' || dest === 'cliArg' ? TUI_TEXT.forThisSession : '';
}

/**
 * The "always" choices for one ask, in the TUI's shape (CLI 2.1.318 binary): the allow-rule and
 * directory suggestions form ONE row ("Yes, and don't ask again for …; Yes, and always allow
 * access to …") that returns them together, as the TUI's row does; each mode suggestion is its own
 * row ("Yes, and switch to … for this session"). Rule suggestions with another behaviour or type
 * are rows of their own with plain wording. Every suggestion goes back unchanged (rule 2).
 */
export function alwaysOptions(
  suggestions: readonly Suggestion[],
): Array<{ option: PermissionOption; applies: Suggestion[] }> {
  const out: Array<{ option: PermissionOption; applies: Suggestion[] }> = [];
  const grouped: Suggestion[] = [];
  const singles: Suggestion[] = [];
  for (const s of suggestions) {
    if (s.type === 'addDirectories' || (s.type === 'addRules' && s.behavior === 'allow')) grouped.push(s);
    else singles.push(s);
  }
  const make = (applies: Suggestion[], label: string) => {
    const dests = [...new Set(applies.map((s) => destinationLabel(s.destination)).filter((d) => d !== undefined))];
    const option: PermissionOption = {
      id: `always-${out.length}`,
      kind: 'allow-always',
      label,
      effects: applies.flatMap(suggestionEffects),
    };
    if (dests.length > 0) option.destination = dests.join('; ');
    out.push({ option, applies });
  };
  if (grouped.length > 0) {
    const parts: string[] = [];
    const rules = grouped.filter((s) => s.type === 'addRules');
    const ruleNames = [...new Set(rules.flatMap(rulesOf))];
    if (ruleNames.length > 0)
      parts.push(`${TUI_TEXT.dontAskAgainFor}${ruleNames.join(', ')}${sessionSuffix(rules[0]?.destination)}`);
    const dirSugs = grouped.filter((s) => s.type === 'addDirectories');
    const dirs = [...new Set(dirSugs.flatMap(dirsOf))];
    if (dirs.length > 0)
      parts.push(`${TUI_TEXT.allowAccessTo}${dirs.join(', ')}${sessionSuffix(dirSugs[0]?.destination)}`);
    if (parts.length > 0) {
      make(grouped, parts.join('; '));
      // The TUI lets the user edit a Bash command prefix before it is saved (binary
      // `yes-prefix-edited`). Offered when the row saves exactly one Bash rule.
      const only = rules.length === 1 && rulesOf(rules[0]!).length === 1 ? rules[0] : undefined;
      const rule = only && 'rules' in only ? only.rules[0] : undefined;
      if (rule && rule.toolName === 'Bash' && typeof rule.ruleContent === 'string')
        out[out.length - 1]!.option.editableRule = {
          toolName: 'Bash',
          ruleContent: rule.ruleContent,
          placeholder: TUI_TEXT.prefixPlaceholder,
        };
    }
  }
  for (const s of singles) {
    if (s.type === 'setMode') {
      make([s], `${TUI_TEXT.switchTo}${MODE_DESCRIPTIONS[s.mode] ?? s.mode}${sessionSuffix(s.destination)}`);
      continue;
    }
    const effects = suggestionEffects(s);
    if (effects.length > 0) make([s], `Yes, and ${effects.join('; ')}`);
  }
  return out;
}

/**
 * The suggestions an "always" row returns. With an edited rule (the TUI's editable prefix), the one
 * Bash rule gets the user's text; its behaviour and destination stay the CLI's. Rows without an
 * editable rule ignore the text.
 */
export function editedRule(
  picked: { option: PermissionOption; applies: Suggestion[] },
  ruleContent: string | undefined,
): Suggestion[] {
  const edit = picked.option.editableRule;
  const text = ruleContent?.trim();
  if (!edit || !text || text === edit.ruleContent) return picked.applies;
  return picked.applies.map((s) =>
    s.type === 'addRules' && s.rules.length === 1 && s.rules[0]!.toolName === edit.toolName
      ? ({ ...s, rules: [{ toolName: edit.toolName, ruleContent: text }] } as Suggestion)
      : s,
  );
}

// ---- AskUserQuestion (D41, D13) ----

/** Read the tool input into the neutral shape; malformed entries are skipped, never invented. */
export function readQuestions(input: Record<string, unknown>): QuestionItem[] {
  const list = Array.isArray(input.questions) ? (input.questions as unknown[]) : [];
  const out: QuestionItem[] = [];
  for (const q of list) {
    if (typeof q !== 'object' || q === null) continue;
    const r = q as Record<string, unknown>;
    if (typeof r.question !== 'string') continue;
    const options: QuestionItem['options'] = [];
    for (const o of Array.isArray(r.options) ? (r.options as unknown[]) : []) {
      if (typeof o !== 'object' || o === null) continue;
      const opt = o as Record<string, unknown>;
      if (typeof opt.label !== 'string') continue;
      const item: QuestionItem['options'][number] = { label: opt.label };
      if (typeof opt.description === 'string' && opt.description !== '') item.description = opt.description;
      if (typeof opt.preview === 'string' && opt.preview !== '') item.preview = opt.preview;
      options.push(item);
    }
    const item: QuestionItem = {
      question: r.question,
      multiSelect: r.multiSelect === true,
      options,
      allowsOther: true,
    };
    if (typeof r.header === 'string' && r.header !== '') item.header = r.header;
    out.push(item);
  }
  return out;
}

/**
 * The TUI's answer (CLI 2.1.318 binary, AskUserQuestion submit): `answers` keyed by question text,
 * multi-select labels joined with ", " (the tool's own schema: "comma-separated"); `annotations`
 * per question with the picked option's preview (single select only, as the TUI shows previews)
 * and the user's notes. Unknown question keys are dropped; the model reads only what the user gave.
 */
export function questionUpdate(
  questions: readonly QuestionItem[],
  answer: NonNullable<QuestionAnswer>,
): { answers: Record<string, string>; annotations?: Record<string, { preview?: string; notes?: string }> } {
  const answers: Record<string, string> = {};
  const annotations: Record<string, { preview?: string; notes?: string }> = {};
  for (const q of questions) {
    const raw = answer.answers[q.question];
    const value = Array.isArray(raw)
      ? raw
          .map(String)
          .filter((s) => s !== '')
          .join(', ')
      : raw;
    if (typeof value === 'string' && value !== '') answers[q.question] = value;
    const note: { preview?: string; notes?: string } = {};
    if (!q.multiSelect && typeof value === 'string') {
      const picked = q.options.find((o) => o.label === value);
      if (picked?.preview !== undefined) note.preview = picked.preview;
    }
    const notes = answer.notes?.[q.question]?.trim();
    if (notes) note.notes = notes;
    if (note.preview !== undefined || note.notes !== undefined) annotations[q.question] = note;
  }
  return Object.keys(annotations).length > 0 ? { answers, annotations } : { answers };
}

/**
 * The TUI's "Chat about this" answer (CLI 2.1.318 binary fns `tht`, `HFo`): a deny whose text is
 * the CLI's own intro plus, per question, `- "<question>"`, then `  Answer: <answer>` or
 * `  (No answer provided)`, then `  User notes: <notes>` for a single-select question with
 * previews. Only what the user gave goes in. The TUI joins a multi-select answer as the submit
 * does (", "). Whether the TUI wraps this text in a further prefix is **unverified** (no live TUI
 * check); we send it as the deny message.
 */
export function clarifyMessage(
  c: RejectConstants,
  questions: readonly QuestionItem[],
  answer: NonNullable<QuestionAnswer>,
): string {
  const { answers } = questionUpdate(questions, answer);
  const blocks = questions.map((q) => {
    const lines = [`- "${q.question}"`];
    const a = answers[q.question];
    lines.push(a !== undefined ? `  Answer: ${a}` : c.clarifyNoAnswer);
    const notes = answer.notes?.[q.question]?.trim();
    if (notes && !q.multiSelect && q.options.some((o) => o.preview !== undefined)) lines.push(`  User notes: ${notes}`);
    return lines.join('\n');
  });
  return c.clarifyIntro + blocks.join('\n');
}

// ---- the adapter ----

export interface InteractionAdapterOptions {
  handler: InteractionHandler;
  cliVersion: () => string | undefined;
  /** The session can switch to bypass now (D14). */
  canBypass: () => boolean;
  newId: () => string;
  /** The mode before plan mode (D42). */
  prePlanMode?: () => string | undefined;
  /** The label of a subagent by its id (D77). */
  agentLabel?: (agentId: string) => string | undefined;
  /** The agent an elicitation most likely came from (D44; inferred). */
  elicitationAgent?: (serverName: string) => AgentRef | undefined;
  /** URL elicitations: remember which ask a completion closes (D43). */
  rememberElicitation?: (elicitationId: string, interactionId: string) => void;
  forgetElicitation?: (elicitationId: string) => void;
  /** How previews are written: the user's own env value, else 'markdown' (D13). */
  previewFormat?: () => 'markdown' | 'html';
  warn?: (text: string) => void;
  /**
   * Called right before a deny that interrupts the turn (the TUI's "No" on the main agent). The
   * CLI then ends the turn with `error_during_execution`, which is the user's stop, not an error.
   */
  onInterruptingDeny?: () => void;
}

export function createCanUseTool(o: InteractionAdapterOptions): CanUseTool {
  return async (toolName, input, opts): Promise<PermissionResult> => {
    const agentId = (opts as { agentID?: string }).agentID;
    const agent: AgentRef = agentId ? { kind: 'child', id: agentId } : { kind: 'main' };
    const agentLabel = agentId ? o.agentLabel?.(agentId) : undefined;
    const callId = opts.toolUseID;
    const id = (opts as { requestId?: string }).requestId ?? o.newId();
    const isChild = agent.kind === 'child';
    const constants = () => rejectConstantsFor(o.cliVersion(), o.warn);

    if (toolName === 'AskUserQuestion') {
      const questions = readQuestions(input);
      const req: QuestionRequest = {
        id,
        agent,
        questions,
        previewFormat: o.previewFormat?.() ?? 'markdown',
        otherLabel: TUI_TEXT.questionOther,
        chatLabel: TUI_TEXT.questionChat,
      };
      if (callId !== undefined) req.callId = callId;
      if (agentLabel !== undefined) req.agentLabel = agentLabel;
      const answer = await o.handler.question(req, opts.signal);
      if (answer === null) return deny(rejectMessage(constants(), isChild, undefined));
      // "Chat about this": a deny with the CLI's clarify text; the turn goes on (no interrupt).
      if (answer.chat === true) return { behavior: 'deny', message: clarifyMessage(constants(), questions, answer) };
      return { behavior: 'allow', updatedInput: { ...input, ...questionUpdate(questions, answer) } };
    }

    if (toolName === 'ExitPlanMode') {
      const plan = typeof input.plan === 'string' ? input.plan : '';
      const req: PlanRequest = {
        id,
        agent,
        plan,
        choices: planChoices({ canBypass: o.canBypass(), prePlanMode: o.prePlanMode?.() }),
        keepPlanning: { label: TUI_TEXT.planKeepPlanning, feedbackPlaceholder: TUI_TEXT.planKeepPlanningPlaceholder },
      };
      if (callId !== undefined) req.callId = callId;
      if (agentLabel !== undefined) req.agentLabel = agentLabel;
      if (typeof input.planFilePath === 'string') req.planFilePath = input.planFilePath;
      const answer = await o.handler.plan(req, opts.signal);
      if (answer.kind === 'keep-planning') return deny(rejectMessage(constants(), isChild, answer.feedback));
      if (!req.choices.some((c) => c.id === answer.choiceId))
        throw new Error(`unknown plan choice: ${answer.choiceId}`);
      const mode = PLAN_MODES[answer.choiceId];
      // "Yes" (use auto mode): no updates, so the CLI restores the pre-plan mode itself (D42).
      if (mode === undefined) return { behavior: 'allow', updatedInput: input };
      return {
        behavior: 'allow',
        updatedInput: input,
        // Session only: any other destination is a settings file (Round 3b).
        updatedPermissions: [{ type: 'setMode', mode, destination: 'session' } as PermissionUpdate],
      };
    }

    const suggestions = opts.suppressAlwaysAllowRule ? [] : (opts.suggestions ?? []);
    const always = alwaysOptions(suggestions);
    const options: PermissionOption[] = [
      { id: 'allow-once', kind: 'allow-once', label: TUI_TEXT.yes },
      ...always.map((a) => a.option),
      {
        id: 'reject',
        kind: 'reject-once',
        label: TUI_TEXT.no,
        acceptsFeedback: true,
        feedbackPlaceholder: TUI_TEXT.rejectPlaceholder,
      },
    ];

    const req: PermissionRequest = { id, agent, toolName, input, options };
    if (agentLabel !== undefined) req.agentLabel = agentLabel;
    if (callId !== undefined) req.callId = callId;
    if (opts.displayName !== undefined) req.displayName = opts.displayName;
    if (opts.title !== undefined) req.title = opts.title;
    if (opts.description !== undefined) req.description = opts.description;
    if (opts.blockedPath !== undefined) req.blockedPath = opts.blockedPath;
    if (opts.decisionReason !== undefined) req.reason = opts.decisionReason;
    if (opts.defaultToNo === true) req.defaultToNo = true;
    if (opts.mcpServer !== undefined) req.mcpServer = { name: opts.mcpServer.name, source: opts.mcpServer.source };
    const answer = await o.handler.permission(req, opts.signal);

    if (answer.optionId === 'allow-once') return { behavior: 'allow', updatedInput: input };
    const picked = always.find((a) => a.option.id === answer.optionId);
    // The suggestions go back unchanged; the CLI writes the rule, as the TUI does (rule 2).
    if (picked)
      return { behavior: 'allow', updatedInput: input, updatedPermissions: editedRule(picked, answer.ruleContent) };
    if (answer.optionId !== 'reject') throw new Error(`unknown permission choice: ${answer.optionId}`);
    return deny(rejectMessage(constants(), isChild, answer.feedback));
  };

  /**
   * One deny rule for every ask (permission, AskUserQuestion decline, "No, keep planning"): the
   * main thread's no-feedback reject says "STOP … and wait for the user", so it also interrupts
   * the turn, as the TUI's reject does. Sending that text and letting the turn go on would ask
   * the model to wait while it keeps running.
   */
  function deny(r: { message: string; interrupt: boolean }): PermissionResult {
    if (!r.interrupt) return { behavior: 'deny', message: r.message };
    o.onInterruptingDeny?.();
    return { behavior: 'deny', message: r.message, interrupt: true };
  }
}

export function createOnElicitation(o: InteractionAdapterOptions): OnElicitation {
  return async (request, opts) => {
    const req: ElicitationRequest = {
      id: opts.requestId ?? o.newId(),
      serverName: request.serverName,
      message: request.message,
    };
    const agent = o.elicitationAgent?.(request.serverName);
    if (agent !== undefined) {
      req.agent = agent;
      const label = agent.kind === 'child' ? o.agentLabel?.(agent.id) : undefined;
      if (label !== undefined) req.agentLabel = label;
    }
    if (request.mode !== undefined) req.mode = request.mode;
    if (request.url !== undefined) req.url = request.url;
    if (request.elicitationId !== undefined) req.elicitationId = request.elicitationId;
    if (request.requestedSchema !== undefined) req.requestedSchema = request.requestedSchema;
    if (request.title !== undefined) req.title = request.title;
    if (request.displayName !== undefined) req.displayName = request.displayName;
    if (request.description !== undefined) req.description = request.description;
    const eid = request.mode === 'url' ? request.elicitationId : undefined;
    if (eid !== undefined) o.rememberElicitation?.(eid, req.id);
    let answer;
    try {
      answer = await o.handler.elicitation(req, opts.signal);
    } catch (e) {
      if (eid !== undefined) o.forgetElicitation?.(eid);
      throw e;
    }
    // Decline and cancel close it now; an accepted URL waits for `elicitation_complete` (D43).
    if (eid !== undefined && answer.action !== 'accept') o.forgetElicitation?.(eid);
    // The answer reaches the server unchanged (Round 3b): accept + content, decline, cancel.
    if (answer.action === 'accept')
      return answer.content !== undefined
        ? { action: 'accept', content: answer.content as never }
        : { action: 'accept' };
    return { action: answer.action };
  };
}
