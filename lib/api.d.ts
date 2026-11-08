// dsh-raw-agent plugin API types (API version 1). Generated from packages/core/src/plugin-api.ts.
// Type declarations only: use `import type { RawAgentService } from 'dsh-raw-agent/api'`.
// The package exports no runtime value for these names. Services: Host `ctx.rawAgent`,
// Client `ctx.rawAgentClient`. Reference: docs/plugin-api.md in the repository.
/** Cordis service name of the Host service. */
export declare const RAW_AGENT_SERVICE = "rawAgent";
/** Cordis service name of the Client (browser) service. */
export declare const RAW_AGENT_CLIENT_SERVICE = "rawAgentClient";
/** The service API version. A change of any shape bumps it. */
export declare const RAW_AGENT_API_VERSION = 1;
/** `source.kind` of a message a granted plugin sent. Never `'user'` (D66). */
export declare const PLUGIN_SOURCE_KIND = "raw-agent-plugin";
/** The longest text `send` and `steer` accept (characters). */
export declare const PLUGIN_TEXT_MAX = 100000;
/** The longest grant label (characters). */
export declare const GRANT_LABEL_MAX = 80;
export interface RawAgentBackendInfo {
    /** The backend factory kind (D80), for example the Claude Code factory's kind. */
    kind: string;
    /** The backend's own name for labels. */
    displayName: string;
    /** The agent's version, once a process reported it. */
    version?: string;
}
/** What other plugins may know about one of our sessions. */
export interface RawAgentSessionInfo {
    sessionId: string;
    backend: RawAgentBackendInfo;
    /** The agent process: none yet (or ended), starting, or running. */
    process: 'none' | 'starting' | 'running';
    /** Shorthand: `process === 'running'`. */
    running: boolean;
    /** A DSH turn of this session is running. */
    busy: boolean;
    /** Background tasks (agents, workflows, shells) of the process. */
    backgroundTasks: number;
    /** Asks (permission, question, plan, …) waiting for the user. */
    waitingForUser: number;
    /** The permission mode the agent reports (or the one picked before the start). */
    mode?: string;
    /** The model the agent reports. */
    model?: string;
    /** The agent's own session id (its transcript id), once known. */
    backendSessionId?: string;
}
/** Usage numbers as the agent reports them (D57-D60); absent fields are unknown, never 0. */
export interface RawAgentUsageInfo {
    tokens?: number;
    costUsd?: number;
    /** How the cost was found (the agent's report, an estimate, …). */
    costLabel?: string;
    context?: {
        used: number;
        window: number;
        percent: number;
    };
    compacting: boolean;
    /** The plan window with the highest share (subscription accounts only). */
    limit?: {
        id: string;
        label: string;
        percent?: number;
        resetsAt?: number;
        status?: string;
    };
    limitsAvailable?: boolean;
}
export interface RawAgentWorkflowInfo {
    taskId: string;
    runId: string;
    name: string;
    status: string;
    phases: Array<{
        index: number;
        title: string;
    }>;
    agents: Array<{
        index: number;
        label: string;
        state: string;
        phaseIndex?: number;
        tokens?: number;
    }>;
    startedAt: number;
    endedAt?: number;
}
export interface RawAgentChildInfo {
    id: string;
    parent: string;
    label: string;
    status: string;
    background: boolean;
    /** The DSH child session, once it exists (read its native log for the content). */
    hostSessionId?: string;
    tokens?: number;
}
/** An ask that waits for the user. Its choices and any answer are never exposed (D66). */
export interface RawAgentAskInfo {
    id: string;
    kind: string;
    agent: 'main' | 'child';
    title: string;
    at: number;
}
export type RawAgentPublicEvent = {
    type: 'state';
    sessionId: string;
    info: RawAgentSessionInfo;
} | {
    type: 'usage';
    sessionId: string;
    usage: RawAgentUsageInfo;
} | {
    type: 'workflows';
    sessionId: string;
    runs: RawAgentWorkflowInfo[];
} | {
    type: 'children';
    sessionId: string;
    children: RawAgentChildInfo[];
} | {
    type: 'asks';
    sessionId: string;
    asks: RawAgentAskInfo[];
}
/** The Host no longer holds this session (it was closed or the plugin was disabled). */
 | {
    type: 'ended';
    sessionId: string;
};
export type RawAgentPublicEventType = RawAgentPublicEvent['type'];
/** Why a service call was refused. */
export type RawAgentErrorCode = 
/** The session is not a session of this plugin (or not open). */
'not-our-session'
/** No grant token was given. */
 | 'no-grant'
/** The token names no grant (wrong, or revoked by the user). */
 | 'bad-grant'
/** The agent has no running process; the user must start it first (no hidden process, rule 9). */
 | 'not-running' | 'empty' | 'too-long'
/** Another side question is still open. */
 | 'busy'
/** This backend or version cannot do it. */
 | 'unsupported'
/** The call reached the plugin, but DSH or the agent refused or failed it. */
 | 'failed';
export declare class RawAgentServiceError extends Error {
    readonly code: RawAgentErrorCode;
    readonly name = "RawAgentServiceError";
    constructor(code: RawAgentErrorCode, message: string);
}
/** True for a `RawAgentServiceError`, also one from another bundle's copy of this module. */
export declare function isRawAgentServiceError(e: unknown): e is RawAgentServiceError;
/** The Host service (`ctx.rawAgent`). */
export interface RawAgentService {
    readonly apiVersion: 1;
    /** The backends this plugin runs (one agent preset each). */
    readonly backends: readonly RawAgentBackendInfo[];
    /** Undefined when the session is not one of ours. Never starts a process. */
    sessionInfo(sessionId: string): Promise<RawAgentSessionInfo | undefined>;
    /** Stop the running turn, as DSH's Stop does. The process and its background tasks keep running. */
    interrupt(sessionId: string): Promise<void>;
    /**
     * Plugin-only data of one session (not in the native log). The listener gets the current
     * state at once and then each change. Returns the unsubscribe function.
     */
    onEvent(sessionId: string, listener: (e: RawAgentPublicEvent) => void): () => void;
    /** Queue a message as a new turn. Needs a grant token (D66). Resolves with the message id. */
    send(sessionId: string, text: string, grant: string): Promise<{
        messageId: string;
    }>;
    /** Add a message to the running turn (or start one). Needs a grant token (D66). */
    steer(sessionId: string, text: string, grant: string): Promise<{
        messageId: string;
    }>;
    /**
     * A side question (`/btw`): full context, no tools, nothing written to any log. Needs a grant
     * token and a running process. `null`: the agent gave no answer.
     */
    askSideQuestion(sessionId: string, question: string, grant: string): Promise<string | null>;
}
/** The Client service (`ctx.rawAgentClient`): the same calls over the plugin's routes, plus `prefill`. */
export interface RawAgentClientService extends RawAgentService {
    /**
     * Put text into our composer (`'composer'`, at the caret) or into the side-question box
     * (`'side-question'`). Nothing is sent until the user presses Enter. Needs no grant.
     * Resolves `false` when the session is not one of ours.
     */
    prefill(sessionId: string, text: string, target?: 'composer' | 'side-question'): Promise<boolean>;
}
/** The parts of a session view (Host `SessionView`, Client `SessionViewWire`) the API reads. */
export interface PublicViewInput {
    state: {
        process: 'none' | 'starting' | 'running';
        turn: boolean;
        backgroundTasks: number;
        waiting?: number;
    };
    live: {
        model?: string;
        mode?: string;
        version?: string;
    };
    choice?: {
        pendingMode?: string;
    };
    backendSessionId?: string;
    usage?: {
        tokens?: number;
        costUsd?: number;
        costLabel?: string;
        compacting: boolean;
        context?: {
            used: number;
            window: number;
            percent: number;
        };
        limitsAvailable?: boolean;
        limit?: {
            id: string;
            label: string;
            percent?: number;
            resetsAt?: number;
            status?: string;
        };
    };
    workflows?: ReadonlyArray<{
        taskId: string;
        runId: string;
        name: string;
        status: string;
        phases: ReadonlyArray<{
            index: number;
            title: string;
        }>;
        agents: ReadonlyArray<{
            index: number;
            label: string;
            state: string;
            phaseIndex?: number;
            tokens?: number;
        }>;
        startedAt: number;
        endedAt?: number;
    }>;
    children?: ReadonlyArray<{
        id: string;
        parent: string;
        label: string;
        status: string;
        background: boolean;
        hostSessionId?: string;
        tokens?: number;
    }>;
    asks?: ReadonlyArray<{
        id: string;
        kind: string;
        agent: 'main' | 'child';
        title: string;
        at: number;
    }>;
}
export declare function sessionInfoFromView(sessionId: string, backend: RawAgentBackendInfo, view: PublicViewInput): RawAgentSessionInfo;
/**
 * Turns successive views of one session into public events. Each kind of event is sent when its
 * content changed (the first view sends every kind the view has, and `state` always).
 */
export declare class PublicEventTracker {
    #private;
    constructor(sessionId: string, backend: RawAgentBackendInfo);
    update(view: PublicViewInput): RawAgentPublicEvent[];
    /** The session went away: one `ended` event, then nothing. */
    end(): RawAgentPublicEvent[];
}
/** A plain trimmed label for a grant, or why it is refused. */
export declare function checkGrantLabel(label: unknown): {
    ok: true;
    label: string;
} | {
    ok: false;
    error: string;
};
