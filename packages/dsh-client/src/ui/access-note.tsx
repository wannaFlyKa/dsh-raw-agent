// 0.1.1: a note under DSH's own access setting (Settings > General): DSH's file access and
// approval level does not control our agents. Nothing of DSH's is hidden or changed; the note is
// a row of its own in DSH's General list.

import * as React from 'react';

const tok = (alias: string, fallback: string) => `var(--dsw-alias-${alias}, ${fallback})`;

export function accessNoteText(names: readonly string[]): { title: string; detail: string } {
  const who = names.length > 0 ? names.join(', ') : 'Agent';
  return {
    title: `${who} sessions do not use this access setting`,
    detail:
      `DSH's file access and approval level applies to DSH's own agent. In ${who} sessions the agent ` +
      `runs its own tools under its own permission mode: use the mode chip in the composer or /permission there. ` +
      `For full access pick bypassPermissions (needs the plugin option allowDangerouslySkipPermissions) or Auto.`,
  };
}

export function AccessNote(props: { agentNames?: readonly string[] }): React.ReactElement {
  const t = accessNoteText(props.agentNames ?? []);
  return (
    <div
      data-raw-agent="access-note"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '12px 0',
        borderBottom: `.5px solid ${tok('border-l2', 'rgba(128,128,128,0.25)')}`,
      }}
    >
      <span style={{ color: tok('label-secondary', 'CanvasText'), fontSize: 13, lineHeight: '20px' }}>{t.title}</span>
      <span style={{ color: tok('label-tertiary', 'GrayText'), fontSize: 12, lineHeight: '18px' }}>{t.detail}</span>
    </div>
  );
}
