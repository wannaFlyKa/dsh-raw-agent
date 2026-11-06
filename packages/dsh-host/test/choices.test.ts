// Session-only model, effort and mode choices (R1.4, D35-D38, D4, K1) and their routes. No processes.

import { describe, expect, it } from 'vitest';
import {
  AsyncQueue,
  offeredPermissionModes,
  type AgentBackendFactory,
  type AgentBackendSession,
  type BackendEvent,
  type ModelInfo,
  type UserInput,
} from '@dsh-raw-agent/core';
import {
  SETTINGS_CHOICE,
  SessionRegistry,
  SessionRuntime,
  catalogAdapter,
  parseChoice,
  sessionControlRoutes,
  type HostSessionPort,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

const MAIN = { kind: 'main' } as const;

interface Rec {
  q: AsyncQueue<BackendEvent>;
  calls: string[];
  sent: UserInput[];
  disposed: number;
}

function fake(models: ModelInfo[] = [{ value: 'm-small', displayName: 'Small', efforts: ['low', 'high'] }]) {
  const sessions: Rec[] = [];
  const opens: unknown[] = [];
  const factory: AgentBackendFactory = {
    kind: 'k',
    displayName: 'Agent',
    staticCapabilities: {
      ids: 'agent-chosen',
      resume: true,
      fork: 'none',
      needsProcess: [],
      permissionModes: [
        { id: 'default', label: 'Ask' },
        { id: 'plan', label: 'Plan' },
      ],
      efforts: [
        { id: 'low', label: 'Low' },
        { id: 'high', label: 'High' },
      ],
      mainAgentPicker: 'none',
      steer: 'native',
    },
    async settingsDefaults() {
      return { model: 'm-from-settings', sources: { model: 'user' } };
    },
    async open(o) {
      opens.push(o.start);
      const q = new AsyncQueue<BackendEvent>();
      const rec: Rec = { q, calls: [], sent: [], disposed: 0 };
      sessions.push(rec);
      q.push({ type: 'session-info', model: 'm-from-settings', mode: 'default', version: '9' });
      const s: AgentBackendSession = {
        kind: 'k',
        sessionId: `b${sessions.length}`,
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
        async send(input) {
          rec.sent.push(input);
          q.push({ type: 'turn-start', origin: 'user' });
          q.push({ type: 'input-consumed', inputId: input.id });
          q.push({ type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 });
        },
        async interrupt() {
          return { cancelledInputIds: [] };
        },
        async forceStop() {
          q.push({ type: 'exit' });
          q.end();
        },
        async dispose() {
          rec.disposed++;
          q.push({ type: 'exit' });
          q.end();
        },
        controls: {
          setModel: async (m) => {
            if (m === 'bogus' && rec.calls.includes('refuse-model')) throw new Error('restricted');
            rec.calls.push(`model ${m}`);
          },
          setEffort: async (e) => void rec.calls.push(`effort ${e}`),
          setPermissionMode: async (m) => {
            if (m === 'plan' && rec.calls.includes('refuse-plan')) throw new Error('not allowed');
            rec.calls.push(`mode ${m}`);
          },
          models: async () => models,
        },
      };
      return s;
    },
  };
  return { factory, sessions, opens };
}

/** A port whose model choice lives in a fake log of `model/selection` values. */
function port() {
  const selections: string[] = [];
  const p: HostSessionPort = {
    hostSessionId: 'h1',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => undefined,
    startJob: () => undefined,
    warn: () => {},
    modelChoice: () => {
      const last = selections.at(-1);
      return last === undefined || last === SETTINGS_CHOICE ? undefined : last;
    },
    selectModel: (m) => void selections.push(m),
  };
  return { p, selections };
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

const tick = () => new Promise((r) => setTimeout(r, 0));
const input = (id: string): UserInput => ({ id, parts: [{ type: 'text', text: 'hi' }] });

describe('session choices (D35-D38)', () => {
  it('a new session with no choice sends no model, effort or mode control (R1.4)', async () => {
    const f = fake();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.runTurn(sink(), { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    expect(f.sessions[0]!.calls).toEqual([]);
    await tick();
    const v = r.view();
    expect(v.live).toEqual({ model: 'm-from-settings', mode: 'default', version: '9' });
    expect(v.choice).toEqual({ applied: {}, resetPending: false });
    expect(v.models?.map((m) => m.value)).toEqual(['m-small']);
  });

  it('choices before the spawn are pending and applied right after it, before the first send (D4)', async () => {
    const f = fake();
    const { p, selections } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    const a = await r.choose({ model: 'm-small', effort: 'high', mode: 'plan' });
    expect(a.ok).toBe(true);
    expect(a.note).toBe('applies when Agent starts');
    expect(selections).toEqual(['m-small']); // recorded through the port (agent.model.select), not selectModel
    expect(a.view.choice).toMatchObject({ model: 'm-small', effort: 'high', pendingMode: 'plan' });
    expect(f.sessions).toHaveLength(0); // no spawn for a choice (rule 9)
    await r.runTurn(sink(), { userInputs: [input('u1')], wake: false }, new AbortController().signal);
    expect(f.sessions[0]!.calls).toEqual(['model m-small', 'effort high', 'mode plan']);
    expect(f.sessions[0]!.sent).toHaveLength(1);
    expect(r.view().choice).toMatchObject({ applied: { model: 'm-small', effort: 'high' } });
    expect(r.view().choice.pendingMode).toBeUndefined();
  });

  it('a model the agent refuses is reported as refused, so the picker can name what runs (M1 live)', async () => {
    const f = fake();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.start();
    f.sessions[0]!.calls.push('refuse-model');
    const res = await r.choose({ model: 'bogus' });
    expect(res.ok).toBe(false);
    expect(r.view().choice).toMatchObject({ model: 'bogus', applied: {}, refused: { model: 'bogus' } });
    await r.choose({ model: 'm-small' });
    expect(r.view().choice.refused).toBeUndefined();
    expect(r.view().choice.applied.model).toBe('m-small');
  });

  it('a choice while running applies at once, once per value', async () => {
    const f = fake();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.start();
    const res = await r.choose({ model: 'm-small' });
    expect(res.note).toBe('applied');
    await r.choose({ model: 'm-small' });
    await r.choose({ mode: 'plan' });
    expect(f.sessions[0]!.calls).toEqual(['model m-small', 'mode plan']);
    expect(r.view().live.mode).toBe('plan');
  });

  it('the agent mode from status frames is shown; a respawn keeps the mode it last ran in, never a stale choice', async () => {
    const f = fake();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.choose({ mode: 'plan' });
    await r.start();
    f.sessions[0]!.q.push({ type: 'mode', mode: 'acceptEdits' });
    await tick();
    expect(r.view().live.mode).toBe('acceptEdits');
    await r.forceStop();
    await tick();
    expect(r.view().choice.pendingMode).toBe('acceptEdits');
    await r.start();
    expect(f.sessions[1]!.calls).toEqual(['mode acceptEdits']);
  });

  it('without a mode choice a respawn runs the settings mode (nothing forced, rule 4)', async () => {
    const f = fake();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.start();
    f.sessions[0]!.q.push({ type: 'mode', mode: 'acceptEdits' });
    await tick();
    await r.forceStop();
    await tick();
    await r.start();
    expect(f.sessions[1]!.calls).toEqual([]);
  });

  it('a model reset keeps the user mode choice in the restarted process (M1 verify 2)', async () => {
    const f = fake();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.choose({ model: 'm-small', mode: 'plan' });
    await r.start();
    expect(f.sessions[0]!.calls).toEqual(['model m-small', 'mode plan']);
    const res = await r.choose({ model: SETTINGS_CHOICE });
    expect(f.sessions[0]!.disposed).toBe(1);
    expect(res.view.choice.pendingMode).toBe('plan');
    await r.runTurn(sink(), { userInputs: [input('u2')], wake: false }, new AbortController().signal);
    expect(f.sessions[1]!.calls).toEqual(['mode plan']); // the model is the settings one again
  });

  it('"back to my settings" with an applied model restarts the idle process with no choice (D35 exact reset)', async () => {
    const f = fake();
    const { p, selections } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.choose({ model: 'm-small', effort: 'low' });
    await r.start();
    expect(f.sessions[0]!.calls).toEqual(['model m-small', 'effort low']);
    const res = await r.choose({ model: SETTINGS_CHOICE, effort: null });
    expect(selections.at(-1)).toBe(SETTINGS_CHOICE);
    expect(res.note).toBe('Agent will start again with your settings at the next message');
    expect(f.sessions[0]!.disposed).toBe(1);
    expect(r.state().process).toBe('none');
    expect(r.state().lastExit).toBeUndefined(); // an intended end, not a crash
    await r.runTurn(sink(), { userInputs: [input('u2')], wake: false }, new AbortController().signal);
    expect(f.sessions[1]!.calls).toEqual([]); // nothing forced: the agent uses the user's settings
    expect(f.opens).toHaveLength(2);
  });

  it('a reset waits while background work runs, then happens at the next message', async () => {
    const f = fake();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.choose({ model: 'm-small' });
    await r.start();
    f.sessions[0]!.q.push({ type: 'task-start', taskId: 't1', kind: 'shell', label: 'sleep' });
    await tick();
    const res = await r.choose({ model: SETTINGS_CHOICE });
    expect(res.view.choice.resetPending).toBe(true);
    expect(res.note).toContain('restarts at the next message once no work runs');
    expect(f.sessions[0]!.disposed).toBe(0);
    f.sessions[0]!.q.push({ type: 'task-end', taskId: 't1', status: 'completed' });
    await tick();
    await r.runTurn(sink(), { userInputs: [input('u2')], wake: false }, new AbortController().signal);
    expect(f.sessions[0]!.disposed).toBe(1);
    expect(f.sessions).toHaveLength(2);
    expect(f.sessions[1]!.calls).toEqual([]);
  });

  it('a settings choice with nothing applied needs no restart', async () => {
    const f = fake();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    await r.start();
    const res = await r.choose({ model: SETTINGS_CHOICE, effort: null });
    expect(res.view.choice.resetPending).toBe(false);
    expect(f.sessions[0]!.disposed).toBe(0);
    expect(f.sessions[0]!.calls).toEqual([]);
  });

  it('a mode that needs a backend option is offered and accepted only when it is on (D38 r4)', async () => {
    const modes = [
      { id: 'default', label: 'Ask' },
      { id: 'bypass', label: 'Bypass', requiresOption: 'allowBypass' },
    ];
    expect(offeredPermissionModes(modes, {}).map((m) => m.id)).toEqual(['default']);
    expect(offeredPermissionModes(modes, { allowBypass: true }).map((m) => m.id)).toEqual(['default', 'bypass']);
    expect(offeredPermissionModes(modes, {}, [undefined, 'bypass']).map((m) => m.id)).toEqual(['default', 'bypass']);
    const f = fake();
    (f.factory.staticCapabilities as { permissionModes: unknown }).permissionModes = modes;
    const { p } = port();
    const off = new SessionRuntime(f.factory, p, { env: {} });
    expect((await off.choose({ mode: 'bypass' })).error).toContain('not available in this session');
    const on = new SessionRuntime(f.factory, p, { env: {}, userConfig: () => ({ options: { allowBypass: true } }) });
    expect((await on.choose({ mode: 'bypass' })).ok).toBe(true);
  });

  it('refuses unknown modes and efforts, and reports a control error', async () => {
    const f = fake();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    expect((await r.choose({ mode: 'yolo' })).error).toBe('unknown mode: yolo');
    expect((await r.choose({ effort: 'huge' })).error).toBe('unknown effort: huge');
    await r.start();
    f.sessions[0]!.calls.push('refuse-plan');
    const res = await r.choose({ mode: 'plan' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('setPermissionMode failed: not allowed');
  });
});

describe('session control routes (D36, D62)', () => {
  const get = (path: string) => new Request(`http://h${path}`);
  const post = (path: string, body: unknown) =>
    new Request(`http://h${path}`, { method: 'POST', body: JSON.stringify(body) });

  it('parseChoice accepts model, effort and mode and refuses anything else', () => {
    expect(parseChoice({ model: 'claude-x[1m]' })).toEqual({ model: 'claude-x[1m]' });
    expect(parseChoice({ effort: null })).toEqual({ effort: null });
    expect(parseChoice({ mode: 'plan', extra: 1 })).toEqual({ mode: 'plan' });
    expect(parseChoice({})).toBe('nothing to choose');
    expect(parseChoice({ model: 'a b' })).toBe('model must be a model id');
    expect(parseChoice([])).toBe('the body must be a JSON object');
  });

  it('a session outside the registry is 404; ours describes labels, models, settings and choices', async () => {
    const f = fake();
    const registry = new SessionRegistry();
    const { p } = port();
    const r = new SessionRuntime(f.factory, p, { env: {} });
    registry.set('h1', 'k', r);
    const [session, choice] = sessionControlRoutes(registry, { factories: [f.factory], seedModels: ['seed-1'] });
    expect((await session!.fetch(get('/api/raw-agent/session?session=other'))).status).toBe(404);
    const body = (await (await session!.fetch(get('/api/raw-agent/session?session=h1'))).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(body.backend).toEqual({ kind: 'k', displayName: 'Agent' });
    expect(body.models).toEqual([{ value: 'seed-1', displayName: 'seed-1' }]);
    expect(body.modelsFrom).toBe('none');
    expect(body.settings).toEqual({ model: 'm-from-settings', sources: { model: 'user' } });
    expect(body.permissionModes.map((m: { id: string }) => m.id)).toEqual(['default', 'plan']);
    expect(f.sessions).toHaveLength(0); // describing never spawns (rule 9)

    const bad = await choice!.fetch(post('/api/raw-agent/choice?session=h1', { model: 'a b' }));
    expect(bad.status).toBe(400);
    const ok = await choice!.fetch(post('/api/raw-agent/choice?session=h1', { model: 'seed-1' }));
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { ok: boolean; session: { view: { choice: { model: string } } } };
    expect(okBody.ok).toBe(true);
    expect(okBody.session.view.choice.model).toBe('seed-1');
    const refused = await choice!.fetch(post('/api/raw-agent/choice?session=h1', { mode: 'yolo' }));
    expect(refused.status).toBe(409);
    expect((await choice!.fetch(post('/api/raw-agent/choice?session=x', { mode: 'plan' }))).status).toBe(404);
  });

  it('the model list comes from the session, else from another session of the same kind (D34)', async () => {
    const f = fake();
    const registry = new SessionRegistry();
    const a = new SessionRuntime(f.factory, port().p, { env: {} });
    const b = new SessionRuntime(f.factory, { ...port().p, hostSessionId: 'h2' }, { env: {} });
    registry.set('h1', 'k', a);
    registry.set('h2', 'k', b);
    await a.start();
    await tick();
    const [session] = sessionControlRoutes(registry, { factories: [f.factory] });
    const read = async (id: string) =>
      (await (await session!.fetch(get(`/api/raw-agent/session?session=${id}`))).json()) as {
        modelsFrom: string;
        models: ModelInfo[];
      };
    expect((await read('h1')).modelsFrom).toBe('session');
    const other = await read('h2');
    expect(other.modelsFrom).toBe('recent');
    expect(other.models.map((m) => m.value)).toEqual(['m-small']);
  });
});

describe('catalog rows stay out of the global model directory (K1, S4 a)', () => {
  it('lists no rows, so DSH selectModel cannot pick (and save as default) our provider', async () => {
    const f = fake();
    const adapter = catalogAdapter(f.factory, ['seed-1']);
    expect(await adapter.listModels('k')).toEqual([]);
    // The loop and image admission still resolve any id (D33, D76).
    const row = await adapter.resolveModel('k', 'seed-1');
    expect(row.inputModalities).toEqual(['text', 'image']);
    expect((await adapter.resolveModel('k', 'settings')).name).toBe('Your Agent settings');
  });
});
