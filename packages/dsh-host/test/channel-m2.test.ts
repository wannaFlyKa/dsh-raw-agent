/* eslint-disable @typescript-eslint/no-explicit-any */
// M2 host channel (D39-D44, D24, R1.4 leftover): full answers through the desk (feedback, question
// forms, elicitation forms and URL completion), the first answer wins, the D44 audit hooks and
// writer events, the streaming channel route, the mode restore from the binding, and `/permission`.

import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  type AgentBackendFactory,
  type AgentBackendSession,
  type BackendEvent,
  type InteractionHandler,
  type OpenSessionOptions,
  type QuestionItem,
} from '@dsh-raw-agent/core';
import {
  ACCEPT,
  AskDesk,
  CANCEL,
  DECLINE,
  CHAT,
  DISMISS,
  KEEP_PLANNING,
  SUBMIT,
  SessionRegistry,
  SessionRuntime,
  TurnLog,
  WriterAssertError,
  checkElicitationContent,
  checkQuestionReply,
  fallbackVerb,
  findMode,
  interactionsRoute,
  parseAnswer,
  channelLine,
  runModeCommand,
  sessionControlRoutes,
  type AuditOutcome,
  type HostBinding,
  type HostSessionPort,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

const MAIN = { kind: 'main' } as const;
const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((x) => setTimeout(x, 0));
};
const signal = () => new AbortController().signal;
const OPTIONS = [
  { id: 'allow-once', kind: 'allow-once', label: 'Yes' },
  {
    id: 'always-0',
    kind: 'allow-always',
    label: "Yes, and don't ask again for Bash(rm:*)",
    destination: 'project local settings',
    effects: ['Bash(rm:*)'],
  },
  { id: 'reject', kind: 'reject-once', label: 'No', acceptsFeedback: true, feedbackPlaceholder: 'tell Claude' },
] as const;

const permission = (h: InteractionHandler, extra: Record<string, unknown> = {}, s = signal()) =>
  h.permission(
    { id: 'p1', agent: MAIN, toolName: 'Bash', input: { command: 'rm x' }, options: [...OPTIONS], ...extra } as any,
    s,
  );

const QUESTIONS: QuestionItem[] = [
  {
    question: 'Colour?',
    multiSelect: false,
    allowsOther: true,
    options: [{ label: 'Red', preview: '# r' }, { label: 'Blue' }],
  },
  { question: 'Pets?', multiSelect: true, allowsOther: false, options: [{ label: 'Cat' }, { label: 'Dog' }] },
];

describe('AskDesk: full answers (D40-D43)', () => {
  it('permission: the card gets the request data; reject carries feedback, allow refuses it', async () => {
    const desk = new AskDesk(() => {});
    const a = permission(desk.handler(), { callId: 'c1', reason: 'no rule', defaultToNo: true, agentLabel: 'x' });
    await tick();
    const v = desk.list()[0]!;
    expect(v.callId).toBe('c1');
    expect(v.form).toMatchObject({
      type: 'permission',
      toolName: 'Bash',
      input: { command: 'rm x' },
      defaultToNo: true,
    });
    expect(v.choices[1]).toMatchObject({ destination: 'project local settings', effects: ['Bash(rm:*)'] });
    expect(v.choices[2]).toMatchObject({ feedback: true, feedbackPlaceholder: 'tell Claude' });
    expect(desk.respond('p1', { choice: 'allow-once', feedback: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(desk.size).toBe(1); // an invalid reply leaves the ask open
    expect(desk.respond('p1', { choice: 'reject', feedback: 'use trash' })).toEqual({ ok: true });
    expect(await a).toEqual({ optionId: 'reject', feedback: 'use trash' });
    // The first answer wins: a second browser gets "gone".
    expect(desk.respond('p1', { choice: 'allow-once' })).toMatchObject({ ok: false, code: 'gone' });
  });

  it('permission: a huge input is not copied into the view', async () => {
    const desk = new AskDesk(() => {});
    void permission(desk.handler(), { input: { content: 'x'.repeat(600 * 1024) } }).catch(() => {});
    await tick();
    expect(desk.list()[0]!.form).toMatchObject({ type: 'permission', inputTruncated: true });
    expect((desk.list()[0]!.form as any).input).toBeUndefined();
    desk.dropAll();
  });

  it('questions: multi select, "Other" and notes are submitted as the agent expects', async () => {
    const desk = new AskDesk(() => {});
    const q = desk
      .handler()
      .question(
        { id: 'q1', agent: MAIN, questions: QUESTIONS, previewFormat: 'markdown', otherLabel: 'Other' },
        signal(),
      );
    await tick();
    const v = desk.list()[0]!;
    expect(v.form).toMatchObject({ type: 'question', previewFormat: 'markdown', otherLabel: 'Other' });
    expect(v.choices.map((c) => c.id)).toEqual([SUBMIT, DECLINE]);
    expect(desk.respond('q1', { choice: SUBMIT, answers: { 'Pets?': ['Fish'] } })).toMatchObject({ ok: false });
    expect(desk.respond('q1', { choice: SUBMIT, answers: { 'Nope?': 'x' } })).toMatchObject({ ok: false });
    expect(
      desk.respond('q1', {
        choice: SUBMIT,
        answers: { 'Colour?': 'Green, please', 'Pets?': ['Cat', 'Dog'] },
        notes: { 'Colour?': 'any shade', 'Pets?': '  ' },
      }),
    ).toEqual({ ok: true });
    expect(await q).toEqual({
      answers: { 'Colour?': 'Green, please', 'Pets?': ['Cat', 'Dog'] },
      notes: { 'Colour?': 'any shade' },
    });
  });

  it('an editable "always" rule: the edited text goes to the agent; other choices refuse a rule', async () => {
    const desk = new AskDesk(() => {});
    const a = desk.handler().permission(
      {
        id: 'p9',
        agent: MAIN,
        toolName: 'Bash',
        input: { command: 'npm run build' },
        options: [
          { id: 'allow-once', kind: 'allow-once', label: 'Yes' },
          {
            id: 'always-0',
            kind: 'allow-always',
            label: "Yes, and don't ask again for Bash(npm run build)",
            editableRule: { toolName: 'Bash', ruleContent: 'npm run build', placeholder: 'command prefix' },
          },
          { id: 'reject', kind: 'reject-once', label: 'No' },
        ],
      },
      signal(),
    );
    await tick();
    expect(desk.list()[0]!.choices[1]!.editable).toEqual({
      value: 'npm run build',
      toolName: 'Bash',
      placeholder: 'command prefix',
    });
    expect(desk.respond('p9', { choice: 'allow-once', rule: 'x' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(desk.respond('p9', { choice: 'always-0', rule: 'a\nb' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(desk.respond('p9', { choice: 'always-0', rule: ' npm run * ' })).toEqual({ ok: true });
    expect(await a).toEqual({ optionId: 'always-0', ruleContent: 'npm run *' });
    expect(parseAnswer({ ask: 'p', choice: 'c', rule: 'x' })).toMatchObject({ rule: 'x' });
    expect(parseAnswer({ ask: 'p', choice: 'c', rule: 3 })).toMatch(/rule/);
  });

  it('a permission heading without an agent title uses a verb from the input shape (D80)', () => {
    expect(fallbackVerb({ file_path: '/a', old_string: 'x', new_string: 'y' })).toBe('wants to edit');
    expect(fallbackVerb({ file_path: '/a', edits: [] })).toBe('wants to edit');
    expect(fallbackVerb({ file_path: '/a', content: 'x' })).toBe('wants to write');
    expect(fallbackVerb({ url: 'https://x' })).toBe('wants to fetch');
    expect(fallbackVerb({ command: 'ls' })).toBe('wants to run');
    expect(fallbackVerb(null)).toBe('wants to run');
  });

  it('"Chat about this" sends the answers so far (none is fine) and is audited as rejected', async () => {
    const outcomes: string[] = [];
    const desk = new AskDesk(() => {}, Date.now, { closed: (_id, o) => void outcomes.push(o) });
    const h = desk.handler();
    const q = h.question(
      {
        id: 'q1',
        agent: MAIN,
        questions: QUESTIONS,
        previewFormat: 'markdown',
        otherLabel: 'Other',
        chatLabel: 'Chat about this',
      },
      signal(),
    );
    await tick();
    const v = desk.list()[0]!;
    expect(v.choices.map((c) => [c.id, c.partial ?? false])).toEqual([
      [SUBMIT, false],
      [CHAT, true],
      [DECLINE, false],
    ]);
    expect(desk.respond('q1', { choice: CHAT, answers: { 'Nope?': 'x' } })).toMatchObject({ ok: false });
    expect(desk.respond('q1', { choice: CHAT })).toEqual({ ok: true });
    expect(await q).toEqual({ answers: {}, chat: true });
    expect(outcomes).toEqual(['rejected']);
    // Without a chat label the choice is not offered.
    const q2 = h.question(
      { id: 'q2', agent: MAIN, questions: QUESTIONS, previewFormat: 'markdown', otherLabel: 'Other' },
      signal(),
    );
    await tick();
    expect(desk.respond('q2', { choice: CHAT })).toMatchObject({ ok: false });
    desk.respond('q2', { choice: DECLINE });
    expect(await q2).toBeNull();
  });

  it('checkQuestionReply refuses an unknown label without "Other", a list for single select, and nothing', () => {
    const q: QuestionItem[] = [{ question: 'A?', multiSelect: false, allowsOther: false, options: [{ label: 'x' }] }];
    expect(checkQuestionReply(q, { choice: SUBMIT, answers: { 'A?': 'y' } })).toMatch(/not an option/);
    expect(checkQuestionReply(q, { choice: SUBMIT, answers: { 'A?': ['x'] } })).toMatch(/one answer/);
    expect(checkQuestionReply(q, { choice: SUBMIT, answers: {} })).toMatch(/at least one/);
    expect(checkQuestionReply(q, { choice: SUBMIT, answers: { 'A?': 'x' } })).toEqual({ answers: { 'A?': 'x' } });
  });

  it('plans: keep planning carries feedback; an approve choice takes none', async () => {
    const desk = new AskDesk(() => {});
    const p = desk.handler().plan(
      {
        id: 'pl',
        agent: MAIN,
        plan: '1. do it',
        planFilePath: '/p.md',
        choices: [{ id: 'yes', label: 'Yes' }],
        keepPlanning: { label: 'No, keep planning', feedbackPlaceholder: 'Tell Claude what to change' },
      },
      signal(),
    );
    await tick();
    const v = desk.list()[0]!;
    expect(v.form).toEqual({ type: 'plan', plan: '1. do it', planFilePath: '/p.md' });
    expect(v.choices[1]).toMatchObject({
      id: KEEP_PLANNING,
      feedback: true,
      feedbackPlaceholder: 'Tell Claude what to change',
    });
    expect(desk.respond('pl', { choice: 'yes', feedback: 'x' })).toMatchObject({ ok: false });
    desk.respond('pl', { choice: KEEP_PLANNING, feedback: 'add tests' });
    expect(await p).toEqual({ kind: 'keep-planning', feedback: 'add tests' });
  });

  it('elicitation forms: accept with content checked against the schema; decline and cancel', async () => {
    const desk = new AskDesk(() => {});
    const schema = {
      type: 'object',
      properties: { name: { type: 'string' }, n: { type: 'integer' } },
      required: ['name'],
    };
    const e = desk
      .handler()
      .elicitation({ id: 'e1', serverName: 'srv', message: 'Who?', mode: 'form', requestedSchema: schema }, signal());
    await tick();
    expect(desk.list()[0]!.form).toMatchObject({ type: 'elicitation', mode: 'form', requestedSchema: schema });
    expect(desk.respond('e1', { choice: ACCEPT })).toMatchObject({ ok: false, error: /not filled/ });
    expect(desk.respond('e1', { choice: ACCEPT, content: { n: 3 } })).toMatchObject({ ok: false, error: /name/ });
    expect(desk.respond('e1', { choice: ACCEPT, content: { name: 'Ada', x: 1 } })).toMatchObject({ ok: false });
    expect(desk.respond('e1', { choice: ACCEPT, content: { name: 'Ada', n: 3 } })).toEqual({ ok: true });
    expect(await e).toEqual({ action: 'accept', content: { name: 'Ada', n: 3 } });
    const c = desk.handler().elicitation({ id: 'e2', serverName: 'srv', message: 'x' }, signal());
    await tick();
    desk.respond('e2', { choice: CANCEL });
    expect(await c).toEqual({ action: 'cancel' });
    expect(checkElicitationContent(undefined, { a: { deep: 1 } })).toMatch(/must be text/);
  });

  it('URL elicitation: after accept the card waits until the agent reports it done (D43)', async () => {
    const desk = new AskDesk(() => {});
    const h = desk.handler();
    const e = h.elicitation(
      { id: 'u1', serverName: 'srv', message: 'Sign in', mode: 'url', url: 'https://x/a' },
      signal(),
    );
    await tick();
    expect(desk.respond('u1', { choice: ACCEPT, content: { token: 'x' } })).toMatchObject({
      ok: false,
      code: 'invalid',
    });
    expect(desk.respond('u1', { choice: DECLINE, content: {} })).toMatchObject({ ok: false, code: 'invalid' });
    desk.respond('u1', { choice: ACCEPT });
    expect(await e).toEqual({ action: 'accept' });
    const w = desk.list()[0]!;
    expect(w).toMatchObject({ id: 'u1', state: 'waiting', choices: [{ id: DISMISS }] });
    expect(desk.stop()).toBe(0); // Stop never touches a waiting card
    expect(desk.done('u1')).toBe(true);
    expect(desk.size).toBe(0);
    // Dismiss closes it on this side only.
    const e2 = h.elicitation(
      { id: 'u2', serverName: 'srv', message: 'Sign in', mode: 'url', url: 'https://x/b' },
      signal(),
    );
    await tick();
    desk.respond('u2', { choice: ACCEPT });
    await e2;
    expect(desk.respond('u2', { choice: DISMISS })).toEqual({ ok: true });
    expect(desk.size).toBe(0);
    // The agent withdraws a pending one.
    const e3 = h.elicitation({ id: 'u3', serverName: 'srv', message: 'x' }, signal());
    await tick();
    expect(desk.cancel('u3')).toBe(true);
    await expect(e3).rejects.toThrow(/cancelled/);
  });
});

describe('AskDesk audit hooks (D44)', () => {
  it('reports opened and the outcome; elicitations and trust are not audited', async () => {
    const log: Array<[string, string]> = [];
    const desk = new AskDesk(
      () => {},
      () => 1,
      {
        opened: (v, info) => log.push(['asked', `${v.id}:${info.toolName}:${info.callId ?? ''}`]),
        closed: (id, o) => log.push([id, o]),
      },
    );
    const h = desk.handler();
    const p = permission(h, { callId: 'c1' });
    await tick();
    desk.respond('p1', { choice: 'always-0' });
    await p;
    const q = h.question(
      { id: 'q', agent: MAIN, questions: QUESTIONS, previewFormat: 'markdown', otherLabel: 'Other' },
      signal(),
    );
    await tick();
    desk.respond('q', { choice: DECLINE });
    await q;
    const ac = new AbortController();
    const pl = h.plan({ id: 'pl', agent: MAIN, plan: 'x', choices: [], keepPlanning: { label: 'No' } }, ac.signal);
    await tick();
    ac.abort();
    await expect(pl).rejects.toThrow();
    void h.elicitation({ id: 'e', serverName: 's', message: 'm' }, signal()).catch(() => {});
    await tick();
    desk.dropAll();
    expect(log).toEqual([
      ['asked', 'p1:Bash:c1'],
      ['p1', 'allowed-once'],
      ['asked', 'q:AskUserQuestion:'],
      ['q', 'rejected'],
      ['asked', 'pl:ExitPlanMode:'],
      ['pl', 'cancelled'],
    ]);
  });
});

describe('TurnLog approval audit (D44)', () => {
  function writer() {
    const events: Array<{ type: string; data: any }> = [];
    const session = {
      id: 's',
      get seq() {
        return events.length - 1;
      },
      header: {},
      append(type: string, data: unknown) {
        events.push({ type, data: data as any });
        return { seq: events.length - 1 };
      },
      snapshotEvents: () => events as never,
    };
    const log = new TurnLog(session, { emit: () => {}, nextRevision: () => 1, nextAttemptId: () => 'a' }, 1, {
      provider: 'p',
    });
    return { log, events };
  }

  it('writes the pair once; close() cancels what is still open; nothing after close', () => {
    const w = writer();
    const a = w.log.approvalAsked({ toolName: 'Bash', callId: 'c1', reason: 'r' });
    const b = w.log.approvalAsked({ toolName: 'ExitPlanMode' });
    w.log.approvalDecided(a, 'rejected');
    w.log.approvalDecided(a, 'allowed-once'); // ignored
    w.log.close();
    expect(w.events.map((e) => [e.type, e.data])).toEqual([
      ['approval/asked', { id: a, toolName: 'Bash', callId: 'c1', reason: 'r' }],
      ['approval/asked', { id: b, toolName: 'ExitPlanMode' }],
      ['approval/decided', { id: a, outcome: 'rejected' }],
      ['approval/decided', { id: b, outcome: 'cancelled' }],
    ]);
    expect(() => w.log.approvalAsked({ toolName: 'Bash' })).toThrow(WriterAssertError);
    expect(() => writer().log.approvalAsked({ toolName: '' })).toThrow(WriterAssertError);
  });
});

// ---- the runtime ----

interface Fake {
  factory: AgentBackendFactory;
  opens: OpenSessionOptions[];
  queues: AsyncQueue<BackendEvent>[];
  controls: Array<[string, unknown]>;
}

function fake(): Fake {
  const f: Fake = { factory: undefined as never, opens: [], queues: [], controls: [] };
  f.factory = {
    kind: 'k',
    displayName: 'Agent',
    staticCapabilities: {
      ids: 'agent-chosen',
      resume: true,
      fork: 'none',
      needsProcess: [],
      permissionModes: [
        { id: 'default', label: 'Ask before edits' },
        { id: 'acceptEdits', label: 'Accept edits' },
        { id: 'plan', label: 'Plan mode' },
      ],
      mainAgentPicker: 'none',
      steer: 'native',
    },
    async open(o) {
      f.opens.push(o);
      const q = new AsyncQueue<BackendEvent>();
      f.queues.push(q);
      const s: AgentBackendSession = {
        kind: 'k',
        sessionId: 'b1',
        startedAs: 'new',
        capabilities: {
          perTaskStop: true,
          sideQuestions: false,
          workflows: false,
          teamMessaging: false,
          cancelQueued: false,
          fileRewind: false,
          planChoices: [],
        },
        events: () => q,
        async send(u) {
          q.push({ type: 'turn-start', origin: 'user' });
          q.push({ type: 'input-consumed', inputId: u.id });
          q.push({ type: 'step-start', agent: MAIN, stepId: 's', at: 1 } as any);
        },
        async interrupt() {
          q.push({ type: 'turn-end', agent: MAIN, outcome: 'interrupted', pendingInputs: 0 });
          return { cancelledInputIds: [] };
        },
        async forceStop() {
          q.push({ type: 'exit' });
          q.end();
        },
        async dispose() {
          q.push({ type: 'exit' });
          q.end();
        },
        controls: {
          async setPermissionMode(mode) {
            f.controls.push(['setPermissionMode', mode]);
            q.push({ type: 'mode', mode });
          },
        },
      };
      return s;
    },
  };
  return f;
}

function port(binding?: HostBinding): HostSessionPort {
  return {
    hostSessionId: 'h1',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => binding,
    startJob: () => undefined,
    warn: () => {},
  };
}

function sink(): TurnSink & { audit: Array<[string, unknown]>; bindings: unknown[] } {
  let open = false;
  let n = 0;
  const audit: Array<[string, unknown]> = [];
  const bindings: unknown[] = [];
  return {
    audit,
    bindings,
    get stepOpen() {
      return open;
    },
    hasMessage: false,
    openCallIds: [],
    hasCall: () => false,
    openStep: () => void (open = true),
    delta: () => {},
    commit: (m) => {
      bindings.push(m.binding);
      return { calls: [] };
    },
    result: () => {},
    closeStep: () => void (open = false),
    claim: () => true,
    approvalAsked: (info) => {
      const id = `a${++n}`;
      audit.push(['asked', { id, ...info }]);
      return id;
    },
    approvalDecided: (id: string, outcome: AuditOutcome) => void audit.push(['decided', { id, outcome }]),
  };
}

const text = (id: string) => ({ id, parts: [{ type: 'text' as const, text: 'hi' }] });

describe('SessionRuntime: audit pair only inside the turn, main thread only (D44)', () => {
  it('audits a main ask in the turn, skips a child ask, writes nothing outside a turn', async () => {
    const f = fake();
    const r = new SessionRuntime(f.factory, port(), { env: {} });
    const s = sink();
    const turn = r.runTurn(s, { userInputs: [text('u1')], wake: false }, signal());
    await tick(10);
    const h = f.opens[0]!.interactions;
    const main = permission(h, { callId: 'c1' });
    void h
      .permission(
        { id: 'c', agent: { kind: 'child', id: 'a' }, toolName: 'Bash', input: {}, options: [...OPTIONS] },
        signal(),
      )
      .catch(() => {});
    await tick();
    r.respond('p1', { choice: 'reject' });
    await main;
    void permission(h, { id: 'p2' }).catch(() => {});
    await tick();
    f.queues[0]!.push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 });
    expect(await turn).toEqual({ kind: 'completed' });
    expect(s.audit).toEqual([
      ['asked', { id: 'a1', toolName: 'Bash', callId: 'c1' }],
      ['decided', { id: 'a1', outcome: 'rejected' }],
      ['asked', { id: 'a2', toolName: 'Bash' }],
      ['decided', { id: 'a2', outcome: 'cancelled' }], // D74: before the turn ends
    ]);
    // Outside a turn: the ask waits for the user, nothing is written.
    void permission(h, { id: 'p3' }).catch(() => {});
    await tick();
    r.respond('p3', { choice: 'allow-once' });
    r.respond('p2', { choice: 'allow-once' }); // decided after its turn: nothing more written
    expect(s.audit).toHaveLength(4);
  });

  it('subscribe() pushes the asks after every change; interaction-done closes a waiting URL card', async () => {
    const f = fake();
    const r = new SessionRuntime(f.factory, port(), { env: {} });
    await r.start();
    const seen: number[] = [];
    const off = r.subscribe((v) => seen.push(v.asks?.length ?? 0));
    const h = f.opens[0]!.interactions;
    const e = h.elicitation({ id: 'u1', serverName: 's', message: 'm', mode: 'url', url: 'https://x' }, signal());
    await tick();
    r.respond('u1', { choice: ACCEPT });
    await e;
    expect(r.view().asks?.[0]?.state).toBe('waiting');
    f.queues[0]!.push({ type: 'interaction-done', id: 'u1' });
    await tick();
    expect(r.view().asks).toBeUndefined();
    off();
    expect(seen).toContain(1);
    expect(seen.at(-1)).toBe(0);
  });
});

describe('SessionRuntime: the mode choice survives a host restart (D24)', () => {
  it('writes the reported mode into the binding only after a choice', async () => {
    const f = fake();
    const r = new SessionRuntime(f.factory, port(), { env: {} });
    const s1 = sink();
    const t1 = r.runTurn(s1, { userInputs: [text('u1')], wake: false }, signal());
    await tick(10);
    f.queues[0]!.push({
      type: 'step-message',
      agent: MAIN,
      stepId: 's',
      blocks: [{ type: 'text', text: 'a' }],
      final: true,
    } as any);
    f.queues[0]!.push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 });
    await t1;
    expect((s1.bindings[0] as any).mode).toBeUndefined();
    await r.choose({ mode: 'acceptEdits' });
    await tick();
    const s2 = sink();
    const t2 = r.runTurn(s2, { userInputs: [text('u2')], wake: false }, signal());
    await tick(10);
    f.queues[0]!.push({ type: 'mode', mode: 'plan' }); // a plan transition the CLI reports
    f.queues[0]!.push({
      type: 'step-message',
      agent: MAIN,
      stepId: 's',
      blocks: [{ type: 'text', text: 'b' }],
      final: true,
    } as any);
    f.queues[0]!.push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 });
    await t2;
    expect((s2.bindings[0] as any).mode).toBe('plan');
  });

  it('a new runtime reads it back as a pending choice and applies it after the spawn', async () => {
    const f = fake();
    const r = new SessionRuntime(f.factory, port({ sessionId: 'b1', mode: 'acceptEdits' }), { env: {} });
    expect(r.view().choice.pendingMode).toBe('acceptEdits');
    await r.start();
    await tick();
    expect(f.controls).toEqual([['setPermissionMode', 'acceptEdits']]);
    expect(r.view().live.mode).toBe('acceptEdits');
    // An unknown mode (another backend version) is ignored; no binding mode means no call.
    const g = fake();
    const r2 = new SessionRuntime(g.factory, port({ sessionId: 'b1', mode: 'weird' }), { env: {} });
    await r2.start();
    const g2 = fake();
    const r3 = new SessionRuntime(g2.factory, port({ sessionId: 'b1' }), { env: {} });
    await r3.start();
    expect([...g.controls, ...g2.controls]).toEqual([]);
  });

  it("a DSH fork (inherited binding) does not carry the parent's mode choice; its own binding does", () => {
    const f = fake();
    const fork = new SessionRuntime(
      f.factory,
      port({ sessionId: 'b1', hostSessionId: 'parent', mode: 'acceptEdits' }),
      {
        env: {},
      },
    );
    expect(fork.view().choice.pendingMode).toBeUndefined();
    const own = new SessionRuntime(fake().factory, port({ sessionId: 'b1', hostSessionId: 'h1', mode: 'plan' }), {
      env: {},
    });
    expect(own.view().choice.pendingMode).toBe('plan');
  });
});

describe('interaction channel routes (D39)', () => {
  it('parseAnswer keeps the form fields and checks their shape', () => {
    expect(parseAnswer({ ask: 'p1', choice: 'reject', feedback: 'no' })).toEqual({
      ask: 'p1',
      choice: 'reject',
      feedback: 'no',
    });
    expect(parseAnswer({ ask: 'q', choice: 'submit', answers: { 'A?': 'x' }, notes: {} })).toMatchObject({
      answers: { 'A?': 'x' },
    });
    expect(parseAnswer({ ask: 'e', choice: 'accept', content: { a: 1 } })).toMatchObject({ content: { a: 1 } });
    expect(parseAnswer({ ask: 'p', choice: 'r', feedback: 3 })).toMatch(/feedback/);
    expect(parseAnswer({ ask: 'p', choice: 'r', answers: [] })).toMatch(/answers/);
    expect(parseAnswer({ ask: 'p', choice: 'r', content: 'x' })).toMatch(/content/);
    expect(parseAnswer({ ask: 'p', choice: 'r', feedback: 'x'.repeat(600 * 1024) })).toMatch(/too large/);
  });

  it('streams the open asks on connect and after each change; the POST answer closes them', async () => {
    const f = fake();
    const reg = new SessionRegistry();
    const r = new SessionRuntime(f.factory, port(), { env: {} });
    reg.set('h1', 'k', r);
    await r.start();
    const route = interactionsRoute(reg, 60_000);
    expect((await route.fetch(new Request('http://h/api/raw-agent/interactions?session=nope'))).status).toBe(404);
    const ac = new AbortController();
    const res = await route.fetch(new Request('http://h/api/raw-agent/interactions?session=h1', { signal: ac.signal }));
    expect(res.headers.get('content-type')).toMatch(/ndjson/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    const line = async () => JSON.parse(dec.decode((await reader.read()).value).trim());
    expect((await line()).asks).toEqual([]);
    const a = permission(f.opens[0]!.interactions, { callId: 'c1' });
    const pushed = await line();
    expect(pushed.asks.map((x: any) => [x.id, x.callId])).toEqual([['p1', 'c1']]);
    const answer = sessionControlRoutes(reg, { factories: [f.factory] }).find((x) => x.path.endsWith('/answer'))!;
    const post = (body: unknown) =>
      answer.fetch(
        new Request('http://h/api/raw-agent/answer?session=h1', { method: 'POST', body: JSON.stringify(body) }),
      );
    expect((await post({ ask: 'p1', choice: 'allow-once', feedback: 'x' })).status).toBe(400);
    expect((await post({ ask: 'p1', choice: 'reject', feedback: 'nope' })).status).toBe(200);
    expect(await a).toEqual({ optionId: 'reject', feedback: 'nope' });
    expect((await line()).asks).toEqual([]);
    expect((await post({ ask: 'p1', choice: 'reject' })).status).toBe(409); // first answer won
    ac.abort();
    expect((await reader.read()).done).toBe(true);
  });

  it('closes an open channel when its session runtime is disposed (no ping timer left)', async () => {
    const f = fake();
    const reg = new SessionRegistry();
    const r = new SessionRuntime(f.factory, port(), { env: {} });
    reg.set('h1', 'k', r);
    await r.start();
    const route = interactionsRoute(reg, 5);
    const res = await route.fetch(new Request('http://h/api/raw-agent/interactions?session=h1'));
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false); // the first `asks` line
    await r.dispose();
    let done = false;
    for (let i = 0; i < 10 && !done; i++) done = (await reader.read()).done; // pings queued before the close
    expect(done).toBe(true);
    // A late subscriber to a disposed runtime is ended at once.
    let ended = 0;
    const off = r.subscribe(
      () => {},
      () => ended++,
    );
    off();
    expect(ended).toBe(1);
  });
});

describe('/permission in our sessions (R1.4 leftover)', () => {
  const factory = fake().factory;
  const runtime = (mode?: string) => {
    const calls: string[] = [];
    return {
      calls,
      view: () => ({ state: {}, live: mode ? { mode } : {}, choice: { applied: {}, resetPending: false } }) as any,
      choose: async (req: { mode: string }) => {
        calls.push(req.mode);
        return { ok: true, note: 'applied', view: {} as any };
      },
    };
  };

  it('shows the agent mode and says DSH presets do not apply', async () => {
    const r = await runModeCommand(runtime('plan'), factory, '');
    expect(r.kind).toBe('success');
    expect(r.text).toMatch(/Agent permission mode: Plan mode \(plan\)/);
    expect(r.text).toMatch(/DSH permission presets do not apply/);
  });

  it('switches by id or label; a DSH preset name changes nothing', async () => {
    const rt = runtime();
    expect(await runModeCommand(rt, factory, 'accept edits')).toMatchObject({ kind: 'success' });
    expect(await runModeCommand(rt, factory, 'plan')).toMatchObject({ kind: 'success' });
    expect(await runModeCommand(rt, factory, 'read-only')).toMatchObject({ kind: 'error' });
    expect(rt.calls).toEqual(['acceptEdits', 'plan']);
    expect(await runModeCommand(undefined, factory, '')).toMatchObject({ kind: 'error' });
    expect(findMode(factory.staticCapabilities.permissionModes, 'ACCEPT_EDITS')?.id).toBe('acceptEdits');
  });

  it('the answer also goes to the status line (DSH shows no command result in the chat)', async () => {
    const notices: Array<[string, string]> = [];
    const rt = { ...runtime('plan'), showNotice: (l: string, t: string) => void notices.push([l, t]) };
    await runModeCommand(rt, factory, 'read-only');
    await runModeCommand(rt, factory, 'plan');
    expect(notices.map((n) => n[0])).toEqual(['warning', 'info']);
    expect(notices[0]![1]).toMatch(/nothing changed/);
  });

  it('SessionRuntime.showNotice sets the live notice and tells the channel', () => {
    const r = new SessionRuntime(fake().factory, port(), { env: {} });
    const seen: unknown[] = [];
    r.subscribe((v) => void seen.push(v.live.notice?.text));
    r.showNotice('info', 'hello');
    expect(r.view().live.notice).toMatchObject({ level: 'info', text: 'hello' });
    expect(seen).toEqual(['hello']);
    expect(channelLine(r.view())).toMatch(/"live":\{"notice":\{"level":"info","text":"hello"/);
  });
});
