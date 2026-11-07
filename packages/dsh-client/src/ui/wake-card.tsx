// D26: the visible trigger of a wake turn. The Host writes it as a native `developer/message`
// (never a user message, rule 3); this card shows it at the start of the turn, outside the turn's
// process fold, so the user sees why the agent continued on its own.

import * as React from 'react';
import { wakeHeading, type WakeTrigger } from '../agents-model.js';
import { css } from './style.js';

const muted = 'var(--raw-agent-muted, var(--dsw-alias-label-secondary, GrayText))';
const border = 'var(--raw-agent-border, var(--dsw-alias-border-l2, rgba(128,128,128,0.35)))';

export function WakeTriggerCard(props: { trigger: WakeTrigger }): React.ReactElement {
  const t = props.trigger;
  const [open, setOpen] = React.useState(false);
  const date = new Date(t.time);
  const time = Number.isFinite(date.getTime())
    ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '';
  const items = t.items;
  return (
    <section
      data-raw-agent="wake-trigger"
      style={{
        border: `1px dashed ${border}`,
        borderRadius: 10,
        padding: '6px 10px',
        margin: '6px 0',
        fontSize: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600 }}>{wakeHeading(t)}</span>
        {items.length === 1 && <span style={{ color: muted }}>after: {items[0]}</span>}
        {items.length > 1 && (
          <button type="button" style={css.button} aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : `After ${items.length} background tasks ended`}
          </button>
        )}
        {time !== '' && (
          <time dateTime={date.toISOString()} style={{ color: muted, marginLeft: 'auto' }}>
            {time}
          </time>
        )}
      </div>
      {items.length === 0 && t.text !== wakeHeading(t) && <span style={{ color: muted }}>{t.text}</span>}
      {open && items.length > 1 && (
        <ul style={{ margin: 0, paddingLeft: 18, color: muted }}>
          {items.map((i, n) => (
            <li key={n}>{i}</li>
          ))}
        </ul>
      )}
      <span style={{ color: muted, fontSize: 11 }}>
        Nobody typed a message: the agent started this turn by itself. This note is not sent to it.
      </span>
    </section>
  );
}
