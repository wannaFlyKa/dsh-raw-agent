// M7 (R3.5, R3.6, D28-D30, D70, D75): fork cut validation and its refusal fallback, file
// restore on a rewind fork, resume of a missing transcript, clear exit reasons, orphan guard.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AsyncQueue, type BackendEvent, type InteractionHandler, type SessionStart } from '@dsh-raw-agent/core';
import {
  checkDropsTurn,
  createClaudeFactory,
  createSpawner,
  describeExit,
  dropsTurnRefusal,
  DROPS_TURN_REFUSAL_PREFIX,
  INPUT_HEAD_BYTES,
  INPUT_SCAN_FILES,
  ORPHAN_GUARD_SCRIPT,
  projectSlug,
  refusalInText,
  withPreview,
  stderrTail,
  toFileRewindResult,
  type QueryFn,
} from '@dsh-raw-agent/backend-claude';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const line = (o: Record<string, unknown>) => JSON.stringify(o);
const prompt = (uuid: string, parentUuid: string | null, text: string, origin: unknown = { kind: 'human' }) =>
  line({ type: 'user', uuid, parentUuid, origin, message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (uuid: string, parentUuid: string) =>
  line({ type: 'assistant', uuid, parentUuid, message: { content: [{ type: 'text', text: 'ok' }] } });
const toolResult = (uuid: string, parentUuid: string) =>
  line({ type: 'user', uuid, parentUuid, message: { content: [{ type: 'tool_result', tool_use_id: 't' }] } });

/** Two kept turns (p1 → a1, p2 → a2), then what the test puts past the cut a2. */
function transcript(...past: string[]): string {
  return [
    prompt('p1', null, 'one'),
    assistant('a1', 'p1'),
    prompt('p2', 'a1', 'two'),
    assistant('a2', 'p2'),
    ...past,
  ].join('\n');
}

describe('D29: which cuts may pass resumeDropsTurn', () => {
  it('exactly the hinted turn past the cut (with its tool payload and interrupt marker)', () => {
    const t = transcript(
      prompt('p3', 'a2', 'three'),
      line({ type: 'attachment', uuid: 'x1', parentUuid: 'p3', attachment: { type: 'date' } }),
      assistant('a3', 'x1'),
      toolResult('r3', 'a3'),
      prompt('m3', 'r3', '[Request interrupted by user for tool use]', undefined),
      '{"type":"user","uuid":"cut-off',
    );
    expect(checkDropsTurn(t, 'a2', 'p3')).toMatchObject({ validated: true });
  });

  it('plain truncation for two turns, a wake turn, a queued message, a peer message or a wrong hint', () => {
    const two = transcript(prompt('p3', 'a2', 'three'), assistant('a3', 'p3'), prompt('p4', 'a3', 'four'));
    expect(checkDropsTurn(two, 'a2', 'p3')).toMatchObject({ validated: false, reason: '2 turns lie past the cut' });
    const wake = transcript(
      prompt('p3', 'a2', 'three'),
      assistant('a3', 'p3'),
      prompt('w1', 'a3', '<task-notification>\n<task-id>b</task-id>', { kind: 'task-notification' }),
    );
    expect(checkDropsTurn(wake, 'a2', 'p3').validated).toBe(false);
    const queued = transcript(
      prompt('p3', 'a2', 'three'),
      line({ type: 'attachment', uuid: 'q', parentUuid: 'p3', attachment: { type: 'queued_command' } }),
    );
    expect(checkDropsTurn(queued, 'a2', 'p3').reason).toBe('a queued message lies past the cut');
    const peer = transcript(prompt('p3', 'a2', 'hi', { kind: 'peer' }));
    expect(checkDropsTurn(peer, 'a2', 'p3').validated).toBe(false);
    expect(checkDropsTurn(transcript(prompt('p3', 'a2', 'three')), 'a2', 'other').validated).toBe(false);
    expect(checkDropsTurn(transcript(), 'a2', 'p3').reason).toBe('no turn lies past the cut');
    expect(checkDropsTurn(transcript(), 'nope', 'p3').reason).toBe('the cut entry is not in the source transcript');
  });

  it('only entries on the cut chain count (an earlier branch is ignored)', () => {
    const t = transcript(prompt('p3', 'a2', 'three'), prompt('b1', 'a1', 'old branch'));
    expect(checkDropsTurn(t, 'a2', 'p3').validated).toBe(true);
  });

  it('recognises the refusal in a result frame or in error text', () => {
    const text = `${DROPS_TURN_REFUSAL_PREFIX} a queued message was absorbed`;
    expect(dropsTurnRefusal({ type: 'result', subtype: 'error_during_execution', errors: [text] })).toBe(text);
    expect(dropsTurnRefusal({ type: 'result', subtype: 'error_during_execution', result: text })).toBe(text);
    expect(dropsTurnRefusal({ type: 'result', subtype: 'error_during_execution', errors: ['other'] })).toBeUndefined();
    expect(refusalInText(`boot\nError: ${text}\nmore`)).toBe(text);
    expect(refusalInText('plain error')).toBeUndefined();
  });
});

describe('R3.6: exit reasons', () => {
  it('names the signal, the exit code, the CLI stderr, or a clean end', () => {
    expect(describeExit({ asked: 'disposed', proc: { code: 0, signal: null, stderr: 'x' } })).toEqual({
      reason: 'disposed',
      code: 0,
    });
    const killed = describeExit({
      sdkError: 'Claude Code process terminated by signal SIGKILL',
      proc: { code: null, signal: 'SIGKILL', stderr: '' },
    });
    expect(killed.reason).toBe('crashed');
    expect(killed.error).toBe('it was killed (SIGKILL: out of memory, or another program ended it)');
    const failed = describeExit({
      sdkError: 'Claude Code process exited with code 1',
      proc: { code: 1, signal: null, stderr: '\u001b[31mInvalid API key\u001b[0m\nPlease run /login\n' },
    });
    expect(failed).toMatchObject({ reason: 'crashed', code: 1 });
    // M8: the log gets the short reason only; the CLI's error output is for the plugin UI.
    expect(failed.error).toBe('it exited with code 1');
    expect(failed.stderr).toBe('Invalid API key\nPlease run /login');
    expect(describeExit({ proc: { code: 0, signal: null, stderr: '' } })).toEqual({
      reason: 'ended',
      code: 0,
      error: 'it ended by itself (exit code 0)',
    });
    expect(describeExit({ sdkError: 'stream broke' })).toEqual({ reason: 'crashed', error: 'stream broke' });
  });

  it("keeps the SDK error's own stderr tail out of the reason (M8)", () => {
    const viaSdk = describeExit({ sdkError: 'Claude Code process exited with code 2. stderr: secret path /x\nboom' });
    expect(viaSdk.error).toBe('Claude Code process exited with code 2');
    expect(viaSdk.stderr).toBe('secret path /x\nboom');
    const both = describeExit({
      sdkError: 'Claude Code process exited with code 1. stderr: from sdk',
      proc: { code: 1, signal: null, stderr: 'from spawn\n' },
    });
    expect(both).toEqual({ reason: 'crashed', code: 1, error: 'it exited with code 1', stderr: 'from spawn' });
    const multi = describeExit({ sdkError: 'first line\nsecond line with output' });
    expect(multi.error).toBe('first line');
  });

  it('keeps only the end of a long stderr', () => {
    const many = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    expect(stderrTail(many).split('\n')).toHaveLength(12);
    expect(stderrTail('x'.repeat(5000)).length).toBeLessThanOrEqual(1501);
  });

  it.skipIf(process.platform === 'win32')('the spawner reports exit code and stderr of the real process', async () => {
    const spawner = createSpawner({ PATH: process.env.PATH ?? '' }, process.platform, { orphanGuard: false });
    spawner.spawn({
      command: 'sh',
      args: ['-c', 'echo "Not logged in" >&2; exit 3'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '' },
      signal: new AbortController().signal,
    } as never);
    const info = await spawner.exitInfo(3000);
    expect(info).toEqual({ code: 3, signal: null, stderr: 'Not logged in\n' });
  });
});

describe('M8: each CLI keeps its own exit', () => {
  const fakeChild = () => {
    const c = new EventEmitter() as EventEmitter & {
      pid: number;
      stderr: EventEmitter;
      exitCode: null;
      signalCode: null;
    };
    c.pid = 4242;
    c.stderr = new EventEmitter();
    c.exitCode = null;
    c.signalCode = null;
    return c;
  };
  const spawnOpts = { command: 'claude', args: [], cwd: '/', env: {}, signal: new AbortController().signal } as never;

  it("a late close of the refused CLI never stands for the plain restart's CLI", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawner = createSpawner({}, 'linux', {
      orphanGuard: false,
      spawn: (() => {
        const c = fakeChild();
        children.push(c);
        return c;
      }) as never,
    });
    spawner.spawn(spawnOpts);
    // The refused cut: the session asks for a new CLI; the old one closes before the new spawns.
    spawner.expectNew();
    children[0]!.stderr.emit('data', 'refused\n');
    children[0]!.emit('close', 143, null);
    expect(await spawner.exitInfo(20)).toBeUndefined();
    spawner.spawn(spawnOpts);
    expect(await spawner.exitInfo(20)).toBeUndefined(); // the new CLI runs
    children[1]!.stderr.emit('data', 'Invalid API key\n');
    children[1]!.emit('close', 1, null);
    expect(await spawner.exitInfo(20)).toEqual({ code: 1, signal: null, stderr: 'Invalid API key\n' });
  });

  it("an old CLI closing after the new one spawned leaves the new one's exit alone", async () => {
    const children: ReturnType<typeof fakeChild>[] = [];
    const spawner = createSpawner({}, 'linux', {
      orphanGuard: false,
      spawn: (() => {
        const c = fakeChild();
        children.push(c);
        return c;
      }) as never,
    });
    spawner.spawn(spawnOpts);
    spawner.expectNew();
    spawner.spawn(spawnOpts);
    children[0]!.emit('close', 143, null);
    expect(await spawner.exitInfo(20)).toBeUndefined();
    children[1]!.emit('close', null, 'SIGKILL');
    expect(await spawner.exitInfo(20)).toMatchObject({ code: null, signal: 'SIGKILL' });
  });
});

describe('D30: file restore results', () => {
  it('maps the SDK result', () => {
    expect(toFileRewindResult({ canRewind: true, filesChanged: ['a.ts'], insertions: 2, deletions: 1 }, false)).toEqual(
      {
        ok: true,
        filesChanged: ['a.ts'],
        insertions: 2,
        deletions: 1,
      },
    );
    expect(toFileRewindResult({ canRewind: false, error: 'No checkpoint' }, true)).toEqual({
      ok: false,
      error: 'No checkpoint',
      filesChanged: [],
      dryRun: true,
    });
    expect(toFileRewindResult(undefined, false).error).toBe('Claude Code could not restore the files');
  });
});

// ---- factory and session with a fake query ----

type Fake = {
  out: AsyncQueue<unknown>;
  options: Record<string, unknown>;
  sent: unknown[];
  calls: Array<[string, unknown[]]>;
  /** Choice controls and inputs in the order this process got them. */
  seq: string[];
  /** Controls never answer (a process that refused its fork cut). */
  hang?: boolean;
  closed: boolean;
  /** Called at close() (the SDK rejects pending controls then). */
  onClose: Array<() => void>;
  /** The CLI dies: the SDK iterator throws this after the buffered frames. */
  fail(error: Error): void;
};

function fakeQueries(rewind?: (id: string, o: unknown, q: Fake) => unknown) {
  const made: Fake[] = [];
  const queryFn: QueryFn = (p) => {
    let failure: Error | undefined;
    const f: Fake = {
      out: new AsyncQueue(),
      options: p.options as never,
      sent: [],
      calls: [],
      seq: [],
      closed: false,
      onClose: [],
      fail(error) {
        failure = error;
        f.out.end();
      },
    };
    async function* frames() {
      for await (const m of f.out) yield m;
      if (failure) throw failure;
    }
    made.push(f);
    void (async () => {
      for await (const m of p.prompt) {
        f.sent.push(m);
        f.seq.push(`sent ${(m as { uuid?: string }).uuid}`);
      }
    })();
    const q = {
      [Symbol.asyncIterator]: () => frames(),
      interrupt: async () => ({}),
      setModel: async (m: string) => {
        f.seq.push(`setModel ${m}`);
        if (f.hang) await new Promise(() => {});
      },
      applyFlagSettings: async (o: unknown) => {
        f.seq.push(`applyFlagSettings ${JSON.stringify(o)}`);
        if (f.hang) await new Promise(() => {});
      },
      close: () => {
        f.closed = true;
        f.out.end();
        for (const c of f.onClose.splice(0)) c();
      },
      rewindFiles: async (id: string, o: unknown) => {
        f.calls.push(['rewindFiles', [id, o]]);
        f.seq.push('rewindFiles');
        return rewind ? rewind(id, o, f) : { canRewind: true, filesChanged: ['x.txt'], insertions: 1, deletions: 0 };
      },
    };
    return q as never;
  };
  return { made, queryFn };
}

const noInteractions: InteractionHandler = {
  permission: async () => ({ optionId: 'reject' }),
  question: async () => null,
  plan: async () => ({ kind: 'keep-planning' }),
  elicitation: async () => ({ action: 'decline' }),
};

function setup() {
  const root = tmp('raw-agent-m7-');
  const exe = join(root, 'claude');
  writeFileSync(exe, '#!/bin/sh\nexit 1\n');
  chmodSync(exe, 0o755);
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  const config = join(root, 'config');
  const projectDir = join(config, 'projects', projectSlug(cwd));
  mkdirSync(projectDir, { recursive: true });
  const env = { PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: config };
  const writeTranscript = (id: string, text: string) => writeFileSync(join(projectDir, `${id}.jsonl`), text);
  return { exe, cwd, env, writeTranscript };
}

async function open(
  s: ReturnType<typeof setup>,
  f: ReturnType<typeof fakeQueries>,
  start: SessionStart,
): Promise<{ session: Awaited<ReturnType<ReturnType<typeof createClaudeFactory>['open']>>; events: BackendEvent[] }> {
  const factory = createClaudeFactory({ queryFn: f.queryFn, env: () => s.env, spawner: { orphanGuard: false } });
  const session = await factory.open({
    cwd: s.cwd,
    env: s.env,
    start,
    userConfig: { executablePath: s.exe, options: {} },
    interactions: noInteractions,
    signal: new AbortController().signal,
  });
  const events: BackendEvent[] = [];
  void (async () => {
    for await (const e of session.events()) events.push(e);
  })();
  return { session, events };
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

describe('D28, D29, D70: the start the factory really makes', () => {
  it('sessionExists reads the transcript file; a resume without one starts new under the same id', async () => {
    const s = setup();
    const factory = createClaudeFactory({ env: () => s.env });
    expect(await factory.sessionExists!('gone', s.cwd)).toBe(false);
    s.writeTranscript('here', transcript());
    expect(await factory.sessionExists!('here', s.cwd)).toBe(true);
    expect(await factory.fileRewindAvailable!(s.cwd)).toBe(true);

    const f = fakeQueries();
    const fresh = await open(s, f, { kind: 'resume', sessionId: 'cleared-id' });
    expect(fresh.session.startedAs).toBe('new');
    expect(fresh.session.sessionId).toBe('cleared-id');
    expect(f.made[0]!.options.sessionId).toBe('cleared-id');
    expect(f.made[0]!.options.resume).toBeUndefined();
    const resumed = await open(s, f, { kind: 'resume', sessionId: 'here' });
    expect(resumed.session.startedAs).toBe('resumed');
    expect(f.made[1]!.options.resume).toBe('here');
    await fresh.session.dispose();
    await resumed.session.dispose();
  });

  it('sessionHoldingInput finds the conversation a /clear moved to (D70, M7 live)', async () => {
    const s = setup();
    const factory = createClaudeFactory({ env: () => s.env });
    const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
    s.writeTranscript('old', line({ type: 'user', uuid: 'in-1', sessionId: 'old', message: { content: 'hi' } }));
    // The CLI 2.1.318 shape: the new transcript starts with the typed /clear (uuid = our input id).
    s.writeTranscript(
      'new',
      line({ type: 'mode', mode: 'normal', sessionId: 'new' }) +
        line({ type: 'user', uuid: 'caveat', sessionId: 'new', message: { content: '<local-command-caveat>' } }) +
        line({
          type: 'user',
          uuid: 'in-clear',
          sessionId: 'new',
          message: { content: '<command-name>/clear</command-name>' },
        }),
    );
    // Another entry that only names the id (not a user entry) does not count.
    s.writeTranscript('other', line({ type: 'last-prompt', uuid: 'in-clear', sessionId: 'other' }));
    expect(await factory.sessionHoldingInput!('in-1', s.cwd, 'old')).toBe('old');
    expect(await factory.sessionHoldingInput!('in-clear', s.cwd, 'old')).toBe('new');
    expect(await factory.sessionHoldingInput!('in-none', s.cwd, 'old')).toBeUndefined();
  });

  it('sessionHoldingInput is async and cheap: heads only, the newest transcripts only (M8)', async () => {
    const s = setup();
    const factory = createClaudeFactory({ env: () => s.env });
    const line = (o: Record<string, unknown>) => JSON.stringify(o) + '\n';
    s.writeTranscript('old', line({ type: 'user', uuid: 'in-1', sessionId: 'old', message: { content: 'hi' } }));
    // The /clear transcript: the command is in its first lines.
    s.writeTranscript(
      'new',
      line({ type: 'user', uuid: 'in-clear', sessionId: 'new', message: { content: '/clear' } }),
    );
    // It never blocks the event loop: a timer queued before the call runs before it answers.
    let ticked = false;
    setImmediate(() => (ticked = true));
    expect(await factory.sessionHoldingInput!('in-clear', s.cwd, 'old')).toBe('new');
    expect(ticked).toBe(true);
    // Another transcript is read at its head only: an entry past it is not found.
    const filler = line({ type: 'assistant', uuid: 'x', message: { content: 'y'.repeat(1000) } });
    s.writeTranscript(
      'deep',
      filler.repeat(Math.ceil(INPUT_HEAD_BYTES / filler.length) + 5) +
        line({ type: 'user', uuid: 'in-deep', sessionId: 'deep', message: { content: 'x' } }),
    );
    expect(await factory.sessionHoldingInput!('in-deep', s.cwd, 'old')).toBeUndefined();
    // The preferred transcript is read whole.
    expect(await factory.sessionHoldingInput!('in-deep', s.cwd, 'deep')).toBe('deep');
    // Only the newest INPUT_SCAN_FILES other transcripts are read.
    const old = Date.now() / 1000 - 3600;
    utimesSync(join(s.cwd, '..', 'config', 'projects', projectSlug(s.cwd), 'new.jsonl'), old, old);
    for (let i = 0; i < INPUT_SCAN_FILES; i++) s.writeTranscript(`newer-${i}`, line({ type: 'mode', mode: 'normal' }));
    expect(await factory.sessionHoldingInput!('in-clear', s.cwd, 'old')).toBeUndefined();
  });

  it('a fork passes resumeDropsTurn only for a validated cut', async () => {
    const s = setup();
    s.writeTranscript('src', transcript(prompt('p3', 'a2', 'three'), assistant('a3', 'p3')));
    const f = fakeQueries();
    const base = { kind: 'fork', fromSessionId: 'src', newSessionId: 'dst', atChainId: 'a2' } as const;
    const ok = await open(s, f, { ...base, dropsTurnHint: 'p3' });
    expect(f.made[0]!.options).toMatchObject({
      resume: 'src',
      forkSession: true,
      sessionId: 'dst',
      resumeSessionAt: 'a2',
      resumeDropsTurn: 'p3',
    });
    const wrong = await open(s, f, { ...base, dropsTurnHint: 'p9' });
    expect(f.made[1]!.options.resumeDropsTurn).toBeUndefined();
    const noHint = await open(s, f, { ...base });
    expect(f.made[2]!.options.resumeDropsTurn).toBeUndefined();
    expect(f.made[2]!.options.resumeSessionAt).toBe('a2');
    for (const x of [ok, wrong, noHint]) await x.session.dispose();
  });

  it('a refused cut restarts once with a plain cut, re-sends the input, shows a note and no error turn', async () => {
    const s = setup();
    s.writeTranscript('src', transcript(prompt('p3', 'a2', 'three')));
    const f = fakeQueries();
    const { session, events } = await open(s, f, {
      kind: 'fork',
      fromSessionId: 'src',
      newSessionId: 'dst',
      atChainId: 'a2',
      dropsTurnHint: 'p3',
    });
    await session.send({ id: 'in-1', parts: [{ type: 'text', text: 'hello' }] }, 'next');
    await tick();
    f.made[0]!.out.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [`${DROPS_TURN_REFUSAL_PREFIX} the range holds a queued message`],
    });
    await tick(30);
    expect(f.made).toHaveLength(2);
    expect(f.made[0]!.closed).toBe(true);
    expect(f.made[1]!.options.resumeDropsTurn).toBeUndefined();
    expect(f.made[1]!.options).toMatchObject({
      resume: 'src',
      forkSession: true,
      sessionId: 'dst',
      resumeSessionAt: 'a2',
    });
    expect((f.made[1]!.sent[0] as { uuid: string }).uuid).toBe('in-1');
    // M7 live: the SDK's close() aborts the refused query's controller; the restart has its own.
    const first = f.made[0]!.options.abortController!;
    const second = f.made[1]!.options.abortController!;
    expect(second).not.toBe(first);
    first.abort();
    expect(second.signal.aborted).toBe(false);
    expect(events.some((e) => e.type === 'turn-end')).toBe(false);
    const note = events.find((e) => e.type === 'notice');
    expect(note).toMatchObject({ level: 'warning' });
    expect((note as { text: string }).text).toContain('plain cut');
    // A second refusal is not caught again: the guard is spent.
    f.made[1]!.out.push({
      type: 'result',
      subtype: 'success',
      num_turns: 1,
      result: 'hi',
      user_message_uuids: ['in-1'],
    });
    await tick();
    expect(f.made).toHaveLength(2);
    expect(events.filter((e) => e.type === 'turn-end')).toHaveLength(1);
    await session.dispose();
    expect(events.at(-1)).toEqual({ type: 'exit', reason: 'disposed' });
  });

  it('a plain restart gets the session choices again before the re-sent input (M7 live)', async () => {
    const s = setup();
    s.writeTranscript('src', transcript(prompt('p3', 'a2', 'three')));
    const f = fakeQueries();
    const { session } = await open(s, f, {
      kind: 'fork',
      fromSessionId: 'src',
      newSessionId: 'dst',
      atChainId: 'a2',
      dropsTurnHint: 'p3',
    });
    // The refused process never answers its controls (M7 live): the calls stay pending.
    f.made[0]!.hang = true;
    void session.controls.setModel!('claude-sonnet-5-5');
    void session.controls.setEffort!('low');
    await session.send({ id: 'in-1', parts: [{ type: 'text', text: 'hello' }] }, 'next');
    await tick();
    f.made[0]!.out.push({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: [`${DROPS_TURN_REFUSAL_PREFIX} the range holds a queued message`],
    });
    await tick(30);
    expect(f.made).toHaveLength(2);
    expect(f.made[1]!.seq).toEqual([
      'setModel claude-sonnet-5-5',
      'applyFlagSettings {"effortLevel":"low","ultracode":false}',
      'sent in-1',
    ]);
    await session.dispose();
  });

  it('a rewind fork restores the files before the first input is sent (D30)', async () => {
    const s = setup();
    s.writeTranscript('src', transcript(prompt('p3', 'a2', 'three')));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // CLI 2.1.318 (M7 live): the dry run lists the files; the real restore answers only
    // `{canRewind, skippedLinks}`.
    const f = fakeQueries(async (_id, o) => {
      await gate;
      return (o as { dryRun?: boolean } | undefined)?.dryRun
        ? { canRewind: true, filesChanged: ['a.txt'], insertions: 0, deletions: 3 }
        : { canRewind: true, skippedLinks: 0 };
    });
    const { session, events } = await open(s, f, {
      kind: 'fork',
      fromSessionId: 'src',
      newSessionId: 'dst',
      atChainId: 'a2',
      dropsTurnHint: 'p3',
      restoreFilesAt: 'p3',
    });
    expect(session.capabilities.fileRewind).toBe(true);
    const sending = session.send({ id: 'in-1', parts: [{ type: 'text', text: 'again' }] }, 'next');
    await tick();
    expect(f.made[0]!.sent).toHaveLength(0);
    release();
    await sending;
    await tick();
    expect(f.made[0]!.calls[0]).toEqual(['rewindFiles', ['p3', { dryRun: true }]]);
    expect(f.made[0]!.calls[1]).toEqual(['rewindFiles', ['p3', undefined]]);
    expect(f.made[0]!.sent).toHaveLength(1);
    expect(events.find((e) => e.type === 'files-rewound')).toEqual({
      type: 'files-rewound',
      inputId: 'p3',
      result: { ok: true, filesChanged: ['a.txt'], insertions: 0, deletions: 3 },
    });
    // The in-place control and its preview (the TUI's "Restore code").
    expect(await session.controls.rewindFiles!('p2', { dryRun: true })).toMatchObject({ ok: true, dryRun: true });
    expect(f.made[0]!.calls[2]).toEqual(['rewindFiles', ['p2', { dryRun: true }]]);
    // A real restore that does list files keeps its own list.
    expect(
      withPreview(
        { ok: true, filesChanged: ['b'] },
        { canRewind: true, filesChanged: ['b'] },
        { ok: true, filesChanged: ['a'] },
      ).filesChanged,
    ).toEqual(['b']);
    // A failed restore never borrows the preview's list.
    expect(
      withPreview({ ok: false, filesChanged: [], error: 'x' }, { canRewind: false }, { ok: true, filesChanged: ['a'] })
        .filesChanged,
    ).toEqual([]);
    await session.dispose();
  });

  it("a send waiting on a refused process's restore moves to the plain restart (M8)", async () => {
    for (const refused of ['hangs', 'rejects'] as const) {
      const s = setup();
      s.writeTranscript('src', transcript(prompt('p3', 'a2', 'three')));
      const f = fakeQueries((_id, o, q) => {
        if (q === f.made[0])
          return refused === 'hangs'
            ? new Promise(() => {})
            : new Promise((_r, reject) => q.onClose.push(() => reject(new Error('Query closed'))));
        return (o as { dryRun?: boolean } | undefined)?.dryRun
          ? { canRewind: true, filesChanged: ['a.txt'], insertions: 0, deletions: 1 }
          : { canRewind: true, skippedLinks: 0 };
      });
      const { session, events } = await open(s, f, {
        kind: 'fork',
        fromSessionId: 'src',
        newSessionId: 'dst',
        atChainId: 'a2',
        dropsTurnHint: 'p3',
        restoreFilesAt: 'p3',
      });
      await session.controls.setModel!('claude-sonnet-5-5');
      const sending = session.send({ id: 'in-1', parts: [{ type: 'text', text: 'again' }] }, 'next');
      await tick();
      f.made[0]!.out.push({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        errors: [`${DROPS_TURN_REFUSAL_PREFIX} the range holds a queued message`],
      });
      const done = await Promise.race([sending.then(() => 'sent'), tick(300).then(() => 'stuck')]);
      expect(done, refused).toBe('sent');
      await tick();
      expect(f.made[0]!.sent, refused).toHaveLength(0);
      // The new process: the choice again, then the restore, then the input.
      expect(f.made[1]!.seq, refused).toEqual([
        'setModel claude-sonnet-5-5',
        'rewindFiles',
        'rewindFiles',
        'sent in-1',
      ]);
      // Only the new process's restore is reported; the refused one's failure is dropped.
      const rewound = events.filter((e) => e.type === 'files-rewound');
      expect(rewound, refused).toHaveLength(1);
      expect(rewound[0], refused).toMatchObject({ result: { ok: true, filesChanged: ['a.txt'] } });
      await session.dispose();
    }
  });

  it('no rewind control and a clear failure when checkpoints are off', async () => {
    const s = setup();
    const env = { ...s.env, CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1' };
    const f = fakeQueries();
    const factory = createClaudeFactory({ queryFn: f.queryFn, env: () => env, spawner: { orphanGuard: false } });
    expect(await factory.fileRewindAvailable!(s.cwd)).toBe(false);
    const session = await factory.open({
      cwd: s.cwd,
      env,
      start: { kind: 'fork', fromSessionId: 'src', atChainId: 'a2', restoreFilesAt: 'p3' },
      userConfig: { executablePath: s.exe, options: {} },
      interactions: noInteractions,
      signal: new AbortController().signal,
    });
    const events: BackendEvent[] = [];
    void (async () => {
      for await (const e of session.events()) events.push(e);
    })();
    await session.send({ id: 'i', parts: [{ type: 'text', text: 'x' }] }, 'next');
    expect(session.controls.rewindFiles).toBeUndefined();
    expect(events.find((e) => e.type === 'files-rewound')).toMatchObject({
      result: { ok: false, error: 'file checkpoints are off for this session' },
    });
    await session.dispose();
  });

  it('a CLI that dies reports a crash with its reason (R3.6)', async () => {
    const s = setup();
    const f = fakeQueries();
    const { events } = await open(s, f, { kind: 'new', sessionId: 'n1' });
    f.made[0]!.fail(new Error('Claude Code process exited with code 1'));
    await tick(30);
    expect(events.at(-1)).toEqual({ type: 'exit', reason: 'crashed', error: 'Claude Code process exited with code 1' });
  });
});

describe.skipIf(process.platform === 'win32')('D75: orphan guard', () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  // A stand-in "DSH" process: it starts a stand-in "CLI" in its own group and the guard for it,
  // prints the CLI's pid, and waits. The test then kills the stand-in DSH with SIGKILL.
  const host = (stop: boolean) => `
const { spawn } = require('node:child_process');
const cli = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
const guard = spawn(process.execPath, ['-e', process.env.GUARD], {
  stdio: ['pipe', 'ignore', 'ignore'], detached: true,
  env: { PATH: process.env.PATH, DSH_RAW_AGENT_GUARD: JSON.stringify({ cli: cli.pid, host: process.pid, group: true, win: false, poll: 100, grace: 300 }) },
});
console.log(JSON.stringify({ cli: cli.pid, guard: guard.pid }));
${stop ? "setTimeout(() => guard.stdin.end('stop\\n'), 300);" : ''}
setInterval(() => {}, 1000);
`;
  async function run(stop: boolean) {
    const h = spawn(process.execPath, ['-e', host(stop)], {
      env: { PATH: process.env.PATH ?? '', GUARD: ORPHAN_GUARD_SCRIPT },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const pids = await new Promise<{ cli: number; guard: number }>((resolve) =>
      h.stdout!.once('data', (d: Buffer) => resolve(JSON.parse(String(d).trim().split('\n')[0]!))),
    );
    return { h, pids };
  }

  it('ends the CLI when its DSH is SIGKILLed', async () => {
    const { h, pids } = await run(false);
    await tick(200);
    expect(alive(pids.cli)).toBe(true);
    h.kill('SIGKILL');
    for (let i = 0; i < 40 && alive(pids.cli); i++) await tick(100);
    expect(alive(pids.cli)).toBe(false);
    for (let i = 0; i < 20 && alive(pids.guard); i++) await tick(100);
    expect(alive(pids.guard)).toBe(false);
  });

  it('a stopped guard leaves the CLI alone', async () => {
    const { h, pids } = await run(true);
    await tick(600);
    expect(alive(pids.guard)).toBe(false);
    h.kill('SIGKILL');
    await tick(500);
    expect(alive(pids.cli)).toBe(true);
    process.kill(pids.cli, 'SIGKILL');
  });
});
