import { describe, expect, it } from 'vitest';
import { buildStartOptions, decideFileCheckpointing, type StartOptionsInput } from '@dsh-raw-agent/backend-claude';

const fn = () => {
  throw new Error('not called');
};

function input(over: Partial<StartOptionsInput> = {}): StartOptionsInput {
  return {
    executablePath: '/home/user/.local/bin/claude',
    cwd: '/work/repo',
    env: { PATH: '/usr/bin', HOME: '/home/user' },
    start: { kind: 'new', sessionId: '00000000-0000-5000-8000-000000000001' },
    userOptions: {},
    fileCheckpointing: true,
    canUseTool: fn as never,
    onElicitation: fn as never,
    spawn: fn as never,
    abortController: new AbortController(),
    ...over,
  };
}

/** Callbacks and the abort controller become markers so the snapshot shows only data. */
function printable(o: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).map(([k, v]) => [
      k,
      typeof v === 'function' ? '[function]' : v instanceof AbortController ? '[AbortController]' : v,
    ]),
  );
}

const FORBIDDEN = [
  'model',
  'effort',
  'permissionMode',
  'thinking',
  'tools',
  'allowedTools',
  'disallowedTools',
  'settings',
  'mcpServers',
  'promptSuggestions',
  'agentProgressSummaries',
  'verbatimPrompts',
  'maxThinkingTokens',
  'agents',
  'extraArgs',
  'executableArgs',
  'hooks',
  'plugins',
  'fallbackModel',
  'betas',
  'onUserDialog',
  'supportedDialogKinds',
];

describe('raw start options (D12-D16)', () => {
  it('new session snapshot', () => {
    expect(printable(buildStartOptions(input()))).toMatchSnapshot();
  });

  it('passes none of the forced options (rule 4)', () => {
    const variants = [
      input(),
      input({ start: { kind: 'resume', sessionId: 's' } }),
      input({ start: { kind: 'fork', fromSessionId: 'a', newSessionId: 'b', atChainId: 'c' } }),
    ];
    for (const v of variants) for (const k of FORBIDDEN) expect(buildStartOptions(v)).not.toHaveProperty(k);
  });

  it('uses the claude_code preset with no append (rule 3)', () => {
    expect(buildStartOptions(input()).systemPrompt).toEqual({ type: 'preset', preset: 'claude_code' });
  });

  it('resume and fork snapshots', () => {
    expect(
      printable(buildStartOptions(input({ start: { kind: 'resume', sessionId: 'sid', mainAgent: 'reviewer' } }))),
    ).toMatchSnapshot();
    expect(
      printable(
        buildStartOptions(
          input({
            start: { kind: 'fork', fromSessionId: 'src', newSessionId: 'dst', atChainId: 'chain', dropsTurnHint: 'x' },
          }),
        ),
      ),
    ).toMatchSnapshot();
  });

  it('keeps the user env preview format (D13)', () => {
    const o = buildStartOptions(input({ env: { CLAUDE_CODE_QUESTION_PREVIEW_FORMAT: 'html' } }));
    expect(o).not.toHaveProperty('toolConfig');
  });

  it('passes bypass only with the plugin switch (D14)', () => {
    expect(buildStartOptions(input())).not.toHaveProperty('allowDangerouslySkipPermissions');
    expect(buildStartOptions(input({ userOptions: { allowDangerouslySkipPermissions: 'yes' } }))).not.toHaveProperty(
      'allowDangerouslySkipPermissions',
    );
    expect(
      buildStartOptions(input({ userOptions: { allowDangerouslySkipPermissions: true } }))
        .allowDangerouslySkipPermissions,
    ).toBe(true);
  });

  it('passes agent only for a picked main agent (D15)', () => {
    expect(buildStartOptions(input())).not.toHaveProperty('agent');
    expect(buildStartOptions(input({ start: { kind: 'new', mainAgent: 'reviewer' } })).agent).toBe('reviewer');
  });

  it('omits checkpointing when it is off (D16) and trust unless accepted (D73)', () => {
    expect(buildStartOptions(input({ fileCheckpointing: false }))).not.toHaveProperty('enableFileCheckpointing');
    expect(buildStartOptions(input())).not.toHaveProperty('workspaceTrust');
    expect(buildStartOptions(input({ trustAccepted: { directory: '/work' } })).workspaceTrust).toEqual({
      accepted: true,
      directory: '/work',
    });
  });
});

describe('file checkpoint decision (D16)', () => {
  const base = { platform: 'linux' as const, homedir: '/home/u', cwd: '/w' };
  it('is on by default', () => {
    expect(decideFileCheckpointing({ ...base, env: {}, readText: () => undefined })).toEqual({ enabled: true });
  });
  it('is off when the env says so', () => {
    expect(
      decideFileCheckpointing({
        ...base,
        env: { CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1' },
        readText: () => undefined,
      }).enabled,
    ).toBe(false);
    expect(
      decideFileCheckpointing({
        ...base,
        env: { CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '0' },
        readText: () => undefined,
      }).enabled,
    ).toBe(true);
  });
  it('is off when any settings source sets fileCheckpointingEnabled: false', () => {
    const files: Record<string, string> = { '/w/.claude/settings.local.json': '{"fileCheckpointingEnabled": false}' };
    expect(decideFileCheckpointing({ ...base, env: {}, readText: (p) => files[p] })).toEqual({
      enabled: false,
      disabledBy: 'local',
    });
    const legacy: Record<string, string> = { '/home/u/.claude.json': '{"fileCheckpointingEnabled": false}' };
    expect(decideFileCheckpointing({ ...base, env: {}, readText: (p) => legacy[p] }).disabledBy).toBe('global-config');
  });
  it('follows CLAUDE_CONFIG_DIR and ignores broken JSON', () => {
    const files: Record<string, string> = {
      '/cfg/settings.json': '{"fileCheckpointingEnabled": false}',
      '/w/.claude/settings.json': '{',
    };
    expect(
      decideFileCheckpointing({ ...base, env: { CLAUDE_CONFIG_DIR: '/cfg' }, readText: (p) => files[p] }).disabledBy,
    ).toBe('user');
  });
});
