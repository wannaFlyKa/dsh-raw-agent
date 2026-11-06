// Live workflow-agent output (D49): tail `<transcriptDir>/agent-<agentId>.jsonl` by byte offset.
// The CLI appends one JSON line per message while the agent runs (sdk-surface §8.2, live M4
// probe `backend-workflows`: each line appeared within one 500 ms poll). A file read only:
// nothing here starts a process or writes a file (rule 9).
//
// Safety (D49): reads only regular files named `agent-<id>.jsonl` directly inside a folder that
// lies under the CLI's own `projects` folder, and at most `MAX_READ_BYTES` per read.

import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs';
import * as path from 'node:path';

/** At most this much is read from one file per read (D49). */
export const MAX_READ_BYTES = 512 * 1024;
/** A single line longer than this is skipped (the CLI's bulky non-chat lines stay far below). */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
/** Agent ids are short tokens (`a` + hex on 2.1.318); anything else is never turned into a path. */
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export interface TailFs {
  /** Real path, or undefined when missing. */
  realpath(p: string): string | undefined;
  /** Size of a regular file, or undefined when it is missing or not a regular file. */
  fileSize(p: string): number | undefined;
  /** Up to `length` bytes from `offset`. */
  readAt(p: string, offset: number, length: number): Buffer | undefined;
}

export const nodeTailFs: TailFs = {
  realpath(p) {
    try {
      return realpathSync(p);
    } catch {
      return undefined;
    }
  },
  fileSize(p) {
    try {
      const st = statSync(p);
      return st.isFile() ? st.size : undefined;
    } catch {
      return undefined;
    }
  },
  readAt(p, offset, length) {
    let fd: number | undefined;
    try {
      fd = openSync(p, 'r');
      if (!fstatSync(fd).isFile()) return undefined;
      const buf = Buffer.alloc(length);
      const n = readSync(fd, buf, 0, length, offset);
      return buf.subarray(0, n);
    } catch {
      return undefined;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  },
};

/** Whether `dir` lies inside `projectsDir` (both resolved). */
export function insideFolder(dir: string, projectsDir: string, fs: TailFs): boolean {
  const real = fs.realpath(dir);
  const root = fs.realpath(projectsDir);
  if (real === undefined || root === undefined) return false;
  const rel = path.relative(root, real);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

interface FileState {
  offset: number;
  /** Bytes of a line not yet ended by a newline. */
  carry: Buffer;
  /** Skipping the rest of a line that grew past MAX_LINE_BYTES. */
  skipping: boolean;
}

/** One workflow run's transcript folder. */
export class TranscriptTail {
  readonly dir: string;
  readonly #fs: TailFs;
  readonly #files = new Map<string, FileState>();

  constructor(dir: string, fs: TailFs = nodeTailFs) {
    this.dir = dir;
    this.#fs = fs;
  }

  /** The agent's file path, or undefined for an id that is not a plain token. */
  agentFile(agentId: string): string | undefined {
    if (!AGENT_ID_RE.test(agentId)) return undefined;
    return path.join(this.dir, `agent-${agentId}.jsonl`);
  }

  /** New complete lines of one agent's file, parsed; [] when nothing new. Reads at most one chunk. */
  read(agentId: string): unknown[] {
    const file = this.agentFile(agentId);
    if (file === undefined) return [];
    const size = this.#fs.fileSize(file);
    if (size === undefined) return [];
    let st = this.#files.get(agentId);
    if (st === undefined) {
      st = { offset: 0, carry: Buffer.alloc(0), skipping: false };
      this.#files.set(agentId, st);
    }
    if (size < st.offset) {
      // The file was replaced or cut: start again (rare; the CLI only appends).
      st.offset = 0;
      st.carry = Buffer.alloc(0);
      st.skipping = false;
    }
    if (size === st.offset) return [];
    const chunk = this.#fs.readAt(file, st.offset, Math.min(MAX_READ_BYTES, size - st.offset));
    if (chunk === undefined || chunk.length === 0) return [];
    st.offset += chunk.length;
    const out: unknown[] = [];
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(0x0a, start);
      if (nl < 0) break;
      const piece = chunk.subarray(start, nl);
      start = nl + 1;
      if (st.skipping) {
        st.skipping = false;
        st.carry = Buffer.alloc(0);
        continue;
      }
      const line = st.carry.length > 0 ? Buffer.concat([st.carry, piece]) : piece;
      st.carry = Buffer.alloc(0);
      const text = line.toString('utf8').trim();
      if (text === '') continue;
      try {
        out.push(JSON.parse(text));
      } catch {
        // a broken line is skipped
      }
    }
    if (start < chunk.length && !st.skipping) {
      const rest = chunk.subarray(start);
      if (st.carry.length + rest.length > MAX_LINE_BYTES) {
        st.skipping = true;
        st.carry = Buffer.alloc(0);
      } else st.carry = Buffer.concat([st.carry, rest]);
    }
    return out;
  }

  /** Read until the file is caught up (at most `maxChunks` reads). */
  drain(agentId: string, maxChunks = 64): unknown[] {
    const out: unknown[] = [];
    for (let i = 0; i < maxChunks; i++) {
      const lines = this.read(agentId);
      const file = this.agentFile(agentId);
      const st = this.#files.get(agentId);
      out.push(...lines);
      if (file === undefined || st === undefined) break;
      const size = this.#fs.fileSize(file);
      if (size === undefined || size <= st.offset) break;
    }
    return out;
  }
}
