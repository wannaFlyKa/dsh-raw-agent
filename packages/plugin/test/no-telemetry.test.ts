// R10.4 (D64, rule 12): no telemetry. The only network traffic is the CLI's own. A grep over every
// package's sources (comments removed): no network module or browser network API, no absolute
// URL a request could go to, and the browser half calls only our own relative routes.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(?:[cm]?[jt]sx?)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Remove comments, keep strings (same idea as scripts/check-imports.mjs). */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') while (i < src.length && src[i] !== '\n') i++;
    else if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += src[i++];
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') out += src[i++];
        out += src[i++];
      }
      out += src[i++] ?? '';
    } else out += src[i++];
  }
  return out;
}

const sources = (): Array<{ rel: string; code: string }> => {
  const files = [
    ...readdirSync(join(root, 'packages')).flatMap((p) => {
      try {
        return walk(join(root, 'packages', p, 'src'));
      } catch {
        return [];
      }
    }),
    ...walk(join(root, 'examples')),
  ];
  return files.map((f) => ({
    rel: relative(root, f).split('\\').join('/'),
    code: stripComments(readFileSync(f, 'utf8')),
  }));
};

/** Absolute URLs that are shown to the user as text, never requested. */
const SHOWN_ONLY = new Set(['packages/dsh-client/src/ui/mcp-panel.tsx http://localhost:…/callback?code=…']);

describe('no telemetry (R10.4)', () => {
  const all = sources();

  it('scans our sources', () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it('no network module, no browser network API', () => {
    const bad: string[] = [];
    const modules = /['"](?:node:)?(?:http|https|http2|net|tls|dgram|undici|ws|axios|node-fetch)['"]/;
    const apis = /\b(?:WebSocket|XMLHttpRequest|EventSource|sendBeacon|RTCPeerConnection)\b/;
    for (const { rel, code } of all) {
      if (modules.test(code)) bad.push(`${rel}: network module`);
      if (apis.test(code)) bad.push(`${rel}: browser network API`);
    }
    expect(bad).toEqual([]);
  });

  it('no absolute URL in code, except text the user only reads', () => {
    const found: string[] = [];
    for (const { rel, code } of all)
      for (const m of code.matchAll(/(?:https?|wss?):\/\/[^\s'"`)]*/g)) found.push(`${rel} ${m[0]}`);
    expect(found.filter((f) => !SHOWN_ONLY.has(f))).toEqual([]);
  });

  it('the browser fetches only our own relative routes, through one fetch call', () => {
    const calls: string[] = [];
    const bases: string[] = [];
    for (const { rel, code } of all) {
      for (const _ of code.matchAll(/\bglobalThis\.fetch\(|\bwindow\.fetch\(|(?<![\w.])(?:await\s+)fetch\(/g))
        calls.push(rel);
      for (const m of code.matchAll(/['"`]api\/[^'"`]*/g)) bases.push(m[0].slice(1));
    }
    expect(calls).toEqual(['packages/dsh-client/src/port/index.tsx']);
    expect(bases.length).toBeGreaterThan(0);
    for (const b of bases) expect(b.startsWith('api/raw-agent')).toBe(true);
  });
});
