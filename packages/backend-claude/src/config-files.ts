// Settings quick access (R1.3, D63, D83). The three settings files the CLI reads for a folder,
// and masking of their `env` values. Paths only and pure text work: nothing here reads or writes
// a file (rule 2). The Host reads the text read-only and serves only these paths.

import * as path from 'node:path';
import type { ConfigFileInfo, ConfigSecret, MaskedConfig } from '@dsh-raw-agent/core';
import { claudeConfigDir } from './checkpoint.js';

export interface ConfigFilesDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homedir: string;
}

/**
 * Exactly three files (D63): user, project and local settings. The user file follows
 * `CLAUDE_CONFIG_DIR` like the CLI does (`claudeConfigDir`). Managed (policy) settings are not
 * offered: the user cannot edit them.
 */
export function claudeConfigFiles(cwd: string, deps: ConfigFilesDeps): ConfigFileInfo[] {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const dir = claudeConfigDir(deps.env, deps.homedir, deps.platform);
  return [
    { label: 'User settings', path: p.join(dir, 'settings.json'), scope: 'user', format: 'json' },
    { label: 'Project settings', path: p.join(cwd, '.claude', 'settings.json'), scope: 'project', format: 'json' },
    {
      label: 'Project local settings',
      path: p.join(cwd, '.claude', 'settings.local.json'),
      scope: 'local',
      format: 'json',
    },
  ];
}

/** What a hidden value looks like in the preview. */
export const MASK = '••••••••';

type Tok =
  | { t: 'str'; start: number; end: number }
  | { t: 'lit'; start: number; end: number }
  | { t: 'punct'; c: string; start: number; end: number };

/** JSON tokens, tolerating comments (the CLI's reader is **unverified** on JSONC). */
function tokenize(text: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\uFEFF') {
      i++;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
    } else if (c === '"') {
      const start = i++;
      while (i < n && text[i] !== '"' && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
      i = Math.min(n, i + 1);
      out.push({ t: 'str', start, end: i });
    } else if ('{}[]:,'.includes(c)) {
      out.push({ t: 'punct', c, start: i, end: ++i });
    } else {
      const start = i;
      while (i < n && !' \t\n\r{}[]:,"/'.includes(text[i]!)) i++;
      if (i === start) i++;
      out.push({ t: 'lit', start, end: i });
    }
  }
  return out;
}

function decodeKey(raw: string): string {
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === 'string' ? v : raw;
  } catch {
    return raw.replace(/^"|"$/g, '');
  }
}

interface Frame {
  kind: 'obj' | 'arr';
  key?: string;
  expectKey: boolean;
}

/** Value tokens to hide: those under the top-level `env` object. `undefined` = text is not well-formed. */
function envValueTokens(text: string, toks: Tok[]): Array<{ tok: Tok; key: string }> | undefined {
  const hide: Array<{ tok: Tok; key: string }> = [];
  const stack: Frame[] = [];
  const pathOf = () => stack.filter((f) => f.kind === 'obj').map((f) => f.key ?? '');
  const underEnv = () => stack.length >= 1 && stack[0]!.kind === 'obj' && stack[0]!.key === 'env';
  for (const tok of toks) {
    const top = stack[stack.length - 1];
    if (tok.t === 'punct') {
      switch (tok.c) {
        case '{':
        case '[':
          if (top?.kind === 'obj' && top.expectKey) return undefined;
          stack.push({ kind: tok.c === '{' ? 'obj' : 'arr', expectKey: tok.c === '{' });
          break;
        case '}':
        case ']':
          if (!top || top.kind !== (tok.c === '}' ? 'obj' : 'arr')) return undefined;
          stack.pop();
          break;
        case ':':
          if (top?.kind !== 'obj' || !top.expectKey || top.key === undefined) return undefined;
          top.expectKey = false;
          break;
        case ',':
          if (!top) return undefined;
          if (top.kind === 'obj') {
            top.expectKey = true;
            delete top.key;
          }
          break;
      }
      continue;
    }
    if (!top) {
      if (stack.length === 0 && tok.t === 'lit') continue; // a bare top-level value
      return undefined;
    }
    if (top.kind === 'obj' && top.expectKey) {
      if (tok.t !== 'str' || top.key !== undefined) return undefined;
      top.key = decodeKey(text.slice(tok.start, tok.end));
      continue;
    }
    if (underEnv()) hide.push({ tok, key: pathOf().join('.') });
  }
  return stack.length === 0 ? hide : undefined;
}

/** Fallback for text that is not well-formed: hide every token that follows a `:`. */
function valueTokensAfterColon(toks: Tok[]): Array<{ tok: Tok; key: string }> {
  const hide: Array<{ tok: Tok; key: string }> = [];
  for (let k = 1; k < toks.length; k++) {
    const prev = toks[k - 1]!;
    const tok = toks[k]!;
    if (prev.t === 'punct' && prev.c === ':' && tok.t !== 'punct') hide.push({ tok, key: '' });
  }
  return hide;
}

/**
 * Hide the values under the top-level `env` key of a settings file (D63). Keys and every other
 * setting stay visible. Text that is not well-formed JSON is masked conservatively: every value
 * after a `:`. Other formats are returned unchanged.
 */
export function maskClaudeSettings(file: { path: string; format: string }, text: string): MaskedConfig {
  if (file.format !== 'json') return { masked: text, secrets: [] };
  const toks = tokenize(text);
  const hide = envValueTokens(text, toks) ?? valueTokensAfterColon(toks);
  let masked = '';
  let at = 0;
  const secrets: ConfigSecret[] = [];
  for (const { tok, key } of hide) {
    const isStr = tok.t === 'str' && tok.end - tok.start >= 2 && text[tok.end - 1] === '"';
    const sourceStart = isStr ? tok.start + 1 : tok.start;
    const sourceEnd = isStr ? tok.end - 1 : tok.end;
    masked += text.slice(at, sourceStart);
    const start = masked.length;
    masked += MASK;
    const secret: ConfigSecret = { start, end: masked.length, sourceStart, sourceEnd };
    if (key !== '') secret.key = key;
    secrets.push(secret);
    at = sourceEnd;
  }
  masked += text.slice(at);
  return { masked, secrets };
}
