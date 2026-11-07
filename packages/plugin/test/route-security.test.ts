// R10.1 (D62, rule 12): every route of ours sits behind DSH's own authentication and trusted-host
// fence. The real DSH connection plugin runs in-process with a small HTTP carrier (what
// dsh-host-webserver does for `/api`), and our Host entry registers its routes on it. Checks:
// - every route is an exact `/api/raw-agent/…` path with no option that skips auth;
// - without the DSH cookie every route answers 401, from an untrusted Host or a cross-site
//   Origin 403, before our code runs;
// - after the launch-token exchange through a `--trusted-host` alias (a reverse proxy's Host),
//   our routes answer with their own JSON (never 401/403);
// - no route reads a caller-chosen file.
// Skipped when no installed DSH is found.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClaudeFactory } from '@dsh-raw-agent/backend-claude';
import { createRawAgentHost } from '@dsh-raw-agent/dsh-host';
import { createStubFactory, loadDsh } from '@dsh-raw-agent/testkit';

/* eslint-disable @typescript-eslint/no-explicit-any */
const dsh = await loadDsh();
const ALIAS = 'raw-agent.test';

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let server: ReturnType<typeof createServer> | undefined;
let port = 0;
let app: any;
let connection: any;

function send(method: string, path: string, headers: Record<string, string>, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The launch-token exchange a browser does on the first visit (`GET /?token=…`), for one Host. */
async function cookieFor(host: string): Promise<string> {
  const url = new URL(connection.authenticatedUrl(`http://${host}/`));
  const r = await send('GET', `/${url.search}`, { host });
  expect(r.status).toBe(303);
  const set = r.headers['set-cookie'];
  const first = (Array.isArray(set) ? set[0] : set) ?? '';
  return first.split(';')[0]!;
}

const post = (path: string, headers: Record<string, string>, body = '{}') =>
  send('POST', path, { 'content-type': 'application/json', ...headers }, body);

beforeAll(async () => {
  if (!dsh) return;
  const conn = await import(
    pathToFileURL(join(dsh.dir, '@deepseek-ai', 'dsh-client-connection', 'lib', 'index.js')).href
  );
  const routes: Array<{ kind: string; path: string; handler(req: IncomingMessage, res: ServerResponse): unknown }> = [];
  server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/') {
      if (connection.authorizeIndex(req, res)) res.end('index');
      return;
    }
    const route = routes.find((r) => (r.kind === 'exact' ? path === r.path : path.startsWith(`${r.path}/`)));
    if (route) void route.handler(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
  app = new dsh.Context();
  const records = new Map<string, unknown>();
  app.provide('credentials', {
    async modifyRecord(key: string, fn: (current: unknown) => Promise<unknown>) {
      const next = await fn(records.get(key));
      if (next !== undefined) records.set(key, next);
      return records.get(key);
    },
  });
  app.provide('webServer', {
    host: '127.0.0.1',
    protocol: 'http:',
    register(route: (typeof routes)[number]) {
      routes.push(route);
      return () => routes.splice(routes.indexOf(route), 1);
    },
  });
  await app.plugin(conn, { trustedHosts: [ALIAS] }).await();
  const host = createRawAgentHost({ factories: [createClaudeFactory(), createStubFactory({}, 'stub').factory] });
  await app.plugin({ name: 'raw-agent-route-test', inject: ['connection'], apply: (c: any) => host.apply(c) }).await();
  await new Promise((r) => setTimeout(r, 20));
  connection = app.get('connection');
});

afterAll(async () => {
  await app?.fiber.dispose();
  await new Promise((r) => (server ? server.close(() => r(undefined)) : r(undefined)));
});

describe.skipIf(dsh === undefined)(
  `route security behind DSH's connection fence (installed DSH ${dsh?.version})`,
  () => {
    const ours = (): Array<[string, string[]]> =>
      [...(connection.fetchRoutes as Map<string, { methods: Set<string> }>).entries()].map(([p, r]) => [
        p,
        [...r.methods],
      ]);

    it('every route is an exact /api/raw-agent/ path (no other paths, no unauthenticated option)', () => {
      const routes = ours();
      expect(routes.length).toBeGreaterThan(20);
      for (const [path, methods] of routes) {
        expect(path.startsWith('/api/raw-agent/')).toBe(true);
        for (const m of methods) expect(['GET', 'POST']).toContain(m);
      }
    });

    it('without the DSH cookie every route answers 401; untrusted Host or cross-site Origin 403', async () => {
      const local = `127.0.0.1:${port}`;
      for (const [path, methods] of ours()) {
        const m = methods[0]!;
        const q = `${path}?session=s1`;
        const anon = m === 'POST' ? await post(q, { host: local }) : await send(m, q, { host: local });
        expect([path, anon.status]).toEqual([path, 401]);
        const evil = await send(m, q, { host: `evil.example:${port}` });
        expect([path, evil.status]).toEqual([path, 403]);
      }
      const cookie = await cookieFor(local);
      const cross = await post('/api/raw-agent/plugin/session-info', {
        host: local,
        cookie,
        origin: 'http://evil.example',
      });
      expect(cross.status).toBe(403);
      // A cookie minted for one authority does not open another (the alias needs its own).
      const other = await post('/api/raw-agent/plugin/session-info', { host: `${ALIAS}:${port}`, cookie });
      expect(other.status).toBe(401);
    });

    it('through the trusted-host alias with the DSH cookie, our routes answer themselves', async () => {
      const alias = `${ALIAS}:${port}`;
      const cookie = await cookieFor(alias);
      const r = await post(
        '/api/raw-agent/plugin/session-info',
        { host: alias, cookie, origin: `http://${alias}` },
        JSON.stringify({ session: 'session-unknown' }),
      );
      expect(r.status).not.toBe(401);
      expect(r.status).not.toBe(403);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      expect(r.status).toBe(404);
      expect(JSON.parse(r.body)).toMatchObject({ code: 'not-our-session' });
      const grants = await post('/api/raw-agent/grants', { host: alias, cookie });
      expect(grants.status).toBe(200);
      expect(JSON.parse(grants.body)).toHaveProperty('grants');
    });

    it('no route reads a caller-chosen file', async () => {
      const local = `127.0.0.1:${port}`;
      const cookie = await cookieFor(local);
      for (const [path, methods] of ours()) {
        const q = `${path}?session=s1&path=%2Fetc%2Fpasswd&file=%2Fetc%2Fpasswd&scope=..%2F..%2Fetc%2Fpasswd`;
        const body = JSON.stringify({ session: 's1', path: '/etc/passwd', file: '/etc/passwd' });
        const r = methods.includes('POST')
          ? await post(q, { host: local, cookie }, body)
          : await send('GET', q, { host: local, cookie });
        expect(r.body).not.toMatch(/root:.*:0:0:/);
        expect([401, 403]).not.toContain(r.status);
      }
    });
  },
);
