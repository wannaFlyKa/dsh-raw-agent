// M1 attachments round trips (R4.3; D23, D34, D76, D85): the real in-process DSH loop with the real
// `llm` runtime and the real local attachment store. A pasted image reaches the backend as base64
// bytes read from DSH's store, a file as its host path; a tool-result image is stored through
// `ctx.attachments.saveImages()` and written as DSH's native image block (no base64 in the log);
// and on turn 1 DSH's image admission passes even when the DSH default model is text-only (D76).
// Skipped when no installed DSH is found.

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createRawAgentHost, mountHost, SETTINGS_MODEL } from '@dsh-raw-agent/dsh-host';
import {
  TEXT_ONLY_DEFAULT,
  checkSession,
  createLoop,
  createStubFactory,
  imageAdmissionRefusal,
  loadDsh,
  type LoopOptions,
  type LoopRuntime,
  type StubScript,
} from '@dsh-raw-agent/testkit';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dsh = await loadDsh();
const MAIN = { kind: 'main' } as const;
const KIND = 'raw-test';

/** A 1x1 PNG (red) and a 1x1 PNG (blue). */
const RED_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const BLUE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPj/HwADBwIAMCbHYQAAAABJRU5ErkJggg==';

let rt: LoopRuntime | undefined;
afterEach(async () => {
  await rt?.dispose();
  rt = undefined;
});

const idle = (agent: any) => new Promise((r) => setTimeout(r, 40)).then(() => agent.whenIdle());

interface Opts extends LoopOptions {
  /** DSH's profile default for the new session; our preset must not depend on it (D76). */
  agentOptions?: { provider: string; model: string };
  /** Mount the Host entry's catalog (our `settings` row, D34). */
  catalog?: boolean;
}

async function session(script: StubScript, opts: Opts = {}) {
  rt ??= await createLoop(dsh!, { llm: opts.llm ?? 'real', attachments: opts.attachments ?? true });
  const stub = createStubFactory(script, KIND);
  if (opts.catalog !== false) mountHost(rt.ctx, [stub.factory]);
  const host = createRawAgentHost({ factories: [stub.factory] });
  const sessionId = `session-${randomUUID()}`;
  const warnings: unknown[] = [];
  const handle = await rt.ctx.agents.create({
    sessionId,
    meta: { cwd: rt.root },
    agentOptions: opts.agentOptions ?? { ...TEXT_ONLY_DEFAULT },
    setup: async (agentCtx: any) => {
      host.applyAgent(
        agentCtx,
        { backend: KIND },
        { writer: { warn: (n: string, d?: unknown) => warnings.push([n, d]) } },
      );
    },
  });
  return { handle, agent: handle.agent, record: stub.record, sessionId, warnings };
}

const store = () => rt!.ctx.get('attachments');

async function savedImage(base64: string, name?: string) {
  const [ref] = await store().saveImages([{ data: Buffer.from(base64, 'base64'), mediaType: 'image/png', name }]);
  return ref;
}

const userMessage = (content: unknown[]) => ({
  id: randomUUID(),
  role: 'user' as const,
  content,
  source: { kind: 'user', rpcId: randomUUID() },
});

const reply = (text: string, stepId = 'r1') => [
  { type: 'step-start', agent: MAIN, stepId, at: Date.now() },
  { type: 'step-message', agent: MAIN, stepId, blocks: [{ type: 'text', text }], final: true },
  { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
];

function expectValid(c: Awaited<ReturnType<typeof checkSession>>) {
  expect(c.relationships).toBe('ok');
  expect(c.streamCheck).toBe('ok');
  expect(c.reload).toBe('ok');
  expect(c.reloadAddedTail.filter((t) => t !== 'session/end-seed')).toEqual([]);
}

/** A tool call whose result carries `content`, then a closing reply. */
function toolTurn(content: unknown[]): StubScript {
  return {
    onSend: [
      [
        { type: 'turn-start', origin: 'user' },
        { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
        {
          type: 'step-message',
          agent: MAIN,
          stepId: 'm1',
          blocks: [{ type: 'tool-call', id: 'toolu_img', name: 'Read', arguments: '{"file_path":"/w/red.png"}' }],
          final: true,
        },
        { type: 'tool-result', agent: MAIN, callId: 'toolu_img', isError: false, chainId: 'c1', content },
        ...reply('A red pixel.', 'm2'),
      ] as any,
    ],
  };
}

describe.skipIf(dsh === undefined)(`M1 attachments round trip (installed DSH ${dsh?.version})`, () => {
  it('D76: turn-1 image admission passes against a text-only DSH default model', async () => {
    const s = await session({ onSend: [reply('ok') as any] });
    // Our preset recorded the session-only `settings` row on creation; the DSH default is unused.
    const sel = s.agent.session.snapshotEvents().filter((e: any) => e.type === 'model/selection');
    expect(sel.map((e: any) => [e.data.provider, e.data.model])).toEqual([[KIND, SETTINGS_MODEL]]);
    expect(s.agent.model.current()).toMatchObject({ provider: KIND, model: SETTINGS_MODEL });
    expect(await imageAdmissionRefusal(rt!.ctx, s.agent)).toBeUndefined();
    const info = await rt!.ctx.get('llm').resolveModelInfo(KIND, SETTINGS_MODEL);
    expect(info.inputModalities).toEqual(['text', 'image']);
    expect(rt!.stray).toEqual([]);
  });

  it('D76 control: a session without our preset is refused by the same text-only DSH default', async () => {
    rt = await createLoop(dsh!, { llm: 'real', attachments: true });
    const plain = await rt.ctx.agents.create({
      sessionId: `session-${randomUUID()}`,
      meta: { cwd: rt.root },
      agentOptions: { ...TEXT_ONLY_DEFAULT },
    });
    expect(plain.agent.model.current()).toMatchObject(TEXT_ONLY_DEFAULT);
    expect(await imageAdmissionRefusal(rt.ctx, plain.agent)).toBe('Model "flash" does not support image input.');
    await plain.dispose();
  });

  it('D23: a pasted image goes as base64 from the store, a file as its host path, in part order', async () => {
    const s = await session({ onSend: [reply('It is red.') as any] });
    const image = await savedImage(RED_PNG, 'red.png');
    const file = await store().saveFile({ data: Buffer.from('hello notes\n'), name: 'notes.txt' });
    const message = userMessage([
      { type: 'image', attachment: image },
      { type: 'file', attachment: file },
      { type: 'text', text: 'What colour is this?' },
    ]);
    s.agent.followup(message);
    await idle(s.agent);
    expect(s.record.sent).toHaveLength(1);
    const stored = await store().readImage(image);
    expect(s.record.sent[0]!.parts).toEqual([
      { type: 'image', mediaType: 'image/png', base64: Buffer.from(stored.data).toString('base64') },
      { type: 'file', hostPath: store().fileHostPath(file) },
      { type: 'text', text: 'What colour is this?' },
    ]);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    // The log keeps DSH's own message unchanged: refs only, no bytes, no added text.
    const um = c.events.find((e: any) => e.type === 'user/message');
    expect(um.data.content).toEqual(message.content);
    const log = JSON.stringify(c.events);
    expect(log).not.toContain(RED_PNG);
    expect(log).not.toContain(Buffer.from(stored.data).toString('base64'));
    expect(rt!.stray).toEqual([]);
  });

  it('D85: a tool-result image is stored and written as a native attachment ref', async () => {
    const s = await session(
      toolTurn([
        { type: 'text', text: 'Read image' },
        { type: 'image', mediaType: 'image/png', base64: BLUE_PNG },
      ]),
    );
    s.agent.followup(userMessage([{ type: 'text', text: 'read red.png' }]));
    await idle(s.agent);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    const result = c.events.find((e: any) => e.type === 'tool/result');
    const [text, img] = result.data.message.content;
    expect(text).toEqual({ type: 'text', text: 'Read image' });
    expect(img.type).toBe('image');
    expect(img.attachment).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 });
    expect(String(img.attachment.attachmentId)).toMatch(/^sha256:/);
    expect(result.data.meta).toEqual({ chainUuid: 'c1' });
    // The bytes live in DSH's store, never in the log.
    const back = await store().readImage(img.attachment);
    expect(back.data.length).toBe(img.attachment.bytes);
    expect(JSON.stringify(c.events)).not.toContain(BLUE_PNG);
    expect(c.sequence.at(-1)).toMatch(/^turn\/end/);
    expect(s.warnings).toEqual([]);
    expect(rt!.stray).toEqual([]);
  });

  it('D85: a refused image batch becomes placeholders for every image of that result', async () => {
    const s = await session(
      toolTurn([
        { type: 'image', mediaType: 'image/png', base64: RED_PNG },
        { type: 'image', mediaType: 'image/bmp', base64: 'Qk0=' },
      ]),
    );
    s.agent.followup(userMessage([{ type: 'text', text: 'read both' }]));
    await idle(s.agent);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    const result = c.events.find((e: any) => e.type === 'tool/result');
    expect(result.data.message.content).toEqual([
      {
        type: 'text',
        text: '[image unavailable: image/png; it was not stored: the media type image/bmp is not PNG, JPEG, WebP or GIF]',
      },
      {
        type: 'text',
        text: '[image unavailable: image/bmp; it was not stored: the media type image/bmp is not PNG, JPEG, WebP or GIF]',
      },
    ]);
    expect(JSON.stringify(c.events)).not.toContain(RED_PNG);
  });

  it('D85: with no attachment store a result image is a placeholder, never base64', async () => {
    const s = await session(toolTurn([{ type: 'image', mediaType: 'image/png', base64: RED_PNG }]), {
      attachments: false,
    });
    s.agent.followup(userMessage([{ type: 'text', text: 'read it' }]));
    await idle(s.agent);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    const result = c.events.find((e: any) => e.type === 'tool/result');
    expect(result.data.message.content).toEqual([
      {
        type: 'text',
        text: '[image unavailable: image/png; it was not stored: no attachment store is mounted]',
      },
    ]);
  });

  it('D23 + D27: a steer with an image is read from the store, then sent and claimed', async () => {
    const s = await session({
      inputAliases: ['first', 'STEER'],
      onSend: [
        [
          { type: 'turn-start', origin: 'user' },
          { type: 'step-start', agent: MAIN, stepId: 'm1', at: Date.now() },
          {
            type: 'step-message',
            agent: MAIN,
            stepId: 'm1',
            blocks: [{ type: 'tool-call', id: 'toolu_1', name: 'Bash', arguments: '{"command":"sleep 1"}' }],
            final: true,
          },
        ],
        [
          { type: 'input-consumed', inputId: 'STEER' },
          {
            type: 'tool-result',
            agent: MAIN,
            callId: 'toolu_1',
            isError: false,
            content: [{ type: 'text', text: '' }],
          },
          ...reply('Seen the picture.', 'm2'),
        ],
      ] as any,
    });
    s.agent.followup(userMessage([{ type: 'text', text: 'run it' }]));
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10));
    };
    await until(() => s.agent.session.snapshotEvents().some((e: any) => e.type === 'tool/call'));
    const image = await savedImage(BLUE_PNG);
    const steer = userMessage([
      { type: 'image', attachment: image },
      { type: 'text', text: 'and this one?' },
    ]);
    s.agent.steer(steer);
    await until(() => s.record.sent.length === 2);
    await idle(s.agent);
    const stored = await store().readImage(image);
    expect(s.record.sent[1]!.parts).toEqual([
      { type: 'image', mediaType: 'image/png', base64: Buffer.from(stored.data).toString('base64') },
      { type: 'text', text: 'and this one?' },
    ]);
    const c = await checkSession(dsh!, rt!, s.handle, s.sessionId);
    expectValid(c);
    const msgs = c.events.filter((e: any) => e.type === 'user/message');
    expect(msgs.map((e: any) => e.data.id)).toEqual([expect.any(String), steer.id]);
    expect(msgs[1].data.content[0]).toEqual({ type: 'image', attachment: image });
  });

  it('an attachment the backend cannot be given ends the turn with a clear error, nothing sent', async () => {
    const s = await session({ onSend: [reply('never') as any] }, { attachments: false });
    const fakeRef = { attachmentId: 'sha256:00', mediaType: 'image/png', bytes: 1, width: 1, height: 1 };
    s.agent.followup(
      userMessage([
        { type: 'image', attachment: fakeRef },
        { type: 'text', text: 'see?' },
      ]),
    );
    await idle(s.agent);
    expect(s.record.sent).toEqual([]);
    expect(s.record.opened).toEqual([]); // no process for a message that cannot be sent (rule 9)
    const events = s.agent.session.snapshotEvents();
    const end = events.findLast((e: any) => e.type === 'turn/end');
    expect(end.data.reason.kind).toBe('error');
    expect(JSON.stringify(end.data.reason)).toContain('no attachment store is mounted');
    expect(events.filter((e: any) => e.type === 'user/message')).toHaveLength(1);
  });
});
