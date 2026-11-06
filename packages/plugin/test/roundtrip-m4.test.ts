// M4 DSH round trip (R6.5; D45, D47, D48, D74): a recorded two-phase workflow (CLI 2.1.318, with
// its transcript folder) goes through the real Claude mapper into the real DSH loop. The parent
// log gets the native `tool-workflow/*` records (no DSH workflow call, dsh-seams R2.4), each
// workflow agent is a one-shot child session named by its member record, the run is a job, and
// every log passes the real v4 check, the stream replay and a reload. Skipped without DSH.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SentInputTracker, type BackendEvent } from '@dsh-raw-agent/core';
import { ClaudeMessageMapper, nodeTailFs, type TailFs } from '@dsh-raw-agent/backend-claude';
import { createRawAgentHost, type AgentMount } from '@dsh-raw-agent/dsh-host';
import {
  checkSession,
  createLoop,
  createStubFactory,
  loadDsh,
  realStreamCheck,
  relationshipCheck,
  type LoopRuntime,
  type StubScript,
} from '@dsh-raw-agent/testkit';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dsh = await loadDsh();
const FIXTURES = fileURLToPath(new URL('../../backend-claude/test/fixtures/', import.meta.url));
const RECORDED_PROJECTS = '/home/user/.claude/projects';

/** The recorded transcript folder maps to the fixture's `<name>.transcripts` folder. */
function fixtureFs(name: string): TailFs {
  const local = join(FIXTURES, `${name}.transcripts`);
  const map = (p: string): string => {
    const i = p.indexOf('/subagents/workflows/');
    if (!p.startsWith(RECORDED_PROJECTS) || i < 0) return p;
    const rest = p
      .slice(i + '/subagents/workflows/'.length)
      .split('/')
      .slice(1)
      .join('/');
    return rest === '' ? local : join(local, rest);
  };
  return {
    realpath: (p) => (p.startsWith(RECORDED_PROJECTS) ? p : nodeTailFs.realpath(p)),
    fileSize: (p) => nodeTailFs.fileSize(map(p)),
    readAt: (p, o, n) => nodeTailFs.readAt(map(p), o, n),
  };
}

/** With `crashAfter`, the recording stops after the first event of that type and the real `mapper.exit` runs. */
function mapWorkflowFixture(name: string, crashAfter?: BackendEvent['type']): BackendEvent[] {
  const tracker = new SentInputTracker();
  let at = 1000;
  const mapper = new ClaudeMessageMapper(tracker, {
    now: () => at,
    workflows: {
      projectsDir: () => RECORDED_PROJECTS,
      fs: fixtureFs(name),
      timers: { set: () => 0, clear: () => {} },
    },
  });
  const out: BackendEvent[] = [];
  for (const l of readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)) {
    const m = JSON.parse(l);
    if (m.type === 'command_lifecycle' && m.state === 'queued') tracker.sent(m.command_uuid);
    at = typeof m._t === 'number' ? 1000 + m._t : at + 10;
    const mapped = mapper.map(m, at);
    out.push(...mapped);
    if (crashAfter !== undefined && mapped.some((e) => e.type === crashAfter))
      return [...out, ...mapper.exit('killed')];
  }
  return out;
}

const user = (text: string) => ({
  id: randomUUID(),
  role: 'user' as const,
  content: [{ type: 'text', text }],
  source: { kind: 'user', rpcId: randomUUID() },
});

async function until(pred: () => boolean, ms = 6000): Promise<void> {
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

async function session(script: StubScript) {
  rt = await createLoop(dsh!, { jobs: true });
  const { factory, record } = createStubFactory(script, 'raw-test');
  const host = createRawAgentHost({ factories: [factory] });
  const sessionId = `session-${randomUUID()}`;
  let mount: AgentMount | undefined;
  const handle = await rt.ctx.agents.create({
    sessionId,
    meta: { cwd: rt.root },
    agentOptions: { provider: 'raw-test', model: 'settings' },
    setup: async (agentCtx: any) => {
      mount = host.applyAgent(agentCtx, { backend: 'raw-test' }, { stopGraceMs: 300 });
    },
  });
  const runtime = () => mount!.runtime(sessionId)!;
  return { handle, agent: handle.agent, record, sessionId, runtime };
}

const wf = (events: any[]) => events.filter((e: any) => e.type.startsWith('tool-workflow/'));

describe.skipIf(dsh === undefined)(`M4 DSH round trip (installed DSH ${dsh?.version})`, () => {
  it('a two-phase workflow: native run node records, one child session per agent, a job (D48)', async () => {
    const events = mapWorkflowFixture('workflow-two-phase');
    const s = await session({ onSend: [events] });
    s.agent.followup(user('run a two-phase workflow'));
    await until(() => s.runtime().view().workflows?.[0]?.status === 'completed');
    await until(() => wf(s.agent.session.snapshotEvents()).some((e: any) => e.type === 'tool-workflow/run-end'));
    await until(() =>
      (s.runtime().view().children ?? []).every(
        (c) => c.status !== 'running' && c.hostSessionId !== undefined && rt!.ctx.agents.get(c.hostSessionId),
      ),
    );
    await s.agent.whenIdle();
    const parent = s.agent.session.snapshotEvents();
    const records = wf(parent);
    const view = s.runtime().view();
    const children = view.children!;
    expect(children.map((c) => [c.label, c.role])).toEqual([
      ['a1', 'workflow-agent'],
      ['b1', 'workflow-agent'],
      ['b2', 'workflow-agent'],
    ]);
    const runId = records[0].data.runId;
    expect(records[0]).toMatchObject({
      type: 'tool-workflow/run-start',
      data: { runId: 'wf_0001', name: 'two-phase' },
    });
    const starts = records.filter((e: any) => e.type === 'tool-workflow/agent-start');
    expect(starts.map((e: any) => [e.data.label, e.data.phase, e.data.seq])).toEqual([
      ['a1', 'One', 1],
      ['b1', 'Two', 2],
      ['b2', 'Two', 3],
    ]);
    // Each member names that agent's own child session.
    expect(starts.map((e: any) => e.data.childId)).toEqual(children.map((c) => c.hostSessionId));
    const ends = records.filter((e: any) => e.type === 'tool-workflow/agent-end');
    expect(ends.map((e: any) => [e.data.seq, e.data.outcome]).sort()).toEqual([
      [1, 'completed'],
      [2, 'completed'],
      [3, 'completed'],
    ]);
    expect(records.at(-1)).toMatchObject({ type: 'tool-workflow/run-end', data: { runId, stopReason: 'completed' } });
    // Every member starts after the run and ends before it.
    for (const e of ends) expect(e.seq).toBeGreaterThan(starts.find((x: any) => x.data.seq === e.data.seq).seq);
    // The run node sits after the launching call's result.
    const launchResult = parent.find(
      (e: any) => e.type === 'tool/result' && e.data.message.toolCallId === s.runtime().view().workflows![0]!.callId,
    );
    expect(launchResult).toBeDefined();
    expect(records[0].seq).toBeGreaterThan(launchResult.seq);
    // The plugin view: phases, agents with tokens, the job.
    const run = view.workflows![0]!;
    expect(run.phases.map((p) => p.title)).toEqual(['One', 'Two']);
    expect(run.agents.every((a) => a.childSessionId !== undefined)).toBe(true);
    expect(parent.filter((e: any) => e.type === 'tool/call').map((e: any) => e.data.name)).toContain('Workflow');

    for (const c of children) {
      const ca = rt!.ctx.agents.get(c.hostSessionId!);
      await ca.whenIdle();
      const ce = ca.session.snapshotEvents();
      expect(relationshipCheck(dsh!, ca.session.id, ce)).toBe('ok');
      expect(realStreamCheck(dsh!, ce)).toBe('ok');
      expect(ce.find((e: any) => e.type === 'user/message').data.content[0].text).toMatch(/Workflow harness/);
    }
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.streamCheck).toBe('ok');
    expect(c.reload).toBe('ok');
    expect(rt!.stray).toEqual([]);
    expect(s.record.sent).toHaveLength(1); // nothing but the user's message was sent
  });

  it('a stopped run (workflow-stop-run) closes its members and the run as cancelled', async () => {
    const events = mapWorkflowFixture('workflow-stop-run');
    const s = await session({ onSend: [events] });
    s.agent.followup(user('run and stop'));
    await until(() => wf(s.agent.session.snapshotEvents()).some((e: any) => e.type === 'tool-workflow/run-end'));
    await s.agent.whenIdle();
    const records = wf(s.agent.session.snapshotEvents());
    const starts = records.filter((e: any) => e.type === 'tool-workflow/agent-start').length;
    const ends = records.filter((e: any) => e.type === 'tool-workflow/agent-end');
    expect(ends).toHaveLength(starts);
    expect(records.at(-1).data.stopReason).toBe('cancelled');
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.reload).toBe('ok');
  });

  it('a crash mid-run ends the run with error and its members failed (D74)', async () => {
    // The process dies just after the first member started; the real mapper exit closes the run.
    const events = mapWorkflowFixture('workflow-two-phase', 'agent-start');
    const s = await session({ onSend: [events] });
    s.agent.followup(user('run then crash'));
    await until(() => wf(s.agent.session.snapshotEvents()).some((e: any) => e.type === 'tool-workflow/run-end'));
    await s.agent.whenIdle();
    const records = wf(s.agent.session.snapshotEvents());
    expect(records.map((e: any) => e.type)).toEqual([
      'tool-workflow/run-start',
      'tool-workflow/agent-start',
      'tool-workflow/agent-end',
      'tool-workflow/run-end',
    ]);
    expect(records[2].data.outcome).toBe('failed');
    expect(records[3].data.stopReason).toBe('error');
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expect(c.relationships).toBe('ok');
    expect(c.reload).toBe('ok');
  });
});
