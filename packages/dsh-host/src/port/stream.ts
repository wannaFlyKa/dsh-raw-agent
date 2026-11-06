// The embedded assistant stream (D17 d, f). Two halves:
// - StreamRecorder: builds the compact durable records exactly as DSH's AssistantStreamAccumulator
//   does (`P/dsh-llm/lib/index.js:1150-1255`), so the stored stream is the live chunk sequence.
// - replayStream: expands the records and assembles them as DSH's BlockAssembler does
//   (`P/dsh-llm/lib/index.js:954-1110, 1257-1295`). The writer uses it as its self-check: it
//   refuses an assistant event whose stream does not reproduce its content, usage and replay
//   state, which is the check DSH runs on a published generation
//   (`P/dsh-session-persistence-jsonl/lib/index.js:1838-1853`).
// Ported, not imported (D65). The DSH round-trip test runs the real classes against our output.

import { isDeepStrictEqual } from 'node:util';
import type { DshBlock, DshChunk, DshStreamRecord, DshUsage } from './types.js';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type RunRecord = Exclude<DshStreamRecord, { type: 'chunk' }> & { lastTime: number };

export class StreamRecorder {
  readonly #records: Array<Mutable<DshStreamRecord> | RunRecord> = [];

  /** Add one timed chunk. Returns the chunk as published live. */
  push(time: number, chunk: DshChunk): DshChunk {
    if (!Number.isSafeInteger(time)) throw new TypeError(`stream time must be a safe integer, got ${time}`);
    const c = structuredClone(chunk);
    const prev = this.#records.at(-1) as RunRecord | undefined;
    if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
      const type = c.type === 'text-delta' ? 'text-chunks' : 'reasoning-chunks';
      if (prev !== undefined && prev.type === type && prev.index === c.index && 'texts' in prev) {
        prev.dt.push(time - prev.lastTime);
        prev.texts.push(c.text);
        prev.lastTime = time;
      } else this.#records.push({ type, time0: time, index: c.index, dt: [], texts: [c.text], lastTime: time });
      return c;
    }
    if (c.type === 'tool-call-delta' && c.id.length > 0 && c.name !== '') {
      const sameName =
        prev?.type === 'tool-call-chunks' &&
        Object.hasOwn(prev, 'name') === Object.hasOwn(c, 'name') &&
        prev.name === c.name;
      if (prev?.type === 'tool-call-chunks' && prev.index === c.index && prev.id === c.id && sameName) {
        prev.dt.push(time - prev.lastTime);
        prev.args.push(c.argumentsDelta);
        prev.lastTime = time;
      } else {
        const r: RunRecord = {
          type: 'tool-call-chunks',
          time0: time,
          index: c.index,
          dt: [],
          id: c.id,
          args: [c.argumentsDelta],
          lastTime: time,
        };
        if (c.name !== undefined) r.name = c.name;
        this.#records.push(r);
      }
      return c;
    }
    this.#records.push({ type: 'chunk', time, chunk: c });
    return c;
  }

  get empty(): boolean {
    return this.#records.length === 0;
  }

  /** The durable record list (DSH `AssistantStreamRecord[]`). */
  snapshot(): DshStreamRecord[] {
    return this.#records.map((r) => {
      if (r.type === 'chunk') return { ...r };
      const { lastTime: _l, ...durable } = r as RunRecord;
      return structuredClone(durable) as DshStreamRecord;
    });
  }
}

/** Expand compact records into the timed chunk list. */
export function expandRecords(records: readonly DshStreamRecord[]): Array<{ time: number; chunk: DshChunk }> {
  const out: Array<{ time: number; chunk: DshChunk }> = [];
  for (const r of records) {
    if (r.type === 'chunk') {
      out.push({ time: r.time, chunk: r.chunk });
      continue;
    }
    const members = r.type === 'tool-call-chunks' ? r.args : r.texts;
    let time = r.time0;
    members.forEach((m, i) => {
      if (i > 0) time += r.dt[i - 1] ?? 0;
      let chunk: DshChunk;
      if (r.type === 'text-chunks') chunk = { type: 'text-delta', index: r.index, text: m };
      else if (r.type === 'reasoning-chunks') chunk = { type: 'reasoning-delta', index: r.index, text: m };
      else {
        const t = r as Extract<DshStreamRecord, { type: 'tool-call-chunks' }>;
        const c: Extract<DshChunk, { type: 'tool-call-delta' }> = {
          type: 'tool-call-delta',
          index: t.index,
          id: t.id,
          argumentsDelta: m,
        };
        if (t.name !== undefined) c.name = t.name;
        chunk = c;
      }
      out.push({ time, chunk });
    });
  }
  return out;
}

interface Partial {
  blockType: string;
  text: string;
  args: string;
  id?: string;
  name?: string;
  block?: DshBlock;
}

export interface Replay {
  blocks: DshBlock[];
  interruptedBlocks: DshBlock[];
  usage: DshUsage | undefined;
  replayState: unknown;
  chunkCount: number;
}

/** Assemble an embedded stream the way DSH's BlockAssembler does. */
export function replayStream(records: readonly DshStreamRecord[]): Replay {
  const partials = new Map<number, Partial>();
  const order: number[] = [];
  let usage: DshUsage | undefined;
  let finish: { kind: string } | undefined;
  let replayState: unknown;
  const ensure = (index: number, blockType: string): Partial => {
    let p = partials.get(index);
    if (p === undefined) {
      p = { blockType, text: '', args: '' };
      partials.set(index, p);
      order.push(index);
    }
    return p;
  };
  const timed = expandRecords(records);
  for (const { chunk: c } of timed) {
    switch (c.type) {
      case 'block-start':
        ensure(c.index, c.blockType);
        break;
      case 'text-delta':
      case 'reasoning-delta': {
        const p = ensure(c.index, c.type === 'text-delta' ? 'text' : 'reasoning');
        if (p.block === undefined) p.text += c.text;
        break;
      }
      case 'tool-call-delta': {
        const p = ensure(c.index, 'tool-call');
        if (p.block !== undefined) break;
        p.id = c.id;
        if (c.name) p.name = c.name;
        p.args += c.argumentsDelta;
        break;
      }
      case 'block-end': {
        const p = ensure(c.index, c.block.type);
        if (p.block === undefined) p.block = c.block;
        break;
      }
      case 'usage':
        usage = c.usage;
        break;
      case 'finish':
        finish = c.reason;
        replayState = c.replayState;
        break;
    }
  }
  const assemble = (p: Partial, index: number): DshBlock => {
    if (p.block !== undefined) return p.block;
    if (p.blockType === 'text') return { type: 'text', text: p.text };
    if (p.blockType === 'reasoning') return { type: 'reasoning', text: p.text };
    if (p.blockType === 'tool-call')
      return { type: 'tool-call', id: p.id ?? `call-${index}`, name: p.name ?? '', arguments: p.args };
    throw new Error(`cannot assemble incomplete block of type "${p.blockType}"`);
  };
  const all = order.map((i) => assemble(partials.get(i)!, i));
  const blocks = finish?.kind === 'max-tokens' ? all.filter((b) => b.type !== 'tool-call') : all;
  const interruptedBlocks = order
    .map((i) => {
      const p = partials.get(i)!;
      const type = p.block?.type ?? p.blockType;
      return type === 'text' || type === 'reasoning' ? assemble(p, i) : undefined;
    })
    .filter((b): b is DshBlock => (b?.type === 'text' || b?.type === 'reasoning') && b.text.trim() !== '');
  // A replay envelope with per-block entries is not used by this writer (D17 f: no `blocks` field).
  const envelope = replayState as { blocks?: unknown[] } | undefined;
  const rs = envelope?.blocks === undefined ? replayState : undefined;
  return { blocks, interruptedBlocks, usage, replayState: rs, chunkCount: timed.length };
}

export const deepEqual = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);
