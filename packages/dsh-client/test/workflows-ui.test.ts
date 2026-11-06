// M4 client-workflows (R6.5; D37, D48, D49) and the R6.2 task output view: the workflow model
// (phases, agent rows, numbers, latest output), the workflow card (Stop entire workflow, no
// per-agent Stop where the agent has none, Open the agent's child session), the chat node beside
// DSH's own workflow-run node, the workflow routes and channel line, the ultracode entry of the
// effort picker, and the background shell output view.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AgentsPanel,
  SessionControlStore,
  SessionStores,
  TaskOutputBody,
  TaskOutputReader,
  WORKFLOW_DEFINITION_KIND,
  WORKFLOW_NODE_KIND,
  WorkflowNode,
  WorkflowRunCard,
  canStopChild,
  createApi,
  effortSelect,
  findWorkflow,
  hasTaskOutput,
  outputCutNote,
  parseChannelLine,
  plainTaskOutput,
  workflowAgentAddress,
  workflowAgentLast,
  workflowAgentRunMs,
  workflowAgentStats,
  workflowAgentStatusText,
  workflowDefinition,
  workflowPhases,
  workflowStatusText,
  workflowSummaryLine,
  type ChannelLine,
  type ChildWire,
  type HostActions,
  type RawAgentApi,
  type SessionInfo,
  type TaskOutputWire,
  type TimerApi,
  type WorkflowAgentWire,
  type WorkflowWire,
} from '@dsh-raw-agent/dsh-client';

const flush = () => new Promise((r) => setTimeout(r, 0));

const agent = (index: number, over: Partial<WorkflowAgentWire> = {}): WorkflowAgentWire => ({
  index,
  label: `a${index}`,
  state: 'running',
  ...over,
});

const run = (over: Partial<WorkflowWire> = {}): WorkflowWire => ({
  taskId: 't1',
  runId: 'wf_1',
  name: 'two-phase',
  status: 'running',
  phases: [
    { index: 1, title: 'One' },
    { index: 2, title: 'Two' },
  ],
  agents: [
    agent(1, {
      phaseIndex: 1,
      phaseTitle: 'One',
      state: 'done',
      agentId: 'x1',
      tokens: 17348,
      toolCalls: 1,
      durationMs: 3516,
      resultPreview: 'one',
      childSessionId: 'hc1',
    }),
    agent(2, { phaseIndex: 2, phaseTitle: 'Two', agentId: 'x2', startedAt: 10_000, tokens: 900, toolCalls: 2 }),
    agent(3, { phaseIndex: 2, phaseTitle: 'Two', state: 'queued' }),
  ],
  startedAt: 5_000,
  ...over,
});

const child = (over: Partial<ChildWire> & { id: string }): ChildWire => ({
  parent: 'main',
  label: over.id,
  role: 'workflow-agent',
  status: 'running',
  background: true,
  depth: 1,
  startedAt: 1000,
  wakes: 0,
  inputs: 0,
  ...over,
});

function info(view: Partial<SessionInfo['view']> = {}, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    backend: { kind: 'k', displayName: 'Agent' },
    permissionModes: [{ id: 'default', label: 'Ask' }],
    efforts: [],
    needsProcess: [],
    models: [],
    modelsFrom: 'session',
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 1 },
      live: {},
      choice: { applied: {}, resetPending: false, agentLocked: false },
      ...view,
    },
    ...over,
  } as SessionInfo;
}

const noActions: HostActions = {
  openPreview: () => false,
  openTerminal: () => false,
  copy: async () => false,
  portal: (n) => n,
};

function fakeApi(base: SessionInfo, over: Partial<RawAgentApi> = {}): RawAgentApi {
  return {
    ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
    session: async () => base,
    ...over,
  };
}

async function readyStore(base: SessionInfo, over: Partial<RawAgentApi> = {}): Promise<SessionControlStore> {
  const store = new SessionControlStore('s1', fakeApi(base, over));
  await store.refresh();
  return store;
}

function manualTimers() {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const timers: TimerApi = {
    set: (fn, ms) => {
      const t = { fn, ms };
      pending.push(t);
      return t;
    },
    clear: (h) => {
      const i = pending.indexOf(h as never);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  const fire = () => {
    const t = pending.shift();
    t?.fn();
  };
  return { timers, pending, fire };
}

describe('workflow model (D48)', () => {
  it('groups agents by phase in order; an undeclared phase gets its own group, no phase goes last', () => {
    const groups = workflowPhases(
      run({
        agents: [
          agent(4),
          agent(3, { phaseIndex: 2, phaseTitle: 'Two', state: 'error' }),
          agent(1, { phaseTitle: 'One', state: 'done' }),
          agent(5, { phaseIndex: 7, phaseTitle: 'Late' }),
        ],
      }),
    );
    expect(groups.map((g) => [g.title, g.agents.map((a) => a.index)])).toEqual([
      ['One', [1]],
      ['Two', [3]],
      ['Late', [5]],
      ['Agents', [4]],
    ]);
    expect(groups[0]!.status).toBe('1 of 1 done');
    expect(groups[1]!.status).toBe('0 of 1 done · 1 failed');
    expect(workflowPhases(run({ agents: [] })).map((g) => g.status)).toEqual(['Not started', 'Not started']);
  });

  it('states, numbers and run time of one agent', () => {
    expect(workflowAgentStatusText(agent(1, { state: 'queued' }))).toBe('Queued');
    expect(workflowAgentStatusText(agent(1, { state: 'done', cached: true }))).toBe('Done (cached)');
    expect(workflowAgentStatusText(agent(1, { state: 'error', blocked: true }))).toBe('Blocked');
    expect(workflowAgentStatusText(agent(1, { state: 'error' }))).toBe('Failed');
    expect(workflowAgentStatusText(agent(1, { state: 'stopped' }))).toBe('Stopped');
    // Running: from its start, never below the time it reports itself.
    expect(workflowAgentRunMs(agent(1, { startedAt: 1000 }), 4000)).toBe(3000);
    expect(workflowAgentRunMs(agent(1, { startedAt: 1000, durationMs: 9000 }), 4000)).toBe(9000);
    expect(workflowAgentRunMs(agent(1, { state: 'done', durationMs: 3516 }), 99_000)).toBe(3516);
    expect(workflowAgentRunMs(agent(1, { state: 'done', startedAt: 1000, lastProgressAt: 6000 }), 0)).toBe(5000);
    expect(workflowAgentRunMs(agent(1, { state: 'queued' }), 0)).toBeUndefined();
    expect(workflowAgentStats(agent(1, { state: 'done', tokens: 17348, toolCalls: 1, durationMs: 3516 }), 0)).toBe(
      '17k tokens · 1 tool call · 3 s',
    );
  });

  it('the latest output: live transcript line while running, else the last tool; error or result once settled', () => {
    const live = child({ id: 'x2', last: { kind: 'tool', text: 'Bash', at: 1 } });
    expect(workflowAgentLast(agent(2, { agentId: 'x2', lastToolName: 'Read' }), live)).toBe('Calling Bash');
    expect(workflowAgentLast(agent(2, { lastToolName: 'Bash', lastToolSummary: 'echo two' }))).toBe(
      'Calling Bash: echo two',
    );
    expect(workflowAgentLast(agent(2, { state: 'done', resultPreview: 'two' }), live)).toBe('two');
    expect(workflowAgentLast(agent(2, { state: 'error', error: 'Stopped because the workflow was stopped' }))).toBe(
      'Stopped because the workflow was stopped',
    );
    expect(workflowAgentLast(agent(2, { state: 'queued' }))).toBeUndefined();
  });

  it('run status and summary line; the address of an agent child session', () => {
    expect(workflowStatusText(run())).toBe('Running');
    expect(workflowStatusText(run({ stopping: true }))).toBe('Stopping…');
    expect(workflowStatusText(run({ status: 'cancelled', stopping: true }))).toBe('Stopped');
    expect(workflowStatusText(run({ status: 'error' }))).toBe('Failed');
    expect(workflowSummaryLine(run(), 65_000)).toBe('2 phases · 3 agents · 1 running · 1 done · 18k tokens · 1 min');
    expect(
      workflowSummaryLine(
        run({ status: 'completed', endedAt: 9_000, usage: { tokens: 40_000, durationMs: 2000 } }),
        1e9,
      ),
    ).toContain('40k tokens · 4 s');
    const r = run();
    expect(workflowAgentAddress('s1', r.agents[0]!)).toEqual({
      parentSessionId: 's1',
      childSessionId: 'hc1',
      mode: 'one-shot',
    });
    // Before the member record, the child row's session still opens it.
    expect(workflowAgentAddress('s1', r.agents[1]!, [child({ id: 'x2', hostSessionId: 'hc2' })])).toMatchObject({
      childSessionId: 'hc2',
    });
    expect(workflowAgentAddress('s1', r.agents[2]!)).toBeUndefined();
    expect(findWorkflow({ workflows: [r] }, 'wf_1')).toBe(r);
    expect(findWorkflow({ workflows: [r] }, 'wf_2')).toBeUndefined();
  });
});

describe('the workflow card (D48, D49)', () => {
  it('shows phases, agents with numbers and output, Open, and Stop entire workflow; no per-agent Stop', async () => {
    const base = info({
      workflows: [run()],
      workflowAgentStop: false,
      children: [child({ id: 'x2', hostSessionId: 'hc2', last: { kind: 'text', text: 'Working on two', at: 2 } })],
    });
    const store = await readyStore(base);
    const html = renderToStaticMarkup(
      React.createElement(WorkflowRunCard, {
        run: base.view.workflows![0]!,
        sessionId: 's1',
        info: base,
        snap: store.getSnapshot(),
        store,
        actions: { ...noActions, openChild: () => true },
        now: 65_000,
      }),
    );
    expect(html).toContain('two-phase');
    expect(html).toContain('Workflow · Running');
    expect((html.match(/data-raw-agent="workflow-phase"/g) ?? []).length).toBe(2);
    expect(html).toContain('17k tokens · 1 tool call · 3 s');
    expect(html).toContain('Working on two');
    expect(html).toContain('Stop entire workflow');
    expect(html).not.toContain('data-raw-agent="workflow-agent-stop"');
    expect(html).toContain('Agent cannot stop one agent of a workflow');
    expect((html.match(/data-raw-agent="workflow-agent-open"/g) ?? []).length).toBe(2); // x1 and x2
    store.dispose();
  });

  it('an agent that can stop one workflow agent gets a per-agent Stop; an ended run has no Stop', async () => {
    const base = info({ workflows: [run()], workflowAgentStop: true });
    const store = await readyStore(base);
    const props = { sessionId: 's1', info: base, snap: store.getSnapshot(), store, actions: noActions, now: 0 };
    const live = renderToStaticMarkup(React.createElement(WorkflowRunCard, { ...props, run: run() }));
    expect((live.match(/data-raw-agent="workflow-agent-stop"/g) ?? []).length).toBe(1); // only the running one
    expect(live).not.toContain('workflow-no-agent-stop');
    const ended = renderToStaticMarkup(
      React.createElement(WorkflowRunCard, { ...props, run: run({ status: 'completed', summary: 'All done' }) }),
    );
    expect(ended).not.toContain('Stop entire workflow');
    expect(ended).toContain('All done');
    store.dispose();
  });

  it('Stop entire workflow and the per-agent stop call their routes and track the click', async () => {
    const calls: string[] = [];
    const store = await readyStore(info({ workflows: [run()] }), {
      stopWorkflow: async (_s, t) => {
        calls.push(`run:${t}`);
        return { ok: true, status: 'cancelled' };
      },
      stopWorkflowAgent: async (_s, t, a) => {
        calls.push(`agent:${t}/${a}`);
        return { ok: false, error: 'Agent cannot stop one agent of a workflow.', unsupported: true };
      },
    });
    const p = store.stopWorkflow('t1');
    expect(store.getSnapshot().stopping).toEqual(['t1']);
    expect(await p).toBe(true);
    expect(await store.stopWorkflowAgent('t1', 'x2')).toBe(false);
    expect(calls).toEqual(['run:t1', 'agent:t1/x2']);
    expect(store.getSnapshot().stopError).toEqual({ id: 'x2', text: 'Agent cannot stop one agent of a workflow.' });
    store.dispose();
  });

  it('the API: workflow-stop, workflow-agent-stop (409 unsupported) and task-output', async () => {
    const seen: Array<[string, string | undefined]> = [];
    const api = createApi(async (url, init) => {
      seen.push([url, init?.method]);
      if (url.includes('workflow-agent-stop'))
        return {
          status: 409,
          ok: false,
          json: async () => ({ ok: false, error: 'cannot', unsupported: true, status: 'unknown' }),
        };
      if (url.includes('task-output')) {
        if (url.includes('task=gone')) return { status: 404, ok: false, json: async () => ({ error: 'no such task' }) };
        return {
          status: 200,
          ok: true,
          json: async () => ({ ok: true, output: 'hi\n', totalBytes: 3, truncated: false }),
        };
      }
      return { status: 200, ok: true, json: async () => ({ ok: true, status: 'stopping' }) };
    });
    expect(await api.stopWorkflow('s 1', 't/1')).toEqual({ ok: true, status: 'stopping' });
    expect(await api.stopWorkflowAgent('s', 't1', 'x2')).toEqual({
      ok: false,
      error: 'cannot',
      status: 'unknown',
      unsupported: true,
    });
    expect(await api.taskOutput('s', 'b1')).toEqual({ output: 'hi\n', totalBytes: 3, truncated: false });
    await expect(api.taskOutput('s', 'gone')).rejects.toMatchObject({ status: 404, message: 'no such task' });
    expect(seen.slice(0, 3)).toEqual([
      ['api/raw-agent/workflow-stop?session=s%201&task=t%2F1', 'POST'],
      ['api/raw-agent/workflow-agent-stop?session=s&task=t1&agent=x2', 'POST'],
      ['api/raw-agent/task-output?session=s&task=b1', undefined],
    ]);
  });

  it('the channel line carries the runs, and the store applies them at once', async () => {
    const line = parseChannelLine(
      JSON.stringify({ type: 'asks', asks: [], workflows: [run(), { taskId: 'bad' }], children: [], tasks: [] }),
    );
    expect(line).toMatchObject({ type: 'asks', workflows: [{ runId: 'wf_1' }] });
    expect((line as { workflows: unknown[] }).workflows).toHaveLength(1);
    expect(parseChannelLine('{"type":"asks","asks":[]}')).not.toHaveProperty('workflows');

    let emit: ((l: ChannelLine) => void) | undefined;
    const api = fakeApi(info(), {
      interactions: (_s, signal, onLine) =>
        new Promise<void>((resolve) => {
          emit = onLine;
          signal.addEventListener('abort', () => resolve());
        }),
    });
    const { timers } = manualTimers();
    const store = new SessionControlStore('s1', api, timers);
    const off = store.subscribe(() => {});
    await flush();
    await flush();
    emit?.({ type: 'asks', asks: [], workflows: [run({ status: 'cancelled' })] });
    expect(store.getSnapshot().info?.view.workflows?.[0]?.status).toBe('cancelled');
    emit?.({ type: 'asks', asks: [] }); // an older Host line: the runs stay
    expect(store.getSnapshot().info?.view.workflows).toHaveLength(1);
    emit?.({ type: 'asks', asks: [], workflows: [] });
    expect(store.getSnapshot().info?.view.workflows).toBeUndefined();
    off();
  });
});

describe('the chat node beside DSH workflow-run node', () => {
  const ev = (type: string, data: unknown, seq = 7) => ({ type, seq, time: 1, data });

  it('reads run-start and run-end without claiming them, and builds one node at the run start', () => {
    const def = workflowDefinition() as {
      kind: string;
      target: string;
      match(e: unknown): { id: string; role: string; exclusive?: boolean } | null;
      start(c: unknown, m: { event: unknown }): unknown;
      update(c: unknown, m: { event: unknown }): unknown;
      buildViewNode(c: unknown): Record<string, unknown> | null;
    };
    expect(def.kind).toBe(WORKFLOW_DEFINITION_KIND);
    expect(def.target).toBe('chat');
    const start = ev('tool-workflow/run-start', { runId: 'wf_1', name: 'two-phase' });
    expect(def.match(start)).toEqual({ id: 'wf_1', role: 'start' });
    expect(def.match(ev('tool-workflow/run-end', { runId: 'wf_1', stopReason: 'completed' }))).toEqual({
      id: 'wf_1',
      role: 'update',
    });
    expect(def.match(ev('tool-workflow/agent-start', { runId: 'wf_1', seq: 1 }))).toBeNull(); // DSH's node draws members
    expect(def.match(ev('tool/call', {}))).toBeNull();
    expect(def.match(ev('tool-workflow/run-start', {}))).toBeNull();
    const state = def.start({}, { event: start });
    expect(state).toEqual({ runId: 'wf_1', name: 'two-phase' });
    const ended = def.update(
      { state },
      { event: ev('tool-workflow/run-end', { runId: 'wf_1', stopReason: 'cancelled' }) },
    );
    expect(ended).toEqual({ runId: 'wf_1', name: 'two-phase', stopReason: 'cancelled' });
    const node = def.buildViewNode({
      key: 'k1',
      id: 'wf_1',
      state: ended,
      start: { location: { kind: 'step' }, event: { seq: 7 } },
      matches: [],
    });
    expect(node).toMatchObject({
      kind: WORKFLOW_NODE_KIND,
      id: 'wf_1',
      target: 'chat',
      anchorSeq: 7,
      location: { kind: 'step' },
      visibility: 'visible',
      data: { runId: 'wf_1' },
    });
    expect(def.buildViewNode({ key: 'k', id: 'x', matches: [] })).toBeNull();
  });

  it('draws the live run of this session, and nothing for a run the process does not know', async () => {
    const base = info({ workflows: [run()] });
    const stores = new SessionStores(fakeApi(base));
    await stores.get('s1').refresh();
    const html = (runId: string) =>
      renderToStaticMarkup(
        React.createElement(WorkflowNode, {
          node: { data: { runId, name: 'two-phase' } },
          sessionId: 's1',
          stores,
          actions: noActions,
        }),
      );
    expect(html('wf_1')).toContain('data-raw-agent="workflow-node"');
    expect(html('wf_1')).toContain('Stop entire workflow');
    expect(html('wf_old')).toBe('');
    expect(
      renderToStaticMarkup(React.createElement(WorkflowNode, { node: { data: { runId: 'wf_1', name: '' } } })),
    ).toBe('');
    stores.dispose();
  });
});

describe('the agents panel with workflows', () => {
  it('a workflow agent child has no Stop where the agent has none, and a Workflows tab lists the runs', async () => {
    const wfChild = child({ id: 'x2', hostSessionId: 'hc2' });
    const sub = child({ id: 'c1', role: 'subagent', background: false });
    const base = info({ children: [wfChild, sub], workflows: [run()], workflowAgentStop: false });
    expect(canStopChild(wfChild, base)).toBe(false);
    expect(canStopChild(sub, base)).toBe(true);
    expect(canStopChild(wfChild, info({ workflowAgentStop: true }))).toBe(true);
    const store = await readyStore(base);
    const html = renderToStaticMarkup(React.createElement(AgentsPanel, { store, actions: noActions }));
    expect((html.match(/data-raw-agent="child-stop"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-raw-agent="child-no-stop"');
    expect(html).toContain('Workflows (1)');
    const tab = renderToStaticMarkup(
      React.createElement(AgentsPanel, { store, actions: noActions, initialTab: 'workflows' }),
    );
    expect(tab).toContain('data-raw-agent="workflow-runs"');
    expect(tab).toContain('two-phase');
    store.dispose();
  });

  it('the tasks tab offers the output of shells and monitors, running or ended, and not of agents', async () => {
    const base = info({
      tasks: [
        { taskId: 'b1', kind: 'shell', label: 'sleep 20', status: 'running', job: true },
        { taskId: 'b2', kind: 'monitor', label: 'watch logs', status: 'completed', job: true },
        { taskId: 'b3', kind: 'agent', label: 'helper', status: 'running', job: true },
      ],
    });
    const store = await readyStore(base);
    const html = renderToStaticMarkup(
      React.createElement(AgentsPanel, { store, actions: noActions, initialTab: 'tasks' }),
    );
    expect((html.match(/data-raw-agent="task-output-toggle"/g) ?? []).length).toBe(2);
    expect(html).toContain('Show output');
    expect(hasTaskOutput({ kind: 'workflow' })).toBe(false);
    store.dispose();
  });
});

describe('background task output (R6.2)', () => {
  it('plain text: escape sequences removed, carriage-return progress reduced to its last state', () => {
    expect(plainTaskOutput('\u001b[32mok\u001b[0m\n')).toBe('ok\n');
    expect(plainTaskOutput('\u001b]0;title\u0007done')).toBe('done');
    expect(plainTaskOutput('10%\r50%\r100%\nnext\r\n')).toBe('100%\nnext\n');
    expect(plainTaskOutput('<b>not markup</b>')).toBe('<b>not markup</b>');
    expect(outputCutNote({ truncated: false, totalBytes: 9, output: '' })).toBeUndefined();
    expect(outputCutNote({ truncated: true, totalBytes: 3 * 1024 * 1024, output: '' })).toBe(
      'Showing the end of the output (3.0 MiB in all).',
    );
  });

  it('the reader polls while the task runs, reads once more when it ends, then stops', async () => {
    let n = 0;
    const reads: number[] = [];
    const out = (): TaskOutputWire => ({ output: `line ${++n}`, totalBytes: 6, truncated: false });
    const { timers, pending, fire } = manualTimers();
    const reader = new TaskOutputReader(
      async () => {
        reads.push(n);
        return out();
      },
      timers,
      2000,
    );
    reader.setRunning(true);
    await flush();
    expect(reader.getSnapshot().output?.output).toBe('line 1');
    expect(pending.map((p) => p.ms)).toEqual([2000]);
    fire();
    await flush();
    expect(reader.getSnapshot().output?.output).toBe('line 2');
    reader.setRunning(false); // the task ended: one final read, no more polling
    await flush();
    expect(reader.getSnapshot().output?.output).toBe('line 3');
    expect(pending).toEqual([]);
    reader.setRunning(false);
    await flush();
    expect(reads).toHaveLength(3);
    await reader.refresh(); // "Read again"
    expect(reader.getSnapshot()).toMatchObject({ output: { output: 'line 4' }, reads: 4, reading: false });
    reader.dispose();
    await reader.refresh();
    expect(reads).toHaveLength(4);
  });

  it('a failed read shows its reason and keeps polling a running task', async () => {
    const { timers, pending } = manualTimers();
    const reader = new TaskOutputReader(
      async () => {
        throw new Error('no such task in this session');
      },
      timers,
      2000,
    );
    reader.setRunning(true);
    await flush();
    expect(reader.getSnapshot().error).toBe('no such task in this session');
    expect(pending).toHaveLength(1);
    reader.dispose();
    expect(pending).toHaveLength(0);
  });

  it('the output body shows the text as text, the cut note and the read-again button for an ended task', () => {
    const html = renderToStaticMarkup(
      React.createElement(TaskOutputBody, {
        snap: { output: { output: '<i>x</i>\n', totalBytes: 9e6, truncated: true }, reading: false, reads: 1 },
        running: false,
        onRefresh: () => {},
      }),
    );
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;');
    expect(html).toContain('Showing the end of the output');
    expect(html).toContain('Read again');
    const empty = renderToStaticMarkup(
      React.createElement(TaskOutputBody, {
        snap: { output: { output: '', totalBytes: 0, truncated: false }, reading: false, reads: 1 },
        running: true,
      }),
    );
    expect(empty).toContain('No output yet.');
    expect(empty).not.toContain('Read again');
  });
});

describe('the ultracode entry of the effort picker (D37)', () => {
  const efforts = [
    { id: 'high', label: 'High' },
    { id: 'max', label: 'Max' },
    { id: 'ultracode', label: 'Ultracode', kind: 'mode' as const, description: 'Workflows at any effort level.' },
  ];
  const models = [{ value: 'm1', displayName: 'M1', efforts: ['high'] }];

  it('is not narrowed by the model effort list, and names that it keeps the level', () => {
    const sel = effortSelect(info({ live: { model: 'm1' } }, { efforts, models } as Partial<SessionInfo>))!;
    const byId = Object.fromEntries(sel.options.map((o) => [o.value, o]));
    expect(byId.max!.disabled).toBe(true); // a level the model does not list
    expect(byId.ultracode).toMatchObject({ label: 'Ultracode (any effort)', hint: 'Workflows at any effort level.' });
    expect(byId.ultracode!.disabled).toBeUndefined();
    expect(sel.title).toContain('Ultracode keeps the effort level');
  });

  it('is greyed out when the agent says it is not available, unless it is the choice', () => {
    const off = effortSelect(
      info({ live: { ultracode: { on: false, available: false } } }, { efforts } as Partial<SessionInfo>),
    )!;
    const u = off.options.find((o) => o.value === 'ultracode')!;
    expect(u.disabled).toBe(true);
    expect(u.hint).toContain('not available');
    const chosen = effortSelect(
      info(
        {
          live: { ultracode: { on: false, requested: true, available: false } },
          choice: { applied: {}, resetPending: false, agentLocked: false, effort: 'ultracode' },
        },
        { efforts } as Partial<SessionInfo>,
      ),
    )!;
    expect(chosen.value).toBe('ultracode');
    expect(chosen.options.find((o) => o.value === 'ultracode')!.disabled).toBeUndefined();
    expect(chosen.options.find((o) => o.value === 'ultracode')!.hint).toContain('cannot take effect now');
  });

  it('"your settings" says when the settings turn ultracode on', () => {
    const sel = effortSelect(
      info({ live: { ultracode: { on: true, available: true } } }, {
        efforts,
        settings: { effort: 'high' },
      } as Partial<SessionInfo>),
    )!;
    expect(sel.options[0]!.label).toBe('Effort: your settings (high, ultracode on)');
  });

  it('a backend without a mode entry keeps the plain picker', () => {
    const sel = effortSelect(info({}, { efforts: [{ id: 'high', label: 'High' }] } as Partial<SessionInfo>))!;
    expect(sel.title).toBe('Effort for this session only.');
    expect(sel.options.map((o) => o.label)).toEqual(['Effort: your settings', 'Effort: High']);
  });
});
