// M2 verify-1 fixes in the client: DSH's `/permission` preset popup stays out of our sessions
// (R1.4 leftover), keyboard keys on the ask cards (R5.2-R5.4), and the card details.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  AskCard,
  cardKey,
  numberedChoices,
  type AskWire,
  type HostActions,
  PRESET_DECORATION,
  SessionStores,
  createApi,
  guardPresetDecoration,
  isOurSession,
  parseChannelLine,
  type RawAgentApi,
  type SessionInfo,
} from '@dsh-raw-agent/dsh-client';

function info(): SessionInfo {
  return {
    backend: { kind: 'k', displayName: 'Agent' },
    permissionModes: [{ id: 'default', label: 'Ask' }],
    efforts: [],
    needsProcess: [],
    models: [],
    modelsFrom: 'session',
    settings: { sources: {} },
    view: {
      state: { process: 'running', turn: false, backgroundTasks: 0 },
      live: { mode: 'default' },
      choice: { applied: {}, resetPending: false },
    },
  } as unknown as SessionInfo;
}

/** The part of DSH's command runtime we touch (`P/dsh-client-ui-commands/lib/client.js:1344, 1521`). */
function fakeCommandUi() {
  const live = { decorations: new Map<string, { name: string; available(s: { sessionId: string }): boolean }>() };
  const decorate = (name: string, available: (s: { sessionId: string }) => boolean) => {
    if (live.decorations.has(name)) throw new Error(`ui-commands: duplicate decoration for /${name}`);
    live.decorations.set(name, { name, available });
    return () => live.decorations.delete(name);
  };
  // DSH's dispatch: the popup opens only when the decoration is there and available.
  const opensPopup = (name: string, sessionId: string) => {
    const d = live.decorations.get(name);
    return d !== undefined && d.available({ sessionId });
  };
  return { live, decorate, opensPopup };
}

describe('R1.4 leftover: DSH preset popup', () => {
  it('our sessions get no popup; other sessions keep it; other names are untouched', () => {
    const ui = fakeCommandUi();
    const ours = new Set(['ours']);
    const undo = guardPresetDecoration(ui, (id) => ours.has(id));
    expect(undo).toBeTypeOf('function');
    // DSH registers its decoration after us (plugin order is not fixed): still guarded.
    ui.decorate(PRESET_DECORATION, () => true);
    ui.decorate('model', () => true);
    expect(ui.opensPopup(PRESET_DECORATION, 'ours')).toBe(false);
    expect(ui.opensPopup(PRESET_DECORATION, 'standard')).toBe(true);
    expect(ui.opensPopup('model', 'ours')).toBe(true);
    // DSH's own availability still counts outside our sessions.
    ui.live.decorations.delete(PRESET_DECORATION);
    ui.decorate(PRESET_DECORATION, () => false);
    expect(ui.opensPopup(PRESET_DECORATION, 'standard')).toBe(false);
    // The duplicate check and the disposer still work on the real map.
    expect(() => ui.decorate(PRESET_DECORATION, () => true)).toThrow(/duplicate/);
    // Undo restores DSH's own lookup.
    undo!();
    ui.live.decorations.delete(PRESET_DECORATION);
    ui.decorate(PRESET_DECORATION, () => true);
    expect(ui.opensPopup(PRESET_DECORATION, 'ours')).toBe(true);
    expect(Object.hasOwn(ui.live.decorations, 'get')).toBe(false);
  });

  it("0.1.1: our sessions get the agent-mode popup; other sessions keep DSH's", async () => {
    const ui = fakeCommandUi();
    const popup = { kind: 'popupSelect' as const, options: async () => [], onSelect: () => {} };
    guardPresetDecoration(ui, (id) => id === 'ours', popup);
    const dshUi = { kind: 'popupSelect', name: 'dsh presets' };
    ui.live.decorations.set(PRESET_DECORATION, { name: PRESET_DECORATION, available: () => true, ui: dshUi } as never);
    // DSH asks `available` and then reads `ui` on the same object.
    const forOurs = ui.live.decorations.get(PRESET_DECORATION) as unknown as {
      available(s: unknown): boolean;
      ui: unknown;
    };
    expect(forOurs.available({ sessionId: 'ours' })).toBe(true);
    expect(forOurs.ui).toBe(popup);
    const forOther = ui.live.decorations.get(PRESET_DECORATION) as unknown as {
      available(s: unknown): boolean;
      ui: unknown;
    };
    expect(forOther.available({ sessionId: 'standard' })).toBe(true);
    expect(forOther.ui).toBe(dshUi);
  });

  it('an unknown command runtime shape changes nothing', () => {
    expect(guardPresetDecoration(undefined, () => true)).toBeUndefined();
    expect(guardPresetDecoration({ live: {} }, () => true)).toBeUndefined();
    expect(guardPresetDecoration({ live: { decorations: {} } }, () => true)).toBeUndefined();
  });

  it('a session counts as ours once our route answered for it', async () => {
    let mine = true;
    const api: RawAgentApi = {
      ...createApi(async () => ({ status: 500, ok: false, json: async () => ({}) })),
      session: async () => {
        if (!mine) throw Object.assign(new Error('404'), { status: 404 });
        return info();
      },
    };
    const stores = new SessionStores(api);
    expect(isOurSession(stores, 's1')).toBe(false); // no store yet: DSH decides
    await stores.get('s1').refresh();
    expect(isOurSession(stores, 's1')).toBe(true);
    mine = false;
    expect(isOurSession(stores, 'other')).toBe(false);
    stores.dispose();
  });
});

const perm: AskWire = {
  id: 'p1',
  kind: 'permission',
  agent: 'main',
  title: 'Bash wants to run',
  choices: [
    { id: 'no', label: 'No', kind: 'reject-once', feedback: true },
    { id: 'yes', label: 'Yes', kind: 'allow-once' },
    { id: 'always', label: 'Yes, and always', kind: 'allow-always', destination: 'x' },
  ],
  stopChoice: 'no',
  at: 1,
  form: { type: 'permission', toolName: 'Bash', input: { command: 'ls' } },
};
const mods = { inText: false, modified: false };

describe('keyboard keys on the ask cards (R5.2-R5.4)', () => {
  it('numbers the choices in the order the card shows them; a number picks one', () => {
    expect(numberedChoices(perm).map((c) => c.id)).toEqual(['yes', 'always', 'no']);
    expect(cardKey(perm, '1', mods)).toMatchObject({ type: 'choose', choice: { id: 'yes' } });
    expect(cardKey(perm, '3', mods)).toMatchObject({ type: 'choose', choice: { id: 'no' } });
    expect(cardKey(perm, '4', mods)).toBeUndefined();
  });

  it('Esc gives the stop answer; arrows move; typing in a field and modified keys do nothing', () => {
    expect(cardKey(perm, 'Escape', mods)).toMatchObject({ type: 'choose', choice: { id: 'no' } });
    expect(cardKey(perm, 'ArrowDown', mods)).toEqual({ type: 'move', by: 1 });
    expect(cardKey(perm, 'ArrowUp', mods)).toEqual({ type: 'move', by: -1 });
    expect(cardKey(perm, '1', { inText: true, modified: false })).toBeUndefined();
    expect(cardKey(perm, 'Escape', { inText: true, modified: false })).toBeUndefined();
    expect(cardKey(perm, '1', { inText: false, modified: true })).toBeUndefined();
  });

  it('plans put "keep planning" last; forms (questions, elicitations) have no number keys', () => {
    const plan: AskWire = {
      ...perm,
      kind: 'plan',
      choices: [
        { id: 'keep', label: 'No, keep planning', feedback: true },
        { id: 'accept-edits', label: 'Yes, auto-accept edits' },
      ],
      stopChoice: 'keep',
      form: { type: 'plan', plan: '# p' },
    } as AskWire;
    expect(numberedChoices(plan).map((c) => c.id)).toEqual(['accept-edits', 'keep']);
    const q = {
      ...perm,
      kind: 'question',
      choices: [{ id: 'decline', label: 'Decline' }],
      stopChoice: 'decline',
    } as AskWire;
    expect(numberedChoices(q)).toEqual([]);
    expect(cardKey(q, 'Escape', mods)).toMatchObject({ choice: { id: 'decline' } });
    expect(numberedChoices({ ...perm, state: 'waiting' })).toEqual([]);
  });

  it('the card shows the number of each choice', () => {
    const acts = {
      openPreview: () => true,
      openTerminal: () => true,
      copy: async () => true,
    } as unknown as HostActions;
    const html = renderToStaticMarkup(
      React.createElement(AskCard, {
        ask: perm,
        displayName: 'Agent',
        sessionId: 's1',
        actions: acts,
        busy: false,
        onAnswer: () => {},
      }),
    );
    expect(html).toMatch(/aria-keyshortcuts="1"[^>]*data-choice="yes"|data-choice="yes"[^>]*aria-keyshortcuts="1"/);
    expect(html).toMatch(/data-choice="no"[^>]*aria-keyshortcuts="3"|aria-keyshortcuts="3"[^>]*data-choice="no"/);
  });

  it('a boolean form field puts its box next to its label', () => {
    const acts = {
      openPreview: () => true,
      openTerminal: () => true,
      copy: async () => true,
    } as unknown as HostActions;
    const ask = {
      id: 'e1',
      kind: 'elicitation',
      agent: 'main',
      title: 'srv: details',
      choices: [
        { id: 'accept', label: 'Submit', submits: 'content' },
        { id: 'decline', label: 'Decline' },
      ],
      stopChoice: 'decline',
      at: 1,
      form: {
        type: 'elicitation',
        serverName: 'srv',
        message: 'details',
        mode: 'form',
        requestedSchema: { type: 'object', properties: { news: { type: 'boolean', title: 'Newsletter' } } },
      },
    } as unknown as AskWire;
    const html = renderToStaticMarkup(
      React.createElement(AskCard, {
        ask,
        displayName: 'Agent',
        sessionId: 's1',
        actions: acts,
        busy: false,
        onAnswer: () => {},
      }),
    );
    expect(html).toMatch(/data-raw-agent="field-boolean"[^>]*><input type="checkbox"[^>]*><span>Newsletter<\/span>/);
  });
});

describe('the channel carries the live line (a /permission answer shows at once)', () => {
  it('parses live and ignores a malformed one', () => {
    const l = parseChannelLine(
      '{"type":"asks","asks":[],"live":{"mode":"plan","notice":{"level":"info","text":"x","at":1}}}',
    );
    expect(l).toMatchObject({ type: 'asks', live: { mode: 'plan', notice: { text: 'x' } } });
    expect(parseChannelLine('{"type":"asks","asks":[],"live":[1]}')).toEqual({ type: 'asks', asks: [] });
  });
});
