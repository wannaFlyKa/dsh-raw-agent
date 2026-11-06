// R4.3 host side: user attachments → backend input (D23), tool-result images → stored host refs
// (D85). Driver-level tests use a fake sink; port-level tests use a fake `ctx.attachments`.
import { describe, expect, it } from 'vitest';
import { AsyncQueue, type AgentBackendFactory, type BackendEvent } from '@dsh-raw-agent/core';
import {
  AttachmentInputError,
  SessionRuntime,
  imageUnavailableText,
  saveResultImages,
  toInput,
  toResultBlocks,
  type HostContext,
  type HostSessionPort,
  type SinkResultContent,
  type TurnSink,
} from '@dsh-raw-agent/dsh-host';

const MAIN = { kind: 'main' } as const;

/** A runtime whose backend plays `events` after the first send. */
function setup(events: BackendEvent[], saveImages?: TurnSink['saveImages']) {
  const results: Array<{ callId: string; content: SinkResultContent[] }> = [];
  const warnings: unknown[] = [];
  let stepOpen = false;
  const calls = new Set<string>();
  const open = new Set<string>();
  const factory = {
    kind: 'k',
    displayName: 'K',
    staticCapabilities: { ids: 'derived', resume: true, fork: 'none' },
    sessionIdFor: (h: string) => `derived-${h}`,
    sessionExists: async () => false,
    async open() {
      const q = new AsyncQueue<BackendEvent>();
      return {
        kind: 'k',
        sessionId: 'x',
        startedAs: 'new',
        capabilities: {},
        events: () => q,
        send: async () => {
          for (const e of events) q.push(e);
        },
        interrupt: async () => ({ cancelledInputIds: [] }),
        forceStop: async () => {},
        dispose: async () => q.end(),
        controls: {},
      };
    },
  } as unknown as AgentBackendFactory;
  const port: HostSessionPort = {
    hostSessionId: 'h1',
    cwd: '/w',
    wake: () => {},
    latestBinding: () => undefined,
    startJob: () => undefined,
    warn: (n, d) => warnings.push([n, d]),
  };
  const sink: TurnSink = {
    get stepOpen() {
      return stepOpen;
    },
    hasMessage: false,
    claim: () => false,
    get openCallIds() {
      return [...open];
    },
    hasCall: (id) => calls.has(id),
    openStep: () => {
      stepOpen = true;
      calls.clear();
    },
    delta: () => {},
    commit: (m) => {
      const ids = m.blocks.flatMap((b) => (b.type === 'tool-call' ? [b.id] : []));
      for (const id of ids) {
        calls.add(id);
        open.add(id);
      }
      return { calls: ids };
    },
    result: (callId, content) => {
      results.push({ callId, content });
      open.delete(callId);
    },
    closeStep: () => {
      stepOpen = false;
    },
  };
  if (saveImages) sink.saveImages = saveImages;
  const rt = new SessionRuntime(factory, port, { env: {} });
  const run = () =>
    rt.runTurn(
      sink,
      { userInputs: [{ id: 'u1', parts: [{ type: 'text', text: 'hi' }] }], wake: false },
      new AbortController().signal,
    );
  return { run, results, warnings, rt };
}

const turnWithImage = (callId = 'c1'): BackendEvent[] => [
  { type: 'step-start', agent: MAIN, stepId: 's1', at: 1 },
  {
    type: 'step-message',
    agent: MAIN,
    stepId: 's1',
    blocks: [{ type: 'tool-call', id: 'c1', name: 'Read', arguments: '{}' }],
    final: true,
  },
  {
    type: 'tool-result',
    agent: MAIN,
    callId,
    isError: false,
    content: [
      { type: 'text', text: 'before' },
      { type: 'image', mediaType: 'image/png', base64: 'AAAA' },
      { type: 'image', mediaType: 'image/jpeg', base64: 'BBBB' },
    ],
  },
  { type: 'turn-end', agent: MAIN, outcome: 'completed', pendingInputs: 0 },
];

describe('D85: tool-result images in the driver', () => {
  it('stores every image of a result as one ordered batch and passes refs to the sink', async () => {
    const batches: unknown[] = [];
    const s = setup(turnWithImage(), async (images) => {
      batches.push(images);
      return images.map((_, i) => ({ ref: i }));
    });
    expect(await s.run()).toEqual({ kind: 'completed' });
    expect(batches).toEqual([
      [
        { mediaType: 'image/png', base64: 'AAAA' },
        { mediaType: 'image/jpeg', base64: 'BBBB' },
      ],
    ]);
    expect(s.results).toEqual([
      {
        callId: 'c1',
        content: [
          { type: 'text', text: 'before' },
          { type: 'saved-image', mediaType: 'image/png', ref: { ref: 0 } },
          { type: 'saved-image', mediaType: 'image/jpeg', ref: { ref: 1 } },
        ],
      },
    ]);
    await s.rt.dispose();
  });

  it('a refused batch turns every image into a placeholder and warns', async () => {
    const s = setup(turnWithImage(), async () => {
      throw new Error('too big');
    });
    await s.run();
    expect(s.results[0]!.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: '[image unavailable: image/png; it was not stored: too big]' },
      { type: 'text', text: '[image unavailable: image/jpeg; it was not stored: too big]' },
    ]);
    expect(s.warnings.some((w) => String((w as unknown[])[0]).includes('could not store'))).toBe(true);
    await s.rt.dispose();
  });

  it('a wrong ref count is treated as a refusal', async () => {
    const s = setup(turnWithImage(), async () => [{ one: 1 }]);
    await s.run();
    expect(s.results[0]!.content.slice(1)).toEqual([
      {
        type: 'text',
        text: imageUnavailableText('image/png', 'the host returned the wrong number of attachment refs'),
      },
      {
        type: 'text',
        text: imageUnavailableText('image/jpeg', 'the host returned the wrong number of attachment refs'),
      },
    ]);
    await s.rt.dispose();
  });

  it('without a store the images are placeholders', async () => {
    const s = setup(turnWithImage());
    await s.run();
    expect(s.results[0]!.content[1]).toEqual({
      type: 'text',
      text: '[image unavailable: image/png; the host has no attachment store]',
    });
    await s.rt.dispose();
  });

  it('a result for an unknown call stores nothing', async () => {
    let saved = 0;
    const s = setup(turnWithImage('nope'), async (i) => {
      saved++;
      return i.map(() => ({}));
    });
    await s.run();
    expect(saved).toBe(0);
    expect(s.results).toEqual([]);
    await s.rt.dispose();
  });

  it('a result without images is passed through unchanged, without a store call', async () => {
    let saved = 0;
    const events = turnWithImage();
    (events[2] as { content: unknown[] }).content = [{ type: 'text', text: 'plain' }];
    const s = setup(events, async (i) => {
      saved++;
      return i.map(() => ({}));
    });
    await s.run();
    expect(saved).toBe(0);
    expect(s.results[0]!.content).toEqual([{ type: 'text', text: 'plain' }]);
    await s.rt.dispose();
  });
});

/** A fake host context with an optional `ctx.attachments`. */
function ctxWith(attachments?: Record<string, unknown>): HostContext {
  return {
    on: () => () => {},
    emit: () => {},
    effect: () => undefined,
    get: (name: string) => (name === 'attachments' ? attachments : undefined),
  };
}

const factory = {
  kind: 'k',
  displayName: 'Agent K',
  inputIdFor: (id: string) => `in-${id}`,
} as unknown as AgentBackendFactory;
const msg = (content: Record<string, unknown>[]) => ({
  id: 'm1',
  role: 'user' as const,
  content,
  source: { kind: 'user' },
});

describe('D23: user attachments → backend input', () => {
  it('reads image bytes from the store and keeps part order; files go as host paths', async () => {
    const reads: unknown[] = [];
    const ctx = ctxWith({
      readImage: async (ref: unknown) => {
        reads.push(ref);
        return { ref: { mediaType: 'image/webp' }, data: new Uint8Array([1, 2, 3]) };
      },
      fileHostPath: (ref: { name: string }) => `/store/files/ab/x/${ref.name}`,
    });
    const input = await toInput(
      factory,
      msg([
        { type: 'text', text: 'see ' },
        { type: 'image', attachment: { attachmentId: 'i1', mediaType: 'image/png' } },
        { type: 'file', attachment: { name: 'notes.txt' } },
        { type: 'text', text: 'thanks' },
      ]),
      ctx,
    );
    expect(reads).toEqual([{ attachmentId: 'i1', mediaType: 'image/png' }]);
    expect(input).toEqual({
      id: 'in-m1',
      parts: [
        { type: 'text', text: 'see ' },
        // The stored (normalized) media type wins over the ref's.
        { type: 'image', mediaType: 'image/webp', base64: 'AQID' },
        { type: 'file', hostPath: '/store/files/ab/x/notes.txt' },
        { type: 'text', text: 'thanks' },
      ],
    });
  });

  it('an offloaded image is still sent: offload is a DSH route decision', async () => {
    const ctx = ctxWith({ readImage: async () => ({ ref: { mediaType: 'image/png' }, data: new Uint8Array([0]) }) });
    const input = await toInput(
      factory,
      msg([{ type: 'image', attachment: { mediaType: 'image/png' }, offloaded: true }]),
      ctx,
    );
    expect(input.parts).toEqual([{ type: 'image', mediaType: 'image/png', base64: 'AA==' }]);
  });

  it('never drops an attachment silently', async () => {
    await expect(toInput(factory, msg([{ type: 'image', attachment: {} }]), ctxWith())).rejects.toThrow(
      /no attachment store is mounted/,
    );
    await expect(
      toInput(
        factory,
        msg([{ type: 'image', attachment: {} }]),
        ctxWith({
          readImage: async () => {
            throw new Error('digest mismatch');
          },
        }),
      ),
    ).rejects.toThrow(/could not be read: digest mismatch/);
    const err = await toInput(
      factory,
      msg([{ type: 'file', attachment: { name: 'a.txt' } }]),
      ctxWith({ fileHostPath: () => undefined }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AttachmentInputError);
    expect(String(err)).toContain('"a.txt" has no local copy on this host, so Agent K cannot read it');
  });

  it('text-only messages need no store', async () => {
    expect(await toInput(factory, msg([{ type: 'text', text: 'hi' }]), ctxWith())).toEqual({
      id: 'in-m1',
      parts: [{ type: 'text', text: 'hi' }],
    });
  });
});

describe('D85: port result blocks and the image store', () => {
  it('writes stored images as native image blocks and never base64', () => {
    expect(
      toResultBlocks([
        { type: 'text', text: 'a' },
        { type: 'saved-image', mediaType: 'image/png', ref: { attachmentId: 'sha256:1' } },
        { type: 'image', mediaType: 'image/png', base64: 'AAAA' },
        { type: 'other', value: { k: 1 } },
      ]),
    ).toEqual([
      { type: 'text', text: 'a' },
      { type: 'image', attachment: { attachmentId: 'sha256:1' } },
      { type: 'text', text: '[image unavailable: image/png; it was not stored]' },
      { type: 'text', text: '{"k":1}' },
    ]);
  });

  it('decodes base64 and checks the media type before calling saveImages', async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({
      saveImages: async (inputs: Array<{ data: Uint8Array; mediaType: string }>) => {
        seen.push(...inputs.map((i) => [Array.from(i.data), i.mediaType]));
        return inputs.map((_, k) => ({ id: k }));
      },
    });
    expect(await saveResultImages(ctx, [{ mediaType: 'image/gif', base64: 'AQID' }])).toEqual([{ id: 0 }]);
    expect(seen).toEqual([[[1, 2, 3], 'image/gif']]);
    await expect(saveResultImages(ctx, [{ mediaType: 'image/tiff', base64: 'AQID' }])).rejects.toThrow(
      /not PNG, JPEG, WebP or GIF/,
    );
    await expect(saveResultImages(ctx, [{ mediaType: 'image/png', base64: '' }])).rejects.toThrow(/empty/);
    await expect(saveResultImages(ctxWith(), [{ mediaType: 'image/png', base64: 'AA' }])).rejects.toThrow(
      /no attachment store/,
    );
  });
});
