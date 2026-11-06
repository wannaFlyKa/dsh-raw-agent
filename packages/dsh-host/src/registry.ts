// The backend-session registry (D6, D87). DSH-neutral.
//
// D87: the Host entry owns the processes, because DSH can evict an idle root agent and the agent
// entry's scope goes with it. The Host entry provides one registry as a service; each agent mount
// attaches its runtime to it and only detaches on agent dispose, so the process and its
// background tasks keep running. Without the Host service (tests, an older Host entry) each agent
// mount owns a local registry, and an agent dispose ends the process as before (D75).
//
// D6: no idle reaping by default. When the user sets a timeout, a process with no turn, no
// background task and no pending wake is ended after that idle time; the next message resumes it.

import type { AgentInfo, BackendUserConfig, ModelInfo } from '@dsh-raw-agent/core';
import type { RuntimeState, SessionRuntime } from './driver.js';

/** Cordis service name of the Host entry's registry. */
export const SESSIONS_SERVICE = 'rawAgentSessions';
/** How often the reaper looks, when reaping is on. */
export const REAP_CHECK_MS = 30_000;

/** A steer the agent dropped on Stop, waiting for the composer to take its text back (D25). */
export interface ReturnedDraft {
  messageId: string;
  text: string;
  at: number;
  /** Images and files of the message: they cannot go back into the browser composer. */
  attachments?: number;
}

export interface SessionRegistryOptions {
  /** Idle-reap timeout in ms; `undefined` or 0 means off (D6). Read at every check (volatile, D87). */
  idleReapMs?: () => number | undefined;
  now?: () => number;
  checkEveryMs?: number;
  /**
   * The Host entry's backend user config (D87): agent mounts in another bundle read it from here
   * at every spawn, so a volatile edit of the Host config applies to the next spawn only.
   */
  userConfig?: () => BackendUserConfig;
}

/** The runtime surface the registry uses (the agent bundle's SessionRuntime satisfies it). */
export type RegisteredRuntime = Pick<
  SessionRuntime,
  | 'attached'
  | 'detach'
  | 'dispose'
  | 'isReapable'
  | 'reap'
  | 'start'
  | 'forceStop'
  | 'state'
  | 'view'
  | 'choose'
  | 'answer'
  | 'respond'
  | 'subscribe'
  | 'showNotice'
  | 'stopChild'
  | 'stopTask'
  | 'stopWorkflow'
  | 'stopWorkflowAgent'
  | 'taskOutput'
> &
  // M5: optional, so a runtime from an older agent bundle still registers (D87).
  Partial<Pick<SessionRuntime, 'usage' | 'contextUsage'>>;

export class SessionRegistry {
  readonly apiVersion = 1;
  readonly #runtimes = new Map<string, { kind: string; runtime: RegisteredRuntime }>();
  readonly #drafts = new Map<string, ReturnedDraft[]>();
  readonly #opts: SessionRegistryOptions;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SessionRegistryOptions = {}) {
    this.#opts = opts;
  }

  /** The Host entry's user config getter, if it has one (D87). */
  get userConfig(): (() => BackendUserConfig) | undefined {
    return this.#opts.userConfig;
  }

  get size(): number {
    return this.#runtimes.size;
  }

  /** The runtime of one host session, if its backend kind matches. */
  get(hostSessionId: string, kind?: string): RegisteredRuntime | undefined {
    const e = this.#runtimes.get(hostSessionId);
    if (!e || (kind !== undefined && e.kind !== kind)) return undefined;
    return e.runtime;
  }

  set(hostSessionId: string, kind: string, runtime: RegisteredRuntime): void {
    this.#runtimes.set(hostSessionId, { kind, runtime });
  }

  /** Remove and end one runtime. */
  async delete(hostSessionId: string): Promise<void> {
    const e = this.#runtimes.get(hostSessionId);
    this.#runtimes.delete(hostSessionId);
    this.#drafts.delete(hostSessionId);
    await e?.runtime.dispose();
  }

  /** The kind of one registered session (its backend factory, D80). */
  kindOf(hostSessionId: string): string | undefined {
    return this.#runtimes.get(hostSessionId)?.kind;
  }

  /** D34: the last model list any process of this kind reported in this host run. */
  lastModels(kind: string): ModelInfo[] | undefined {
    let found: ModelInfo[] | undefined;
    for (const e of this.#runtimes.values()) {
      if (e.kind !== kind) continue;
      const m = e.runtime.view().models;
      if (m && m.length > 0) found = m;
    }
    return found;
  }

  /**
   * D51: the last agent list a process of this kind reported for the same folder (project agents
   * differ per folder), so the main-agent picker can list agents before this session's spawn.
   */
  lastAgents(kind: string, cwd: string | undefined): AgentInfo[] | undefined {
    let found: AgentInfo[] | undefined;
    for (const e of this.#runtimes.values()) {
      if (e.kind !== kind) continue;
      const v = e.runtime.view();
      if (v.cwd === cwd && v.agents && v.agents.length > 0) found = v.agents;
    }
    return found;
  }

  /**
   * The parent session and child id of one host child session (D45), so a child's own view can
   * show its row, its Stop and its asks. Only children of registry sessions are found.
   */
  findChild(childHostSessionId: string): { parentSession: string; childId: string } | undefined {
    for (const [id, e] of this.#runtimes) {
      const child = e.runtime.view().children?.find((c) => c.hostSessionId === childHostSessionId);
      if (child) return { parentSession: id, childId: child.id };
    }
    return undefined;
  }

  state(hostSessionId: string): RuntimeState | undefined {
    return this.#runtimes.get(hostSessionId)?.runtime.state();
  }

  noteDraft(hostSessionId: string, draft: ReturnedDraft): void {
    const list = this.#drafts.get(hostSessionId) ?? [];
    list.push(draft);
    this.#drafts.set(hostSessionId, list.slice(-20));
  }

  /** Hand the returned drafts to the composer once. */
  takeDrafts(hostSessionId: string): ReturnedDraft[] {
    const list = this.#drafts.get(hostSessionId) ?? [];
    this.#drafts.delete(hostSessionId);
    return list;
  }

  /** End every idle process past the timeout (D6). Returns the host session ids it reaped. */
  async reapIdle(now = (this.#opts.now ?? Date.now)()): Promise<string[]> {
    const idleMs = this.#opts.idleReapMs?.() ?? 0;
    if (!(idleMs > 0)) return [];
    const out: string[] = [];
    for (const [id, e] of this.#runtimes) {
      if (!e.runtime.isReapable(now, idleMs)) continue;
      if (await e.runtime.reap()) out.push(id);
    }
    return out;
  }

  /** Start the periodic reaper. Returns its stop function. A check costs nothing when reaping is off. */
  startReaper(): () => void {
    this.stopReaper();
    const t = setInterval(() => void this.reapIdle().catch(() => {}), this.#opts.checkEveryMs ?? REAP_CHECK_MS);
    t.unref?.();
    this.#timer = t;
    return () => this.stopReaper();
  }

  stopReaper(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** The Host entry goes away (DSH shutdown, plugin disable): every process ends (D75, D87). */
  async disposeAll(): Promise<void> {
    this.stopReaper();
    const all = [...this.#runtimes.values()];
    this.#runtimes.clear();
    this.#drafts.clear();
    await Promise.all(all.map((e) => e.runtime.dispose().catch(() => {})));
  }
}

/** Is this value a registry this code can use (another bundle's copy counts)? */
export function isSessionRegistry(v: unknown): v is SessionRegistry {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Partial<SessionRegistry>;
  return r.apiVersion === 1 && typeof r.get === 'function' && typeof r.set === 'function';
}
