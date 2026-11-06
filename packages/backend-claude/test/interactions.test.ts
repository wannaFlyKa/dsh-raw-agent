import { describe, expect, it } from 'vitest';
import type { InteractionHandler, PermissionRequest } from '@dsh-raw-agent/core';
import { REJECT_CONSTANTS, createCanUseTool, rejectMessage } from '@dsh-raw-agent/backend-claude';

const C = REJECT_CONSTANTS['2.1.318'];

function handler(answer: { optionId: string; feedback?: string }, seen: PermissionRequest[] = []): InteractionHandler {
  return {
    permission: async (r) => {
      seen.push(r);
      return answer;
    },
    question: async () => ({ answers: { 'Color?': 'Blue' } }),
    plan: async () => ({ kind: 'approve', choiceId: 'accept-edits' }),
    elicitation: async () => ({ action: 'decline' }),
  };
}

const opts = (extra: object = {}) =>
  ({ signal: new AbortController().signal, toolUseID: 'toolu_1', ...extra }) as never;
const can = (h: InteractionHandler) =>
  createCanUseTool({ handler: h, cliVersion: () => '2.1.318', canBypass: () => false, newId: () => 'id' });

describe('permission mapping (D40)', () => {
  it('reject texts mirror the TUI', () => {
    expect(rejectMessage(C, false, undefined)).toEqual({ message: C.mainNoFeedback, interrupt: true });
    expect(rejectMessage(C, false, 'use git rm')).toEqual({
      message: C.mainFeedbackPrefix + 'use git rm',
      interrupt: false,
    });
    expect(rejectMessage(C, true, undefined)).toEqual({ message: C.subagentNoFeedback, interrupt: false });
    expect(rejectMessage(C, true, 'no')).toEqual({ message: C.subagentFeedbackPrefix + 'no', interrupt: false });
  });

  it('offers allow once, one always per CLI suggestion, and reject', async () => {
    const seen: PermissionRequest[] = [];
    const suggestion = {
      type: 'addRules',
      rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
      behavior: 'allow',
      destination: 'localSettings',
    };
    const r = await can(handler({ optionId: 'always-0' }, seen))(
      'Bash',
      { command: 'rm x' },
      opts({ suggestions: [suggestion] }),
    );
    expect(seen[0]!.options.map((o) => o.kind)).toEqual(['allow-once', 'allow-always', 'reject-once']);
    expect(seen[0]!.options[1]!.destination).toBe('project local settings');
    expect(seen[0]!.callId).toBe('toolu_1');
    expect(r).toEqual({ behavior: 'allow', updatedInput: { command: 'rm x' }, updatedPermissions: [suggestion] });
  });

  it('hides always when the CLI suppresses it', async () => {
    const seen: PermissionRequest[] = [];
    await can(handler({ optionId: 'allow-once' }, seen))(
      'Bash',
      {},
      opts({ suggestions: [{}], suppressAlwaysAllowRule: true }),
    );
    expect(seen[0]!.options.map((o) => o.kind)).toEqual(['allow-once', 'reject-once']);
  });

  it('a main-thread reject stops the turn; a subagent reject does not', async () => {
    expect(await can(handler({ optionId: 'reject' }))('Bash', {}, opts())).toEqual({
      behavior: 'deny',
      message: C.mainNoFeedback,
      interrupt: true,
    });
    expect(await can(handler({ optionId: 'reject' }))('Bash', {}, opts({ agentID: 'a1' }))).toEqual({
      behavior: 'deny',
      message: C.subagentNoFeedback,
    });
  });

  it('AskUserQuestion answers go into updatedInput.answers', async () => {
    const input = { questions: [{ question: 'Color?', options: [{ label: 'Blue' }], multiSelect: false }] };
    expect(await can(handler({ optionId: 'x' }))('AskUserQuestion', input, opts())).toEqual({
      behavior: 'allow',
      updatedInput: { ...input, answers: { 'Color?': 'Blue' } },
    });
  });

  it('plan approval with a mode is a session-only setMode (D42)', async () => {
    expect(await can(handler({ optionId: 'x' }))('ExitPlanMode', { plan: 'p' }, opts())).toEqual({
      behavior: 'allow',
      updatedInput: { plan: 'p' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
  });
});
