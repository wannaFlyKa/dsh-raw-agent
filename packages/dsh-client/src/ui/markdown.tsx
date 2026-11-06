// Safe Markdown for plans and question previews: the parsed blocks of ../asks-model.ts become
// React elements. No raw HTML is ever inserted; links open only for http(s) URLs.

import * as React from 'react';
import { parseMarkdown, type Block, type Inline } from '../asks-model.js';
import { css } from './style.js';

function inline(nodes: readonly Inline[], key = ''): React.ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return <React.Fragment key={k}>{n.text}</React.Fragment>;
      case 'code':
        return (
          <code key={k} style={css.inlineCode}>
            {n.text}
          </code>
        );
      case 'strong':
        return <strong key={k}>{inline(n.children, `${k}.`)}</strong>;
      case 'em':
        return <em key={k}>{inline(n.children, `${k}.`)}</em>;
      case 'link':
        return n.href ? (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer" style={css.link}>
            {inline(n.children, `${k}.`)}
          </a>
        ) : (
          <span key={k}>{inline(n.children, `${k}.`)}</span>
        );
    }
  });
}

function block(b: Block, i: number): React.ReactNode {
  switch (b.t) {
    case 'heading': {
      const size = [0, 16, 15, 14, 13, 13, 13][b.level] ?? 13;
      return (
        <div key={i} role="heading" aria-level={b.level} style={{ ...css.mdHeading, fontSize: size }}>
          {inline(b.children)}
        </div>
      );
    }
    case 'paragraph':
      return (
        <p key={i} style={css.mdBlock}>
          {inline(b.children)}
        </p>
      );
    case 'list': {
      const items = b.items.map((it, j) => <li key={j}>{inline(it, `${j}.`)}</li>);
      return b.ordered ? (
        <ol key={i} style={css.mdList}>
          {items}
        </ol>
      ) : (
        <ul key={i} style={css.mdList}>
          {items}
        </ul>
      );
    }
    case 'code':
      return (
        <pre key={i} style={css.mdCode} data-lang={b.lang}>
          {b.text}
        </pre>
      );
    case 'quote':
      return (
        <blockquote key={i} style={css.mdQuote}>
          {inline(b.children)}
        </blockquote>
      );
    case 'rule':
      return <hr key={i} style={css.mdRule} />;
    case 'table':
      return (
        <table key={i} style={css.mdTable}>
          <tbody>
            {b.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) =>
                  r === 0 ? (
                    <th key={c} style={css.mdCell}>
                      {inline(cell, `${r}.${c}.`)}
                    </th>
                  ) : (
                    <td key={c} style={css.mdCell}>
                      {inline(cell, `${r}.${c}.`)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

export function Markdown(props: { text: string; testId?: string }): React.ReactElement {
  const blocks = React.useMemo(() => parseMarkdown(props.text), [props.text]);
  return <div data-raw-agent={props.testId ?? 'markdown'}>{blocks.map(block)}</div>;
}
