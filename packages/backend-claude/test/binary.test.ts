import { describe, expect, it } from 'vitest';
import {
  ClaudeBinaryNotFoundError,
  npmShimTarget,
  resolveClaudeBinary,
  type BinaryResolveDeps,
} from '@dsh-raw-agent/backend-claude';

function deps(files: Record<string, string>, over: Partial<BinaryResolveDeps> = {}): BinaryResolveDeps {
  return {
    env: { PATH: '/usr/local/bin:/usr/bin' },
    platform: 'linux',
    homedir: '/home/u',
    isExecutable: (p) => p in files,
    readText: (p) => files[p],
    ...over,
  };
}

describe('binary resolution (D10)', () => {
  it('uses the configured path first', () => {
    expect(resolveClaudeBinary('/opt/claude', deps({ '/opt/claude': '', '/usr/bin/claude': '' }))).toEqual({
      path: '/opt/claude',
      source: 'configured',
    });
  });
  it('fails clearly when the configured path is missing (no silent fallback)', () => {
    expect(() => resolveClaudeBinary('/nope', deps({ '/usr/bin/claude': '' }))).toThrow(ClaudeBinaryNotFoundError);
  });
  it('then the first claude on PATH', () => {
    expect(resolveClaudeBinary(undefined, deps({ '/usr/bin/claude': '', '/home/u/.local/bin/claude': '' }))).toEqual({
      path: '/usr/bin/claude',
      source: 'path',
    });
  });
  it('then ~/.local/bin/claude', () => {
    expect(resolveClaudeBinary('  ', deps({ '/home/u/.local/bin/claude': '' }))).toEqual({
      path: '/home/u/.local/bin/claude',
      source: 'local-bin',
    });
  });
  it('reports what it tried', () => {
    try {
      resolveClaudeBinary(undefined, deps({}));
      expect.unreachable();
    } catch (e) {
      expect((e as ClaudeBinaryNotFoundError).tried).toEqual([
        '/usr/local/bin/claude',
        '/usr/bin/claude',
        '/home/u/.local/bin/claude',
      ]);
    }
  });
  it('on Windows finds claude.exe and follows an npm shim', () => {
    const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
    const w = (files: Record<string, string>) =>
      deps(files, { platform: 'win32', env: { Path: 'C:\\npm;C:\\bin' }, homedir: 'C:\\Users\\u' });
    expect(resolveClaudeBinary(undefined, w({ 'C:\\bin\\claude.exe': '' })).path).toBe('C:\\bin\\claude.exe');
    const target = 'C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe';
    expect(resolveClaudeBinary(undefined, w({ 'C:\\npm\\claude.cmd': shim, [target]: '' })).path).toBe(target);
    expect(resolveClaudeBinary(undefined, w({ 'C:\\Users\\u\\.local\\bin\\claude.exe': '' })).source).toBe('local-bin');
  });
  it('parses the shim target', () => {
    expect(npmShimTarget('C:\\npm\\claude.cmd', '"%dp0%\\node_modules\\x\\cli.js" %*')).toBe(
      'C:\\npm\\node_modules\\x\\cli.js',
    );
    expect(npmShimTarget('C:\\npm\\claude.cmd', 'nothing')).toBeUndefined();
  });
});
