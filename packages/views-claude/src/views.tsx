// The Claude tool views (D19): one compact row per call, expanded on click. Each view reads only
// `ToolViewProps` (core); the client port registers them for our sessions only. Restyle points
// (D67): `--raw-agent-*` CSS variables with DSH theme aliases as fallbacks; every element carries
// `data-raw-agent="tool-…"`.

import * as React from 'react';
import { diffHunks, splitLines, type DiffLine, type ToolViewProps } from '@dsh-raw-agent/core';
import {
  STATE_LABEL,
  agentModel,
  bashModel,
  displayPath,
  editModel,
  firstLine,
  planTitle,
  questionModels,
  readLines,
  readModel,
  resultCount,
  rowState,
  safeUrl,
  searchSummary,
  skillName,
  str,
  todoItems,
  todoSummary,
  writeModel,
  type RowState,
} from './model.js';

const v = (name: string, alias: string, fallback: string) =>
  `var(--raw-agent-${name}, var(--dsw-alias-${alias}, ${fallback}))`;
const muted = v('muted', 'label-secondary', 'GrayText');
const border = v('border', 'border-l2', 'rgba(128,128,128,0.35)');
const mono = 'var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)';

export const toolCss = {
  row: { display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, minWidth: 0, padding: '2px 0' },
  head: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 6,
    minWidth: 0,
    cursor: 'pointer',
    background: 'transparent',
    border: 'none',
    padding: 0,
    font: 'inherit',
    color: 'inherit',
    textAlign: 'left',
    width: '100%',
  },
  title: { fontWeight: 600, flex: 'none' },
  summary: {
    color: muted,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    flex: '0 1 auto',
  },
  state: { fontSize: 11, color: muted, flex: 'none' },
  error: { fontSize: 11, color: v('danger', 'state-error-primary', '#c0392b'), flex: 'none' },
  body: { display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 12, minWidth: 0 },
  pre: {
    fontFamily: mono,
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: 8,
    margin: 0,
    maxHeight: 320,
    overflow: 'auto',
  },
  errorText: { color: v('danger', 'state-error-primary', '#c0392b') },
  label: { fontSize: 11, color: muted },
  add: { background: v('diff-add', 'code-diff-added', 'rgba(46,160,67,0.18)') },
  del: { background: v('diff-del', 'code-diff-deleted', 'rgba(248,81,73,0.18)') },
  num: { color: muted, userSelect: 'none', whiteSpace: 'pre' },
  gap: { color: muted },
  counts: { fontSize: 11, flex: 'none' },
  addCount: { color: v('done', 'state-success-primary', '#22a06b') },
  delCount: { color: v('danger', 'state-error-primary', '#c0392b') },
  link: { color: v('link', 'link', 'LinkText'), wordBreak: 'break-all', cursor: 'pointer' },
  todo: { display: 'flex', gap: 6, alignItems: 'baseline', listStyle: 'none', fontSize: 13 },
  todoList: { margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  button: {
    font: 'inherit',
    fontSize: 12,
    color: 'inherit',
    background: 'transparent',
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: '1px 6px',
    cursor: 'pointer',
    alignSelf: 'flex-start',
  },
} satisfies Record<string, React.CSSProperties>;

/** Lines a body shows before "Show all". */
export const BODY_LINES = 40;

function StateTag(props: { state: RowState }): React.ReactElement | null {
  const label = STATE_LABEL[props.state];
  if (!label) return null;
  return (
    <span
      style={props.state === 'error' ? toolCss.error : toolCss.state}
      data-raw-agent="tool-state"
      data-state={props.state}
    >
      {label}
    </span>
  );
}

/** The row frame: a one-line head (title, summary, extra, state) and a body shown on click. */
export function ToolRow(props: {
  view: string;
  call: ToolViewProps;
  title: string;
  summary?: React.ReactNode;
  extra?: React.ReactNode;
  /** Start expanded (a checklist, a question). */
  open?: boolean;
  children?: React.ReactNode;
}): React.ReactElement {
  const state = rowState(props.call);
  const [open, setOpen] = React.useState(props.open === true);
  const hasBody = props.children !== undefined && props.children !== null && props.children !== false;
  return (
    <div style={toolCss.row} data-raw-agent={`tool-${props.view}`} data-tool={props.call.toolName}>
      <button
        type="button"
        style={toolCss.head}
        aria-expanded={hasBody ? open : undefined}
        onClick={() => hasBody && setOpen(!open)}
        data-raw-agent="tool-head"
      >
        <span style={toolCss.title}>{props.title}</span>
        {props.summary !== undefined && props.summary !== '' && <span style={toolCss.summary}>{props.summary}</span>}
        {props.extra}
        <StateTag state={state} />
      </button>
      {hasBody && open && (
        <div style={toolCss.body} data-raw-agent="tool-body">
          {props.children}
        </div>
      )}
    </div>
  );
}

/** Plain text in a box, clipped to BODY_LINES with "Show all". */
export function TextBox(props: { text: string; label?: string; error?: boolean; testId?: string }): React.ReactElement {
  const [all, setAll] = React.useState(false);
  const lines = splitLines(props.text);
  const shown = all ? lines : lines.slice(0, BODY_LINES);
  const hidden = lines.length - shown.length;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {props.label && <span style={toolCss.label}>{props.label}</span>}
      <pre
        style={props.error ? { ...toolCss.pre, ...toolCss.errorText } : toolCss.pre}
        data-raw-agent={props.testId ?? 'tool-text'}
      >
        {shown.join('\n') || '\u00a0'}
      </pre>
      {hidden > 0 && (
        <button type="button" style={toolCss.button} onClick={() => setAll(true)} data-raw-agent="tool-show-all">
          Show all ({hidden} more {hidden === 1 ? 'line' : 'lines'})
        </button>
      )}
    </div>
  );
}

/** The result's text, or nothing while there is none. */
function ResultBox(props: { call: ToolViewProps; label?: string }): React.ReactElement | null {
  const r = props.call.result;
  if (!r) return null;
  const note = r.images > 0 ? `${r.images === 1 ? 'An image' : `${r.images} images`} (shown by the host).` : undefined;
  if (r.text === '' && note) return <span style={toolCss.label}>{note}</span>;
  return (
    <>
      <TextBox text={r.text} error={r.isError} testId="tool-result" {...(props.label ? { label: props.label } : {})} />
      {note && <span style={toolCss.label}>{note}</span>}
    </>
  );
}

/** A path that opens in the host's preview when it can. */
function PathLink(props: { call: ToolViewProps; path: string; line?: number }): React.ReactElement {
  const { call, path } = props;
  const shown = displayPath(path, call.cwd, call.home);
  if (!call.openFile) return <span>{shown}</span>;
  return (
    <span
      role="link"
      tabIndex={0}
      style={toolCss.link}
      title={path}
      data-raw-agent="tool-path"
      onClick={(e) => {
        e.stopPropagation();
        call.openFile?.(path, props.line);
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter') return;
        e.stopPropagation();
        call.openFile?.(path, props.line);
      }}
    >
      {shown}
    </span>
  );
}

/** A numbered diff (Leftover M2: line numbers), with unchanged runs folded. */
export function DiffBox(props: { lines: readonly DiffLine[] }): React.ReactElement {
  const [full, setFull] = React.useState(false);
  const changed = props.lines.some((l) => l.op !== ' ');
  const rows = full || !changed ? props.lines : diffHunks(props.lines);
  const width = String(props.lines.reduce((m, l) => Math.max(m, l.old ?? 0, l.new ?? 0), 0)).length;
  const numbered = props.lines.some((l) => l.old !== undefined || l.new !== undefined);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <pre style={toolCss.pre} data-raw-agent="tool-diff">
        {rows.map((l, i) =>
          l.op === '…' ? (
            <div key={i} style={toolCss.gap}>{`⋯ ${l.count} unchanged ${l.count === 1 ? 'line' : 'lines'}`}</div>
          ) : (
            <div key={i} style={l.op === '+' ? toolCss.add : l.op === '-' ? toolCss.del : undefined} data-op={l.op}>
              {numbered && (
                <span style={toolCss.num} data-raw-agent="tool-diff-num" aria-hidden="true">
                  {`${l.old ?? ''}`.padStart(width)} {`${l.new ?? ''}`.padStart(width)}{' '}
                </span>
              )}
              {`${l.op} ${l.text}`}
            </div>
          ),
        )}
      </pre>
      {rows.length < props.lines.length || full ? (
        <button type="button" style={toolCss.button} onClick={() => setFull(!full)}>
          {full ? 'Show only the changes' : 'Show the whole edit'}
        </button>
      ) : null}
    </div>
  );
}

function Counts(props: { added: number; removed: number }): React.ReactElement | null {
  if (props.added === 0 && props.removed === 0) return null;
  return (
    <span style={toolCss.counts} data-raw-agent="tool-counts">
      <span style={toolCss.addCount}>+{props.added}</span> <span style={toolCss.delCount}>−{props.removed}</span>
    </span>
  );
}

// ---- the views -----------------------------------------------------------------------------------

export function BashView(call: ToolViewProps): React.ReactElement {
  const m = bashModel(call.input);
  return (
    <ToolRow
      view="bash"
      call={call}
      title="Bash"
      summary={m.description ?? firstLine(m.command)}
      extra={m.background ? <span style={toolCss.state}>background</span> : undefined}
    >
      {m.command !== '' && <TextBox text={`$ ${m.command}`} testId="tool-command" />}
      <ResultBox call={call} label={m.background ? 'Started in the background' : 'Output'} />
    </ToolRow>
  );
}

export function ReadView(call: ToolViewProps): React.ReactElement {
  const m = readModel(call.input);
  const r = call.result;
  const lines = r && !r.isError ? readLines(r.text) : [];
  const numbered = lines.some((l) => l.n !== undefined);
  return (
    <ToolRow
      view="read"
      call={call}
      title="Read"
      summary={
        m.path ? (
          <>
            <PathLink call={call} path={m.path} {...(m.line !== undefined ? { line: m.line } : {})} />
            {m.range ? ` · ${m.range}` : ''}
          </>
        ) : undefined
      }
      extra={numbered ? <span style={toolCss.state}>{`${lines.length} lines`}</span> : undefined}
    >
      {r && numbered ? (
        <TextBox
          text={lines.map((l) => (l.n !== undefined ? `${String(l.n).padStart(5)}  ${l.text}` : l.text)).join('\n')}
          testId="tool-result"
        />
      ) : (
        <ResultBox call={call} />
      )}
    </ToolRow>
  );
}

export function EditView(call: ToolViewProps): React.ReactElement {
  const m = editModel(call.input);
  const failed = call.result?.isError === true;
  return (
    <ToolRow
      view="edit"
      call={call}
      title={call.toolName === 'MultiEdit' ? 'MultiEdit' : 'Edit'}
      summary={m.path ? <PathLink call={call} path={m.path} /> : undefined}
      extra={
        <>
          {!failed && <Counts added={m.added} removed={m.removed} />}
          {m.edits > 1 && <span style={toolCss.state}>{`${m.edits} edits`}</span>}
        </>
      }
    >
      {m.replaceAll && <span style={toolCss.label}>Every match is replaced.</span>}
      {m.lines.length > 0 && <DiffBox lines={m.lines} />}
      {m.lines.length > 0 && <span style={toolCss.label}>Line numbers count from the start of the edited text.</span>}
      {failed && <ResultBox call={call} />}
    </ToolRow>
  );
}

export function WriteView(call: ToolViewProps): React.ReactElement {
  const m = writeModel(call.input);
  const failed = call.result?.isError === true;
  return (
    <ToolRow
      view="write"
      call={call}
      title="Write"
      summary={m.path ? <PathLink call={call} path={m.path} /> : undefined}
      extra={<span style={toolCss.state}>{`${m.lines.length} ${m.lines.length === 1 ? 'line' : 'lines'}`}</span>}
    >
      {m.lines.length > 0 && <DiffBox lines={m.lines} />}
      {failed && <ResultBox call={call} />}
    </ToolRow>
  );
}

function SearchView(props: { call: ToolViewProps; title: string; noun: string; view: string }): React.ReactElement {
  const { call } = props;
  const r = call.result;
  const count = r && !r.isError ? resultCount(r.text) : undefined;
  return (
    <ToolRow
      view={props.view}
      call={call}
      title={props.title}
      summary={searchSummary(call.input, call.cwd, call.home)}
      extra={count !== undefined ? <span style={toolCss.state}>{`${count} ${props.noun}`}</span> : undefined}
    >
      <ResultBox call={call} />
    </ToolRow>
  );
}

export const GrepView = (call: ToolViewProps): React.ReactElement => (
  <SearchView call={call} title="Grep" noun="lines" view="grep" />
);
export const GlobView = (call: ToolViewProps): React.ReactElement => (
  <SearchView call={call} title="Glob" noun="files" view="glob" />
);

export function AgentView(call: ToolViewProps): React.ReactElement {
  const m = agentModel(call.input);
  const who = m.name ?? m.agentType ?? 'agent';
  return (
    <ToolRow
      view="agent"
      call={call}
      title={call.toolName === 'Task' ? 'Task' : 'Agent'}
      summary={`${who}${m.description ? ` · ${m.description}` : ''}`}
      extra={m.background ? <span style={toolCss.state}>background</span> : undefined}
    >
      {m.prompt && <TextBox text={m.prompt} label="Task" testId="tool-prompt" />}
      <ResultBox call={call} label="Result" />
    </ToolRow>
  );
}

const TODO_MARK: Record<string, string> = { completed: '☑', in_progress: '◐', pending: '☐' };

export function TodoWriteView(call: ToolViewProps): React.ReactElement {
  const items = todoItems(call.input);
  return (
    <ToolRow view="todo" call={call} title="Tasks" summary={todoSummary(items)} open>
      {items.length > 0 && (
        <ul style={toolCss.todoList} data-raw-agent="tool-checklist">
          {items.map((t, i) => (
            <li
              key={i}
              style={{
                ...toolCss.todo,
                ...(t.status === 'completed' ? { textDecoration: 'line-through', color: muted } : {}),
                ...(t.status === 'in_progress' ? { fontWeight: 600 } : {}),
              }}
              data-status={t.status}
            >
              <span aria-hidden="true">{TODO_MARK[t.status] ?? '☐'}</span>
              <span>{t.text}</span>
            </li>
          ))}
        </ul>
      )}
      {call.result?.isError === true && <ResultBox call={call} />}
    </ToolRow>
  );
}

export function WebFetchView(call: ToolViewProps): React.ReactElement {
  const url = safeUrl(call.input.url);
  const raw = str(call.input.url) ? call.input.url : '';
  return (
    <ToolRow
      view="web-fetch"
      call={call}
      title="Fetch"
      summary={
        url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            style={toolCss.link}
            onClick={(e) => e.stopPropagation()}
            data-raw-agent="tool-url"
          >
            {url}
          </a>
        ) : (
          raw
        )
      }
    >
      {str(call.input.prompt) && call.input.prompt !== '' && <TextBox text={call.input.prompt} label="Prompt" />}
      <ResultBox call={call} />
    </ToolRow>
  );
}

export function WebSearchView(call: ToolViewProps): React.ReactElement {
  const q = str(call.input.query) ? call.input.query : '';
  const domains = Array.isArray(call.input.allowed_domains) ? call.input.allowed_domains.filter(str) : [];
  return (
    <ToolRow view="web-search" call={call} title="Web search" summary={q}>
      {domains.length > 0 && <span style={toolCss.label}>Only: {domains.join(', ')}</span>}
      <ResultBox call={call} />
    </ToolRow>
  );
}

/** R7.5, D56: the card names the skill. */
export function SkillView(call: ToolViewProps): React.ReactElement {
  const name = skillName(call.input);
  const args = str(call.input.args) && call.input.args.trim() !== '' ? call.input.args : undefined;
  return (
    <ToolRow
      view="skill"
      call={call}
      title="Skill"
      summary={
        name ? (
          <>
            <span data-raw-agent="tool-skill-name" style={{ fontFamily: mono }}>
              {name}
            </span>
            {args ? ` ${firstLine(args, 80)}` : ''}
          </>
        ) : undefined
      }
    >
      {args && <TextBox text={args} label="Arguments" />}
      <ResultBox call={call} />
    </ToolRow>
  );
}

export function ExitPlanModeView(call: ToolViewProps): React.ReactElement {
  const plan = str(call.input.plan) ? call.input.plan : '';
  return (
    <ToolRow view="plan" call={call} title="Plan" summary={plan ? planTitle(plan) : undefined}>
      {plan !== '' && <TextBox text={plan} testId="tool-plan" />}
      <ResultBox call={call} label="Answer" />
    </ToolRow>
  );
}

export function AskUserQuestionView(call: ToolViewProps): React.ReactElement {
  const qs = questionModels(call.input);
  return (
    <ToolRow
      view="question"
      call={call}
      title="Question"
      summary={qs.length === 1 ? qs[0]!.question : qs.length > 1 ? `${qs.length} questions` : undefined}
    >
      {qs.map((q, i) => (
        <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 2 }} data-raw-agent="tool-question">
          {q.header && <span style={toolCss.label}>{q.header}</span>}
          <span>{q.question}</span>
          {q.options.length > 0 && (
            <span style={toolCss.label}>
              {q.multiSelect ? 'Pick any: ' : 'Pick one: '}
              {q.options.join(' · ')}
            </span>
          )}
        </div>
      ))}
      <ResultBox call={call} label="Answers" />
    </ToolRow>
  );
}
