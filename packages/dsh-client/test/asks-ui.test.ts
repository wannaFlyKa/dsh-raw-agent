// M2 client UI: interaction cards (R5.2-R5.5, D39-D43, D73, D77), the interaction channel in the
// store, the mode picker and Shift+Tab ring (R5.1, D38), and the port's composer takeover.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { nextPermissionMode } from '@dsh-raw-agent/core';
import {
  ASK_INTERACTION_KIND,
  AskCard,
  AskComposer,
  SessionControlStore,
  SessionStores,
  TOOL_WAITING_ATTR,
  createApi,
  diffHunks,
  draftAnswer,
  elicitationContent,
  elicitationFields,
  emptyDraft,
  lineDiff,
  markToolCard,
  modeKeyHandler,
  modeSelect,
  mountClient,
  MODE_SHORTCUT_ID,
  nextModeFor,
  parseChannelLine,
  parseInline,
  parseMarkdown,
  permissionGroups,
  permissionPreview,
  publishAsks,
  questionPreview,
  questionReply,
  readLines,
  safeHttpUrl,
  selectAsk,
  toggleOption,
  toggleOther,
  type AskInteraction,
  type AskWire,
  type ChannelLine,
  type FetchFn,
  type FixedInput,
  type HostActions,
  type RawAgentApi,
  type SessionInfo,
  type TimerApi,
} from '@dsh-raw-agent/dsh-client';

function info(over: Partial<SessionInfo> = {}, view: Partial<SessionInfo['view']> = {}): SessionInfo {
  return {
    backend: { kind: 'k', displayName: 'Agent' },
    permissionModes: [
      { id: 'default', label: 'Ask', description: 'Asks first' },
      { id: 'acceptEdits', label: 'Accept edits' },
      { id: 'plan', label: 'Plan' },
      { id: 'auto', label: 'Auto' },
      { id: 'dontAsk', label: "Don't ask" },
    ],
    unavailableModes: [{ id: 'bypassPermissions', label: 'Bypass', optionLabel: 'Allow bypass' }],
    permissionModeCycle: ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'],
    efforts: [],
    needsProcess: [],
    models: [{ value: 'm1', displayName: 'Model one', supportsAutoMode: true }],
    modelsFrom: 'session',
    settings: { model: 'm1', permissionMode: 'default', sources: {} },
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 0 },
      live: { model: 'm1', mode: 'default' },
      choice: { applied: {}, resetPending: false },
      ...view,
    },
    ...over,
  };
}

const actions = (over: Partial<HostActions> = {}): HostActions => ({
  openPreview: () => true,
  openTerminal: () => true,
  copy: async () => true,
  portal: (n) => n,
  ...over,
});

const manualTimers = () => {
  const pending: Array<{ fn: () => void; ms: number }> = [];
  const timers: TimerApi = {
    set: (fn, ms) => {
      const p = { fn, ms };
      pending.push(p);
      return p;
    },
    clear: (h) => {
      const i = pending.indexOf(h as (typeof pending)[number]);
      if (i >= 0) pending.splice(i, 1);
    },
  };
  return { timers, pending };
};

const flush = () => new Promise((r) => setTimeout(r, 0));

const perm = (over: Partial<AskWire> = {}): AskWire => ({
  id: 'p1',
  kind: 'permission',
  agent: 'main',
  title: 'Bash wants to run',
  choices: [
    { id: 'yes', label: 'Yes', kind: 'allow-once' },
    {
      id: 'always',
      label: "Yes, and don't ask again for Bash(rm:*)",
      kind: 'allow-always',
      destination: '.claude/settings.local.json',
      effects: ['add allow rule Bash(rm:*)'],
    },
    {
      id: 'no',
      label: 'No',
      kind: 'reject-once',
      feedback: true,
      feedbackPlaceholder: 'and tell Claude what to do differently',
    },
  ],
  stopChoice: 'no',
  at: 1,
  form: { type: 'permission', toolName: 'Bash', input: { command: 'rm -rf build', description: 'Remove build' } },
  ...over,
});

const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const card = (ask: AskWire, over: { error?: string; acts?: HostActions } = {}) =>
  render(
    React.createElement(AskCard, {
      ask,
      displayName: 'Agent',
      sessionId: 's1',
      actions: over.acts ?? actions(),
      busy: false,
      ...(over.error ? { error: over.error } : {}),
      onAnswer: () => {},
    }),
  );

describe('mode ring and picker (R5.1, D38)', () => {
  const ring = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto'];
  it('follows the TUI ring and skips modes that are not available (CLI fn uhn)', () => {
    const all = () => true;
    expect(nextPermissionMode(ring, 'default', all)).toBe('acceptEdits');
    expect(nextPermissionMode(ring, 'acceptEdits', all)).toBe('plan');
    expect(nextPermissionMode(ring, 'plan', all)).toBe('bypassPermissions');
    expect(nextPermissionMode(ring, 'plan', (m) => m !== 'bypassPermissions')).toBe('auto');
    expect(nextPermissionMode(ring, 'plan', (m) => !['bypassPermissions', 'auto'].includes(m))).toBe('default');
    expect(nextPermissionMode(ring, 'bypassPermissions', (m) => m !== 'auto')).toBe('default');
    expect(nextPermissionMode(ring, 'auto', all)).toBe('default');
    expect(nextPermissionMode(ring, 'dontAsk', all)).toBe('default');
    expect(nextPermissionMode(ring, 'default', (m) => m === 'default')).toBeUndefined();
  });

  it('lists all six modes: an unavailable one greyed out with its reason; "your settings" marked', () => {
    const s = modeSelect(info());
    expect(s.options.map((o) => o.value)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'auto',
      'dontAsk',
      'bypassPermissions',
    ]);
    expect(s.options[0]).toMatchObject({ label: 'Ask (your settings)', hint: 'Asks first' });
    expect(s.options.at(-1)).toMatchObject({ disabled: true, hint: 'Needs the plugin option “Allow bypass”.' });
    expect(s.title).toContain('Shift+Tab');
    expect(s.value).toBe('default');
  });

  it('greys out auto on a model without it, and the ring skips it', () => {
    const noAuto = info(
      { models: [{ value: 'm1', displayName: 'Model one', supportsAutoMode: false }] },
      {
        live: { model: 'm1', mode: 'plan' },
      },
    );
    const auto = modeSelect(noAuto).options.find((o) => o.value === 'auto')!;
    expect(auto.disabled).toBe(true);
    expect(auto.hint).toContain('no auto mode');
    expect(nextModeFor(noAuto)).toBe('default'); // plan → (no bypass, no auto) → default
    expect(nextModeFor(info({}, { live: { model: 'm1', mode: 'plan' } }))).toBe('auto');
    expect(nextModeFor(info({ permissionModeCycle: undefined }))).toBeUndefined();
  });

  it('the picker shows the agent mode, not the last request (status.permissionMode)', () => {
    expect(modeSelect(info({}, { live: { mode: 'acceptEdits' } })).value).toBe('acceptEdits');
  });
});

describe('permission previews (R5.2, D77)', () => {
  it('a line diff keeps unchanged lines and marks removed and added ones', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\nd\n')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' },
    ]);
    const long = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const hunks = diffHunks(lineDiff(long, long.replace('l10', 'X')), 2);
    expect(hunks[0]).toEqual({ op: '…', count: 8 });
    expect(hunks.at(-1)).toEqual({ op: '…', count: 7 });
  });

  it('picks the preview by the shape of the input', () => {
    expect(permissionPreview({ command: 'ls -la', description: 'List' })).toEqual({
      kind: 'command',
      text: 'ls -la',
      note: 'List',
    });
    const edit = permissionPreview({ file_path: '/w/a.ts', old_string: 'x', new_string: 'y' });
    expect(edit).toMatchObject({ kind: 'diff', path: '/w/a.ts' });
    const multi = permissionPreview({
      file_path: '/w/a.ts',
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    });
    expect(multi && multi.kind === 'diff' && multi.lines.map((l) => l.op).join('')).toBe('-+ -+');
    const write = permissionPreview({ file_path: '/w/n.txt', content: 'one\ntwo\n' });
    expect(write).toMatchObject({
      kind: 'diff',
      lines: [
        { op: '+', text: 'one' },
        { op: '+', text: 'two' },
      ],
    });
    expect(permissionPreview({ url: 'https://x.test', prompt: 'p' })).toMatchObject({
      kind: 'text',
      text: 'https://x.test',
    });
    expect(permissionPreview({ query: 'q' })).toEqual({ kind: 'json', text: '{\n  "query": "q"\n}' });
    expect(permissionPreview(undefined)).toBeUndefined();
  });

  it('groups choices into allow, always and reject', () => {
    const g = permissionGroups(perm().choices);
    expect([g.allow, g.always, g.reject].map((l) => l.map((c) => c.id))).toEqual([['yes'], ['always'], ['no']]);
  });

  it('the card shows the whole command (Show all for long ones), the rule and its file, and feedback', () => {
    const long = Array.from({ length: 60 }, (_, i) => `echo ${i}`).join('\n');
    const html = card(perm({ form: { type: 'permission', toolName: 'Bash', input: { command: long } } }));
    expect(html).toContain('echo 39');
    expect(html).not.toContain('echo 40');
    expect(html).toContain('Show all (20 more lines)');
    expect(html).toContain('Yes, and don&#x27;t ask again for Bash(rm:*)');
    expect(html).toContain('Saved to: .claude/settings.local.json');
    expect(html).toContain('add allow rule Bash(rm:*)');
    expect(html).toContain('placeholder="and tell Claude what to do differently"');
  });

  it('names the asking subagent, and a refused answer shows on the card', () => {
    const html = card(
      perm({ agent: 'child', agentLabel: 'Explore: scan', title: 'Explore: scan: Bash wants to run' }),
      {
        error: 'feedback must be text',
      },
    );
    expect(html).toContain('Subagent “Explore: scan” asks for permission');
    expect(html).toContain('>Bash wants to run<');
    expect(html).toContain('feedback must be text');
  });

  it('defaultToNo puts the focus on the reject choice; a too large input says so', () => {
    const html = card(
      perm({ form: { type: 'permission', toolName: 'Write', inputTruncated: true, defaultToNo: true } }),
    );
    expect(html).toContain('too large to show here');
    expect(html).toMatch(/data-choice="no"/);
  });

  it('marks the tool card the ask is about (D77)', () => {
    const attrs = new Map<string, string>();
    const el = {
      setAttribute: (k: string, v: string) => attrs.set(k, v),
      removeAttribute: (k: string) => attrs.delete(k),
    };
    const head: unknown[] = [];
    const doc = {
      querySelector: (sel: string) => (sel === '[data-chat-call-id="c\\"1"]' ? el : null),
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '' }),
      head: { appendChild: (n: unknown) => head.push(n) },
    };
    const m = markToolCard('c"1', 'Waiting', doc);
    expect(m.found).toBe(true);
    expect(attrs.get(TOOL_WAITING_ATTR)).toBe('Waiting');
    expect(head).toHaveLength(1);
    m.undo();
    expect(attrs.size).toBe(0);
    expect(markToolCard('other', 'Waiting', doc).found).toBe(false);
  });
});

describe('AskUserQuestion (R5.3, D41)', () => {
  const single = {
    question: 'Which?',
    header: 'Pick',
    multiSelect: false,
    allowsOther: true,
    options: [
      { label: 'A', description: 'first', preview: '# Title A\n\n- one' },
      { label: 'B', preview: 'plain B' },
    ],
  };
  const multi = {
    question: 'Which ones?',
    multiSelect: true,
    allowsOther: true,
    options: [{ label: 'X' }, { label: 'Y' }],
  };

  it('builds answers keyed by question text: single, multi, Other and notes', () => {
    let d1 = toggleOption(single, emptyDraft(), 'A');
    d1 = toggleOption(single, d1, 'B');
    expect(draftAnswer(single, d1)).toBe('B');
    const other = { ...toggleOther(single, d1, true), other: ' my own ' };
    expect(other.picked).toEqual([]);
    expect(draftAnswer(single, other)).toBe('my own');
    let d2 = toggleOption(multi, emptyDraft(), 'X');
    d2 = toggleOption(multi, d2, 'Y');
    d2 = { ...toggleOther(multi, d2, true), other: 'Z', note: 'why' };
    const r = questionReply([single, multi], [other, d2]);
    expect(r).toEqual({
      answers: { 'Which?': 'my own', 'Which ones?': ['X', 'Y', 'Z'] },
      notes: { 'Which ones?': 'why' },
      missing: [],
    });
    expect(questionReply([single, multi], [emptyDraft(), d2]).missing).toEqual(['Which?']);
  });

  it('shows the focused or picked option preview for single select only', () => {
    expect(questionPreview(single, emptyDraft())).toBe('# Title A\n\n- one');
    expect(questionPreview(single, toggleOption(single, emptyDraft(), 'B'))).toBe('plain B');
    expect(questionPreview(single, emptyDraft(), 'B')).toBe('plain B');
    expect(questionPreview({ ...single, multiSelect: true }, emptyDraft())).toBeUndefined();
  });

  it('the card renders options, Other, the markdown preview, Submit and Decline', () => {
    const html = card({
      id: 'q1',
      kind: 'question',
      agent: 'main',
      title: 'Which?',
      choices: [
        { id: 'option-0', label: 'A' },
        { id: 'submit', label: 'Submit answers', submits: 'answers' },
        { id: 'decline', label: 'Decline' },
      ],
      stopChoice: 'decline',
      at: 1,
      form: { type: 'question', questions: [single, multi], previewFormat: 'markdown', otherLabel: 'Other' },
    });
    expect(html).toContain('type="radio"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('Other');
    expect(html).toContain('role="heading" aria-level="1"');
    expect(html).toContain('Title A');
    expect(html).toContain('data-choice="submit"');
    expect(html).toContain('data-choice="decline"');
    expect(html).not.toContain('data-choice="option-0"');
  });

  it('an html preview is shown as text, never as live HTML (D13)', () => {
    const html = card({
      id: 'q2',
      kind: 'question',
      agent: 'main',
      title: 'H',
      choices: [{ id: 'submit', label: 'Submit answers', submits: 'answers' }],
      stopChoice: 'decline',
      at: 1,
      form: {
        type: 'question',
        questions: [
          { question: 'H', multiSelect: false, allowsOther: false, options: [{ label: 'A', preview: '<b>x</b>' }] },
        ],
        previewFormat: 'html',
        otherLabel: 'Other',
      },
    });
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;');
  });
});

describe('plan card (R5.4, D42)', () => {
  it('renders the plan, the mode choices, and keep planning with its field', () => {
    const html = card({
      id: 'pl',
      kind: 'plan',
      agent: 'main',
      title: 'Ready to code? Here is the plan',
      choices: [
        { id: 'accept-edits', label: 'Yes, auto-accept edits' },
        { id: 'manual', label: 'Yes, manually approve edits' },
        {
          id: 'keep-planning',
          label: 'No, keep planning',
          feedback: true,
          feedbackPlaceholder: 'Tell Claude what to change',
        },
      ],
      stopChoice: 'keep-planning',
      at: 1,
      form: {
        type: 'plan',
        plan: '## Steps\n\n1. **Read** `a.ts`\n2. Write tests',
        planFilePath: '/w/.claude/plans/p.md',
      },
    });
    expect(html).toContain('Steps');
    expect(html).toContain('<strong>Read</strong>');
    expect(html).toContain('<ol');
    expect(html).toContain('Yes, auto-accept edits');
    expect(html).toContain('placeholder="Tell Claude what to change"');
    expect(html).toContain('Open the plan file');
  });
});

describe('elicitation (R5.5, D43)', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', minLength: 2 },
      email: { type: 'string', format: 'email' },
      count: { type: 'integer', minimum: 1, maximum: 5 },
      color: { type: 'string', enum: ['r', 'g'], enumNames: ['Red', 'Green'] },
      size: { type: 'string', oneOf: [{ const: 's', title: 'Small' }] },
      tags: { type: 'array', items: { enum: ['a', 'b'] } },
      agree: { type: 'boolean', default: false },
    },
    required: ['name', 'count'],
  };

  it('builds fields in property order with their kinds', () => {
    const f = elicitationFields(schema);
    expect(f.map((x) => [x.key, x.kind, x.required])).toEqual([
      ['name', 'text', true],
      ['email', 'text', false],
      ['count', 'integer', true],
      ['color', 'select', false],
      ['size', 'select', false],
      ['tags', 'multi', false],
      ['agree', 'boolean', false],
    ]);
    expect(f[1]!.inputType).toBe('email');
    expect(f[3]!.options).toEqual([
      { value: 'r', label: 'Red' },
      { value: 'g', label: 'Green' },
    ]);
  });

  it('types the content and refuses what the user can fix', () => {
    const f = elicitationFields(schema);
    expect(elicitationContent(f, { name: '', count: '2' })).toEqual({ error: 'Name is required' });
    expect(elicitationContent(f, { name: 'Ada', count: '9' })).toEqual({ error: 'count must be at most 5' });
    expect(elicitationContent(f, { name: 'Ada', count: '2.5' })).toEqual({ error: 'count must be a whole number' });
    expect(elicitationContent(f, { name: 'A', count: '2' })).toEqual({ error: 'Name needs at least 2 characters' });
    expect(elicitationContent(f, { name: 'Ada', count: '3', color: 'g', tags: ['b'], agree: true })).toEqual({
      content: { name: 'Ada', count: 3, color: 'g', tags: ['b'], agree: true },
    });
  });

  it('the form card renders its fields; the URL card shows the whole link and opens only http(s)', () => {
    const form = card({
      id: 'e1',
      kind: 'elicitation',
      agent: 'main',
      title: 'srv: Who are you?',
      choices: [
        { id: 'accept', label: 'Submit', submits: 'content' },
        { id: 'decline', label: 'Decline' },
        { id: 'cancel', label: 'Cancel' },
      ],
      stopChoice: 'decline',
      at: 1,
      form: { type: 'elicitation', serverName: 'srv', message: 'Who are you?', mode: 'form', requestedSchema: schema },
    });
    expect(form).toContain('data-field="name"');
    expect(form).toContain('Name *');
    expect(form).toContain('type="email"');
    expect(form).toContain('<option value="g">Green</option>');
    const longUrl = `https://auth.example.test/authorize?${'x'.repeat(300)}`;
    const urlAsk: AskWire = {
      id: 'e2',
      kind: 'elicitation',
      agent: 'main',
      title: 'srv: Sign in',
      choices: [
        { id: 'accept', label: 'Open and continue' },
        { id: 'decline', label: 'Decline' },
      ],
      stopChoice: 'decline',
      at: 1,
      form: { type: 'elicitation', serverName: 'srv', message: 'Sign in', mode: 'url', url: longUrl },
    };
    const url = card(urlAsk);
    expect(url).toContain(longUrl);
    expect(url).toContain(`href="${longUrl}"`);
    expect(url).toContain('rel="noopener noreferrer"');
    const waiting = card({ ...urlAsk, state: 'waiting', choices: [{ id: 'dismiss', label: 'Close' }] });
    expect(waiting).toContain('waits for you to finish in the browser');
    expect(waiting).toContain('Open the link again');
    const bad = card({ ...urlAsk, form: { ...urlAsk.form!, url: 'javascript:alert(1)' } as AskWire['form'] });
    expect(bad).not.toContain('href="javascript');
    expect(bad).toContain('not an http(s) link');
    expect(safeHttpUrl('ftp://x')).toBeUndefined();
  });
});

describe('trust question (D73)', () => {
  it('shows the whole body and the folder', () => {
    const body = 'Quick safety check: '.repeat(60);
    const html = card({
      id: 't1',
      kind: 'trust',
      agent: 'main',
      title: 'Do you trust the files in this folder? /w',
      detail: body,
      choices: [
        { id: 'trust-accept', label: 'Yes, I trust this folder' },
        { id: 'trust-decline', label: 'No, exit' },
      ],
      stopChoice: 'trust-decline',
      at: 1,
      form: { type: 'trust', directory: '/w', body },
    });
    expect(html).toContain(body.trim());
    expect(html).toContain('Yes, I trust this folder');
  });
});

describe('markdown (safe subset)', () => {
  it('parses blocks and inline marks, and never keeps an unsafe link', () => {
    expect(parseMarkdown('# T\n\ntext *em*\n\n- a\n- b\n\n```ts\nx\n```\n\n> q\n\n---').map((b) => b.t)).toEqual([
      'heading',
      'paragraph',
      'list',
      'code',
      'quote',
      'rule',
    ]);
    expect(parseInline('[x](javascript:alert(1))')[0]).toMatchObject({ t: 'link' });
    expect(parseInline('[x](javascript:alert(1))')[0]).not.toHaveProperty('href');
    expect(parseInline('snake_case_name')).toEqual([{ t: 'text', text: 'snake_case_name' }]);
    expect(parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')[0]).toMatchObject({ t: 'table' });
  });
});

describe('interaction channel (D39)', () => {
  it('parses lines and splits a byte stream into lines', async () => {
    expect(parseChannelLine('{"type":"ping"}')).toEqual({ type: 'ping' });
    expect(parseChannelLine('nope')).toBeUndefined();
    expect(parseChannelLine('{"type":"asks","asks":[{"id":"a","kind":"plan","choices":[]},{"bad":1}]}')).toEqual({
      type: 'asks',
      asks: [{ id: 'a', kind: 'plan', choices: [] }],
    });
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('{"a":1}\n{"b"'));
        c.enqueue(enc.encode(':2}\n'));
        c.close();
      },
    });
    const lines: string[] = [];
    await readLines(body, new AbortController().signal, (l) => lines.push(l));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  function channelApi(base: SessionInfo) {
    let emit: ((l: ChannelLine) => void) | undefined;
    const answers: unknown[] = [];
    let answerStatus = 200;
    let answerBody: unknown = { ok: true };
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      session: async () => base,
      async answer(_s, ask, reply) {
        answers.push({ ask, reply });
        if (answerStatus === 409) return { ok: false, gone: true, error: 'gone' };
        if (answerStatus === 400) return { ok: false, error: (answerBody as { error: string }).error };
        return { ok: true };
      },
      interactions: (_s, signal, onLine) =>
        new Promise<void>((resolve) => {
          emit = onLine;
          signal.addEventListener('abort', () => resolve());
        }),
      choose: async (_s, c) => {
        answers.push({ choose: c });
        return { ok: true };
      },
    };
    return {
      api,
      answers,
      emit: (l: ChannelLine) => emit?.(l),
      setAnswer: (status: number, body?: unknown) => {
        answerStatus = status;
        if (body !== undefined) answerBody = body;
      },
    };
  }

  it('asks from the channel show at once; answers post the form; gone and refused are told apart', async () => {
    const c = channelApi(info());
    const { timers } = manualTimers();
    const store = new SessionControlStore('s1', c.api, timers);
    const off = store.subscribe(() => {});
    await flush();
    await flush();
    c.emit({ type: 'asks', asks: [perm()] });
    expect(store.getSnapshot().channel).toBe('open');
    expect(store.getSnapshot().info?.view.asks?.map((a) => a.id)).toEqual(['p1']);
    c.setAnswer(400, { error: 'that choice is not offered' });
    expect(await store.answer('p1', { choice: 'no', feedback: 'use git clean' })).toBe(false);
    expect(store.getSnapshot().askError).toEqual({ id: 'p1', text: 'that choice is not offered' });
    expect(store.getSnapshot().info?.view.asks).toHaveLength(1);
    c.setAnswer(409);
    expect(await store.answer('p1', 'yes')).toBe(false);
    expect(store.getSnapshot().info?.view.asks).toHaveLength(0);
    expect(store.getSnapshot().error).toContain('answered elsewhere');
    expect(c.answers.slice(0, 2)).toEqual([
      { ask: 'p1', reply: { choice: 'no', feedback: 'use git clean' } },
      { ask: 'p1', reply: 'yes' },
    ]);
    off();
    expect(store.getSnapshot().channel).toBe('closed');
  });

  it('cycleMode picks the next mode of the ring; never while an ask waits', async () => {
    const c = channelApi(info());
    const store = new SessionControlStore('s1', c.api, manualTimers().timers);
    await store.refresh();
    expect(store.cycleMode()).toBe(true);
    await flush();
    expect(c.answers).toEqual([{ choose: { mode: 'acceptEdits' } }]);
    const asking = new SessionControlStore('s2', channelApi(info({}, { asks: [perm()] })).api, manualTimers().timers);
    await asking.refresh();
    expect(asking.cycleMode()).toBe(false);
  });

  it('the answer body carries the form fields (POST …/answer)', async () => {
    const bodies: string[] = [];
    const fetchFn: FetchFn = async (_url, init) => {
      bodies.push(init?.body ?? '');
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    };
    await createApi(fetchFn).answer('s1', 'q1', { choice: 'submit', answers: { 'Which?': ['A', 'B'] } });
    expect(JSON.parse(bodies[0]!)).toEqual({ choice: 'submit', answers: { 'Which?': ['A', 'B'] }, ask: 'q1' });
  });
});

describe('port: pending interaction, takeover and Shift+Tab', () => {
  it('publishes the oldest ask per session with a new key per ask, and removes it when answered', async () => {
    let asks: AskWire[] = [perm({ id: 'b', at: 2 }), perm({ id: 'a', at: 1 })];
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      session: async () => info({}, { asks }),
    };
    const stores = new SessionStores(api, manualTimers().timers);
    const log: string[] = [];
    const off = publishAsks(stores, (i: AskInteraction) => {
      log.push(`+${i.sessionId}/${i.key}/${i.kind}`);
      return () => log.push(`-${i.key}`);
    });
    const store = stores.get('s1');
    await store.refresh();
    expect(log).toEqual([`+s1/a/${ASK_INTERACTION_KIND}`]);
    asks = [perm({ id: 'b', at: 2 })];
    await store.refresh();
    expect(log.slice(1)).toEqual(['-a', `+s1/b/${ASK_INTERACTION_KIND}`]);
    asks = [{ ...perm({ id: 'b', at: 2 }), state: 'waiting' }];
    await store.refresh();
    expect(log.slice(3)).toEqual(['-b', `+s1/b:waiting/${ASK_INTERACTION_KIND}`]);
    asks = [];
    await store.refresh();
    expect(log.at(-1)).toBe('-b:waiting');
    off();
  });

  it('the composer chain elects only our interaction, for its own session', () => {
    const mine = { key: 'a', kind: ASK_INTERACTION_KIND, sessionId: 's1', askId: 'a' } as const;
    expect(selectAsk({ sessionId: 's1', pendingInteraction: mine })).toBe(mine);
    expect(selectAsk({ sessionId: 's2', pendingInteraction: mine })).toBeNull();
    expect(selectAsk({ sessionId: 's1', pendingInteraction: { kind: 'approval' } })).toBeNull();
  });

  it('the takeover renders the cards of the session', async () => {
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      session: async () => info({}, { asks: [perm(), perm({ id: 'p2', at: 2, title: 'Edit wants to run' })] }),
    };
    const stores = new SessionStores(api, manualTimers().timers);
    await stores.get('s1').refresh();
    const html = render(
      React.createElement(AskComposer, {
        matched: { key: 'p1', kind: ASK_INTERACTION_KIND, sessionId: 's1', askId: 'p1' },
        stores,
        actions: actions(),
      }),
    );
    expect(html).toContain('data-raw-agent="ask-composer"');
    expect(html).toContain('data-ask="p1"');
    expect(html).toContain('1 more ask waits');
    expect(html).toContain('Edit wants to run');
  });

  it('the takeover offers Stop while a turn runs (DSH hides its own Stop button), and only then', async () => {
    const stopped: string[] = [];
    const make = async (turn: boolean) => {
      const base = info({}, { asks: [perm()] });
      const api: RawAgentApi = {
        ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
        session: async () => ({ ...base, view: { ...base.view, state: { ...base.view.state, turn } } }),
      };
      const stores = new SessionStores(api, manualTimers().timers);
      await stores.get('s1').refresh();
      return render(
        React.createElement(AskComposer, {
          matched: { key: 'p1', kind: ASK_INTERACTION_KIND, sessionId: 's1', askId: 'p1' },
          stores,
          actions: actions({ stopTurn: (id) => (stopped.push(id), true) }),
        }),
      );
    };
    expect(await make(true)).toContain('data-raw-agent="ask-stop"');
    expect(await make(false)).not.toContain('data-raw-agent="ask-stop"');
  });

  it('Shift+Tab in our composer cycles the mode and consumes the key; otherwise it passes', async () => {
    const chosen: unknown[] = [];
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      session: async () => info(),
      choose: async (_s, c) => {
        chosen.push(c);
        return { ok: true };
      },
    };
    const stores = new SessionStores(api, manualTimers().timers);
    await stores.get('s1').refresh();
    const handler = modeKeyHandler(stores);
    const press = (over: { shift?: boolean; prevented?: boolean; session?: string; region?: boolean } = {}) => {
      let consumed = false;
      const target = {
        closest: (sel: string) =>
          sel === '[data-conversation-session]'
            ? { dataset: { conversationSession: over.session ?? 's1' } }
            : over.region === false
              ? null
              : {},
      };
      const input: FixedInput = {
        type: 'keydown',
        gesture: {
          code: 'Tab',
          control: false,
          alt: false,
          shift: over.shift ?? true,
          meta: false,
          repeat: false,
          composing: false,
          defaultPrevented: over.prevented ?? false,
        },
        context: { region: 'editable', modal: null, target },
        consume: () => {
          consumed = true;
        },
      };
      handler(input);
      return consumed;
    };
    expect(press({ shift: false })).toBe(false);
    expect(press({ prevented: true })).toBe(false); // the command menu took it
    expect(press({ session: 'not-ours' })).toBe(false);
    expect(press({ region: false })).toBe(false);
    expect(press()).toBe(true);
    await flush();
    expect(chosen).toEqual([{ mode: 'acceptEdits' }]);
  });

  it('mountClient wires the takeover and Shift+Tab through injected services (D39, D38)', () => {
    const registered: Array<{ name: unknown; options: Record<string, unknown> }> = [];
    const fixed: unknown[] = [];
    const effects: Array<() => () => void> = [];
    const services: Record<string, unknown> = {
      uiSession: { registerPendingInteraction: () => () => () => {} },
      shortcuts: {
        registerFixed: (c: { id: string }) => {
          fixed.push(c.id);
          return () => {};
        },
        observeFixedInput: () => () => {},
      },
    };
    const slots = {
      inject: (_k: string, cb: () => unknown) => void cb(),
      register: (options: Record<string, unknown>) => {
        registered.push({ name: options.name, options });
        return () => {};
      },
    };
    const ctx = {
      slots,
      get: (n: string) => services[n],
      effect: (fn: () => () => void) => void effects.push(fn),
      inject: (deps: string[], fn: (scope: unknown) => void) =>
        fn({ ...Object.fromEntries(deps.map((d) => [d, services[d]])), slots, get: ctx.get, effect: ctx.effect }),
    };
    mountClient(ctx as never, { fetch: async () => ({ status: 404, ok: false, json: async () => ({}) }) });
    for (const e of effects) e();
    expect(registered.map((r) => r.name)).toEqual(['conversation.composer', 'conversation.input.left']);
    expect(fixed).toEqual([MODE_SHORTCUT_ID]);
    const inject = registered[1]!.options.inject as (id: string) => { asksInComposer: () => boolean };
    expect(inject('s1').asksInComposer()).toBe(true);
  });
});
