// SDK callbacks → InteractionHandler (D39-D43). Spike scope: permissions with allow once, the
// CLI's own "always" suggestions, and reject (with the CLI's constants, D40); AskUserQuestion;
// ExitPlanMode; elicitation. The DSH layer renders options by `kind` and never builds deny text.

import type { CanUseTool, OnElicitation, PermissionResult, PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type { AgentRef, InteractionHandler, PermissionOption, PlanChoiceInfo } from '@dsh-raw-agent/core';

/**
 * Reject texts, as the TUI sends them (D40). Keyed by CLI version; an unknown newer CLI uses the
 * newest entry. Source: CLI 2.1.318 binary strings. A later test checks them against the binary.
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
  },
} as const;

export type RejectConstants = (typeof REJECT_CONSTANTS)['2.1.318'];

export function rejectConstantsFor(_cliVersion: string | undefined): RejectConstants {
  // One entry so far. Newer versions use the newest entry (D40).
  return REJECT_CONSTANTS['2.1.318'];
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

/** TUI plan choices (D42). Bypass is offered only when the session can bypass. */
export function planChoices(canBypass: boolean): PlanChoiceInfo[] {
  const choices: PlanChoiceInfo[] = [
    { id: 'yes', label: 'Yes' },
    { id: 'accept-edits', label: 'Yes, auto-accept edits' },
    { id: 'default', label: 'Yes, manually approve edits' },
  ];
  if (canBypass) choices.push({ id: 'bypass', label: 'Yes, bypass permissions' });
  return choices;
}

function destinationLabel(d: string | undefined): string | undefined {
  switch (d) {
    case 'localSettings':
      return 'project local settings';
    case 'projectSettings':
      return 'project settings';
    case 'userSettings':
      return 'user settings';
    case 'session':
      return 'this session only';
    default:
      return d;
  }
}

export interface InteractionAdapterOptions {
  handler: InteractionHandler;
  cliVersion: () => string | undefined;
  canBypass: () => boolean;
  newId: () => string;
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
    const callId = opts.toolUseID;
    const id = (opts as { requestId?: string }).requestId ?? o.newId();

    if (toolName === 'AskUserQuestion') {
      const questions = Array.isArray(input.questions) ? (input.questions as never[]) : [];
      const answer = await o.handler.question({ id, agent, callId, questions }, opts.signal);
      if (answer === null)
        return deny(rejectMessage(rejectConstantsFor(o.cliVersion()), agent.kind === 'child', undefined));
      return { behavior: 'allow', updatedInput: { ...input, answers: answer.answers } };
    }

    if (toolName === 'ExitPlanMode') {
      const plan = typeof input.plan === 'string' ? input.plan : '';
      const req = { id, agent, callId, plan, choices: planChoices(o.canBypass()) } as Parameters<
        InteractionHandler['plan']
      >[0];
      if (typeof input.planFilePath === 'string') req.planFilePath = input.planFilePath;
      const answer = await o.handler.plan(req, opts.signal);
      if (answer.kind === 'keep-planning') {
        return deny(rejectMessage(rejectConstantsFor(o.cliVersion()), agent.kind === 'child', answer.feedback));
      }
      const mode = { 'accept-edits': 'acceptEdits', default: 'default', bypass: 'bypassPermissions' }[answer.choiceId];
      if (mode === undefined) return { behavior: 'allow', updatedInput: input };
      return {
        behavior: 'allow',
        updatedInput: input,
        updatedPermissions: [{ type: 'setMode', mode, destination: 'session' } as PermissionUpdate],
      };
    }

    const suggestions = opts.suppressAlwaysAllowRule ? [] : (opts.suggestions ?? []);
    const options: PermissionOption[] = [{ id: 'allow-once', kind: 'allow-once', label: 'Allow once' }];
    suggestions.forEach((s, i) => {
      const dest = destinationLabel(s.destination);
      const opt: PermissionOption = {
        id: `always-${i}`,
        kind: 'allow-always',
        label: dest ? `Always allow (${dest})` : 'Always allow',
      };
      if (dest !== undefined) opt.destination = dest;
      options.push(opt);
    });
    options.push({ id: 'reject', kind: 'reject-once', label: 'Reject', acceptsFeedback: true });

    const req: Parameters<InteractionHandler['permission']>[0] = { id, agent, toolName, input, options };
    if (callId !== undefined) req.callId = callId;
    if (opts.displayName !== undefined) req.displayName = opts.displayName;
    if (opts.title !== undefined) req.title = opts.title;
    if (opts.description !== undefined) req.description = opts.description;
    if (opts.blockedPath !== undefined) req.blockedPath = opts.blockedPath;
    const answer = await o.handler.permission(req, opts.signal);

    if (answer.optionId === 'allow-once') return { behavior: 'allow', updatedInput: input };
    const always = /^always-(\d+)$/.exec(answer.optionId);
    if (always) {
      const s = suggestions[Number(always[1])];
      // The suggestion goes back unchanged; the CLI writes the rule, as the TUI does (rule 2).
      return s
        ? { behavior: 'allow', updatedInput: input, updatedPermissions: [s] }
        : { behavior: 'allow', updatedInput: input };
    }
    return deny(rejectMessage(rejectConstantsFor(o.cliVersion()), agent.kind === 'child', answer.feedback));
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
    const req: Parameters<InteractionHandler['elicitation']>[0] = {
      id: opts.requestId ?? o.newId(),
      serverName: request.serverName,
      message: request.message,
    };
    if (request.mode !== undefined) req.mode = request.mode;
    if (request.url !== undefined) req.url = request.url;
    if (request.requestedSchema !== undefined) req.requestedSchema = request.requestedSchema;
    const answer = await o.handler.elicitation(req, opts.signal);
    return answer as never;
  };
}
