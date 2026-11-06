// Inline styles. Restyle points (D67): `--raw-agent-*` CSS variables, then DSH theme aliases
// (`--dsw-alias-*`, names **unverified** against the live theme), then system colours.

import type * as React from 'react';

const v = (name: string, alias: string, fallback: string) =>
  `var(--raw-agent-${name}, var(--dsw-alias-${alias}, ${fallback}))`;

const surface = v('surface', 'surface-elevated', 'Canvas');
const text = v('text', 'text-primary', 'CanvasText');
const muted = v('muted', 'text-secondary', 'GrayText');
const border = v('border', 'border-default', 'rgba(128,128,128,0.35)');

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
  error: { color: v('danger', 'text-danger', '#c0392b'), fontSize: 12, margin: '6px 0' },
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
    background: v('secret', 'surface-muted', 'rgba(128,128,128,0.2)'),
    border: 'none',
    borderRadius: 3,
    padding: '0 2px',
    cursor: 'pointer',
  },
  status: { fontSize: 11, color: muted },
  ask: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    flexWrap: 'wrap',
    fontSize: 12,
    color: text,
    border: `1px solid ${v('ask-border', 'border-warning', 'orange')}`,
    borderRadius: 6,
    padding: '2px 6px',
    flexBasis: '100%',
  },
  askDetail: {
    fontSize: 11,
    color: muted,
    maxWidth: 480,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
} satisfies Record<string, React.CSSProperties>;
