// Inline styles. Restyle points (D67): `--raw-agent-*` CSS variables, then DSH theme aliases
// (`--dsw-alias-*`, the names DSH 0.2.2-rc.1's theme defines for light and dark: 0.1.1), then
// system colours.

import type * as React from 'react';

const v = (name: string, alias: string, fallback: string) =>
  `var(--raw-agent-${name}, var(--dsw-alias-${alias}, ${fallback}))`;

const surface = v('surface', 'bg-layer-1', 'Canvas');
const text = v('text', 'label-primary', 'CanvasText');
const muted = v('muted', 'label-secondary', 'GrayText');
const border = v('border', 'border-l2', 'rgba(128,128,128,0.35)');

export const css = {
  // `flex: 1 1 0%` + `minWidth: 0`: the bar takes the space left in DSH's composer tool row and
  // wraps inside it, so DSH's own items (the mode seat) keep their width and are never drawn over
  // our buttons (live M1: the seat label covered an ask's first button).
  bar: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
    font: 'inherit',
    flex: '1 1 0%',
    minWidth: 0,
  },
  select: {
    font: 'inherit',
    fontSize: 12,
    maxWidth: 220,
    color: text,
    background: 'transparent',
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: '1px 4px',
  },
  button: {
    font: 'inherit',
    fontSize: 12,
    color: text,
    background: 'transparent',
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: '1px 6px',
    cursor: 'pointer',
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    zIndex: 1000,
    background: 'rgba(0,0,0,0.3)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dialog: {
    background: surface,
    color: text,
    border: `1px solid ${border}`,
    borderRadius: 10,
    width: 'min(760px, 94vw)',
    maxHeight: '86vh',
    overflow: 'auto',
    padding: 16,
    fontSize: 13,
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  hint: { color: muted, fontSize: 12, margin: '6px 0' },
  error: { color: v('danger', 'state-error-primary', '#c0392b'), fontSize: 12, margin: '6px 0' },
  file: { borderTop: `1px solid ${border}`, padding: '10px 0' },
  fileHead: { display: 'flex', justifyContent: 'space-between' },
  path: { fontSize: 12, wordBreak: 'break-all', color: muted },
  badge: { fontSize: 11, color: muted, border: `1px solid ${border}`, borderRadius: 4, padding: '0 4px' },
  row: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 6 },
  pre: {
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: 8,
    margin: '8px 0 0',
    maxHeight: 360,
    overflow: 'auto',
  },
  secret: {
    font: 'inherit',
    color: 'inherit',
    background: v('secret', 'markdown-code-block', 'rgba(128,128,128,0.2)'),
    border: 'none',
    borderRadius: 3,
    padding: '0 2px',
    cursor: 'pointer',
  },
  status: { fontSize: 11, color: muted },
  // The inline cards (no composer takeover): a full row of the controls bar.
  ask: { display: 'block', flexBasis: '100%', minWidth: 0 },
  askDetail: {
    fontSize: 11,
    color: muted,
    maxWidth: 480,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // Interaction cards (D39-D43). They take over the composer, so they size to its width and
  // scroll inside themselves; nothing is clipped without a "Show all" control.
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    color: text,
    background: surface,
    border: `1px solid ${v('ask-border', 'state-warn-primary', 'orange')}`,
    borderRadius: 12,
    padding: 12,
    fontSize: 13,
    maxHeight: '70vh',
    overflow: 'auto',
    boxSizing: 'border-box',
    width: '100%',
  },
  cardHead: { display: 'flex', flexDirection: 'column', gap: 2 },
  cardWho: { fontSize: 12, color: muted },
  cardTitle: { fontWeight: 600, wordBreak: 'break-word', whiteSpace: 'pre-wrap' },
  cardNote: { fontSize: 12, color: muted, wordBreak: 'break-word', whiteSpace: 'pre-wrap' },
  cardError: { fontSize: 12, color: v('danger', 'state-error-primary', '#c0392b') },
  choiceRow: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'flex-start' },
  choiceCol: { display: 'flex', flexDirection: 'column', gap: 6 },
  primary: {
    font: 'inherit',
    fontSize: 12,
    color: v('on-accent', 'label-primary-foreground', 'HighlightText'),
    background: v('accent', 'button-primary-fill', 'Highlight'),
    border: `1px solid ${v('accent', 'button-primary-fill', 'Highlight')}`,
    borderRadius: 6,
    padding: '3px 10px',
    cursor: 'pointer',
    textAlign: 'left',
  },
  choice: {
    font: 'inherit',
    fontSize: 12,
    color: text,
    background: 'transparent',
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: '3px 10px',
    cursor: 'pointer',
    textAlign: 'left',
    textDecoration: 'none',
    display: 'inline-block',
  },
  always: { display: 'flex', flexDirection: 'column', gap: 2, maxWidth: '100%' },
  effects: { fontSize: 11, color: muted, margin: '0 0 0 12px', padding: 0, wordBreak: 'break-word' },
  previewBox: {
    fontFamily: 'var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: 8,
    margin: 0,
    overflow: 'auto',
  },
  diffAdd: { background: v('diff-add', 'code-diff-added', 'rgba(46,160,67,0.18)') },
  diffDel: { background: v('diff-del', 'code-diff-deleted', 'rgba(248,81,73,0.18)') },
  diffGap: { color: muted },
  diffNum: { color: muted, userSelect: 'none', whiteSpace: 'pre' },
  textarea: {
    font: 'inherit',
    fontSize: 12,
    color: text,
    background: 'transparent',
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: 6,
    minHeight: 36,
    width: '100%',
    boxSizing: 'border-box',
    resize: 'vertical',
  },
  input: {
    font: 'inherit',
    fontSize: 12,
    color: text,
    background: 'transparent',
    border: `1px solid ${border}`,
    borderRadius: 6,
    padding: '3px 6px',
    boxSizing: 'border-box',
    maxWidth: '100%',
  },
  question: { display: 'flex', flexDirection: 'column', gap: 6, borderTop: `1px solid ${border}`, paddingTop: 8 },
  questionBody: { display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' },
  options: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px', minWidth: 0 },
  option: { display: 'flex', gap: 6, alignItems: 'flex-start', cursor: 'pointer' },
  optionDesc: { display: 'block', fontSize: 11, color: muted },
  questionPreview: { flex: '1 1 260px', minWidth: 0, maxHeight: 320 },
  chip: {
    fontSize: 11,
    color: muted,
    border: `1px solid ${border}`,
    borderRadius: 4,
    padding: '0 4px',
    alignSelf: 'flex-start',
  },
  field: { display: 'flex', flexDirection: 'column', gap: 2 },
  /** A boolean field: the box sits at the start of its label, not stretched across the row. */
  fieldCheck: { display: 'flex', flexDirection: 'row', gap: 6, alignItems: 'center', cursor: 'pointer' },
  checkbox: { margin: 0, flex: 'none', alignSelf: 'center' },
  /** The number key of a choice, before its label. */
  keyHint: { opacity: 0.6, marginRight: 6, fontVariantNumeric: 'tabular-nums' },
  link: { color: v('link', 'link', 'LinkText'), wordBreak: 'break-all' },
  url: { fontSize: 12, wordBreak: 'break-all', whiteSpace: 'pre-wrap' },
  more: { display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11, color: muted, alignItems: 'center' },
  inlineCode: {
    fontFamily: 'var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    fontSize: '0.92em',
    background: v('code-bg', 'markdown-code-block', 'rgba(128,128,128,0.15)'),
    borderRadius: 3,
    padding: '0 3px',
  },
  mdHeading: { fontWeight: 600, margin: '8px 0 4px' },
  mdBlock: { margin: '4px 0', lineHeight: 1.45 },
  mdList: { margin: '4px 0', paddingLeft: 20, lineHeight: 1.45 },
  mdCode: {
    fontFamily: 'var(--raw-agent-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    fontSize: 12,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    background: v('code-bg', 'markdown-code-block', 'rgba(128,128,128,0.12)'),
    borderRadius: 6,
    padding: 8,
    margin: '6px 0',
  },
  mdQuote: { margin: '4px 0', paddingLeft: 10, borderLeft: `3px solid ${border}`, color: muted },
  mdRule: { border: 'none', borderTop: `1px solid ${border}`, margin: '8px 0' },
  mdTable: { borderCollapse: 'collapse', margin: '6px 0', fontSize: 12 },
  mdCell: { border: `1px solid ${border}`, padding: '2px 6px', textAlign: 'left', verticalAlign: 'top' },
} satisfies Record<string, React.CSSProperties>;

/** 0.1.1: the class of our compact chips (the session pickers and the row's text buttons). */
export const CHIP_CLASS = 'raw-agent-chip';
export const STATUS_CLASS = 'raw-agent-status';

// The chip colours, by mode risk. Each text colour mixes the DSH state token with DSH's primary
// label colour, so it stays readable in the light theme (dark label) and the dark theme (light label).
const tok = (name: string, alias: string, fallback: string) =>
  `var(--raw-agent-${name}, var(--dsw-alias-${alias}, ${fallback}))`;
const riskTone = {
  plan: tok('chip-plan', 'state-business-primary', '#4176e6'),
  caution: tok('chip-caution', 'state-warn-primary', '#f59e0b'),
  danger: tok('chip-danger', 'state-error-primary', '#ec1313'),
};
const label = 'var(--dsw-alias-label-primary, CanvasText)';
const riskRule = (risk: keyof typeof riskTone, textShare: number, fill: number) =>
  `.${CHIP_CLASS}[data-risk="${risk}"]{color:color-mix(in srgb, ${riskTone[risk]} ${textShare}%, ${label});` +
  `background:color-mix(in srgb, ${riskTone[risk]} ${fill}%, transparent);` +
  `box-shadow:inset 0 0 0 1px color-mix(in srgb, ${riskTone[risk]} 40%, transparent)}`;

/**
 * The chip style sheet, matching DSH's own composer pills (`dsh-client-ui-chat` StatsPills 0.2.2-rc.1:
 * no border, `--dsw-radius-sm`, `--dsw-alias-label-tertiary` text, `--dsw-alias-interactive-bg-hover`
 * on hover, 1px 8px padding, the secondary content size minus 1px). A native `<select>` lies on top
 * of each picker chip, invisible, so the browser's list, keyboard use and `showPicker` stay.
 */
export const CHIP_CSS = [
  `.${CHIP_CLASS}{position:relative;display:inline-flex;align-items:center;gap:4px;box-sizing:border-box;` +
    `max-width:220px;min-width:0;padding:1px 8px;border:none;border-radius:var(--raw-agent-chip-radius, var(--dsw-radius-sm, 8px));` +
    `background:transparent;color:${tok('chip-text', 'label-tertiary', 'GrayText')};` +
    `font:inherit;font-size:calc(var(--dsh-content-font-size-secondary, 13px) - 1px);` +
    `line-height:calc(20px + var(--dsh-content-font-delta-secondary, 0px));white-space:nowrap;cursor:pointer;` +
    `font-variant-numeric:tabular-nums}`,
  `.${CHIP_CLASS}:hover,.${CHIP_CLASS}:focus-within{background:${tok('chip-hover', 'interactive-bg-hover', 'rgba(128,128,128,0.15)')};` +
    `color:${tok('chip-text-hover', 'label-secondary', 'CanvasText')}}`,
  `.${CHIP_CLASS}:focus-visible,.${CHIP_CLASS}:has(select:focus-visible){outline:var(--dsw-focus-ring-width, 2px) solid ` +
    `var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, Highlight));outline-offset:1px}`,
  `.${CHIP_CLASS}[data-disabled]{opacity:.55;cursor:default}`,
  `.${CHIP_CLASS} select{position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;opacity:0;cursor:inherit;font:inherit;` +
    `color:CanvasText;background:Canvas;border:none;appearance:none}`,
  `.${CHIP_CLASS} [data-chip-text]{overflow:hidden;text-overflow:ellipsis;min-width:0}`,
  `.${CHIP_CLASS} [data-chip-dot]{flex:none;width:5px;height:5px;border-radius:50%;background:currentColor;opacity:.55}`,
  `.${CHIP_CLASS} svg{flex:none;width:10px;height:10px;opacity:.7}`,
  `.${CHIP_CLASS}[data-session-mode]{font-weight:600;color:color-mix(in srgb, ${tok('chip-session-mode', 'state-done-primary', '#7c3aed')} 70%, ${label})}`,
  riskRule('plan', 75, 12),
  riskRule('caution', 55, 16),
  riskRule('danger', 70, 14),
  // The status line: shown, then faded out of the row; screen readers still have it (aria-live).
  `.${STATUS_CLASS}{font-size:11px;color:${tok('muted', 'label-tertiary', 'GrayText')};transition:opacity .4s ease}`,
  `.${STATUS_CLASS}[data-level="error"]{color:${tok('danger', 'state-error-primary', '#c0392b')}}`,
  `.${STATUS_CLASS}[data-fading]{opacity:0}`,
  `.${STATUS_CLASS}[data-faded]{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);` +
    `clip-path:inset(50%);white-space:nowrap;opacity:0}`,
].join('\n');
