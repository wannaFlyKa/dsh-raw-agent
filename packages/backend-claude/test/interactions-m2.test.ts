// M2 (R5.1-R5.5): permission suggestions with rule text, reject forms, AskUserQuestion forms,
// plan choices, elicitation, asks of subagents, and permission modes through the session.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  type BackendEvent,
  type ElicitationRequest,
  type InteractionHandler,
  type PermissionRequest,
  type PlanRequest,
  type QuestionAnswer,
  type QuestionRequest,
} from '@dsh-raw-agent/core';
import {
  AskContext,
  ASK_CONTEXT_LIMIT,
  CLAUDE_STATIC_CAPABILITIES,
  MODE_DESCRIPTIONS,
  REJECT_CONSTANTS,
  alwaysOptions,
  clarifyMessage,
  editedRule,
  createCanUseTool,
  createClaudeFactory,
  createOnElicitation,
  planChoices,
  questionPreviewFormat,
  questionUpdate,
  readQuestions,
  rejectConstantsFor,
  type InteractionAdapterOptions,
  type QueryFn,
} from '@dsh-raw-agent/backend-claude';

const C = REJECT_CONSTANTS['2.1.318'];
const sig = () => new AbortController().signal;
const opts = (extra: object = {}) => ({ signal: sig(), toolUseID: 'toolu_1', requestId: 'req-1', ...extra }) as never;

function recorder(answers: Partial<{ [K in keyof InteractionHandler]: Awaited<ReturnType<InteractionHandler[K]>> }>) {
  const seen = {
    permission: [] as PermissionRequest[],
    question: [] as QuestionRequest[],
    plan: [] as PlanRequest[],
    elicitation: [] as ElicitationRequest[],
  };
  const handler: InteractionHandler = {
    permission: async (r) => (seen.permission.push(r), answers.permission ?? { optionId: 'allow-once' }),
    question: async (r) => (seen.question.push(r), answers.question === undefined ? null : answers.question),
    plan: async (r) => (seen.plan.push(r), answers.plan ?? { kind: 'keep-planning' }),
    elicitation: async (r) => (seen.elicitation.push(r), answers.elicitation ?? { action: 'decline' }),
  };
  return { seen, handler };
}

const adapter = (
  handler: InteractionHandler,
  extra: Partial<InteractionAdapterOptions> = {},
): InteractionAdapterOptions => ({
  handler,
  cliVersion: () => '2.1.318',
  canBypass: () => false,
  newId: () => 'id',
  ...extra,
});

// The live suggestions for `rm` (sdk-surface probe3 X / Round 3b session G).
const RM_SUGGESTIONS = [
  {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
    behavior: 'allow',
    destination: 'localSettings',
  },
  { type: 'addDirectories', directories: ['/tmp/x'], destination: 'session' },
  { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
] as const;

describe('always-allow choices name their rule and destination (R5.2, D40)', () => {
  it('groups rules and directories into the TUI row and keeps a mode row of its own', () => {
    const rows = alwaysOptions(RM_SUGGESTIONS as never);
    expect(rows.map((r) => r.option.label)).toEqual([
      "Yes, and don't ask again for Bash(rm:*); Yes, and always allow access to /tmp/x for this session",
      `Yes, and switch to ${MODE_DESCRIPTIONS.acceptEdits} for this session`,
    ]);
    expect(rows[0]!.applies).toEqual([RM_SUGGESTIONS[0], RM_SUGGESTIONS[1]]);
    expect(rows[0]!.option.effects).toEqual([
      'add allow rule Bash(rm:*) (project local settings (.claude/settings.local.json))',
      'allow directory /tmp/x (this session only)',
    ]);
    expect(rows[0]!.option.destination).toBe('project local settings (.claude/settings.local.json); this session only');
    expect(rows[1]!.applies).toEqual([RM_SUGGESTIONS[2]]);
    expect(new Set(rows.map((r) => r.option.label)).size).toBe(rows.length); // no twin labels (verify 3-3)
  });

  it('returns the picked row unchanged as updatedPermissions; the CLI writes the rule', async () => {
    const { seen, handler } = recorder({ permission: { optionId: 'always-0' } });
    const r = await createCanUseTool(adapter(handler))(
      'Bash',
      { command: 'rm x' },
      opts({ suggestions: RM_SUGGESTIONS }),
    );
    expect(r).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'rm x' },
      updatedPermissions: [RM_SUGGESTIONS[0], RM_SUGGESTIONS[1]],
    });
    const req = seen.permission[0]!;
    expect(req.options.map((o) => [o.id, o.kind])).toEqual([
      ['allow-once', 'allow-once'],
      ['always-0', 'allow-always'],
      ['always-1', 'allow-always'],
      ['reject', 'reject-once'],
    ]);
    expect(req.options.at(-1)).toMatchObject({ label: 'No', acceptsFeedback: true });
    expect(req.id).toBe('req-1');
  });

  it("one Bash rule can be edited before it is saved (the TUI prefix row); the rest stays the CLI's", async () => {
    const rows = alwaysOptions(RM_SUGGESTIONS as never);
    expect(rows[0]!.option.editableRule).toEqual({
      toolName: 'Bash',
      ruleContent: 'rm:*',
      placeholder: 'command prefix (e.g., npm run *)',
    });
    expect(rows[1]!.option.editableRule).toBeUndefined();
    const { handler } = recorder({ permission: { optionId: 'always-0', ruleContent: ' rm -rf build/* ' } });
    const r = await createCanUseTool(adapter(handler))(
      'Bash',
      { command: 'rm x' },
      opts({ suggestions: RM_SUGGESTIONS }),
    );
    expect(r).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'rm x' },
      updatedPermissions: [
        { ...RM_SUGGESTIONS[0], rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build/*' }] },
        RM_SUGGESTIONS[1],
      ],
    });
    // Unchanged or empty text: the suggestions go back as they are; other rows ignore it.
    expect(editedRule(rows[0]!, 'rm:*')).toBe(rows[0]!.applies);
    expect(editedRule(rows[0]!, '  ')).toBe(rows[0]!.applies);
    expect(editedRule(rows[1]!, 'x')).toBe(rows[1]!.applies);
    // Two rules in one row: not editable (the TUI edits one prefix).
    const two = alwaysOptions([
      {
        type: 'addRules',
        rules: [
          { toolName: 'Bash', ruleContent: 'a:*' },
          { toolName: 'Bash', ruleContent: 'b:*' },
        ],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ] as never);
    expect(two[0]!.option.editableRule).toBeUndefined();
  });

  it('passes the CLI ask facts through: reason, defaultToNo, MCP server, title', async () => {
    const { seen, handler } = recorder({});
    await createCanUseTool(adapter(handler))(
      'mcp__srv__do',
      {},
      opts({
        decisionReason: 'rule ask',
        defaultToNo: true,
        mcpServer: { name: 'srv', source: 'project' },
        title: 'Claude wants to run do',
      }),
    );
    expect(seen.permission[0]).toMatchObject({
      reason: 'rule ask',
      defaultToNo: true,
      mcpServer: { name: 'srv', source: 'project' },
      title: 'Claude wants to run do',
    });
  });

  it('an unknown choice id is an error, never a silent reject text', async () => {
    const { handler } = recorder({ permission: { optionId: 'always-9' } });
    await expect(createCanUseTool(adapter(handler))('Bash', {}, opts())).rejects.toThrow(/unknown permission choice/);
  });
});

describe('reject forms (D40)', () => {
  it('main thread: feedback goes after the CLI prefix and does not interrupt; plain reject interrupts', async () => {
    let interrupts = 0;
    const mk = (feedback?: string) =>
      createCanUseTool(
        adapter(
          recorder({ permission: feedback ? { optionId: 'reject', feedback } : { optionId: 'reject' } }).handler,
          {
            onInterruptingDeny: () => interrupts++,
          },
        ),
      );
    expect(await mk('use git rm')('Bash', {}, opts())).toEqual({
      behavior: 'deny',
      message: C.mainFeedbackPrefix + 'use git rm',
    });
    expect(await mk('   ')('Bash', {}, opts())).toEqual({
      behavior: 'deny',
      message: C.mainNoFeedback,
      interrupt: true,
    });
    expect(interrupts).toBe(1);
  });

  it('subagent: the CLI subagent forms, never an interrupt; the ask names the subagent (D77)', async () => {
    const { seen, handler } = recorder({ permission: { optionId: 'reject', feedback: 'no' } });
    const can = createCanUseTool(
      adapter(handler, { agentLabel: (id) => (id === 'a1' ? 'Explore: scan repo' : undefined) }),
    );
    expect(await can('Bash', {}, opts({ agentID: 'a1' }))).toEqual({
      behavior: 'deny',
      message: C.subagentFeedbackPrefix + 'no',
    });
    expect(seen.permission[0]).toMatchObject({ agent: { kind: 'child', id: 'a1' }, agentLabel: 'Explore: scan repo' });
  });

  it('an unknown newer CLI uses the newest table entry and warns', () => {
    const warns: string[] = [];
    expect(rejectConstantsFor('9.9.9', (w) => warns.push(w))).toBe(C);
    expect(warns[0]).toContain('9.9.9');
    expect(rejectConstantsFor(undefined)).toBe(C);
  });
});

describe('AskUserQuestion (R5.3, D41, D13)', () => {
  const input = {
    questions: [
      {
        question: 'Which layout?',
        header: 'Layout',
        multiSelect: false,
        options: [
          { label: 'Grid', description: 'cards', preview: '```\n[ ][ ]\n```' },
          { label: 'List', description: 'rows', preview: '- a\n- b' },
        ],
      },
      {
        question: 'Which checks?',
        header: 'Checks',
        multiSelect: true,
        options: [{ label: 'Lint' }, { label: 'Test' }],
      },
      { bogus: true },
    ],
  };

  it('reads single and multi select, offers "Other", and says the preview format', async () => {
    const { seen, handler } = recorder({ question: { answers: { 'Which layout?': 'Grid' } } });
    await createCanUseTool(adapter(handler, { previewFormat: () => 'markdown' }))('AskUserQuestion', input, opts());
    const req = seen.question[0]!;
    expect(req.questions).toHaveLength(2);
    expect(req.questions[0]).toEqual({
      question: 'Which layout?',
      header: 'Layout',
      multiSelect: false,
      allowsOther: true,
      options: [
        { label: 'Grid', description: 'cards', preview: '```\n[ ][ ]\n```' },
        { label: 'List', description: 'rows', preview: '- a\n- b' },
      ],
    });
    expect(req.questions[1]!.multiSelect).toBe(true);
    expect(req.previewFormat).toBe('markdown');
    expect(req.otherLabel).toBe('Other');
    expect(req.callId).toBe('toolu_1');
  });

  it('answers as the TUI does: multi joined with ", ", preview and notes in annotations, Other as typed', async () => {
    const answer: QuestionAnswer = {
      answers: { 'Which layout?': 'Grid', 'Which checks?': ['Lint', 'Test'] },
      notes: { 'Which layout?': ' tight spacing ' },
    };
    const { handler } = recorder({ question: answer });
    const r = await createCanUseTool(adapter(handler))('AskUserQuestion', input, opts());
    expect(r).toEqual({
      behavior: 'allow',
      updatedInput: {
        ...input,
        answers: { 'Which layout?': 'Grid', 'Which checks?': 'Lint, Test' },
        annotations: { 'Which layout?': { preview: '```\n[ ][ ]\n```', notes: 'tight spacing' } },
      },
    });
    const qs = readQuestions(input);
    expect(questionUpdate(qs, { answers: { 'Which layout?': 'My own idea', 'Nope?': 'x' } })).toEqual({
      answers: { 'Which layout?': 'My own idea' },
    });
  });

  it('"Chat about this" is a deny with the CLI clarify text and the answers so far (no interrupt)', async () => {
    const answer: QuestionAnswer = {
      answers: { 'Which layout?': 'Grid' },
      notes: { 'Which layout?': 'not sure', 'Which checks?': 'dropped: multi select' },
      chat: true,
    };
    const { seen, handler } = recorder({ question: answer });
    const r = await createCanUseTool(adapter(handler))('AskUserQuestion', input, opts());
    expect(seen.question[0]!.chatLabel).toBe('Chat about this');
    expect(r).toEqual({
      behavior: 'deny',
      message:
        C.clarifyIntro +
        '- "Which layout?"\n  Answer: Grid\n  User notes: not sure\n- "Which checks?"\n  (No answer provided)',
    });
    expect(clarifyMessage(C, readQuestions(input), { answers: {}, chat: true })).toBe(
      C.clarifyIntro + '- "Which layout?"\n  (No answer provided)\n- "Which checks?"\n  (No answer provided)',
    );
  });

  it('dismissing the card is the reject mirror (main thread interrupts)', async () => {
    const { handler } = recorder({});
    expect(await createCanUseTool(adapter(handler))('AskUserQuestion', input, opts())).toEqual({
      behavior: 'deny',
      message: C.mainNoFeedback,
      interrupt: true,
    });
  });

  it('preview format: markdown unless the user env says html (never html by us)', () => {
    expect(questionPreviewFormat({})).toBe('markdown');
    expect(questionPreviewFormat({ CLAUDE_CODE_QUESTION_PREVIEW_FORMAT: 'html' })).toBe('html');
    expect(questionPreviewFormat({ claude_code_question_preview_format: 'HTML' })).toBe('html');
    expect(questionPreviewFormat({ CLAUDE_CODE_QUESTION_PREVIEW_FORMAT: 'markdown' })).toBe('markdown');
  });
});

describe('plan approval (R5.4, D42)', () => {
  it('offers the TUI lead choice for the context, then "manually approve"', () => {
    expect(planChoices({ canBypass: false, prePlanMode: 'auto' }).map((c) => c.id)).toEqual([
      'yes',
      'default',
      'accept-edits',
    ]);
    expect(planChoices({ canBypass: false, prePlanMode: 'default' }).map((c) => c.id)).toEqual([
      'accept-edits',
      'default',
    ]);
    const bypass = planChoices({ canBypass: true, prePlanMode: 'default' });
    expect(bypass.map((c) => c.id)).toEqual(['bypass', 'default', 'accept-edits']);
    expect(bypass[0]!.label).toBe('Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session');
    expect(planChoices(false)[0]).toEqual({ id: 'accept-edits', label: 'Yes, auto-accept edits', mode: 'acceptEdits' });
  });

  it('"use auto mode" sends no updates (the CLI restores the pre-plan mode); others a session setMode', async () => {
    const run = async (choiceId: string, extra: Partial<InteractionAdapterOptions> = {}) => {
      const { seen, handler } = recorder({ plan: { kind: 'approve', choiceId } });
      const r = await createCanUseTool(adapter(handler, extra))(
        'ExitPlanMode',
        { plan: 'p', planFilePath: '/p.md' },
        opts(),
      );
      return { r, req: seen.plan[0]! };
    };
    const auto = await run('yes', { prePlanMode: () => 'auto' });
    expect(auto.r).toEqual({ behavior: 'allow', updatedInput: { plan: 'p', planFilePath: '/p.md' } });
    expect(auto.req).toMatchObject({
      planFilePath: '/p.md',
      keepPlanning: { label: 'No, keep planning', feedbackPlaceholder: 'Tell Claude what to change' },
    });
    expect((await run('default')).r).toMatchObject({
      updatedPermissions: [{ type: 'setMode', mode: 'default', destination: 'session' }],
    });
    expect((await run('bypass', { canBypass: () => true })).r).toMatchObject({
      updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'session' }],
    });
    // A choice this ask did not offer (bypass without bypass) is refused, not applied.
    await expect(run('bypass')).rejects.toThrow(/unknown plan choice/);
  });

  it('keep planning with feedback is the CLI reject text plus the feedback; a subagent plan uses its form', async () => {
    const fb = (agentID?: string) =>
      createCanUseTool(adapter(recorder({ plan: { kind: 'keep-planning', feedback: 'add tests' } }).handler))(
        'ExitPlanMode',
        { plan: 'p' },
        opts(agentID ? { agentID } : {}),
      );
    expect(await fb()).toEqual({ behavior: 'deny', message: C.mainFeedbackPrefix + 'add tests' });
    expect(await fb('a1')).toEqual({ behavior: 'deny', message: C.subagentFeedbackPrefix + 'add tests' });
  });
});

describe('elicitation (R5.5, D43, D44)', () => {
  it('form accept returns the content unchanged; the agent comes from the open MCP call', async () => {
    const ctx = new AskContext();
    ctx.observe({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent',
      agent_id: 'bg1',
      subagent_type: 'general-purpose',
      task_description: 'fetch colors',
      message: { content: [{ type: 'tool_use', id: 'toolu_m1', name: 'mcp__my_srv__ask_color', input: {} }] },
    });
    const { seen, handler } = recorder({ elicitation: { action: 'accept', content: { color: 'green' } } });
    const on = createOnElicitation(
      adapter(handler, {
        elicitationAgent: (s) => ctx.elicitationAgent(s),
        agentLabel: (id) => ctx.agentLabel(id),
      }),
    );
    const schema = { type: 'object', properties: { color: { type: 'string' } } };
    const r = await on(
      { serverName: 'my srv', message: 'Pick', mode: 'form', requestedSchema: schema },
      { signal: sig(), requestId: 'r-el' },
    );
    expect(r).toEqual({ action: 'accept', content: { color: 'green' } });
    expect(seen.elicitation[0]).toEqual({
      id: 'r-el',
      agent: { kind: 'child', id: 'bg1' },
      agentLabel: 'general-purpose: fetch colors',
      serverName: 'my srv',
      message: 'Pick',
      mode: 'form',
      requestedSchema: schema,
    });
  });

  it('decline and cancel pass through; URL accept stays open until elicitation_complete', async () => {
    const ctx = new AskContext();
    const mk = (action: 'accept' | 'decline' | 'cancel') =>
      createOnElicitation(
        adapter(recorder({ elicitation: { action } }).handler, {
          rememberElicitation: (e, i) => ctx.rememberElicitation(e, i),
          forgetElicitation: (e) => ctx.forgetElicitation(e),
        }),
      );
    const url = { serverName: 's', message: 'Log in', mode: 'url' as const, url: 'https://x', elicitationId: 'e1' };
    expect(await mk('decline')(url, { signal: sig(), requestId: 'a' })).toEqual({ action: 'decline' });
    expect(ctx.observe({ type: 'system', subtype: 'elicitation_complete', elicitation_id: 'e1' })).toEqual([]);
    expect(await mk('cancel')({ serverName: 's', message: 'm' }, { signal: sig(), requestId: 'b' })).toEqual({
      action: 'cancel',
    });
    expect(await mk('accept')(url, { signal: sig(), requestId: 'c' })).toEqual({ action: 'accept' });
    expect(ctx.observe({ type: 'system', subtype: 'elicitation_complete', elicitation_id: 'e1' })).toEqual([
      { type: 'interaction-done', id: 'c' },
    ]);
  });

  it('AskContext: unknown agent when no or several agents call that server; results close calls', () => {
    const ctx = new AskContext();
    expect(ctx.elicitationAgent('srv')).toBeUndefined();
    ctx.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__srv__a' }] } });
    expect(ctx.elicitationAgent('srv')).toEqual({ kind: 'main' });
    ctx.observe({
      type: 'assistant',
      parent_tool_use_id: 'p',
      agent_id: 'c1',
      message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__srv__b' }] },
    });
    expect(ctx.elicitationAgent('srv')).toBeUndefined();
    ctx.observe({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } });
    expect(ctx.elicitationAgent('srv')).toEqual({ kind: 'child', id: 'c1' });
  });

  it('AskContext drops the oldest open calls and elicitations past its limit', () => {
    const ctx = new AskContext();
    ctx.observe({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'old', name: 'mcp__lost__a' }] } });
    ctx.rememberElicitation('e-old', 'i-old');
    for (let i = 0; i < ASK_CONTEXT_LIMIT; i++) {
      ctx.observe({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'mcp__srv__a' }] },
      });
      ctx.rememberElicitation(`e${i}`, `i${i}`);
    }
    // The call whose result never came is gone, so it no longer decides the elicitation's agent.
    expect(ctx.elicitationAgent('lost')).toBeUndefined();
    expect(ctx.elicitationAgent('srv')).toEqual({ kind: 'main' });
    expect(ctx.observe({ type: 'system', subtype: 'elicitation_complete', elicitation_id: 'e-old' })).toEqual([]);
    expect(ctx.observe({ type: 'system', subtype: 'elicitation_complete', elicitation_id: 'e0' })).toEqual([
      { type: 'interaction-done', id: 'i0' },
    ]);
  });

  it('AskContext tracks the mode and the pre-plan mode from init and status frames', () => {
    const ctx = new AskContext();
    ctx.observe({ type: 'system', subtype: 'init', permissionMode: 'auto' });
    ctx.observe({ type: 'system', subtype: 'status', permissionMode: 'plan' });
    expect([ctx.startMode, ctx.mode, ctx.prePlanMode]).toEqual(['auto', 'plan', 'auto']);
    ctx.observe({ type: 'system', subtype: 'status', permissionMode: 'plan' });
    expect(ctx.prePlanMode).toBe('auto');
  });

  it('a later turn init (the CLI sends one per turn) keeps the start mode and the pre-plan mode', () => {
    // Live M2: acceptEdits -> auto -> plan by the picker, then the next turn's init says plan.
    const ctx = new AskContext();
    ctx.observe({ type: 'system', subtype: 'init', permissionMode: 'bypassPermissions' });
    ctx.observe({ type: 'system', subtype: 'status', permissionMode: 'acceptEdits' });
    ctx.observe({ type: 'system', subtype: 'status', permissionMode: 'auto' });
    ctx.observe({ type: 'system', subtype: 'status', permissionMode: 'plan' });
    ctx.observe({ type: 'system', subtype: 'init', permissionMode: 'plan' });
    expect([ctx.startMode, ctx.mode, ctx.prePlanMode]).toEqual(['bypassPermissions', 'plan', 'auto']);
  });
});

// ---- the session (fake query) ----

function fakeQuery() {
  const out = new AsyncQueue<unknown>();
  const calls: Array<[string, unknown[]]> = [];
  let options: Record<string, unknown> | undefined;
  const q = {
    [Symbol.asyncIterator]: () => out[Symbol.asyncIterator](),
    interrupt: async () => ({ cancelled: [] }),
    setPermissionMode: async (...a: unknown[]) => void calls.push(['setPermissionMode', a]),
    supportedModels: async () => [{ value: 'm', displayName: 'M', description: '', supportsAutoMode: false }],
    close: () => out.end(),
  };
  const queryFn: QueryFn = (p) => {
    options = p.options as unknown as Record<string, unknown>;
    return q as never;
  };
  return {
    out,
    calls,
    queryFn,
    get options() {
      return options!;
    },
  };
}

function fakeClaude(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raw-agent-m2-'));
  const p = join(dir, 'claude');
  writeFileSync(p, '#!/bin/sh\nexit 1\n');
  chmodSync(p, 0o755);
  return p;
}

async function openWith(options: Record<string, unknown>, handler: InteractionHandler) {
  const fake = fakeQuery();
  const session = await createClaudeFactory({ queryFn: fake.queryFn }).open({
    cwd: '/tmp',
    env: { PATH: '/usr/bin' },
    start: { kind: 'new' },
    userConfig: { executablePath: fakeClaude(), options },
    interactions: handler,
    signal: sig(),
  });
  const events: BackendEvent[] = [];
  void (async () => {
    for await (const e of session.events()) events.push(e);
  })();
  return { fake, session, events };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe.skipIf(process.platform === 'win32')('permission modes through the session (R5.1, D14, D38)', () => {
  it('the static list has all six modes, with the CLI descriptions; bypass needs the option', () => {
    expect(CLAUDE_STATIC_CAPABILITIES.permissionModes.map((m) => m.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions',
    ]);
    expect(CLAUDE_STATIC_CAPABILITIES.permissionModes.at(-1)!.requiresOption).toBe('allowDangerouslySkipPermissions');
    expect(CLAUDE_STATIC_CAPABILITIES.permissionModes[0]!.description).toBe(MODE_DESCRIPTIONS.default);
  });

  it('refuses bypass without the option before calling the CLI; the status frame is the mode', async () => {
    const { fake, session, events } = await openWith({}, recorder({}).handler);
    fake.out.push({ type: 'system', subtype: 'init', permissionMode: 'default', claude_code_version: '2.1.318' });
    await tick();
    await expect(session.controls.setPermissionMode!('bypassPermissions')).rejects.toThrow(/allow-dangerously-skip/);
    await expect(session.controls.setPermissionMode!('yolo')).rejects.toThrow(/unknown permission mode/);
    await session.controls.setPermissionMode!('acceptEdits');
    expect(fake.calls).toEqual([['setPermissionMode', ['acceptEdits']]]);
    expect(fake.options.allowDangerouslySkipPermissions).toBeUndefined();
    fake.out.push({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' });
    await tick();
    expect(events.filter((e) => e.type === 'mode')).toEqual([{ type: 'mode', mode: 'acceptEdits' }]);
    expect((await session.controls.models!())[0]!.supportsAutoMode).toBe(false);
    await session.dispose();
  });

  it('a process that started in bypass (the user settings) may switch back to it and offers the bypass plan choice', async () => {
    const { seen, handler } = recorder({ plan: { kind: 'approve', choiceId: 'bypass' } });
    const { fake, session } = await openWith({}, handler);
    fake.out.push({ type: 'system', subtype: 'init', permissionMode: 'bypassPermissions' });
    fake.out.push({ type: 'system', subtype: 'status', permissionMode: 'plan' });
    await tick();
    await session.controls.setPermissionMode!('bypassPermissions');
    const canUseTool = fake.options.canUseTool as ReturnType<typeof createCanUseTool>;
    const r = await canUseTool('ExitPlanMode', { plan: 'p' }, opts());
    expect(seen.plan[0]!.choices[0]!.id).toBe('bypass');
    expect(r).toMatchObject({ updatedPermissions: [{ mode: 'bypassPermissions' }] });
    await session.dispose();
  });

  it('a plan picked before the CLI reported a mode keeps the settings start mode as the pre-plan mode', async () => {
    // Live M2 re-run: auto (settings) then plan picked before the first message; the status
    // frame of that setPermissionMode comes before the first init, so "use auto mode" was lost.
    const home = mkdtempSync(join(tmpdir(), 'raw-agent-m2-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'raw-agent-m2-cwd-'));
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { defaultMode: 'auto' } }));
    const { seen, handler } = recorder({ plan: { kind: 'approve', choiceId: 'yes' } });
    const fake = fakeQuery();
    const session = await createClaudeFactory({ queryFn: fake.queryFn, homedir: home, env: () => ({}) }).open({
      cwd,
      env: { PATH: '/usr/bin' },
      start: { kind: 'new' },
      userConfig: { executablePath: fakeClaude(), options: {} },
      interactions: handler,
      signal: sig(),
    });
    void (async () => {
      for await (const _e of session.events()) void _e;
    })();
    await session.controls.setPermissionMode!('plan');
    fake.out.push({ type: 'system', subtype: 'status', permissionMode: 'plan' });
    fake.out.push({ type: 'system', subtype: 'init', permissionMode: 'plan' });
    await tick();
    const asks = (session as unknown as { asks: AskContext }).asks;
    expect([asks.startMode, asks.mode, asks.prePlanMode]).toEqual(['auto', 'plan', 'auto']);
    await (fake.options.canUseTool as ReturnType<typeof createCanUseTool>)('ExitPlanMode', { plan: 'p' }, opts());
    expect(seen.plan[0]!.choices[0]!.id).toBe('yes');
    await session.dispose();
  });

  it('seedStartMode is ignored once the CLI reported a mode', () => {
    const ctx = new AskContext();
    ctx.observe({ type: 'system', subtype: 'init', permissionMode: 'default' });
    ctx.seedStartMode('auto');
    expect([ctx.startMode, ctx.mode]).toEqual(['default', 'default']);
  });

  it('with the option on, the CLI gets the allow flag and bypass is allowed', async () => {
    const { fake, session } = await openWith({ allowDangerouslySkipPermissions: true }, recorder({}).handler);
    expect(fake.options.allowDangerouslySkipPermissions).toBe(true);
    await session.controls.setPermissionMode!('bypassPermissions');
    expect(fake.calls).toEqual([['setPermissionMode', ['bypassPermissions']]]);
    await session.dispose();
  });

  it('a subagent ask carries the label from its own messages; URL completion closes the card', async () => {
    const { seen, handler } = recorder({ elicitation: { action: 'accept' } });
    const { fake, session, events } = await openWith({}, handler);
    fake.out.push({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent',
      agent_id: 'bg1',
      subagent_type: 'Explore',
      message: { content: [{ type: 'tool_use', id: 'toolu_m', name: 'mcp__auth__login', input: {} }] },
    });
    await tick();
    await (fake.options.canUseTool as ReturnType<typeof createCanUseTool>)('Bash', {}, opts({ agentID: 'bg1' }));
    expect(seen.permission[0]!.agentLabel).toBe('Explore');
    const on = fake.options.onElicitation as ReturnType<typeof createOnElicitation>;
    await on(
      { serverName: 'auth', message: 'Log in', mode: 'url', url: 'https://x', elicitationId: 'e9' },
      { signal: sig(), requestId: 'r9' },
    );
    expect(seen.elicitation[0]!.agent).toEqual({ kind: 'child', id: 'bg1' });
    fake.out.push({ type: 'system', subtype: 'elicitation_complete', mcp_server_name: 'auth', elicitation_id: 'e9' });
    await tick();
    expect(events).toContainEqual({ type: 'interaction-done', id: 'r9' });
    await session.dispose();
  });
});
