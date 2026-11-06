// No-process reads of the CLI's own transcript files (D83): the main-thread agent a session was
// started with (D15), and a child agent's transcript as backend events (D49, D50).
// Read-only; nothing here writes a file or starts a process.

import * as path from 'node:path';
import type { AgentRef, BackendEvent } from '@dsh-raw-agent/core';
import { ChildAgents } from './children.js';
import { claudeConfigDir } from './checkpoint.js';
import { isObject, str, type WireMessage } from './wire.js';

/** The CLI's project folder name for a cwd (SDK 0.3.318 `nl`/`ju`: non-alphanumerics → '-'). */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}
/** Longer slugs are cut and get a hash suffix (SDK `ju`, limit 200); we match the prefix. */
export const SLUG_LIMIT = 200;
/** How much of a transcript the main-agent read scans. The entry is near the top. */
export const MAIN_AGENT_SCAN_BYTES = 4 * 1024 * 1024;

export interface TranscriptReadDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homedir: string;
  realpath(p: string): string;
  exists(p: string): boolean;
  /** The first `maxBytes` of a file as UTF-8, or undefined when missing. */
  readHead(p: string, maxBytes: number): string | undefined;
  /** Names in a folder; [] when missing. */
  listDir(p: string): string[];
}

/** Candidate transcript paths for a session (the cwd as given and its real path). */
export function transcriptPaths(sessionId: string, cwd: string, deps: TranscriptReadDeps): string[] {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const projects = p.join(claudeConfigDir(deps.env, deps.homedir, deps.platform), 'projects');
  const out: string[] = [];
  for (const dir of new Set([cwd, deps.realpath(cwd)])) {
    const slug = projectSlug(dir);
    if (slug.length <= SLUG_LIMIT) out.push(p.join(projects, slug, `${sessionId}.jsonl`));
    else {
      const prefix = `${slug.slice(0, SLUG_LIMIT)}-`;
      for (const name of deps.listDir(projects))
        if (name.startsWith(prefix)) out.push(p.join(projects, name, `${sessionId}.jsonl`));
    }
  }
  return out;
}

/**
 * D15 (r4): the agent a session was started with: an `agent-setting` entry written before the
 * conversation's first message (live M3 probe G: line 1 of a `--agent` session; the CLI repeats
 * it at every turn). An entry written only after the first message comes from a mid-session
 * switch, which the CLI does not apply (sdk-surface §8.1 row B), so it is not returned.
 * Which entry the CLI itself restores on `--resume` is still **unverified** (S8).
 */
export function firstAgentSetting(text: string): string | undefined {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a cut last line of the scanned head
    }
    if (!isObject(entry)) continue;
    if (entry.type === 'agent-setting') {
      const name = str(entry.agentSetting);
      if (name !== undefined && name !== '') return name;
      continue;
    }
    if (entry.type === 'user' || entry.type === 'assistant') return undefined;
  }
  return undefined;
}

export function readSessionMainAgent(sessionId: string, cwd: string, deps: TranscriptReadDeps): string | undefined {
  for (const file of transcriptPaths(sessionId, cwd, deps)) {
    const head = deps.readHead(file, MAIN_AGENT_SCAN_BYTES);
    if (head !== undefined) return firstAgentSetting(head);
  }
  return undefined;
}

/** One message of `getSubagentMessages()` (SDK `SessionMessage`). */
export interface TranscriptMessage {
  type: string;
  uuid?: string;
  message?: unknown;
  parent_tool_use_id?: string | null;
}

/**
 * D49, D50: map a child's transcript to the same events the live stream gives (D68 shape, all
 * with `agent: ref`), without `agent-start` / `agent-end`. Every user text that is not CLI
 * context becomes an `agent-input`, the first one being the child's prompt.
 */
export function transcriptEvents(
  ref: Extract<AgentRef, { kind: 'child' }>,
  messages: readonly TranscriptMessage[],
  at: number,
): BackendEvent[] {
  const kids = new ChildAgents();
  kids.adopt(ref.id, ref.id);
  const out: BackendEvent[] = [];
  for (const m of messages) {
    const wire: WireMessage = {
      type: m.type,
      message: m.message,
      parent_tool_use_id: m.parent_tool_use_id ?? `transcript:${ref.id}`,
      agent_id: ref.id,
    };
    if (m.uuid !== undefined) wire.uuid = m.uuid;
    if (m.type === 'assistant') kids.assistant(wire, at, out);
    else if (m.type === 'user') kids.user(wire, at, out);
  }
  // Only the child's own events: nested children it started are their own transcripts.
  return out.filter(
    (e) =>
      e.type !== 'agent-start' &&
      e.type !== 'agent-end' &&
      e.type !== 'team-message' &&
      (!('agent' in e) || e.agent === undefined || (e.agent.kind === 'child' && e.agent.id === ref.id)),
  );
}
