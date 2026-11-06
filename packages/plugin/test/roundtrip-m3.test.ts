// M3 DSH round trip (R6.1-R6.3): child agents become one-shot DSH child sessions (D45) written
// with the D68 step shape, nested by spawn depth; teammates and the roster (D50); per-child stop
// (D46); D74 closing on a crash; D47 fallback rows and re-linking. Recorded fixtures go through the
// real Claude mapper; every log (parent and children) passes the real v4 check, the stream replay
// and a reload. Skipped when no installed DSH is found.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SentInputTracker, type BackendEvent } from '@dsh-raw-agent/core';
import { ClaudeMessageMapper } from '@dsh-raw-agent/backend-claude';
import { wakeDefinition, wakeTriggerOf } from '@dsh-raw-agent/dsh-client';
import { createRawAgentHost, liveChildCount, type AgentMount } from '@dsh-raw-agent/dsh-host';
import {
  checkSession,
  createLoop,
  createStubFactory,
  loadDsh,
  realStreamCheck,
  relationshipCheck,
  type LoopRuntime,
  type ScriptStep,
  type StubScript,
} from '@dsh-raw-agent/testkit';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dsh = await loadDsh();
const MAIN = { kind: 'main' } as const;

function mapFixture(name: string): BackendEvent[] {
  const p = fileURLToPath(new URL(`../../backend-claude/test/fixtures/${name}`, import.meta.url));
  const mapper = new ClaudeMessageMapper(new SentInputTracker());
  const out: BackendEvent[] = [];
  let at = Date.now();
  for (const l of readFileSync(p, 'utf8').split('\n').filter(Boolean))
    out.push(...mapper.map(JSON.parse(l), (at += 5)));
  return out;
}

const user = (text: string) => ({
  id: randomUUID(),
  role: 'user' as const,
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: randomUUID() },
});

async function until(pred: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

let rt: LoopRuntime | undefined;
afterEach(async () => {
  await rt?.dispose();
  rt = undefined;
});

async function session(script: StubScript, opts: { jobs?: boolean } = {}) {
  rt = await createLoop(dsh!, { jobs: opts.jobs === true });
  const { factory, record } = createStubFactory(script, 'raw-test');
  const host = createRawAgentHost({ factories: [factory] });
  const sessionId = `session-${randomUUID()}`;
  const warnings: unknown[] = [];
  let mount: AgentMount | undefined;
  const handle = await rt.ctx.agents.create({
    sessionId,
    meta: { cwd: rt.root },
    agentOptions: { provider: 'raw-test', model: 'settings' },
    setup: async (agentCtx: any) => {
      mount = host.applyAgent(
        agentCtx,
        { backend: 'raw-test' },
        { stopGraceMs: 300, writer: { warn: (n: string, d?: unknown) => warnings.push([n, d]) } },
      );
    },
  });
  const runtime = () => mount!.runtime(sessionId)!;
  return { handle, agent: handle.agent, record, sessionId, warnings, runtime };
}

const turnEnds = (agent: any) => agent.session.snapshotEvents().filter((e: any) => e.type === 'turn/end').length;
const types = (events: any[]) => events.map((e: any) => e.type);

/** Check one child log the way DSH does, then reload it from disk (after the parent is gone). */
function checkChild(child: any) {
  const events = child.session.snapshotEvents();
  expect(relationshipCheck(dsh!, child.session.id, events)).toBe('ok');
  expect(realStreamCheck(dsh!, events)).toBe('ok');
  return events;
}

async function reloadChild(id: string): Promise<string[]> {
  const h = await rt!.ctx.agents.resume({
    resumeSessionId: id,
    agentOptions: { provider: 'raw-test', model: 'settings' },
  });
  const before = h.agent.session.header;
  expect(before.origin).toBe('subagent');
  const added = h.agent.session.snapshotEvents().map((e: any) => e.type);
  await h.dispose();
  return added;
}

const childTurn = (id: string): ScriptStep[] => [
  { type: 'step-start', agent: { kind: 'child', id }, stepId: `${id}-m1`, at: Date.now() },
  {
    type: 'step-message',
    agent: { kind: 'child', id },
    stepId: `${id}-m1`,
    blocks: [{ type: 'tool-call', id: `${id}-call`, name: 'Bash', arguments: '{"command":"sleep 5"}' }],
    final: false,
    model: 'test-model',
  },
];

describe.skipIf(dsh === undefined)(`M3 DSH round trip (installed DSH ${dsh?.version})`, () => {
  it('a subagent becomes a one-shot child session (D45, D68); the parent keeps only the Agent call', async () => {
    const s = await session({ onSend: [mapFixture('subagent.jsonl')] });
    s.agent.followup(user('use a subagent'));
    await until(() => turnEnds(s.agent) === 1);
    await until(() => s.runtime().view().children?.[0]?.status === 'completed');
    // The child session is created asynchronously; under load it can lag the agent's end.
    await until(() => {
      const id = s.runtime().view().children?.[0]?.hostSessionId;
      return id !== undefined && rt!.ctx.agents.get(id) !== undefined;
    });
    const view = s.runtime().view();
    const child = view.children![0]!;
    expect(child).toMatchObject({ id: 'task_01', parent: 'main', label: 'echo helper', role: 'subagent', depth: 1 });
    expect(child.tokens).toBe(21782); // final usage from task_notification (D46), never step usage
    expect(child.toolUses).toBe(2);
    const agentId = child.hostSessionId!;
    const ca = rt!.ctx.agents.get(agentId);
    await until(() => turnEnds(ca) === 1);
    await ca.whenIdle();

    const events = checkChild(ca);
    expect(ca.session.header).toMatchObject({ origin: 'subagent', parentSession: s.sessionId, delegationDepth: 1 });
    expect(ca.session.header.agentPreset).toBe('raw-agent-raw-test');
    expect(types(events)).toEqual([
      'subagent/descriptor',
      'agent-preset/selected',
      'agent/inbox/spliced',
      'turn/start',
      'agent/inbox/spliced',
      'user/message',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'step/start',
      'assistant/message',
      'tool/call',
      'tool/result',
      'step/end',
      'turn/end',
    ]);
    expect(events[0].data).toMatchObject({ version: 3, mode: 'one-shot', provider: 'raw-test', label: 'echo helper' });
    expect(events.find((e: any) => e.type === 'user/message').data.content[0].text).toMatch(/echo hi/);
    for (const m of events.filter((e: any) => e.type === 'assistant/message')) {
      expect(m.data.usage).toBeUndefined(); // D68: no usage, so no tok/s
      expect(m.data.stream.some((r: any) => r.chunk?.type === 'usage' || r.type === 'text-chunks')).toBe(false);
    }
    expect(events.at(-1).data.reason.kind).toBe('completed');

    await s.agent.whenIdle();
    const parentEvents = s.agent.session.snapshotEvents();
    const catalog = parentEvents.filter((e: any) => e.type === 'subagent/catalog');
    expect(catalog).toHaveLength(1);
    expect(catalog[0].data).toMatchObject({ version: 0, childId: agentId, mode: 'one-shot', label: 'echo helper' });
    // The parent's own turn has only main-thread steps: no child step or result leaked in.
    expect(parentEvents.filter((e: any) => e.type === 'tool/call').map((e: any) => e.data.name)).toEqual(['Agent']);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.streamCheck).toBe('ok');
    expect(c.reload).toBe('ok');
    expect(rt!.stray).toEqual([]); // no DSH model call in parent or child
    expect(s.record.sent).toHaveLength(1); // the child never sent anything
    const added = await reloadChild(agentId);
    expect(added.filter((t) => t !== 'session/end-seed')).toEqual(types(events));
  });

  it('a nested subagent is a child of its parent child (spawn depth 2)', async () => {
    const s = await session({ onSend: [mapFixture('nested-subagent.jsonl')] });
    s.agent.followup(user('nest'));
    await until(() => (s.runtime().view().children ?? []).filter((c) => c.status === 'completed').length === 2);
    await until(() =>
      (s.runtime().view().children ?? []).every(
        (c) => c.hostSessionId !== undefined && rt!.ctx.agents.get(c.hostSessionId) !== undefined,
      ),
    );
    const [outer, inner] = s.runtime().view().children!;
    expect(outer).toMatchObject({ id: 'task_01', parent: 'main', depth: 1 });
    expect(inner).toMatchObject({ id: 'task_03', parent: 'task_01', depth: 2 });
    const oa = rt!.ctx.agents.get(outer!.hostSessionId);
    const ia = rt!.ctx.agents.get(inner!.hostSessionId);
    await until(() => turnEnds(oa) === 1 && turnEnds(ia) === 1);
    await Promise.all([oa.whenIdle(), ia.whenIdle(), s.agent.whenIdle()]);
    expect(ia.session.header).toMatchObject({ parentSession: oa.session.id, delegationDepth: 2 });
    const oe = checkChild(oa);
    checkChild(ia);
    // The inner child is listed in the outer child's log, not in the root's.
    expect(oe.filter((e: any) => e.type === 'subagent/catalog').map((e: any) => e.data.childId)).toEqual([
      ia.session.id,
    ]);
    expect(
      s.agent.session
        .snapshotEvents()
        .filter((e: any) => e.type === 'subagent/catalog')
        .map((e: any) => e.data.childId),
    ).toEqual([oa.session.id]);
  });

  it('teammates: roster, messages, and a woken teammate runs a new turn in the same child (D50)', async () => {
    const s = await session({ onSend: [mapFixture('team.jsonl')] }, { jobs: true });
    s.agent.followup(user('make a team'));
    await until(() => turnEnds(s.agent) >= 5, 6000);
    await until(() =>
      (s.runtime().view().children ?? []).every((c) => c.status === 'completed' && c.hostSessionId !== undefined),
    );
    await s.agent.whenIdle();
    const view = s.runtime().view();
    expect(view.children!.map((c) => [c.label, c.role, c.wakes])).toEqual([
      ['alice', 'teammate', 1],
      ['bob', 'teammate', 1],
    ]);
    expect(view.team!.teams).toEqual([{ name: 'probe-team', members: ['task_01', 'task_03'] }]);
    expect(view.team!.messages.map((m) => `${m.from}->${m.to}:${m.text}`)).toEqual([
      'alice->bob:ping',
      'bob->alice:pong',
    ]);
    expect(view.team!.messaging).toBe(false); // D50: no messaging control on this agent
    const bob = rt!.ctx.agents.get(view.children![1]!.hostSessionId);
    await until(() => turnEnds(bob) === 2); // the woken teammate's turn opens once bob is idle
    await bob.whenIdle();
    const be = checkChild(bob);
    const prompts = be.filter((e: any) => e.type === 'user/message').map((e: any) => e.data.content[0].text);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/^<agent-message from="alice">/);
    // One catalog row per child, never again for a woken teammate (a duplicate is refused on load).
    expect(s.agent.session.snapshotEvents().filter((e: any) => e.type === 'subagent/catalog')).toHaveLength(2);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.reload).toBe('ok');
    expect(rt!.stray).toEqual([]);
  });

  it('per-child stop calls stopTask for that child only; its turn ends aborted (D46)', async () => {
    const start = (id: string, label: string): BackendEvent => ({
      type: 'agent-start',
      ref: { kind: 'child', id },
      parent: MAIN,
      label,
      role: 'subagent',
      background: true,
      taskId: id,
      taskPrompt: `do ${label}`,
      at: Date.now(),
    });
    const s = await session({
      onSend: [
        [
          { type: 'turn-start', origin: 'user' },
          start('k1', 'one'),
          start('k2', 'two'),
          ...childTurn('k1'),
          ...childTurn('k2'),
          { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
        ],
      ],
    });
    s.agent.followup(user('two background agents'));
    await until(
      () => (s.runtime().view().children ?? []).every((c) => c.hostSessionId !== undefined) && turnEnds(s.agent) === 1,
    );
    const k1 = rt!.ctx.agents.get(s.runtime().view().children![0]!.hostSessionId);
    await until(() => k1.session.snapshotEvents().some((e: any) => e.type === 'tool/call'));
    // The agent answers the stop with the child's end.
    const stopping = s.runtime().stopChild('k1');
    await until(() => s.record.stoppedTasks.length === 1);
    expect(s.record.stoppedTasks).toEqual(['k1']);
    await s.record.emit([{ type: 'agent-end', ref: { kind: 'child', id: 'k1' }, status: 'stopped' }]);
    expect(await stopping).toEqual({ ok: true, status: 'stopped' });
    await until(() => turnEnds(k1) === 1);
    const e1 = checkChild(k1);
    expect(e1.at(-1).data.reason.kind).toBe('aborted');
    // The open call got DSH's exact repair result before step/end (D74).
    expect(types(e1).slice(-4)).toEqual(['tool/call', 'tool/result', 'step/end', 'turn/end']);
    const children = s.runtime().view().children!;
    expect(children.map((c) => c.status)).toEqual(['stopped', 'running']);
    // A stop whose end does not come in 2 s reports "stopping".
    expect(await s.runtime().stopChild('nope')).toMatchObject({ ok: false, status: 'unknown' });
  });

  it('D74: a crash closes every open child step and ends each child turn before the root turn', async () => {
    const s = await session({
      onSend: [
        [
          { type: 'turn-start', origin: 'user' },
          { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
          {
            type: 'agent-start',
            ref: { kind: 'child', id: 'f1' },
            parent: MAIN,
            label: 'fg',
            role: 'subagent',
            background: false,
            taskId: 'f1',
            taskPrompt: 'work',
            at: Date.now(),
          },
          {
            type: 'step-message',
            agent: MAIN,
            stepId: 'm1',
            blocks: [{ type: 'tool-call', id: 'agent-call', name: 'Agent', arguments: '{"prompt":"work"}' }],
            final: true,
          },
          ...childTurn('f1'),
        ],
      ],
    });
    s.agent.followup(user('crash while a child runs a tool'));
    await until(() => s.runtime().view().children?.[0]?.hostSessionId !== undefined);
    const f1 = rt!.ctx.agents.get(s.runtime().view().children![0]!.hostSessionId);
    await until(() => f1.session.snapshotEvents().some((e: any) => e.type === 'tool/call'));
    s.record.crash('boom');
    await until(() => turnEnds(s.agent) === 1 && turnEnds(f1) === 1);
    await s.agent.whenIdle();
    const fe = checkChild(f1);
    expect(fe.at(-1).data.reason.kind).toBe('error');
    expect(types(fe).slice(-3)).toEqual(['tool/result', 'step/end', 'turn/end']);
    const childEnd = fe.at(-1).seq;
    expect(childEnd).toBeGreaterThan(0);
    expect(s.runtime().view().children![0]!.status).toBe('failed');
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.reload).toBe('ok');
    expect(c.events.findLast((e: any) => e.type === 'turn/end').data.reason.kind).toBe('error');
  });

  it('a background agent and shells: job rows, the child session, and named wake triggers (D47, D26)', async () => {
    const s = await session({ onSend: [mapFixture('background-agent-shell.jsonl')] }, { jobs: true });
    s.agent.followup(user('background work'));
    await until(() => turnEnds(s.agent) === 3, 6000);
    await s.agent.whenIdle();
    const events = s.agent.session.snapshotEvents();
    expect(events.filter((e: any) => e.type === 'job/registered')).toHaveLength(3);
    const triggers = events
      .filter((e: any) => e.type === 'developer/message')
      .map((e: any) => e.data.message.content[0].text);
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toMatch(/background agent "bg helper" finished/);
    expect(triggers[1]).toMatch(
      /"Sleep 120 seconds in background" stopped; background shell "Run tick loop in background" finished/,
    );
    expect(events.filter((e: any) => e.type === 'user/message')).toHaveLength(1);
    // The client's trigger card reads these real events (D26): one line per task that ended, and
    // its chat Definition claims only them.
    const cards = events.map((e: any) => wakeTriggerOf(e)).filter(Boolean);
    expect(cards).toHaveLength(2);
    expect(cards[1]!.items).toEqual([
      'background shell "Sleep 120 seconds in background" stopped',
      'background shell "Run tick loop in background" finished',
    ]);
    const def = wakeDefinition() as { match(e: unknown): unknown };
    expect(events.filter((e: any) => def.match(e) !== null)).toHaveLength(2);
    expect(s.runtime().view().children![0]).toMatchObject({
      label: 'bg helper',
      background: true,
      status: 'completed',
    });
    expect(s.runtime().view().tasks).toBeUndefined(); // all tasks ended
    const runtime = s.runtime();
    const live = liveChildCount();
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.streamCheck).toBe('ok');
    expect(c.reload).toBe('ok');
    expect(rt!.stray).toEqual([]);
    await runtime.dispose();
    expect(liveChildCount()).toBe(live - 1); // the child writer is released with the runtime
  });
});
