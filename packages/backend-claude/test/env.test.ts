import { describe, expect, it } from 'vitest';
import {
  buildClaudeEnv,
  HOST_SESSION_VARS,
  restoreSdkDeletedVars,
  withSdkVersionEnvRestored,
} from '@dsh-raw-agent/backend-claude';

const hostLeak = {
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'host-session',
  CLAUDE_CODE_HOST_SESSION_ID: 'h',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ATTENDED: '0',
  CLAUDE_CODE_SESSION_KIND: 'bg',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'tok',
  CLAUDE_CODE_EXECPATH: '/host/claude',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_DESKTOP_APP_VERSION: '1.0',
  CLAUDE_AGENT_SDK_VERSION: '0.0.1',
  CLAUDE_EFFORT: 'max',
  CLAUDE_PID: '123',
};

describe('env policy (D17a)', () => {
  it('strips every host-session variable and keeps the rest', () => {
    const { env, removed } = buildClaudeEnv({ ...hostLeak, PATH: '/usr/bin', HOME: '/home/u', LANG: 'C' }, 'linux');
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', LANG: 'C' });
    expect(removed.map((r) => r.name).sort()).toEqual([...HOST_SESSION_VARS].sort());
  });

  it("never strips the user's tokens, keys or Claude settings variables", () => {
    const user = {
      ANTHROPIC_API_KEY: 'sk-ant-x',
      ANTHROPIC_AUTH_TOKEN: 't',
      AWS_SECRET_ACCESS_KEY: 's',
      AWS_SESSION_TOKEN: 's',
      GITHUB_TOKEN: 'g',
      CLAUDE_CODE_USE_BEDROCK: '1',
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      CLAUDE_CONFIG_DIR: '/c',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
      CLAUDE_CODE_QUESTION_PREVIEW_FORMAT: 'html',
      NODE_OPTIONS: '--max-old-space-size=4096',
      DEBUG: 'x',
      GIT_EDITOR: 'true',
      DSH_HOME: '/d',
      DSH_PROFILE: 'web',
    };
    expect(buildClaudeEnv(user, 'linux').env).toEqual(user);
  });

  it('removes AI_AGENT only in the CLI form', () => {
    expect(buildClaudeEnv({ AI_AGENT: 'claude-code_2-1-318_agent' }, 'linux').env).toEqual({});
    expect(buildClaudeEnv({ AI_AGENT: 'my-agent' }, 'linux').env).toEqual({ AI_AGENT: 'my-agent' });
  });

  it('removes TRACEPARENT/TRACESTATE only when CLAUDECODE was present', () => {
    expect(buildClaudeEnv({ TRACEPARENT: 'a', TRACESTATE: 'b' }, 'linux').env).toEqual({
      TRACEPARENT: 'a',
      TRACESTATE: 'b',
    });
    expect(buildClaudeEnv({ CLAUDECODE: '1', TRACEPARENT: 'a', TRACESTATE: 'b' }, 'linux').env).toEqual({});
  });

  it("keeps the user's own DSH_* tokens and keys (rule 5)", () => {
    const src = {
      DSH_API_TOKEN: 'x',
      DSH_SECRET_THING: 'y',
      DSH_DEPLOY_TOKEN: 'z',
      DSH_MY_API_KEY: 'k',
      DSH_PORT: '1',
    };
    const { env, removed } = buildClaudeEnv(src, 'linux');
    expect(env).toEqual(src);
    expect(removed).toEqual([]);
  });

  it('is case-insensitive on Windows only', () => {
    expect(buildClaudeEnv({ ClaudeCode: '1', Claude_Pid: '1', Path: 'C:\\x' }, 'win32').env).toEqual({ Path: 'C:\\x' });
    expect(buildClaudeEnv({ ClaudeCode: '1' }, 'linux').env).toEqual({ ClaudeCode: '1' });
  });

  it('drops undefined values', () => {
    expect(buildClaudeEnv({ A: undefined, B: 'b' }, 'linux').env).toEqual({ B: 'b' });
  });
});

describe('spawn env (D7)', () => {
  it("puts the user's NODE_OPTIONS and DEBUG back", () => {
    const sdkEnv = { PATH: '/bin', CLAUDE_CODE_ENTRYPOINT: 'sdk-ts', CLAUDE_AGENT_SDK_VERSION: '0.3.318' };
    expect(restoreSdkDeletedVars(sdkEnv, { PATH: '/bin', NODE_OPTIONS: '--x', DEBUG: 'y' })).toEqual({
      ...sdkEnv,
      NODE_OPTIONS: '--x',
      DEBUG: 'y',
    });
  });
  it("keeps the SDK's choice when the user had none", () => {
    expect(restoreSdkDeletedVars({ PATH: '/bin', DEBUG: '1' }, { PATH: '/bin' })).toEqual({ PATH: '/bin', DEBUG: '1' });
  });
  it('restores CLAUDE_AGENT_SDK_VERSION of the host process after query()', () => {
    const target: NodeJS.ProcessEnv = {};
    withSdkVersionEnvRestored(() => {
      target.CLAUDE_AGENT_SDK_VERSION = '0.3.318';
    }, target);
    expect('CLAUDE_AGENT_SDK_VERSION' in target).toBe(false);
    const t2: NodeJS.ProcessEnv = { CLAUDE_AGENT_SDK_VERSION: 'mine' };
    withSdkVersionEnvRestored(() => {
      t2.CLAUDE_AGENT_SDK_VERSION = '0.3.318';
    }, t2);
    expect(t2.CLAUDE_AGENT_SDK_VERSION).toBe('mine');
  });
});
