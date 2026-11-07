// The host side of the `/` menu of our sessions (R7.1, R7.3, D36, D38, D52 r5, D54). DSH touch
// points only.
//
// The agent's own commands are NOT host commands: DSH writes a `command/run` + `command/done`
// pair for every host command it executes (`P/dsh-commands/lib/index.js:327-395`), so a host row
// per agent command (or a host `/btw`) put records in the DSH log that the terminal app never
// makes (M6 review). The client's `/` source lists them instead; a pick only fills the composer
// and Enter sends the line as typed text (D52), and the source claims `/btw` in the browser
// (D54), so nothing is written for it.
//
// What is left here, in the agent's own scope (a command-injected child of `agent.ctx`,
// `P/dsh-commands/lib/index.js:89, 205-209`, so Standard sessions never see it):
// - `/permission` (R1.4 leftover, D38): shows and switches the agent's own mode. It is a DSH
//   name clash, so it stays a host command;
// - reading DSH's registry for the names DSH already uses for this agent (`taken`, D52) and
//   handing the placements to the runtime, which serves them on the commands route.

import type { AgentBackendFactory } from '@dsh-raw-agent/core';
import { planCommandMenu } from '../agent-commands.js';
import type { SessionRuntime } from '../driver.js';
import { modeCommandDescription, runModeCommand } from '../mode-command.js';
import type { CordisContext, DshAgent } from './types.js';

/** The name of DSH's permission-preset command, shadowed in our sessions. */
export const PERMISSION_COMMAND = 'permission';

/** What a host command handler returns (`P/dsh-commands/lib/index.js:184-204`). */
export type DshCommandResult = { kind: 'success'; text?: string } | { kind: 'error'; text: string };

/** The part of DSH's command registry the port uses (`P/dsh-commands/lib/index.js:262-298`). */
export interface DshCommands {
  register(definition: {
    name: string;
    description: string;
    input?: { hint: string; attachments?: boolean };
    recordInput?: boolean;
    handler(invocation: {
      agent: DshAgent;
      rawInput: string;
      attachments?: readonly Record<string, unknown>[];
      commandId?: string;
    }): Promise<DshCommandResult> | DshCommandResult;
  }): unknown;
  list?(agent: DshAgent): ReadonlyArray<{ name: string }>;
}

export interface CommandMenuOptions {
  factory: AgentBackendFactory;
  runtime(agentId: string): SessionRuntime | undefined;
  warn(note: string, detail?: unknown): void;
  /** Shadow DSH's `/permission` (default on). */
  modeCommand?: boolean;
}

interface Scope {
  agent: DshAgent;
  handle: unknown;
  svc: DshCommands | undefined;
  /** Names registered once per scope (permission). */
  fixed: Set<string>;
}

const disposeHandle = (handle: unknown) => {
  if (typeof handle === 'function') (handle as () => void)();
  else (handle as { dispose?: () => void } | undefined)?.dispose?.();
};

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

/** One menu per agent of our preset (D52). */
export class AgentCommandMenus {
  readonly #o: CommandMenuOptions;
  readonly #scopes = new Map<string, Scope>();

  constructor(o: CommandMenuOptions) {
    this.#o = o;
  }

  has(agentId: string): boolean {
    return this.#scopes.has(agentId);
  }

  /** Register our rows in the agent's own scope (once per agent). */
  mount(agent: DshAgent): void {
    if (this.#scopes.has(agent.id)) return;
    const actx = agent.ctx as CordisContext | undefined;
    if (typeof actx?.inject !== 'function') return;
    const scope: Scope = { agent, handle: undefined, svc: undefined, fixed: new Set() };
    this.#scopes.set(agent.id, scope);
    try {
      scope.handle = actx.inject(['commands'], (c) => {
        const svc = c.get('commands') as DshCommands | undefined;
        if (typeof svc?.register !== 'function') return;
        scope.svc = svc;
        // The child scope goes when the service or the agent goes; its registrations go with it.
        c.effect(
          () => () => {
            if (scope.svc === svc) {
              scope.svc = undefined;
              scope.fixed.clear();
            }
          },
          'raw-agent: / menu',
        );
        this.#registerFixed(scope, svc);
        this.sync(agent.id);
      });
    } catch (error) {
      this.#o.warn('could not add our rows to the / menu', errorText(error));
    }
  }

  /** The agent left our preset: remove every row of ours. */
  unmount(agentId: string): void {
    const scope = this.#scopes.get(agentId);
    this.#scopes.delete(agentId);
    if (!scope) return;
    try {
      disposeHandle(scope.handle);
    } catch (error) {
      this.#o.warn('could not remove our / menu rows', errorText(error));
    }
  }

  /** The agent was disposed: its own context disposes the rows with it. */
  forget(agentId: string): void {
    this.#scopes.delete(agentId);
  }

  #registerFixed(scope: Scope, svc: DshCommands): void {
    const { factory } = this.#o;
    if (this.#o.modeCommand !== false) {
      // R1.4 leftover (D38): DSH's `/permission` changes DSH's preset, which this agent ignores.
      this.#fixed(scope, svc, {
        name: PERMISSION_COMMAND,
        description: modeCommandDescription(factory),
        input: { hint: '<mode>' },
        handler: ({ agent, rawInput }) =>
          runModeCommand(this.#o.runtime(agent.id), factory, typeof rawInput === 'string' ? rawInput : ''),
      });
    }
  }

  #fixed(scope: Scope, svc: DshCommands, def: Parameters<DshCommands['register']>[0]): void {
    try {
      svc.register(def);
      scope.fixed.add(def.name);
    } catch (error) {
      this.#o.warn(`could not add /${def.name} in this session`, errorText(error));
    }
  }

  /** R7.1: hand the runtime the placements of the agent's commands (taken names, D52). Idempotent. */
  sync(agentId: string): void {
    const scope = this.#scopes.get(agentId);
    const svc = scope?.svc;
    if (!scope || !svc) return;
    const { factory } = this.#o;
    const runtime = this.#o.runtime(agentId);
    const known = runtime?.commandList().list;
    if (!known) return;
    let taken: string[] = [];
    try {
      // Our own `/permission` is in the list too: it shadows the agent's command of that name.
      taken = (svc.list?.(scope.agent) ?? []).map((d) => d.name);
    } catch (error) {
      this.#o.warn('could not read the / menu', errorText(error));
    }
    const { sideQuestionCommand, mcpCommand, rewindCommand } = factory.staticCapabilities;
    const plan = planCommandMenu(known, {
      taken,
      displayName: factory.displayName,
      ...(sideQuestionCommand !== undefined ? { sideQuestionCommand } : {}),
      ...(mcpCommand !== undefined ? { mcpCommand } : {}),
      ...(rewindCommand !== undefined ? { rewindCommand } : {}),
    });
    runtime?.noteMenu(plan.rows);
  }
}
