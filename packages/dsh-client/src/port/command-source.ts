// R7.1, R7.3, R7.4, D52 r5, D54, D55: our `/` input source in our sessions (our store is `ready`,
// or the commands route answers for the session).
// - It offers every agent command, names byte for byte. A pick only puts `/name ` in the composer
//   and Enter sends the line as plain typed text (no claim), so the agent gets the exact text and
//   DSH writes no `command/run` record (none of them is a DSH host command).
// - It claims the side-question command (`/btw …`) in the browser: the question goes to the side
//   panel's route and nothing reaches the agent or either log (D54).
// - It claims the bare MCP command (`/mcp`) and opens our MCP panel, as the terminal app opens its
//   own (D55); with words after it the line goes to the agent.
// - It claims the bare rewind command (`/rewind` and its aliases) and opens our rewind dialog
//   (D30, M7): the terminal app's rewind menu does not run outside it.
// DSH touch point: the `inputTriggers` service (`P/dsh-client-ui-input-trigger` InputTriggerSource;
// claims follow `P/dsh-client-ui-conversation` `CommandClaim`).

import type { CommandsAnswerWire, RawAgentApi } from '../api.js';
import {
  leadingCommand,
  sourceCandidates,
  sourcePickText,
  type CandidateAction,
  type CommandCandidate,
} from '../commands-model.js';
import type { SessionStores } from '../session-store.js';

export const COMMAND_SOURCE_NAME = 'Agent commands';

/** DSH's submit outcome of a claimed command (structural). */
export interface ClaimOutcome {
  kind: 'success' | 'error';
  text?: string;
}

/** DSH's command claim (structural `CommandClaim`): the composer shows the token as a chip. */
export interface SourceClaim {
  name: string;
  token: string;
  hint?: string;
  attachments?: boolean;
  submit(args: string, actx: unknown, attachments: readonly unknown[]): Promise<ClaimOutcome>;
}

export type SourceOutcome = { claim: SourceClaim } | { text: string } | 'handled' | undefined;

/** The structural part of DSH's input-trigger source we implement. */
export interface AgentCommandSource {
  readonly trigger: '/';
  readonly name: string;
  readonly order: number;
  candidates(session: { sessionId: string }, req: { query: string; position: string }): Promise<CommandCandidate[]>;
  onPick(pick: {
    candidate: { name: string; value?: string };
    session: { sessionId: string };
    position?: string;
  }): SourceOutcome;
  matchSpace(session: { sessionId: string }, token: string): SourceOutcome;
  matchEnter(
    session: { sessionId: string },
    line: string,
    signal?: AbortSignal,
    envelope?: { attachments: number },
  ): Promise<SourceOutcome>;
  matchClaim(session: { sessionId: string }, token: string, signal?: AbortSignal): Promise<SourceClaim | undefined>;
  warm(session: { sessionId: string }): void;
}

export function agentCommandSource(stores: SessionStores, api: RawAgentApi): AgentCommandSource {
  const cache = new Map<string, { version: number; answer: Promise<CommandsAnswerWire | undefined> }>();
  /** Answers already in hand, for the synchronous space check. */
  const hot = new Map<string, CommandsAnswerWire>();
  const keep = (sessionId: string, p: Promise<CommandsAnswerWire | undefined>) =>
    p.then((a) => {
      if (a) hot.set(sessionId, a);
      else hot.delete(sessionId);
      return a;
    });
  /** The commands answer of one of our sessions (cached per menu version), else undefined. */
  const answerOf = (sessionId: string): Promise<CommandsAnswerWire | undefined> | undefined => {
    const snap = stores.peek(sessionId)?.getSnapshot();
    if (snap?.status !== 'ready' || !snap.info || !api.commands) return undefined;
    const version = snap.info.view.menu?.version ?? -1;
    const hit = cache.get(sessionId);
    if (hit && hit.version === version) return hit.answer;
    const answer = keep(
      sessionId,
      api.commands(sessionId).catch(() => undefined),
    );
    cache.set(sessionId, { version, answer });
    return answer;
  };
  /**
   * Enter-time answer: also when our store is not ready yet (the first message of a new page, or
   * right after a restart), so a typed `/btw …` is still claimed (D54 r4). A session of another
   * agent answers 404, so it costs one read and claims nothing.
   */
  const answerNow = async (sessionId: string): Promise<CommandsAnswerWire | undefined> => {
    const cached = answerOf(sessionId);
    if (cached) return cached;
    const snap = stores.peek(sessionId)?.getSnapshot();
    if (snap?.status === 'absent' || !api.commands) return undefined;
    return keep(
      sessionId,
      api.commands(sessionId).catch(() => undefined),
    );
  };

  const sideClaim = (sessionId: string, name: string, displayName: string): SourceClaim => ({
    name,
    token: `/${name} `,
    hint: '<question>',
    attachments: false,
    async submit(args) {
      if (!api.askSide) return { kind: 'error', text: 'Side questions are not available here.' };
      const r = await api.askSide(sessionId, args);
      void stores.peek(sessionId)?.refresh();
      if (!r.ok) return { kind: 'error', text: r.error ?? 'The side question was refused.' };
      if (r.entry?.status === 'waiting')
        return { kind: 'success', text: `The question waits in the side panel. Start ${displayName} to ask it.` };
      // The side panel opens by itself and shows the answer; nothing goes to the conversation.
      return { kind: 'success' };
    },
  });
  // A claim, not 'handled': a settled claim clears the draft (DSH's input machine keeps the
  // draft on 'handled'). Nothing is sent and no command record is written (it is not a host command).
  const mcpClaim = (sessionId: string, name: string): SourceClaim => ({
    name,
    token: `/${name} `,
    attachments: false,
    submit() {
      stores.get(sessionId).requestPanel('mcp');
      return Promise.resolve({ kind: 'success' });
    },
  });
  const rewindClaim = (sessionId: string, name: string): SourceClaim => ({
    name,
    token: `/${name} `,
    attachments: false,
    submit() {
      stores.get(sessionId).requestPanel('rewind');
      return Promise.resolve({ kind: 'success' });
    },
  });
  const displayNameOf = (a: CommandsAnswerWire) => a.displayName ?? 'the agent';

  return {
    trigger: '/',
    name: COMMAND_SOURCE_NAME,
    order: 50,
    async candidates(session, req) {
      if (req.position !== 'leading') return [];
      const answer = answerOf(session.sessionId);
      return answer ? sourceCandidates(await answer, req.query) : [];
    },
    onPick(pick) {
      const id = pick.session.sessionId;
      const action = pick.candidate.value as CandidateAction | undefined;
      if (action === 'start') {
        void stores.get(id).start();
        return { text: '' };
      }
      // A name DSH uses in this session: shown so the menu matches the agent's list, but a pick
      // would run DSH's command, so it does nothing (D52).
      if (action === 'taken') return 'handled';
      if (action === 'side') {
        const a = hot.get(id);
        return { claim: sideClaim(id, pick.candidate.name, a ? displayNameOf(a) : 'the agent') };
      }
      return { text: sourcePickText(pick.candidate.name) };
    },
    matchSpace(session, token) {
      const a = hot.get(session.sessionId);
      if (!a?.sideQuestionCommand || token !== `/${a.sideQuestionCommand}`) return undefined;
      return { claim: sideClaim(session.sessionId, a.sideQuestionCommand, displayNameOf(a)) };
    },
    async matchEnter(session, line, _signal, envelope) {
      const cmd = leadingCommand(line);
      if (!cmd) return undefined;
      const a = await answerNow(session.sessionId);
      if (!a) return undefined;
      if (cmd.name === a.sideQuestionCommand) {
        if ((envelope?.attachments ?? 0) > 0)
          throw new Error(`/${cmd.name} takes a question only; remove the attachments first.`);
        return { claim: sideClaim(session.sessionId, cmd.name, displayNameOf(a)) };
      }
      if (cmd.name === a.mcpCommand && cmd.rest === '' && (envelope?.attachments ?? 0) === 0)
        return { claim: mcpClaim(session.sessionId, cmd.name) };
      if (isRewindName(a, cmd.name) && cmd.rest === '' && (envelope?.attachments ?? 0) === 0)
        return { claim: rewindClaim(session.sessionId, cmd.name) };
      return undefined; // every other line is plain text: the agent runs it (D52)
    },
    async matchClaim(session, token) {
      const a = await answerNow(session.sessionId);
      if (!a?.sideQuestionCommand || token !== `/${a.sideQuestionCommand}`) return undefined;
      return sideClaim(session.sessionId, a.sideQuestionCommand, displayNameOf(a));
    },
    warm(session) {
      void answerOf(session.sessionId);
    },
  };
}

/** The rewind command's name or one of its aliases, as the agent lists them (D30, M7). */
export function isRewindName(answer: CommandsAnswerWire, name: string): boolean {
  const cmd = answer.rewindCommand;
  if (cmd === undefined) return false;
  if (name === cmd) return true;
  const row = answer.rows.find((r) => r.name === cmd);
  return (row?.aliases ?? []).includes(name);
}
