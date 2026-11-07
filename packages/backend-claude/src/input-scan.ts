// D28, D70 (M7 live, M8): which CLI transcript holds a given input. After `/clear` the CLI runs
// under a new id whose transcript starts with the typed command (its `uuid` is our input id); the
// host has no step to bind that id to. File reads only, no process (rule 9).
//
// M8: the scan is async and bounded, so a resume never blocks the host's event loop. The
// preferred transcript is read whole (up to the fork scan limit); every other one only at its
// head, because a `/clear` transcript starts with the command. At most `INPUT_SCAN_FILES` of the
// newest other transcripts are read.

import { open, readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { FORK_SCAN_LIMIT_BYTES } from './lifecycle.js';

/** How many of a folder's newest other transcripts are read at most. */
export const INPUT_SCAN_FILES = 32;
/** How much of the head of another transcript is read (a `/clear` entry sits in its first lines). */
export const INPUT_HEAD_BYTES = 128 * 1024;

export interface InputScanDeps {
  /** The whole file, or undefined when it cannot be read. */
  readText(p: string): Promise<string | undefined>;
  /** The first `maxBytes` of the file. */
  readHead(p: string, maxBytes: number): Promise<string | undefined>;
  listDir(p: string): Promise<string[]>;
  /** Modification time in ms, 0 when unknown. */
  mtime(p: string): Promise<number>;
  /** Size in bytes, undefined when unknown. */
  size(p: string): Promise<number | undefined>;
}

export const nodeInputScanDeps: InputScanDeps = {
  async readText(p) {
    try {
      return await readFile(p, 'utf8');
    } catch {
      return undefined;
    }
  },
  async readHead(p, maxBytes) {
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
      fh = await open(p, 'r');
      const buf = Buffer.alloc(Math.max(0, maxBytes));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } catch {
      return undefined;
    } finally {
      await fh?.close().catch(() => undefined);
    }
  },
  async listDir(p) {
    try {
      return await readdir(p);
    } catch {
      return [];
    }
  },
  async mtime(p) {
    try {
      return (await stat(p)).mtimeMs;
    } catch {
      return 0;
    }
  },
  async size(p) {
    try {
      return (await stat(p)).size;
    } catch {
      return undefined;
    }
  },
};

/** The session id of the user entry `inputId` in a transcript text, if it is there. */
export function sessionOfInput(text: string, inputId: string, file: string): string | undefined {
  const needle = `"uuid":"${inputId}"`;
  if (!text.includes(needle)) return undefined;
  for (const line of text.split('\n')) {
    if (!line.includes(needle)) continue;
    try {
      const d = JSON.parse(line) as { type?: unknown; uuid?: unknown; sessionId?: unknown };
      if (d.type === 'user' && d.uuid === inputId)
        return typeof d.sessionId === 'string' ? d.sessionId : path.basename(file, '.jsonl');
    } catch {
      // a half-written line, or a line cut at the end of a head read
    }
  }
  return undefined;
}

/**
 * The transcript that holds `inputId`: the preferred file first (read whole, within the fork
 * scan limit), then the heads of the newest other transcripts in `dirs`.
 */
export async function findSessionHoldingInput(
  inputId: string,
  preferred: string | undefined,
  dirs: readonly string[],
  deps: InputScanDeps,
): Promise<string | undefined> {
  if (preferred !== undefined) {
    const size = await deps.size(preferred);
    if (size === undefined || size <= FORK_SCAN_LIMIT_BYTES) {
      const text = await deps.readText(preferred);
      const hit = text === undefined ? undefined : sessionOfInput(text, inputId, preferred);
      if (hit !== undefined) return hit;
    }
  }
  for (const dir of dirs) {
    const files = (await deps.listDir(dir))
      .filter((n) => n.endsWith('.jsonl'))
      .map((n) => path.join(dir, n))
      .filter((p) => p !== preferred);
    const dated = await Promise.all(files.map(async (p) => ({ p, at: await deps.mtime(p) })));
    dated.sort((a, b) => b.at - a.at);
    for (const { p } of dated.slice(0, INPUT_SCAN_FILES)) {
      const head = await deps.readHead(p, INPUT_HEAD_BYTES);
      const hit = head === undefined ? undefined : sessionOfInput(head, inputId, p);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}
