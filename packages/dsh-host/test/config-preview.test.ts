import { describe, expect, it } from 'vitest';
import type { AgentBackendFactory, ConfigFileInfo } from '@dsh-raw-agent/core';
import {
  CONFIG_FILE_ROUTE,
  CONFIG_FILES_ROUTE,
  configRoutes,
  listConfigFiles,
  mountConfigRoutes,
  previewConfigFile,
  readUserConfig,
  type ConfigPreviewDeps,
  type HostContext,
} from '@dsh-raw-agent/dsh-host';

const files = (cwd: string): ConfigFileInfo[] => [
  { label: 'User', path: '/home/u/.agent/settings.json', scope: 'user', format: 'json' },
  { label: 'Project', path: `${cwd}/.agent/settings.json`, scope: 'project', format: 'json' },
];

function factory(over: Partial<AgentBackendFactory> = {}): AgentBackendFactory {
  return {
    kind: 'stub',
    displayName: 'Stub',
    staticCapabilities: {} as never,
    open: async () => {
      throw new Error('never opened');
    },
    configFiles: async (cwd) => files(cwd),
    maskConfig: (_f, text) => {
      const i = text.indexOf('SECRET');
      if (i < 0) return { masked: text, secrets: [] };
      return {
        masked: text.slice(0, i) + '***' + text.slice(i + 6),
        secrets: [{ start: i, end: i + 3, sourceStart: i, sourceEnd: i + 6, key: 'env.K' }],
      };
    },
    ...over,
  };
}

const disk: Record<string, string> = {
  '/home/u/.agent/settings.json': '{"env":{"K":"SECRET"}}',
  '/etc/passwd': 'root',
};
const reads: string[] = [];

function deps(over: Partial<ConfigPreviewDeps> = {}): ConfigPreviewDeps {
  return {
    factories: [factory()],
    cwdOf: (id) => (id === 's1' ? '/w' : undefined),
    readFile: (p) => {
      reads.push(p);
      const t = disk[p];
      return t === undefined ? { kind: 'missing' } : { kind: 'ok', text: t, mtimeMs: 1, size: t.length };
    },
    ...over,
  };
}

const u = (q: string) => new URL(`http://h/api/raw-agent/config-file?${q}`);

describe('settings preview (R1.3, D63)', () => {
  it('lists the factory files for a live session', async () => {
    const r = await listConfigFiles(u('session=s1'), deps());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      backend: 'stub',
      files: [
        { scope: 'user', exists: true },
        { scope: 'project', exists: false, path: '/w/.agent/settings.json' },
      ],
    });
  });

  it('refuses unknown sessions, scopes and backends', async () => {
    expect((await previewConfigFile(u('scope=user'), deps())).status).toBe(400);
    expect((await previewConfigFile(u('session=nope&scope=user'), deps())).status).toBe(404);
    expect((await previewConfigFile(u('session=s1&scope=other'), deps())).status).toBe(404);
    expect((await previewConfigFile(u('session=s1&scope=user&backend=x'), deps())).status).toBe(404);
  });

  it('never reads a path from the request', async () => {
    reads.length = 0;
    const r = await previewConfigFile(u('session=s1&scope=/etc/passwd&path=/etc/passwd&file=/etc/passwd'), deps());
    expect(r.status).toBe(404);
    expect(reads).not.toContain('/etc/passwd');
  });

  it('serves the masked text only', async () => {
    const r = await previewConfigFile(u('session=s1&scope=user'), deps());
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
    expect(r.body).toMatchObject({ exists: true, masked: '{"env":{"K":"***"}}', secrets: [{ key: 'env.K' }] });
    expect((r.body as { secrets: object[] }).secrets[0]).not.toHaveProperty('sourceStart');
  });

  it('reveals one value on request', async () => {
    const r = await previewConfigFile(u('session=s1&scope=user&reveal=0'), deps());
    expect(r.body).toEqual({ index: 0, key: 'env.K', value: 'SECRET' });
    expect((await previewConfigFile(u('session=s1&scope=user&reveal=5'), deps())).status).toBe(404);
  });

  it('a missing file says so', async () => {
    const r = await previewConfigFile(u('session=s1&scope=project'), deps());
    expect(r.body).toMatchObject({ exists: false });
    expect(r.body).not.toHaveProperty('masked');
  });

  it('shows no text when the backend cannot mask', async () => {
    const f = factory();
    delete f.maskConfig;
    const r = await previewConfigFile(u('session=s1&scope=user'), deps({ factories: [f] }));
    expect(JSON.stringify(r.body)).not.toContain('SECRET');
    expect(r.body).toMatchObject({ error: expect.stringMatching(/cannot mask/) });
  });

  it('does not preview very large files', async () => {
    const r = await previewConfigFile(
      u('session=s1&scope=user'),
      deps({ readFile: () => ({ kind: 'ok', text: '', mtimeMs: 1, size: 5 * 1024 * 1024 }) }),
    );
    expect(r.body).toMatchObject({ tooLarge: true });
  });

  it('routes answer JSON with no-store', async () => {
    const [list, one] = configRoutes(deps());
    expect(list!.path).toBe(CONFIG_FILES_ROUTE);
    expect(one!.path).toBe(CONFIG_FILE_ROUTE);
    expect(one!.methods).toEqual(['GET']);
    const res = await one!.fetch(new Request('http://h/api/raw-agent/config-file?session=s1&scope=user'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ masked: '{"env":{"K":"***"}}' });
  });

  it('mounts through connection.fetch once the service is served', () => {
    const registered: string[] = [];
    const connection = { fetch: { register: (r: { path: string }) => registered.push(r.path) } };
    const ctx = {
      get: (n: string) => (n === 'connection' ? connection : undefined),
      inject: (d: string[], apply: (c: unknown) => void) => {
        expect(d).toEqual(['connection']);
        apply(ctx);
      },
    } as unknown as HostContext;
    expect(mountConfigRoutes(ctx, [factory()])).toBe(true);
    expect(registered).toEqual([CONFIG_FILES_ROUTE, CONFIG_FILE_ROUTE]);
    const f = factory();
    delete f.configFiles;
    expect(mountConfigRoutes(ctx, [f])).toBe(false);
  });
});

describe('readUserConfig (D87)', () => {
  it('reads plain values and volatile references at call time', () => {
    let path = '/a/claude';
    const raw = { executablePath: { get: () => path }, options: { get: () => ({ allow: true }) } };
    expect(readUserConfig(raw)).toEqual({ executablePath: '/a/claude', options: { allow: true } });
    path = '/b/claude';
    expect(readUserConfig(raw).executablePath).toBe('/b/claude');
    expect(readUserConfig({ executablePath: '  ' })).toEqual({ options: {} });
    expect(readUserConfig(undefined)).toEqual({ options: {} });
  });
});
