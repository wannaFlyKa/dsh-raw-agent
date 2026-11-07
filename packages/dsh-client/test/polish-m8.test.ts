// M8 polish: cheap UX leftovers (phase4 LEFTOVERS.md). Lifecycle notices shown once, the banner
// above the composer, the rewound message back in the branch composer, rewind row figures, the
// edited "always" rule in its label, `/model` opening our picker, long command names, the MCP
// count refresh, and the workflow launch phases.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  LIFECYCLE_ENTRY_ID,
  LIFECYCLE_ORDER,
  LIFECYCLE_SLOT,
  MODEL_CONTRIBUTION,
  RewindPanel,
  SessionStores,
  editedAlwaysChoice,
  guardModelContribution,
  handBackDraft,
  lifecycleStackStyle,
  openPicker,
  parseRewindOptions,
  permissionPreview,
  pointStats,
  rewindDraft,
  scriptPhases,
  shortCommandLabel,
  sourceCandidates,
  statusLine,
  type AskChoiceWire,
  type CommandsAnswerWire,
  type HostActions,
  type RawAgentApi,
  type RewindOptionsWire,
  type SessionInfo,
} from '@dsh-raw-agent/dsh-client';

function info(view: Partial<SessionInfo['view']> = {}): SessionInfo {
  return {
    backend: { kind: 'claude-code', displayName: 'Agent' },
    view: {
      state: { process: 'idle', turn: 'idle', inputs: 0 },
      live: {},
      choice: { applied: {}, resetPending: false },
      ...view,
    },
  } as SessionInfo;
}

describe('lifecycle facts show once (M7 leftover)', () => {
  it('the status line skips a notice the lifecycle banner holds', () => {
    const i = info({
      live: { notice: { level: 'warning', text: 'When DSH last stopped…', at: 1, topic: 'lifecycle' } },
    });
    expect(statusLine(i)).toBeUndefined();
    const plain = info({ live: { notice: { level: 'info', text: 'Mode: plan', at: 1 } } });
    expect(statusLine(plain)).toBe('Agent: Mode: plan');
  });

  it('the banner sits in the card stack above the composer, sized as DSH cards (not in the pill row)', () => {
    expect(LIFECYCLE_SLOT).toBe('conversation.input.dock');
    expect(LIFECYCLE_ENTRY_ID).toBe('raw-agent-lifecycle');
    expect(LIFECYCLE_ORDER).toBeGreaterThan(20); // after DSH's queue card (20), next to the composer
    expect(lifecycleStackStyle.flexBasis).toBeUndefined();
    expect(String(lifecycleStackStyle.width)).toContain('--dsh-composer-side-clearance');
    expect(lifecycleStackStyle.margin).toBe('0 auto');
  });
});

describe('the rewound message goes back to the composer (M7 leftover)', () => {
  it('reads the whole text, and says what cannot go back', () => {
    expect(rewindDraft({ messageId: 'm', text: 'hello', at: 0 })).toEqual({ text: 'hello' });
    expect(rewindDraft({ messageId: 'm', text: 'abc…', cut: true, draft: 'abcdef', at: 0 })).toEqual({
      text: 'abcdef',
    });
    const tooLong = rewindDraft({ messageId: 'm', text: 'abc…', cut: true, at: 0 });
    expect(tooLong.text).toBeUndefined();
    expect(tooLong.note).toContain('too long');
    const withImage = rewindDraft({ messageId: 'm', text: 'look', attachments: 2, at: 0 });
    expect(withImage.text).toBe('look');
    expect(withImage.note).toContain('2 attachments were not put back');
    expect(rewindDraft({ messageId: 'm', text: '', attachments: 1, at: 0 }).text).toBeUndefined();
  });

  it('hands the text to the branch store as a composer prefill, and the note', () => {
    const api = { state: vi.fn() } as unknown as RawAgentApi;
    const stores = new SessionStores(api);
    const branch = stores.get('branch-1');
    handBackDraft(branch, { text: 'retry this', note: 'its attachment was not put back' });
    const snap = branch.getSnapshot();
    expect(snap.prefillRequest).toMatchObject({ text: 'retry this', target: 'composer', seq: 1 });
    expect(snap.note).toBe('its attachment was not put back');
    handBackDraft(undefined, { text: 'x' }); // no store: nothing breaks
  });

  it('the wire keeps the whole text and the cut flag', () => {
    const o = parseRewindOptions({
      points: [{ messageId: 'm', text: 'a…', cut: true, draft: 'abc', at: 1 }],
    } as Partial<RewindOptionsWire>);
    expect(o.points[0]).toMatchObject({ cut: true, draft: 'abc' });
  });
});

describe('rewind rows show their change figure (M7 leftover)', () => {
  it('words the figure of a dry run', () => {
    expect(pointStats(undefined)).toBeUndefined();
    expect(pointStats({ ok: false, filesChanged: [] })).toBeUndefined();
    expect(pointStats({ ok: true, filesChanged: [], dryRun: true })).toBe('no file changed since');
    expect(pointStats({ ok: true, filesChanged: ['a', 'b'], insertions: 10, deletions: 2, dryRun: true })).toBe(
      '2 files +10 −2 since',
    );
    expect(pointStats({ ok: true, filesChanged: ['a'] })).toBe('1 file since');
  });

  it('the dialog shows the figure under a row', () => {
    const options: RewindOptionsWire = {
      running: true,
      fileRewind: true,
      unstartedFork: false,
      restoreCodePending: false,
      displayName: 'Agent',
      points: [{ messageId: 'm1', text: 'make a file', at: 1, forkSeq: 3 }],
    };
    const html = renderToStaticMarkup(
      React.createElement(RewindPanel, {
        sessionId: 's',
        api: {} as RawAgentApi,
        actions: {} as HostActions,
        store: new SessionStores({} as RawAgentApi).get('s'),
        onClose: () => {},
        initial: { options, stats: { m1: { ok: true, filesChanged: ['f.txt'], insertions: 3, deletions: 0 } } },
      }),
    );
    expect(html).toContain('data-raw-agent="rewind-point-stats"');
    expect(html).toContain('1 file +3 −0 since');
  });
});

describe('an edited "always" rule shows in its row (M2 leftover)', () => {
  const choice: AskChoiceWire = {
    id: 'always-0',
    kind: 'allow-always',
    label: "Yes, and don't ask again for Bash(ln -s README.md link1)",
    effects: ['add allow rule Bash(ln -s README.md link1) (project local settings)'],
    editable: { value: 'ln -s README.md link1', toolName: 'Bash' },
  };
  it('label and effects name the edited rule', () => {
    const c = editedAlwaysChoice(choice, ' ln -s README.md * ');
    expect(c.label).toBe("Yes, and don't ask again for Bash(ln -s README.md *)");
    expect(c.effects).toEqual(['add allow rule Bash(ln -s README.md *) (project local settings)']);
    expect(c.editable).toEqual(choice.editable); // the answer still compares with the agent's rule
  });
  it('an empty or unchanged edit keeps the agent text', () => {
    expect(editedAlwaysChoice(choice, undefined)).toBe(choice);
    expect(editedAlwaysChoice(choice, '  ')).toBe(choice);
    expect(editedAlwaysChoice(choice, 'ln -s README.md link1')).toBe(choice);
    const plain: AskChoiceWire = { id: 'a', label: 'Yes, always' };
    expect(editedAlwaysChoice(plain, 'x')).toBe(plain);
  });
});

describe('/model opens our model picker in our sessions (M6 leftover)', () => {
  const dshModel = () => ({
    name: MODEL_CONTRIBUTION,
    available: (s: { sessionId?: string }) => s.sessionId !== 'sub',
    ui: { kind: 'popupSelect', options: async () => [] },
  });

  it('our session gets an action that opens our picker; others keep DSH popup', () => {
    const contributions = new Map<string, unknown>([
      ['model', dshModel()],
      ['other', { available: () => true, ui: { kind: 'popupSelect' } }],
    ]);
    const ui = { live: { contributions } };
    const opened: string[] = [];
    const undo = guardModelContribution(
      ui,
      (id) => id === 'ours',
      (id) => opened.push(id),
    );
    expect(undo).toBeTypeOf('function');
    // What the command runtime does: available(session), then read ui, in one step.
    const c = contributions.get('model') as {
      available(s: object): boolean;
      ui: { kind: string; run?(s: object): void };
    };
    expect(c.available({ sessionId: 'ours' })).toBe(true);
    expect(c.ui.kind).toBe('action');
    c.ui.run!({ sessionId: 'ours' });
    expect(opened).toEqual(['ours']);
    const d = contributions.get('model') as typeof c;
    expect(d.available({ sessionId: 'dsh' })).toBe(true);
    expect(d.ui.kind).toBe('popupSelect');
    expect((contributions.get('other') as { ui: { kind: string } }).ui.kind).toBe('popupSelect');
    // A session DSH hides /model in keeps it hidden unless it is ours.
    expect((contributions.get('model') as typeof c).available({ sessionId: 'sub' })).toBe(false);
    undo!();
    expect((contributions.get('model') as typeof c).ui.kind).toBe('popupSelect');
    expect(
      guardModelContribution(
        {},
        () => true,
        () => {},
      ),
    ).toBeUndefined();
  });

  it('openPicker focuses the select and opens it where the browser allows', () => {
    const el = { focus: vi.fn(), showPicker: vi.fn() };
    expect(openPicker(el)).toBe(true);
    expect(el.focus).toHaveBeenCalled();
    const refused = {
      focus: vi.fn(),
      showPicker: () => {
        throw new Error('NotAllowedError');
      },
    };
    expect(openPicker(refused)).toBe(false);
    expect(refused.focus).toHaveBeenCalled();
    expect(openPicker(null)).toBe(false);
    expect(openPicker({ disabled: true, focus: vi.fn() })).toBe(false);
  });

  it('the store takes a model panel request', () => {
    const store = new SessionStores({} as RawAgentApi).get('s');
    store.requestPanel('model');
    expect(store.getSnapshot().panelRequest).toMatchObject({ panel: 'model', seq: 1 });
  });
});

describe('long command names keep their end in the / menu (M6 leftover)', () => {
  it('shortens a long plugin MCP prompt name to its first and last segment', () => {
    const name = 'plugin:SomeVeryLongPluginName-claude-code:builder-mcp:search_code (MCP)';
    expect(shortCommandLabel(name)).toBe('plugin:…:search_code (MCP)');
    expect(shortCommandLabel('compact')).toBeUndefined();
    const flat = 'x'.repeat(30) + 'the-distinct-tail';
    const s = shortCommandLabel(flat)!;
    expect(s.length).toBeLessThanOrEqual(36);
    expect(s.endsWith('distinct-tail')).toBe(true);
  });

  it('the menu row carries the short label and the exact name', () => {
    const name = 'plugin:SomeVeryLongPluginName-claude-code:builder-mcp:search_code (MCP)';
    const answer = {
      running: true,
      displayName: 'Agent',
      rows: [{ name, description: 'Search', kind: 'mcp', menu: 'agent' }],
    } as unknown as CommandsAnswerWire;
    const [row] = sourceCandidates(answer, '');
    expect(row).toMatchObject({ name, label: 'plugin:…:search_code (MCP)' });
  });
});

describe('workflow launch ask lists the script phases (M4 leftover)', () => {
  it('reads literal phase titles in order, once each', () => {
    const script =
      'phase("Plan")\nawait agent("a")\nphase(\'Build\', {x: 1})\nphase(`Check`)\nphase("Plan")\nphase(name)';
    expect(scriptPhases(script)).toEqual(['Plan', 'Build', 'Check']);
    expect(scriptPhases('nophase("x")')).toEqual([]);
    expect(permissionPreview({ script, name: 'w' })).toMatchObject({
      kind: 'text',
      note: 'Workflow: w · Phases: Plan → Build → Check',
    });
  });
});
