// The interaction cards (D39-D43, D73, D77): one card per pending ask, rendered from the ask's
// own data (`form`). Labels are the agent's own words from the Host; nothing is answered without
// the user's click. The cards take over DSH's composer (port) or, without that seam, show in the
// controls row.

import * as React from 'react';
import type { AskChoiceWire, AskFormWire, AskReplyWire, AskWire, QuestionWire } from '../api.js';
import {
  askHeading,
  askTitle,
  cardKey,
  numberedChoices,
  clipLines,
  diffHunks,
  diffText,
  elicitationContent,
  elicitationFields,
  emptyDraft,
  initialValues,
  permissionGroups,
  permissionPreview,
  questionPreview,
  questionReply,
  safeHttpUrl,
  splitLines,
  toggleOption,
  toggleOther,
  type FieldModel,
  type FieldValue,
  type Preview,
  type QuestionDraft,
} from '../asks-model.js';
import type { SessionControlStore } from '../session-store.js';
import type { HostActions } from './actions.js';
import { Markdown } from './markdown.js';
import { css } from './style.js';

/** Lines a preview shows before "Show all". */
export const PREVIEW_LINES = 40;

export interface AskCardProps {
  ask: AskWire;
  displayName: string;
  sessionId: string;
  actions: HostActions;
  /** The answer is in flight. */
  busy: boolean;
  /** Why the last answer was refused (the ask stays open). */
  error?: string;
  onAnswer(reply: AskReplyWire): void;
}

type Form<K extends AskFormWire['type']> = Extract<AskFormWire, { type: K }>;
const formOf = <K extends AskFormWire['type']>(ask: AskWire, type: K): Form<K> | undefined =>
  ask.form?.type === type ? (ask.form as Form<K>) : undefined;

/** The number key that picks a choice (1-9), as the terminal app numbers its rows. */
const KeyHint = React.createContext<(choice: AskChoiceWire) => number | undefined>(() => undefined);

function Button(props: {
  choice: AskChoiceWire;
  primary?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onClick(): void;
}): React.ReactElement {
  const n = React.useContext(KeyHint)(props.choice);
  return (
    <button
      type="button"
      style={props.primary ? css.primary : css.choice}
      disabled={props.disabled}
      autoFocus={props.autoFocus}
      data-raw-agent="ask-choice"
      data-choice={props.choice.id}
      {...(n !== undefined ? { 'aria-keyshortcuts': String(n), title: `Key ${n}` } : {})}
      onClick={props.onClick}
    >
      {n !== undefined && <span style={css.keyHint}>{n}</span>}
      {props.choice.label}
    </button>
  );
}

type KeyTarget = { tagName?: string; type?: string } | null;

/** The focus is in a field where keys are typing. */
function isTextTarget(t: KeyTarget): boolean {
  const tag = t?.tagName?.toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes(String(t?.type ?? 'text'));
}

type ChoiceEl = { disabled?: boolean; getAttribute(n: string): string | null; click(): void; focus(): void };

/** Number keys, Up/Down and Esc on a card (R5.2-R5.4). The click runs the button's own handler. */
function onCardKey(ask: AskWire, e: React.KeyboardEvent<HTMLDivElement>): void {
  const k = cardKey(ask, e.key, {
    inText: isTextTarget(e.target as unknown as KeyTarget),
    modified: e.ctrlKey || e.metaKey || e.altKey,
  });
  if (!k) return;
  const root = e.currentTarget as unknown as { querySelectorAll(s: string): ArrayLike<ChoiceEl> };
  const buttons = Array.from(root.querySelectorAll('[data-raw-agent="ask-choice"]')).filter((b) => !b.disabled);
  if (k.type === 'choose') {
    const b = buttons.find((x) => x.getAttribute('data-choice') === k.choice.id);
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    b.click();
    return;
  }
  if (buttons.length === 0) return;
  const active = (globalThis.document?.activeElement ?? null) as unknown as ChoiceEl | null;
  const at = active ? buttons.indexOf(active) : -1;
  const next = buttons[(at + k.by + buttons.length) % buttons.length] ?? buttons[0]!;
  e.preventDefault();
  next.focus();
}

/** A long text with "Show all" (nothing is clipped without a way to expand) and Copy. */
function Clipped(props: {
  lines: readonly React.ReactNode[];
  copyText: string;
  actions: HostActions;
  testId: string;
}): React.ReactElement {
  const [all, setAll] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const { shown, hidden } = clipLines(props.lines, PREVIEW_LINES, all);
  return (
    <div style={css.choiceCol}>
      <pre style={css.previewBox} data-raw-agent={props.testId}>
        {shown}
      </pre>
      <span style={css.choiceRow}>
        {hidden > 0 && (
          <button type="button" style={css.button} data-raw-agent="show-all" onClick={() => setAll(true)}>
            Show all ({hidden} more {hidden === 1 ? 'line' : 'lines'})
          </button>
        )}
        {all && props.lines.length > PREVIEW_LINES && (
          <button type="button" style={css.button} onClick={() => setAll(false)}>
            Show less
          </button>
        )}
        <button
          type="button"
          style={css.button}
          onClick={() => void props.actions.copy(props.copyText).then((ok) => setCopied(ok))}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </span>
    </div>
  );
}

function plainLines(text: string): React.ReactNode[] {
  const lines = splitLines(text);
  return (lines.length > 0 ? lines : ['']).map((l, i) => <div key={i}>{l === '' ? '\u00a0' : l}</div>);
}

export function PreviewView(props: { preview: Preview; actions: HostActions }): React.ReactElement {
  const { preview: p, actions } = props;
  const [full, setFull] = React.useState(false);
  if (p.kind === 'diff') {
    const changed = p.lines.some((l) => l.op !== ' ');
    const hunks = full || !changed ? p.lines : diffHunks(p.lines);
    const folded = hunks.length < p.lines.length;
    const rows = hunks.map((l, i) =>
      l.op === '…' ? (
        <div key={i} style={css.diffGap}>
          {`⋯ ${l.count} unchanged ${l.count === 1 ? 'line' : 'lines'}`}
        </div>
      ) : (
        <div key={i} style={l.op === '+' ? css.diffAdd : l.op === '-' ? css.diffDel : undefined} data-op={l.op}>
          {`${l.op} ${l.text}`}
        </div>
      ),
    );
    return (
      <div style={css.choiceCol}>
        {p.path && <span style={css.path}>{p.path}</span>}
        {p.note && <span style={css.cardNote}>{p.note}</span>}
        <Clipped lines={rows} copyText={diffText(p.lines)} actions={actions} testId="preview-diff" />
        {(folded || full) && changed && (
          <span>
            <button type="button" style={css.button} onClick={() => setFull(!full)}>
              {full ? 'Show only the changes' : 'Show the whole text'}
            </button>
          </span>
        )}
      </div>
    );
  }
  if (p.kind === 'command')
    return (
      <div style={css.choiceCol}>
        <Clipped lines={plainLines(p.text)} copyText={p.text} actions={actions} testId="preview-command" />
        {p.note && <span style={css.cardNote}>{p.note}</span>}
      </div>
    );
  if (p.kind === 'text')
    return (
      <div style={css.choiceCol}>
        <span style={css.cardNote}>{p.label}</span>
        <Clipped lines={plainLines(p.text)} copyText={p.text} actions={actions} testId="preview-text" />
        {p.note && <span style={css.cardNote}>{p.note}</span>}
      </div>
    );
  return <Clipped lines={plainLines(p.text)} copyText={p.text} actions={actions} testId="preview-json" />;
}

function Feedback(props: {
  value: string;
  placeholder?: string;
  onChange(v: string): void;
  testId?: string;
}): React.ReactElement {
  return (
    <textarea
      style={css.textarea}
      value={props.value}
      placeholder={props.placeholder}
      aria-label={props.placeholder ?? 'Feedback'}
      data-raw-agent={props.testId ?? 'feedback'}
      onChange={(e) => props.onChange(e.currentTarget.value)}
    />
  );
}

/** D77: the card marks the tool card it is about and can scroll to it. */
function ToolCallLink(props: { callId?: string; actions: HostActions }): React.ReactElement | null {
  const { callId, actions } = props;
  const [found, setFound] = React.useState(false);
  React.useEffect(() => {
    if (!callId || !actions.markToolCall) return undefined;
    let mark = actions.markToolCall(callId, 'Waiting for your approval');
    setFound(mark.found);
    // DSH may draw the tool card after the ask arrives (D18 buffering): look again.
    const timer = setInterval(() => {
      if (mark.found) return;
      mark.undo();
      mark = actions.markToolCall!(callId, 'Waiting for your approval');
      setFound(mark.found);
    }, 1000);
    return () => {
      clearInterval(timer);
      mark.undo();
    };
  }, [callId, actions]);
  if (!callId || !found || !actions.revealToolCall) return null;
  return (
    <span>
      <button
        type="button"
        style={css.button}
        data-raw-agent="reveal-tool-call"
        onClick={() => actions.revealToolCall?.(callId)}
      >
        Show the tool call
      </button>
    </span>
  );
}

function PermissionBody(props: AskCardProps): React.ReactElement {
  const { ask, actions, busy, onAnswer } = props;
  const form = formOf(ask, 'permission');
  const [feedback, setFeedback] = React.useState('');
  // The user's edit of an editable "always" rule, by choice id (the agent's text until changed).
  const [rules, setRules] = React.useState<Record<string, string>>({});
  const groups = permissionGroups(ask.choices);
  const preview = React.useMemo(() => permissionPreview(form?.input), [form?.input]);
  const reject = groups.reject.find((c) => c.feedback) ?? groups.reject[0];
  const noFirst = form?.defaultToNo === true;
  return (
    <>
      {form?.mcpServer && (
        <span style={css.cardNote}>
          MCP server: {form.mcpServer.name} ({form.mcpServer.source})
        </span>
      )}
      {form?.reason && <span style={css.cardNote}>Why it asks: {form.reason}</span>}
      {form?.blockedPath && <span style={css.cardNote}>Path: {form.blockedPath}</span>}
      {preview ? (
        <PreviewView preview={preview} actions={actions} />
      ) : (
        ask.detail && <span style={css.cardNote}>{ask.detail}</span>
      )}
      {form?.description && preview?.kind !== 'command' && <span style={css.cardNote}>{form.description}</span>}
      {form?.inputTruncated && (
        <span style={css.cardNote}>
          The tool input is too large to show here (over 512 KB). The agent's terminal app shows it.
        </span>
      )}
      <ToolCallLink {...(ask.callId ? { callId: ask.callId } : {})} actions={actions} />
      <div style={css.choiceCol}>
        <span style={css.choiceRow}>
          {groups.allow.map((c, i) => (
            <Button
              key={c.id}
              choice={c}
              primary={i === 0 && !noFirst}
              autoFocus={i === 0 && !noFirst}
              disabled={busy}
              onClick={() => onAnswer({ choice: c.id })}
            />
          ))}
        </span>
        {groups.always.map((c) => (
          <span key={c.id} style={css.always} data-raw-agent="always">
            <span>
              <Button
                choice={c}
                disabled={busy || (c.editable !== undefined && (rules[c.id] ?? c.editable.value).trim() === '')}
                onClick={() => {
                  const edited = c.editable ? (rules[c.id] ?? c.editable.value).trim() : undefined;
                  onAnswer(
                    c.editable && edited !== undefined && edited !== c.editable.value
                      ? { choice: c.id, rule: edited }
                      : { choice: c.id },
                  );
                }}
              />
            </span>
            {c.editable && (
              <label style={css.choiceRow}>
                <span style={css.cardNote}>Don&apos;t ask again for: {c.editable.toolName}(</span>
                <input
                  type="text"
                  style={{ ...css.input, minWidth: '16em' }}
                  value={rules[c.id] ?? c.editable.value}
                  placeholder={c.editable.placeholder}
                  aria-label={c.editable.placeholder ?? 'Rule'}
                  data-raw-agent="always-rule"
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    setRules((all) => ({ ...all, [c.id]: v }));
                  }}
                />
                <span style={css.cardNote}>)</span>
              </label>
            )}
            {c.destination && (
              <span style={css.cardNote} data-raw-agent="always-destination">
                Saved to: {c.destination}
              </span>
            )}
            {(c.effects?.length ?? 0) > 0 && (
              <ul style={css.effects}>
                {c.effects!.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </span>
        ))}
        {reject?.feedback && (
          <Feedback
            value={feedback}
            onChange={setFeedback}
            {...(reject.feedbackPlaceholder ? { placeholder: reject.feedbackPlaceholder } : {})}
          />
        )}
        <span style={css.choiceRow}>
          {groups.reject.map((c) => (
            <Button
              key={c.id}
              choice={c}
              primary={noFirst && c === reject}
              autoFocus={noFirst && c === reject}
              disabled={busy}
              onClick={() =>
                onAnswer(c.feedback && feedback.trim() !== '' ? { choice: c.id, feedback } : { choice: c.id })
              }
            />
          ))}
        </span>
      </div>
    </>
  );
}

function QuestionView(props: {
  q: QuestionWire;
  index: number;
  draft: QuestionDraft;
  otherLabel: string;
  previewFormat: 'markdown' | 'html';
  onChange(d: QuestionDraft): void;
}): React.ReactElement {
  const { q, draft, index } = props;
  const [focused, setFocused] = React.useState<string | undefined>();
  const [noteOpen, setNoteOpen] = React.useState(draft.note !== '');
  const preview = questionPreview(q, draft, focused);
  const name = `raw-agent-q-${index}`;
  return (
    <div style={css.question} data-raw-agent="question" data-question={q.question}>
      {q.header && <span style={css.chip}>{q.header}</span>}
      <span style={css.cardTitle}>{q.question}</span>
      {q.multiSelect && <span style={css.cardNote}>Pick one or more.</span>}
      <div style={css.questionBody}>
        <div style={css.options} role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
          {q.options.map((o) => (
            <label
              key={o.label}
              style={css.option}
              onMouseEnter={() => setFocused(o.label)}
              onFocus={() => setFocused(o.label)}
            >
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={name}
                checked={draft.picked.includes(o.label)}
                data-raw-agent="question-option"
                onChange={() => props.onChange(toggleOption(q, draft, o.label))}
              />
              <span>
                {o.label}
                {o.description && <span style={css.optionDesc}>{o.description}</span>}
              </span>
            </label>
          ))}
          {q.allowsOther && (
            <label style={css.option}>
              <input
                type={q.multiSelect ? 'checkbox' : 'radio'}
                name={name}
                checked={draft.otherOn}
                data-raw-agent="question-other"
                onChange={(e) => props.onChange(toggleOther(q, draft, q.multiSelect ? e.currentTarget.checked : true))}
              />
              <span style={{ flex: 1 }}>
                {props.otherLabel}
                {draft.otherOn && (
                  <input
                    type="text"
                    style={{ ...css.input, display: 'block', width: '100%', marginTop: 2 }}
                    value={draft.other}
                    aria-label={`${props.otherLabel}: ${q.question}`}
                    data-raw-agent="question-other-text"
                    autoFocus
                    onChange={(e) => props.onChange({ ...draft, other: e.currentTarget.value })}
                  />
                )}
              </span>
            </label>
          )}
        </div>
        {preview !== undefined && (
          <div style={{ ...css.previewBox, ...css.questionPreview }} data-raw-agent="question-preview">
            {/* D13: html previews are shown as text, never as live HTML. */}
            {props.previewFormat === 'markdown' ? <Markdown text={preview} testId="preview-markdown" /> : preview}
          </div>
        )}
      </div>
      {noteOpen ? (
        <Feedback
          value={draft.note}
          placeholder="Notes for this answer (optional)"
          testId="question-note"
          onChange={(note) => props.onChange({ ...draft, note })}
        />
      ) : (
        <span>
          <button type="button" style={css.button} onClick={() => setNoteOpen(true)}>
            Add a note
          </button>
        </span>
      )}
    </div>
  );
}

function QuestionBody(props: AskCardProps): React.ReactElement {
  const { ask, busy, onAnswer } = props;
  const form = formOf(ask, 'question');
  const questions = form?.questions ?? [];
  const [drafts, setDrafts] = React.useState<QuestionDraft[]>(() => questions.map(() => emptyDraft()));
  const reply = questionReply(questions, drafts);
  const submit = ask.choices.find((c) => c.submits === 'answers' && !c.partial);
  // "Chat about this": the answers so far go with it, also none.
  const chat = ask.choices.find((c) => c.submits === 'answers' && c.partial);
  // The one-button `option-<i>` choices are the old row's path; the form replaces them here.
  const others = ask.choices.filter((c) => c.submits === undefined && !/^option-\d+$/.test(c.id));
  const answered = Object.keys(reply.answers).length;
  return (
    <>
      {questions.map((q, i) => (
        <QuestionView
          key={`${i}:${q.question}`}
          q={q}
          index={i}
          draft={drafts[i] ?? emptyDraft()}
          otherLabel={form?.otherLabel ?? 'Other'}
          previewFormat={form?.previewFormat ?? 'markdown'}
          onChange={(d) => setDrafts((all) => all.map((x, j) => (j === i ? d : x)))}
        />
      ))}
      {answered > 0 && reply.missing.length > 0 && (
        <span style={css.cardNote}>Not answered yet: {reply.missing.join(' / ')}</span>
      )}
      <span style={css.choiceRow}>
        {submit && (
          <Button
            choice={submit}
            primary
            disabled={busy || answered === 0}
            onClick={() =>
              onAnswer({
                choice: submit.id,
                answers: reply.answers,
                ...(reply.notes ? { notes: reply.notes } : {}),
              })
            }
          />
        )}
        {chat && (
          <Button
            choice={chat}
            disabled={busy}
            onClick={() =>
              onAnswer({ choice: chat.id, answers: reply.answers, ...(reply.notes ? { notes: reply.notes } : {}) })
            }
          />
        )}
        {others.map((c) => (
          <Button key={c.id} choice={c} disabled={busy} onClick={() => onAnswer({ choice: c.id })} />
        ))}
      </span>
    </>
  );
}

function PlanBody(props: AskCardProps): React.ReactElement {
  const { ask, actions, sessionId, busy, onAnswer } = props;
  const form = formOf(ask, 'plan');
  const [feedback, setFeedback] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const keep = ask.choices.find((c) => c.feedback);
  const approve = ask.choices.filter((c) => c !== keep);
  const plan = form?.plan ?? ask.detail ?? '';
  return (
    <>
      <div
        style={{ ...css.previewBox, fontFamily: 'inherit', ...(open ? {} : { maxHeight: '40vh' }) }}
        data-raw-agent="plan"
      >
        <Markdown text={plan} testId="plan-markdown" />
      </div>
      <span style={css.choiceRow}>
        <button type="button" style={css.button} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show the whole plan'}
        </button>
        {form?.planFilePath && (
          <button
            type="button"
            style={css.button}
            title={form.planFilePath}
            data-raw-agent="open-plan"
            onClick={() => actions.openPreview(sessionId, form.planFilePath!)}
          >
            Open the plan file
          </button>
        )}
      </span>
      <div style={css.choiceCol}>
        {approve.map((c, i) => (
          <span key={c.id}>
            <Button
              choice={c}
              primary={i === 0}
              autoFocus={i === 0}
              disabled={busy}
              onClick={() => onAnswer({ choice: c.id })}
            />
          </span>
        ))}
        {keep && (
          <>
            <Feedback
              value={feedback}
              onChange={setFeedback}
              {...(keep.feedbackPlaceholder ? { placeholder: keep.feedbackPlaceholder } : {})}
            />
            <span>
              <Button
                choice={keep}
                disabled={busy}
                onClick={() => onAnswer(feedback.trim() !== '' ? { choice: keep.id, feedback } : { choice: keep.id })}
              />
            </span>
          </>
        )}
      </div>
    </>
  );
}

function FieldView(props: { f: FieldModel; value: FieldValue; onChange(v: FieldValue): void }): React.ReactElement {
  const { f, value } = props;
  const label = (
    <span>
      {f.title}
      {f.required ? ' *' : ''}
    </span>
  );
  let input: React.ReactNode;
  if (f.kind === 'boolean')
    return (
      <span style={css.choiceCol}>
        <label style={css.fieldCheck} data-raw-agent="field-boolean">
          <input
            type="checkbox"
            style={css.checkbox}
            checked={value === true}
            aria-label={f.title}
            data-field={f.key}
            onChange={(e) => props.onChange(e.currentTarget.checked)}
          />
          {label}
        </label>
        {f.description && <span style={css.optionDesc}>{f.description}</span>}
      </span>
    );
  if (f.kind === 'select')
    input = (
      <select
        style={css.input}
        value={typeof value === 'string' ? value : ''}
        aria-label={f.title}
        data-field={f.key}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        <option value="">–</option>
        {f.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  else if (f.kind === 'multi') {
    const list = Array.isArray(value) ? value : [];
    input = (
      <span style={css.choiceCol} role="group" aria-label={f.title}>
        {f.options.map((o) => (
          <label key={o.value} style={css.option}>
            <input
              type="checkbox"
              data-field={`${f.key}:${o.value}`}
              checked={list.includes(o.value)}
              onChange={() =>
                props.onChange(list.includes(o.value) ? list.filter((x) => x !== o.value) : [...list, o.value])
              }
            />
            {o.label}
          </label>
        ))}
      </span>
    );
  } else
    input = (
      <input
        style={css.input}
        type={f.kind === 'number' || f.kind === 'integer' ? 'number' : f.inputType}
        step={f.kind === 'integer' ? 1 : undefined}
        min={f.min}
        max={f.max}
        value={typeof value === 'string' ? value : ''}
        aria-label={f.title}
        data-field={f.key}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      />
    );
  return (
    <label style={css.field}>
      {label}
      {input}
      {f.description && <span style={css.optionDesc}>{f.description}</span>}
    </label>
  );
}

function ElicitationBody(props: AskCardProps): React.ReactElement {
  const { ask, busy, onAnswer } = props;
  const form = formOf(ask, 'elicitation');
  const fields = React.useMemo(() => elicitationFields(form?.requestedSchema), [form?.requestedSchema]);
  const [values, setValues] = React.useState<Record<string, FieldValue>>(() => initialValues(fields));
  const [problem, setProblem] = React.useState<string | undefined>();
  const accept = ask.choices.find((c) => c.id === 'accept') ?? ask.choices.find((c) => c.submits === 'content');
  const rest = ask.choices.filter((c) => c !== accept);
  const url = safeHttpUrl(form?.url);
  const waiting = ask.state === 'waiting';
  return (
    <>
      {form?.description && <span style={css.cardNote}>{form.description}</span>}
      {form?.mode === 'url' && (
        <div style={css.choiceCol}>
          <span style={css.url} data-raw-agent="elicitation-url">
            {form.url}
          </span>
          {!url && <span style={css.cardError}>This is not an http(s) link, so it is not opened from here.</span>}
          {waiting && (
            <span style={css.cardNote}>
              Finish in the page that opened. This card closes when {form.displayName ?? form.serverName} says it is
              done.
            </span>
          )}
        </div>
      )}
      {form?.mode === 'form' &&
        fields.map((f) => (
          <FieldView
            key={f.key}
            f={f}
            value={values[f.key] ?? ''}
            onChange={(v) => setValues((all) => ({ ...all, [f.key]: v }))}
          />
        ))}
      {problem && <span style={css.cardError}>{problem}</span>}
      <span style={css.choiceRow}>
        {waiting && url && (
          <a href={url} target="_blank" rel="noopener noreferrer" style={css.choice} data-raw-agent="open-url">
            Open the link again
          </a>
        )}
        {accept && form?.mode === 'url' && !waiting && (
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              ...css.primary,
              textDecoration: 'none',
              ...(url && !busy ? {} : { pointerEvents: 'none', opacity: 0.5 }),
            }}
            aria-disabled={!url || busy}
            data-raw-agent="ask-choice"
            data-choice={accept.id}
            onClick={() => {
              if (url && !busy) onAnswer({ choice: accept.id });
            }}
          >
            {accept.label}
          </a>
        )}
        {accept && form?.mode !== 'url' && (
          <Button
            choice={accept}
            primary
            disabled={busy}
            onClick={() => {
              const r = elicitationContent(fields, values);
              if ('error' in r) {
                setProblem(r.error);
                return;
              }
              setProblem(undefined);
              onAnswer({ choice: accept.id, content: r.content });
            }}
          />
        )}
        {rest.map((c) => (
          <Button key={c.id} choice={c} disabled={busy} onClick={() => onAnswer({ choice: c.id })} />
        ))}
      </span>
    </>
  );
}

function TrustBody(props: AskCardProps): React.ReactElement {
  const { ask, busy, onAnswer } = props;
  const form = formOf(ask, 'trust');
  return (
    <>
      {form && <span style={css.path}>{form.directory}</span>}
      <div style={{ ...css.cardNote, color: 'inherit' }} data-raw-agent="trust-body">
        {form?.body ?? ask.detail}
      </div>
      <span style={css.choiceRow}>
        {ask.choices.map((c, i) => (
          <Button key={c.id} choice={c} primary={i === 0} disabled={busy} onClick={() => onAnswer({ choice: c.id })} />
        ))}
      </span>
    </>
  );
}

function PlainBody(props: AskCardProps): React.ReactElement {
  const { ask, busy, onAnswer } = props;
  return (
    <>
      {ask.detail && <span style={css.cardNote}>{ask.detail}</span>}
      <span style={css.choiceRow}>
        {ask.choices
          .filter((c) => c.submits === undefined)
          .map((c) => (
            <Button key={c.id} choice={c} disabled={busy} onClick={() => onAnswer({ choice: c.id })} />
          ))}
      </span>
    </>
  );
}

/** One ask's card. */
export function AskCard(props: AskCardProps): React.ReactElement {
  const { ask } = props;
  const body =
    ask.kind === 'permission' && ask.form?.type === 'permission' ? (
      <PermissionBody {...props} />
    ) : ask.kind === 'question' && ask.form?.type === 'question' ? (
      <QuestionBody {...props} />
    ) : ask.kind === 'plan' ? (
      <PlanBody {...props} />
    ) : ask.kind === 'elicitation' && ask.form?.type === 'elicitation' ? (
      <ElicitationBody {...props} />
    ) : ask.kind === 'trust' ? (
      <TrustBody {...props} />
    ) : (
      <PlainBody {...props} />
    );
  const numbered = numberedChoices(ask);
  const hint = (c: AskChoiceWire) => {
    const i = numbered.findIndex((x) => x.id === c.id);
    return i >= 0 && i < 9 ? i + 1 : undefined;
  };
  return (
    <div
      style={css.card}
      data-raw-agent="ask-card"
      data-ask={ask.id}
      data-kind={ask.kind}
      role="alert"
      onKeyDown={(e) => onCardKey(ask, e)}
    >
      <KeyHint.Provider value={hint}>
        <div style={css.cardHead}>
          <span style={css.cardWho} data-raw-agent="ask-who">
            {askHeading(ask, props.displayName)}
          </span>
          <span style={css.cardTitle}>{askTitle(ask)}</span>
        </div>
        {body}
        {props.error && (
          <span style={css.cardError} role="status">
            {props.error}
          </span>
        )}
      </KeyHint.Provider>
    </div>
  );
}

/**
 * Every open ask of one session: the selected one (default: the oldest) as a full card, the
 * others as a row to switch to. Reads the session store, so the takeover keeps it subscribed.
 */
export function AskPanel(props: {
  store: SessionControlStore;
  actions: HostActions;
  /** The ask to show first (the pending interaction the composer elected). */
  askId?: string;
  /** Show only these asks (a child's own view shows the asks of that child, R6.1). */
  only?: (ask: AskWire) => boolean;
}): React.ReactElement | null {
  const { store, actions, only } = props;
  const snap = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [picked, setPicked] = React.useState<string | undefined>();
  const info = snap.info;
  if (!info) return null;
  const asks = [...(info.view.asks ?? [])].filter((a) => !only || only(a)).sort((a, b) => a.at - b.at);
  if (asks.length === 0) return null;
  const ask = asks.find((a) => a.id === picked) ?? asks.find((a) => a.id === props.askId) ?? asks[0]!;
  const others = asks.filter((a) => a !== ask);
  const name = info.backend.displayName;
  return (
    <div style={css.choiceCol} data-raw-agent="ask-panel">
      <AskCard
        // A new ask gets fresh form state.
        key={ask.id + (ask.state ?? '')}
        ask={ask}
        displayName={name}
        sessionId={store.sessionId}
        actions={actions}
        busy={snap.answering === ask.id}
        {...(snap.askError?.id === ask.id ? { error: snap.askError.text } : {})}
        onAnswer={(reply) => void store.answer(ask.id, reply)}
      />
      {info.view.state.turn && actions.stopTurn && (
        // The takeover hides DSH's Stop button. Stop only interrupts the turn (rule 6); it never
        // answers an ask, so a background agent's ask stays open (D39).
        <span>
          <button
            type="button"
            style={css.button}
            data-raw-agent="ask-stop"
            title="Stop the running turn, as the Stop button does. Open asks of background work stay open."
            onClick={() => actions.stopTurn?.(store.sessionId)}
          >
            Stop the turn
          </button>
        </span>
      )}
      {others.length > 0 && (
        <span style={css.more} data-raw-agent="ask-more">
          {others.length === 1 ? '1 more ask waits:' : `${others.length} more asks wait:`}
          {others.map((a) => (
            <button key={a.id} type="button" style={css.button} onClick={() => setPicked(a.id)}>
              {askHeading(a, name)}: {askTitle(a)}
            </button>
          ))}
        </span>
      )}
      {snap.error && (
        <span style={css.cardError} role="status">
          {snap.error}
        </span>
      )}
    </div>
  );
}
