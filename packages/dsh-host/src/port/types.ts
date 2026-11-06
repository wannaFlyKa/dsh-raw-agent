// Structural types for the DSH objects the port touches (D79). They mirror DSH 0.2.2-rc.1
// (`P/dsh-agent/lib/types/runtime-types.d.ts`, `P/dsh-session/lib/types/types.d.ts`,
// `P/dsh-jobs/lib/types/*.d.ts`, `P/dsh-llm/lib/types/types.d.ts`). They are local copies, not
// `import type`, because the spike has no DSH devDependencies yet (D65 forbids runtime imports;
// the pinned type packages come with S7).

export interface DshUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type DshBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string };

export type DshChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: DshBlock }
  | { type: 'usage'; usage: DshUsage }
  | { type: 'finish'; reason: { kind: string }; replayState?: unknown };

export type DshStreamRecord =
  | { type: 'chunk'; time: number; chunk: DshChunk }
  | { type: 'text-chunks' | 'reasoning-chunks'; time0: number; index: number; dt: number[]; texts: string[] }
  | {
      type: 'tool-call-chunks';
      time0: number;
      index: number;
      dt: number[];
      id: string;
      name?: string;
      args: string[];
    };

export interface DshUserMessage {
  readonly id: string;
  readonly role: 'user';
  readonly content: readonly Record<string, unknown>[];
  readonly source: { readonly kind: string; readonly [k: string]: unknown };
}

export interface DshEvent {
  readonly type: string;
  readonly seq: number;
  readonly time: number;
  readonly data: Record<string, unknown>;
}

export interface DshSession {
  readonly id: string;
  readonly seq: number;
  readonly header: {
    readonly cwd?: string;
    readonly origin?: string;
    readonly isSeeded?: boolean;
    readonly [k: string]: unknown;
  };
  append(type: string, data: unknown, options?: { surfaceOp?: 'append'; sourceEventSeqs?: number[] }): { seq: number };
  snapshotEvents(): readonly DshEvent[];
}

export interface DshAgent {
  readonly id: string;
  readonly session: DshSession;
  readonly status: 'idle' | 'running';
  readonly inbox: {
    readonly nextTurn: readonly DshUserMessage[];
    readonly nextStep: readonly DshUserMessage[];
  };
  readonly model: { current(): unknown; select(s: { provider: string; model: string }): void };
  send(message: DshUserMessage, target: 'next-turn' | 'next-step', wakeup: boolean): void;
  followup(message: DshUserMessage): void;
}

export type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: DshUserMessage[] };

export interface PreStepPayload {
  agent: DshAgent;
  messages: DshUserMessage[];
  turn: number;
  step: number;
  signal: AbortSignal;
}

export interface DshJobHandle {
  readonly id: string;
  append(text: string, options?: { channel?: 'stdout' | 'stderr' | 'log' }): void;
  updateProgress(line: string): void;
}

export interface DshJobOutcome {
  status: 'completed' | 'killed' | 'failed';
  detail?: string;
}

export interface DshJobs {
  start(spec: {
    kind: string;
    label: string;
    owner?: string;
    run(job: DshJobHandle): { cancel(reason?: string): void; done: Promise<DshJobOutcome> };
  }): string;
  wait(id: string, timeoutMs: number, caller?: string, signal?: AbortSignal): Promise<{ status: string }>;
  attachController(name: string): () => void;
}

/** The parts of a Cordis context the port uses. */
export interface CordisContext {
  on(
    name: string,
    listener: (...args: never[]) => unknown,
    options?: { prepend?: boolean; global?: boolean },
  ): () => void;
  emit(name: string, ...args: unknown[]): void;
  effect(fn: () => () => void, label?: string): unknown;
  get(name: string): unknown;
  /** Cordis `ctx.inject(deps, apply)`: runs `apply` in a child scope while every dep is served. */
  inject?(deps: string[], apply: (child: CordisContext) => void): unknown;
  readonly logger?: { warn(...a: unknown[]): void; info(...a: unknown[]): void; debug?(...a: unknown[]): void };
}
