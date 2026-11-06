// M6 client-commands: the Claude tool views (D19, D56, R7.5) and their pure models.

import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolViewProps } from '@dsh-raw-agent/core';
import {
  CLAUDE_TOOL_VIEWS,
  DiffBox,
  bashModel,
  displayPath,
  editModel,
  planTitle,
  questionModels,
  readLines,
  readModel,
  rowState,
  safeUrl,
  searchSummary,
  skillName,
  todoItems,
  todoSummary,
  toolViewPack,
  writeModel,
} from '@dsh-raw-agent/views-claude';

const call = (toolName: string, input: Record<string, unknown>, over: Partial<ToolViewProps> = {}): ToolViewProps => ({
  callId: 'c1',
  toolName,
  phase: 'done',
  input,
  result: { text: 'ok', isError: false, images: 0 },
  cwd: '/work/repo',
  home: '/home/u',
  ...over,
});

const render = (name: string, p: ToolViewProps) =>
  renderToStaticMarkup(React.createElement(CLAUDE_TOOL_VIEWS[name] as React.FC<ToolViewProps>, p));

describe('the Claude view pack', () => {
  it('registers the Claude names only, byte for byte, and no MCP name', () => {
    expect(toolViewPack.kind).toBe('claude-code');
    expect(Object.keys(toolViewPack.views).sort()).toEqual(
      [
        'Agent',
        'AskUserQuestion',
        'Bash',
        'Edit',
        'ExitPlanMode',
        'Glob',
        'Grep',
        'MultiEdit',
        'Read',
        'Skill',
        'Task',
        'TodoWrite',
        'WebFetch',
        'WebSearch',
        'Write',
      ].sort(),
    );
    expect(Object.keys(toolViewPack.views).some((n) => n.startsWith('mcp__'))).toBe(false);
  });

  it('names the skill on the Skill card (R7.5)', () => {
    const html = render('Skill', call('Skill', { skill: 'review-pr', args: '123' }));
    expect(html).toContain('data-raw-agent="tool-skill-name"');
    expect(html).toContain('review-pr');
    expect(html).toContain('123');
    expect(skillName({ command: '/deploy' })).toBe('deploy');
    expect(skillName({})).toBeUndefined();
  });

  it('shows the Bash description, the background mark and the state', () => {
    const html = render(
      'Bash',
      call(
        'Bash',
        { command: 'ls -la\necho hi', description: 'List files', run_in_background: true },
        { phase: 'running', result: undefined },
      ),
    );
    expect(html).toContain('List files');
    expect(html).toContain('background');
    expect(html).toContain('running…');
    expect(bashModel({ command: 'x', timeout: 5 })).toEqual({ command: 'x', background: false, timeoutMs: 5 });
  });

  it('marks failed and stopped calls apart', () => {
    expect(rowState(call('Bash', {}, { result: { text: 'boom', isError: true, images: 0 } }))).toBe('error');
    expect(
      rowState(
        call(
          'Bash',
          {},
          { result: { text: "The user doesn't want to proceed with this tool use.", isError: true, images: 0 } },
        ),
      ),
    ).toBe('stopped');
    expect(rowState(call('Bash', {}, { phase: 'preparing', result: undefined }))).toBe('preparing');
  });

  it('opens the checklist of TodoWrite by default', () => {
    const html = render(
      'TodoWrite',
      call('TodoWrite', {
        todos: [
          { content: 'Write tests', status: 'completed', activeForm: 'Writing tests' },
          { content: 'Run build', status: 'in_progress', activeForm: 'Running build' },
          { content: 'Ship', status: 'pending' },
        ],
      }),
    );
    expect(html).toContain('data-raw-agent="tool-checklist"');
    expect(html).toContain('Running build');
    expect(html).toContain('1/3 done');
    expect(html).toContain('data-status="completed"');
  });

  it('shows the Edit path relative to the session folder with +/- counts', () => {
    const html = render(
      'Edit',
      call('Edit', { file_path: '/work/repo/src/a.ts', old_string: 'a\nb\nc', new_string: 'a\nB\nc' }),
    );
    expect(html).toContain('src/a.ts');
    expect(html).toContain('+1');
    expect(html).toContain('−1');
  });

  it('names every call row by its tool and survives a partial input while preparing', () => {
    for (const name of Object.keys(CLAUDE_TOOL_VIEWS)) {
      const html = render(name, call(name, {}, { phase: 'preparing', result: undefined }));
      expect(html).toContain(`data-tool="${name}"`);
      expect(html).toContain('writing…');
    }
  });

  it('shows the plan title, the question and the search pattern', () => {
    expect(render('ExitPlanMode', call('ExitPlanMode', { plan: '# Fix the bug\n\nSteps' }))).toContain('Fix the bug');
    expect(
      render(
        'AskUserQuestion',
        call('AskUserQuestion', { questions: [{ question: 'Which DB?', options: [{ label: 'pg' }] }] }),
      ),
    ).toContain('Which DB?');
    expect(
      render(
        'Grep',
        call(
          'Grep',
          { pattern: 'TODO', path: '/work/repo/src' },
          { result: { text: 'a\nb', isError: false, images: 0 } },
        ),
      ),
    ).toContain('2 lines');
    expect(render('WebFetch', call('WebFetch', { url: 'https://example.com/x' }))).toContain(
      'href="https://example.com/x"',
    );
    expect(render('WebFetch', call('WebFetch', { url: 'javascript:alert(1)' }))).not.toContain('href=');
    expect(render('Agent', call('Agent', { subagent_type: 'Explore', description: 'Find files' }))).toContain(
      'Explore · Find files',
    );
  });
});

describe('the view models', () => {
  it('shortens paths to the session folder, then the home folder', () => {
    expect(displayPath('/work/repo/a/b.ts', '/work/repo', '/home/u')).toBe('a/b.ts');
    expect(displayPath('/home/u/x', '/work/repo', '/home/u')).toBe('~/x');
    expect(displayPath('/etc/hosts', '/work/repo', '/home/u')).toBe('/etc/hosts');
    expect(displayPath('C:\\w\\r\\f.ts', 'C:\\w\\r')).toBe('f.ts');
  });

  it('numbers an edit from its first line (Leftover M2)', () => {
    const m = editModel({ file_path: '/f', old_string: 'one\ntwo\nthree', new_string: 'one\n2\nthree\nfour' });
    expect(m.added).toBe(2);
    expect(m.removed).toBe(1);
    expect(m.lines).toEqual([
      { op: ' ', text: 'one', old: 1, new: 1 },
      { op: '-', text: 'two', old: 2 },
      { op: '+', text: '2', new: 2 },
      { op: ' ', text: 'three', old: 3, new: 3 },
      { op: '+', text: 'four', new: 4 },
    ]);
    const multi = editModel({
      edits: [
        { old_string: 'a', new_string: 'b' },
        { old_string: 'c', new_string: 'd' },
      ],
    });
    expect(multi.edits).toBe(2);
    expect(multi.lines.some((l) => l.text === '⋯')).toBe(true);
    const html = renderToStaticMarkup(React.createElement(DiffBox, { lines: m.lines }));
    expect(html).toContain('data-raw-agent="tool-diff-num"');
    expect(writeModel({ file_path: '/f', content: 'x\ny\n' }).lines).toEqual([
      { op: '+', text: 'x', new: 1 },
      { op: '+', text: 'y', new: 2 },
    ]);
  });

  it('reads the numbered lines of a Read result and its range', () => {
    expect(readLines('     1\tconst a = 1;\n     2→b\nnote')).toEqual([
      { n: 1, text: 'const a = 1;' },
      { n: 2, text: 'b' },
      { text: 'note' },
    ]);
    expect(readModel({ file_path: '/f', offset: 10, limit: 50 })).toEqual({
      path: '/f',
      range: 'lines 10–59',
      line: 10,
    });
  });

  it('builds checklists, question lists, plan titles and safe links', () => {
    const items = todoItems({
      todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }, 'x'],
    });
    expect(todoSummary(items)).toBe('1/2 done');
    expect(
      questionModels({
        questions: [{ question: 'Q', header: 'H', multiSelect: true, options: ['a', { label: 'b' }] }],
      }),
    ).toEqual([{ question: 'Q', header: 'H', multiSelect: true, options: ['a', 'b'] }]);
    expect(planTitle('Intro\n## Step one')).toBe('Step one');
    expect(safeUrl('file:///etc/passwd')).toBeUndefined();
    expect(searchSummary({ pattern: '*.ts', path: '/work/repo/src', glob: '*.ts' }, '/work/repo')).toBe(
      '*.ts in src (*.ts)',
    );
  });
});
