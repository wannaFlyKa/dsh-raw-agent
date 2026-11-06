// Line diffs for previews and tool views (shared by dsh-client and the tool view packs). Pure.

export interface DiffLine {
  op: ' ' | '-' | '+';
  text: string;
  /** Line number in the old text (unchanged and removed lines), counted from `oldStart`. */
  old?: number;
  /** Line number in the new text (unchanged and added lines), counted from `newStart`. */
  new?: number;
}

/** A run of unchanged lines folded away. */
export interface DiffGap {
  op: '…';
  count: number;
}

/** Split into lines; a trailing newline makes no empty last line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Above this many line pairs the diff is shown as "all removed, then all added". */
const MAX_DIFF_CELLS = 4_000_000;

/** A line diff (longest common subsequence). Exact for normal edit sizes. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  // Trim the common head and tail first: most edits touch a few lines.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: DiffLine[] = a.slice(0, head).map((text) => ({ op: ' ', text }));
  const ma = a.slice(head, a.length - tail);
  const mb = b.slice(head, b.length - tail);
  if (ma.length * mb.length > MAX_DIFF_CELLS) {
    for (const text of ma) out.push({ op: '-', text });
    for (const text of mb) out.push({ op: '+', text });
  } else {
    const n = ma.length;
    const m = mb.length;
    const len: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        len[i]![j] = ma[i] === mb[j] ? len[i + 1]![j + 1]! + 1 : Math.max(len[i + 1]![j]!, len[i]![j + 1]!);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        out.push({ op: ' ', text: ma[i]! });
        i++;
        j++;
      } else if (len[i + 1]![j]! >= len[i]![j + 1]!) out.push({ op: '-', text: ma[i++]! });
      else out.push({ op: '+', text: mb[j++]! });
    }
    while (i < n) out.push({ op: '-', text: ma[i++]! });
    while (j < m) out.push({ op: '+', text: mb[j++]! });
  }
  for (const text of a.slice(a.length - tail)) out.push({ op: ' ', text });
  return out;
}

/**
 * Give every line its old and new line number (Leftover M2: "Edit diff without line numbers").
 * The numbers start at `oldStart` / `newStart`; with the default 1 they count from the start of
 * the edited text, which is all an edit's own input tells.
 */
export function numberDiff(lines: readonly DiffLine[], oldStart = 1, newStart = 1): DiffLine[] {
  let o = oldStart;
  let n = newStart;
  return lines.map((l) => {
    if (l.op === ' ') return { ...l, old: o++, new: n++ };
    if (l.op === '-') return { op: l.op, text: l.text, old: o++ };
    return { op: l.op, text: l.text, new: n++ };
  });
}

/** Keep `context` unchanged lines around each change; the rest collapses into a "…" line. */
export function diffHunks(lines: readonly DiffLine[], context = 3): Array<DiffLine | DiffGap> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: Array<DiffLine | DiffGap> = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (keep[i]) {
      if (skipped > 0) out.push({ op: '…', count: skipped });
      skipped = 0;
      out.push(l);
    } else skipped++;
  });
  if (skipped > 0) out.push({ op: '…', count: skipped });
  return out;
}

/** Added and removed line counts. */
export function diffCounts(lines: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === '+') added++;
    else if (l.op === '-') removed++;
  }
  return { added, removed };
}

/** The diff as plain text (for Copy). */
export function diffText(lines: readonly DiffLine[]): string {
  return lines.map((l) => `${l.op}${l.text}`).join('\n');
}
