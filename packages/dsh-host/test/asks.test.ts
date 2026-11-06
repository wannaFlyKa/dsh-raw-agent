// Asks are held for the user (rules 3, 4; M1 verify): no auto-reject, no auto-allow. Stop gives
// the agent's own Esc answer. Also: the D73 trust question, input-consumed outside a turn, the
// answer route, and the read-only preview file read (symlinks, size limit).

import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  type AgentBackendFactory,
  type AgentBackendSession,
  type BackendEvent,
  type ElicitationAnswer,
  type InteractionHandler,
  type OpenSessionOptions,
  type PermissionAnswer,
  type TrustState,
  type UserInput,
} from '@dsh-raw-agent/core';
import {
  AskDesk,
  DECLINE,
  KEEP_PLANNING,
  SessionRegistry,
  SessionRuntime,
  TRUST_ACCEPT,
  TRUST_DECLINE,
  parseAnswer,
  readFileForPreview,
  sessionControlRoutes,
  type HostSessionPort,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

const MAIN = { kind: 'main' } as const;
const tick = async (n = 3): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((x) => setTimeout(x, 0));
};
const input = (id: string): UserInput => ({ id, parts: [{ type: 'text', text: 'hi' }] });

const PERMISSION_OPTIONS = [
  { id: 'allow-once', kind: 'allow-once', label: 'Allow once' },
  { id: 'always-0', kind: 'allow-always', label: 'Always allow (project local settings)' },
  { id: 'reject', kind: 'reject-once', label: 'Reject' },
] as const;

describe('AskDesk (held asks)', () => {
  const permission = (h: InteractionHandler, signal = new AbortController().signal) =>
    h.permission(
      { id: 'p1', agent: MAIN, toolName: 'Bash', input: { command: 'ls -la' }, options: [...PERMISSION_OPTIONS] },
      signal,
    );

  it('holds a permission ask until the user answers; nothing is answered for the user', async () => {
    let changes = 0;
    const desk = new AskDesk(
      () => changes++,
      () => 7,
    );
    let answered: PermissionAnswer | undefined;
    void permission(desk.handler()).then((a) => (answered = a));
    await tick();
    expect(answered).toBeUndefined();
    expect(desk.list()).toEqual([
      {
        id: 'p1',
        kind: 'permission',
        agent: 'main',
        title: 'Bash wants to run',
        detail: 'ls -la',
        choices: PERMISSION_OPTIONS.map((o) => ({ id: o.id, label: o.label, kind: o.kind })),
        stopChoice: 'reject',
        at: 7,
        form: { type: 'permission', toolName: 'Bash', input: { command: 'ls -la' } },
      },
    ]);
    expect(desk.answer('p1', 'not-offered')).toBe(false);
    expect(desk.answer('p1', 'always-0')).toBe(true);
    await tick();
    expect(answered).toEqual({ optionId: 'always-0' });
    expect(desk.size).toBe(0);
    expect(changes).toBe(2);
    expect(desk.answer('p1', 'allow-once')).toBe(false);
  });

  it('shows the command with the tool description, never the description alone', async () => {
    const desk = new AskDesk(() => {});
    void desk.handler().permission(
      {
        id: 'p2',
        agent: MAIN,
        toolName: 'Bash',
        input: { command: 'ln -s README.md link', description: 'Create a link' },
        description: 'Create a link',
        options: [...PERMISSION_OPTIONS],
      },
      new AbortController().signal,
    );
    await tick();
    expect(desk.list()[0]?.detail).toBe('ln -s README.md link — Create a link');
    void desk.handler().permission(
      {
        id: 'p3',
        agent: MAIN,
        toolName: 'X',
        input: undefined,
        description: 'Only text',
        options: [...PERMISSION_OPTIONS],
      },
      new AbortController().signal,
    );
    await tick();
    expect(desk.list()[1]?.detail).toBe('Only text');
    desk.stop();
  });

  it('Stop limited to the main thread leaves a subagent ask open', async () => {
    const desk = new AskDesk(() => {});
    const child = desk.handler().permission(
      {
        id: 'c1',
        agent: { kind: 'child', id: 'a1' },
        toolName: 'Bash',
        input: { command: 'ls' },
        options: [...PERMISSION_OPTIONS],
      },
      new AbortController().signal,
    );
    const main = permission(desk.handler());
    await tick();
    expect(desk.stop(undefined, ['main'])).toBe(1);
    expect(await main).toEqual({ optionId: 'reject' });
    expect(desk.list().map((a) => a.id)).toEqual(['c1']);
    desk.answer('c1', 'allow-once');
    expect(await child).toEqual({ optionId: 'allow-once' });
  });

  it('Stop answers with the reject option (the agent Esc answer); an aborted ask is just dropped', async () => {
    const desk = new AskDesk(() => {});
    const a = permission(desk.handler());
    await tick();
    expect(desk.stop()).toBe(1);
    expect(await a).toEqual({ optionId: 'reject' });

    const ac = new AbortController();
    const b = permission(desk.handler(), ac.signal);
    await tick();
    ac.abort();
    await expect(b).rejects.toThrow(/cancelled/);
    expect(desk.size).toBe(0);

    const c = permission(desk.handler());
    await tick();
    desk.dropAll();
    await expect(c).rejects.toThrow(/ended/);
  });

  it('questions: one single-select question offers its options; others can only be declined', async () => {
    const desk = new AskDesk(() => {});
    const h = desk.handler();
    const q = h.question(
      {
        id: 'q1',
        agent: { kind: 'child', id: 'a1' },
        questions: [{ question: 'Which colour?', options: [{ label: 'Red' }, { label: 'Blue' }] }] as never,
      },
      new AbortController().signal,
    );
    await tick();
    const v = desk.list()[0]!;
    expect(v).toMatchObject({ kind: 'question', agent: 'child', title: 'Which colour?', stopChoice: DECLINE });
    expect(v.choices.map((c) => c.label)).toEqual(['Red', 'Blue', 'Submit answers', 'Decline']);
    desk.answer('q1', 'option-1');
    expect(await q).toEqual({ answers: { 'Which colour?': 'Blue' } });

    const multi = h.question(
      {
        id: 'q2',
        agent: MAIN,
        questions: [{ question: 'A?', multiSelect: true, options: [{ label: 'x' }] }] as never,
      },
      new AbortController().signal,
    );
    await tick();
    expect(desk.list()[0]!.choices.map((c) => c.id)).toEqual(['submit', DECLINE]);
    desk.answer('q2', DECLINE);
    expect(await multi).toBeNull();
  });

  it('plans offer the backend choices plus "No, keep planning"; elicitations can be declined', async () => {
    const desk = new AskDesk(() => {});
    const h = desk.handler();
    const p = h.plan(
      {
        id: 'pl',
        agent: MAIN,
        plan: '1. do it',
        choices: [{ id: 'yes', label: 'Yes' }],
        keepPlanning: { label: 'No, keep planning' },
      },
      new AbortController().signal,
    );
    await tick();
    expect(desk.list()[0]!.choices.map((c) => c.id)).toEqual(['yes', KEEP_PLANNING]);
    desk.answer('pl', 'yes');
    expect(await p).toEqual({ kind: 'approve', choiceId: 'yes' });
    const p2 = h.plan(
      { id: 'pl2', agent: MAIN, plan: 'x', choices: [], keepPlanning: { label: 'No' } },
      new AbortController().signal,
    );
    await tick();
    desk.stop();
    expect(await p2).toEqual({ kind: 'keep-planning' });
    const e = h.elicitation({ id: 'e', serverName: 'srv', message: 'token?' }, new AbortController().signal);
    await tick();
    expect(desk.list()[0]!.title).toBe('srv: token?');
    desk.answer('e', DECLINE);
    expect(await e).toEqual({ action: 'decline' });
  });
});

// ---- the runtime ----

interface Fake {
  factory: AgentBackendFactory;
  opens: OpenSessionOptions[];
  queues: AsyncQueue<BackendEvent>[];
  interrupts: number;
  answers: PermissionAnswer[];
  elicited: ElicitationAnswer[];
}

/** A backend whose turn asks for permission before it ends. */
function fake(trust?: () => Promise<TrustState>): Fake {
  const f: Fake = { factory: undefined as never, opens: [], queues: [], interrupts: 0, answers: [], elicited: [] };
  f.factory = {
    kind: 'k',
    displayName: 'Agent',
    staticCapabilities: {
      ids: 'agent-chosen',
      resume: true,
      fork: 'none',
      needsProcess: [],
      permissionModes: [{ id: 'default', label: 'Ask' }],
      mainAgentPicker: 'none',
      steer: 'native',
    },
    ...(trust ? { trustState: () => trust() } : {}),
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
          if (u.parts.some((p) => p.type === 'text' && p.text === 'elicit')) {
            // An MCP server of a background agent asks for input; the agent keeps running.
            void o.interactions
              .elicitation(
                { id: 'el1', agent: { kind: 'child', id: 'bg' }, serverName: 'srv', message: 'token?' },
                new AbortController().signal,
              )
              .then(
                (a) => void f.elicited.push(a),
                () => undefined,
              );
            return;
          }
          const child = u.parts.some((p) => p.type === 'text' && p.text === 'ask-child');
          if (child) {
            // A background agent asks while the main turn waits on something else.
            void o.interactions
              .permission(
                {
                  id: 'c1',
                  agent: { kind: 'child', id: 'bg' },
                  toolName: 'Bash',
                  input: { command: 'touch y' },
                  options: [...PERMISSION_OPTIONS],
                },
                new AbortController().signal,
              )
              .then(
                (a) => void f.answers.push(a),
                () => undefined,
              );
            return;
          }
          if (!u.parts.some((p) => p.type === 'text' && p.text === 'ask')) {
            q.push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 });
            return;
          }
          // As the SDK does: send returns at once; the ask arrives on its own (canUseTool).
          void o.interactions
            .permission(
              { id: 'p1', agent: MAIN, toolName: 'Bash', input: { command: 'rm x' }, options: [...PERMISSION_OPTIONS] },
              new AbortController().signal,
            )
            .then(
              (a) => void f.answers.push(a),
              () => undefined,
            )
            .finally(() => q.push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 }));
        },
        async interrupt() {
          f.interrupts++;
          // The main turn ends; a background agent (if any) keeps running.
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
        controls: {},
      };
      return s;
    },
  };
  return f;
}

function port(): HostSessionPort & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    hostSessionId: 'h1',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => undefined,
    startJob: () => undefined,
    warn: (n) => void warnings.push(n),
    warnings,
  };
}

function sink(): TurnSink {
  return {
    stepOpen: false,
    hasMessage: false,
    openCallIds: [],
    hasCall: () => false,
    openStep: () => {},
    delta: () => {},
    commit: () => ({ calls: [] }),
    result: () => {},
    closeStep: () => {},
    claim: () => true,
  };
}

const askInput: UserInput = { id: 'u1', parts: [{ type: 'text', text: 'ask' }] };

describe('SessionRuntime asks (rules 3, 4)', () => {
  it('a permission ask waits in the view until the user answers it; the answer reaches the backend', async () => {
    const f = fake();
    const r = new SessionRuntime(f.factory, port(), { env: {} });
    const turn = r.runTurn(sink(), { userInputs: [askInput], wake: false }, new AbortController().signal);
    await tick(10);
    expect(r.view().asks?.map((a) => a.id)).toEqual(['p1']);
    expect(r.state().waiting).toBe(1);
    expect(f.answers).toEqual([]); // never answered for the user
    expect(r.answer('p1', 'allow-once')).toBe(true);
    expect(await turn).toEqual({ kind: 'completed' });
    expect(f.answers).toEqual([{ optionId: 'allow-once' }]);
    expect(r.view().asks).toBeUndefined();
  });

  it('Stop interrupts and gives an open ask the reject option, as Esc does in the terminal app', async () => {
    const f = fake();
    const r = new SessionRuntime(f.factory, port(), { env: {}, stopGraceMs: 50 });
    const stop = new AbortController();
    const turn = r.runTurn(sink(), { userInputs: [askInput], wake: false }, stop.signal);
    await tick(10);
    stop.abort();
    await turn;
    expect(f.interrupts).toBe(1);
    expect(f.answers).toEqual([{ optionId: 'reject' }]);
  });

  it('Stop leaves a background agent ask open: no reject the user never picked (rule 6)', async () => {
    const f = fake();
    const r = new SessionRuntime(f.factory, port(), { env: {}, stopGraceMs: 50 });
    const stop = new AbortController();
    const childInput: UserInput = { id: 'u2', parts: [{ type: 'text', text: 'ask-child' }] };
    const turn = r.runTurn(sink(), { userInputs: [childInput], wake: false }, stop.signal);
    await tick(10);
    expect(r.view().asks?.map((a) => [a.id, a.agent])).toEqual([['c1', 'child']]);
    stop.abort();
    expect(await turn).toEqual({ kind: 'interrupted' });
    await tick(5);
    expect(f.interrupts).toBe(1);
    expect(f.answers).toEqual([]);
    expect(r.view().asks?.map((a) => a.id)).toEqual(['c1']);
    expect(r.answer('c1', 'allow-once')).toBe(true);
    await tick();
    expect(f.answers).toEqual([{ optionId: 'allow-once' }]);
  });
});

describe('Stop and elicitations (M1 verify 3-2 item 5)', () => {
  it('Stop never declines an elicitation; the agent cancels the ones its interrupt ends', async () => {
    const f = fake();
    const r = new SessionRuntime(f.factory, port(), { env: {}, stopGraceMs: 50 });
    const stop = new AbortController();
    const turn = r.runTurn(
      sink(),
      { userInputs: [{ id: 'u3', parts: [{ type: 'text', text: 'elicit' }] }], wake: false },
      stop.signal,
    );
    await tick(10);
    expect(r.view().asks?.map((a) => [a.id, a.agent])).toEqual([['el1', 'child']]);
    stop.abort();
    expect(await turn).toEqual({ kind: 'interrupted' });
    await tick(5);
    expect(f.elicited).toEqual([]);
    expect(r.view().asks?.map((a) => a.id)).toEqual(['el1']);
  });
});

describe('workspace trust (D73)', () => {
  const untrusted = async (): Promise<TrustState> => ({
    state: 'untrusted',
    directory: '/w',
    untrustedEffect: 'project permission rules are ignored',
    question: { title: 'Accessing workspace:', body: 'Is this yours?', acceptLabel: 'Yes', declineLabel: 'No' },
  });

  it('asks before the first spawn; accept passes trustAccepted, never without the click', async () => {
    const f = fake(untrusted);
    const r = new SessionRuntime(f.factory, port(), { env: {} });
    const turn = r.runTurn(sink(), { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    await tick(10);
    expect(f.opens).toHaveLength(0);
    const ask = r.view().asks?.[0];
    expect(ask).toMatchObject({ kind: 'trust', title: 'Accessing workspace: /w', stopChoice: TRUST_DECLINE });
    r.answer(ask!.id, TRUST_ACCEPT);
    expect(await turn).toEqual({ kind: 'completed' });
    expect(f.opens[0]!.trustAccepted).toEqual({ directory: '/w' });
  });

  it('decline (or Stop) does not start the agent and says so', async () => {
    const f = fake(untrusted);
    const r = new SessionRuntime(f.factory, port(), { env: {} });
    const turn = r.runTurn(sink(), { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    await tick(10);
    r.answer(r.view().asks![0]!.id, TRUST_DECLINE);
    const out = await turn;
    expect(out.kind).toBe('error');
    expect((out as { message: string }).message).toMatch(/did not trust this folder/);
    expect(f.opens).toHaveLength(0);

    const stop = new AbortController();
    const again = r.runTurn(sink(), { userInputs: [input('u2')], wake: false }, stop.signal);
    await tick(10);
    stop.abort();
    expect((await again).kind).toBe('error');
    expect(f.opens).toHaveLength(0);
  });

  it('a trusted folder is not asked; an unreadable record spawns without trust and shows a notice', async () => {
    const t = fake(async () => ({ state: 'trusted', directory: '/w' }));
    const r1 = new SessionRuntime(t.factory, port(), { env: {} });
    await r1.runTurn(sink(), { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    expect(t.opens[0]!.trustAccepted).toBeUndefined();

    const u = fake(async () => ({ state: 'unknown', directory: '/w', untrustedEffect: 'rules are ignored' }));
    const r2 = new SessionRuntime(u.factory, port(), { env: {} });
    await r2.runTurn(sink(), { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    expect(u.opens[0]!.trustAccepted).toBeUndefined();
    expect(r2.view().live.notice?.text).toMatch(/could not tell whether it trusts this folder: rules are ignored/);
  });
});

describe('input-consumed outside a turn (verify-1-2 item 7)', () => {
  it('opens no wake turn and is not lost; the next turn runs at once', async () => {
    const f = fake();
    const p = port();
    let wakes = 0;
    p.wake = () => void wakes++;
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.runTurn(sink(), { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    f.queues[0]!.push({ type: 'input-consumed', inputId: 'u1' });
    await tick();
    expect(wakes).toBe(0);
    expect(r.state().turn).toBe(false);
    const t2 = r.runTurn(sink(), { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    expect(await Promise.race([t2, tick(20).then(() => 'waiting')])).toEqual({ kind: 'completed' });
  });
});

describe('answer route', () => {
  it('parseAnswer accepts ids only', () => {
    expect(parseAnswer({ ask: 'p1', choice: 'allow-once' })).toEqual({ ask: 'p1', choice: 'allow-once' });
    expect(parseAnswer({ ask: 'p 1', choice: 'x' })).toMatch(/ask/);
    expect(parseAnswer({ ask: 'p1' })).toMatch(/choice/);
    expect(parseAnswer([])).toMatch(/object/);
  });

  it('POST answer reaches only registry sessions and only offered choices', async () => {
    const f = fake();
    const reg = new SessionRegistry();
    const r = new SessionRuntime(f.factory, port(), { env: {} });
    reg.set('h1', 'k', r);
    const route = sessionControlRoutes(reg, { factories: [f.factory] }).find((x) => x.path.endsWith('/answer'))!;
    const post = (id: string, body: unknown) =>
      route.fetch(
        new Request(`http://h/api/raw-agent/answer?session=${id}`, { method: 'POST', body: JSON.stringify(body) }),
      );
    expect((await post('nope', { ask: 'a', choice: 'b' })).status).toBe(404);
    const turn = r.runTurn(sink(), { userInputs: [askInput], wake: false }, new AbortController().signal);
    await tick(10);
    expect((await post('h1', { ask: 'p1', choice: 'bogus' })).status).toBe(400);
    expect((await post('h1', { ask: 'gone', choice: 'reject' })).status).toBe(409);
    const ok = await post('h1', { ask: 'p1', choice: 'reject' });
    expect(ok.status).toBe(200);
    await turn;
    expect(f.answers).toEqual([{ optionId: 'reject' }]);
  });
});

describe('readFileForPreview (read-only, verify-1-2 item 8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'raw-preview-'));
  const file = join(dir, 'settings.json');
  writeFileSync(file, '{"a":1}');

  it('follows a symlinked settings file (the CLI reads it too) and refuses a directory', () => {
    const link = join(dir, 'link.json');
    symlinkSync(file, link);
    expect(readFileForPreview(link)).toMatchObject({ kind: 'ok', text: '{"a":1}', size: 7 });
    const sub = join(dir, 'sub');
    mkdirSync(sub);
    const dirLink = join(dir, 'dirlink.json');
    symlinkSync(sub, dirLink);
    expect(readFileForPreview(dirLink)).toEqual({ kind: 'error', message: 'not a regular file' });
    const dangling = join(dir, 'dangling.json');
    symlinkSync(join(dir, 'gone'), dangling);
    expect(readFileForPreview(dangling)).toEqual({ kind: 'missing' });
  });

  it('does not read a file over 1 MB (size only), and a missing file is missing', () => {
    const big = join(dir, 'big.json');
    writeFileSync(big, 'x'.repeat(1024 * 1024 + 1));
    expect(readFileForPreview(big)).toMatchObject({ kind: 'ok', text: '', size: 1024 * 1024 + 1 });
    expect(readFileForPreview(join(dir, 'none.json'))).toEqual({ kind: 'missing' });
  });
});
