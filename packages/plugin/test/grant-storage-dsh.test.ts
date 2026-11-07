// D88 against DSH's real domain layer: our plain spec (no defineDomain, no zod, D65) opens in
// `DomainFacility` over the real json backend, a grant survives a "restart" (a new facility over the
// same folder), and a revoke does too. Skips without an installed DSH (DSH_PKG or `dsh` on PATH).

import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { GRANTS_DOMAIN_NAME, GrantStore, domainGrantPersistence } from '@dsh-raw-agent/dsh-host';
import { findDshPackages } from '@dsh-raw-agent/testkit';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const dir = findDshPackages();
const imp = async (pkg: string): Promise<Any> =>
  import(pathToFileURL(join(dir!, '@deepseek-ai', pkg, 'lib', 'index.js')).href);
const domainPkg = dir ? await imp('dsh-storage-domain') : undefined;
const jsonPkg = dir ? await imp('dsh-storage-json') : undefined;

const roots: string[] = [];
afterEach(async () => {
  for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

/** One "DSH run": a json backend and a facility over `root`, and a Host context serving it. */
function run(root: string) {
  const backend = new jsonPkg.JsonStorageBackend(root);
  const domainCtx = {
    storage: { backend: { get: () => backend } },
    emit() {},
    logger: { warn() {}, error() {}, info() {} },
  };
  const facility = new domainPkg.DomainFacility(domainCtx, { backend: 'json' });
  const disposers: Array<() => void> = [];
  const ctx = {
    on: () => () => {},
    emit() {},
    effect: (fn: () => () => void) => void disposers.push(fn()),
    get: (n: string) => (n === 'storageDomain' ? facility : undefined),
    inject: (_deps: string[], apply: (c: unknown) => void) => apply(ctx),
    logger: { warn: (...a: unknown[]) => console.warn(...a), info() {} },
  };
  const fallback = { load: () => undefined, save: async () => false, durable: () => false };
  const persistence = domainGrantPersistence(ctx as never, { fallback });
  return {
    persistence,
    store: new GrantStore({ persistence }),
    async stop() {
      disposers.splice(0).forEach((d) => d());
      await facility.closeAll();
      await backend.close();
    },
  };
}

describe.skipIf(!domainPkg || !jsonPkg)('grants in the real DSH storage domain (D88)', () => {
  it('opens our plain spec, keeps a grant across a restart, and keeps a revoke', async () => {
    const root = await mkdtemp(join(tmpdir(), 'raw-agent-grants-'));
    roots.push(root);
    const a = run(root);
    expect(await a.persistence.ready).toBe(true);
    const r = await a.store.create('reminders');
    if (!r.ok) throw new Error(r.error);
    expect(r.grant.saved).toBe(true);
    await a.stop();

    // One file per grant; the token itself is in no file.
    const files = await readdir(join(root, GRANTS_DOMAIN_NAME, 'grants'));
    expect(files).toEqual([`${r.grant.id}.json`]);
    const text = await readFile(join(root, GRANTS_DOMAIN_NAME, 'grants', files[0]!), 'utf8');
    expect(text).not.toContain(r.token);

    const b = run(root);
    expect(await b.persistence.ready).toBe(true);
    expect(b.store.check(r.token)?.id).toBe(r.grant.id);
    expect(b.store.list()).toEqual([expect.objectContaining({ label: 'reminders', saved: true })]);
    expect(await b.store.revoke(r.grant.id)).toEqual({ ok: true, saved: true });
    await b.stop();

    const c = run(root);
    expect(await c.persistence.ready).toBe(true);
    expect(c.store.list()).toEqual([]);
    expect(c.store.check(r.token)).toBeUndefined();
    await c.stop();
  });
});
