// D88: durable grants over DSH's storage domain, the config import, and the fallback.

import { describe, expect, it } from 'vitest';
import {
  GRANTS_DOMAIN_NAME,
  GRANTS_DOMAIN_SPEC,
  GrantStore,
  domainGrantPersistence,
  grantPersistence,
  hashToken,
  type DomainFacilityLike,
  type GrantPersistence,
} from '@dsh-raw-agent/dsh-host';

type Disk = Map<string, Map<string, unknown>>;

/** A fake `ctx.storageDomain`: the "disk" outlives a facility, as the json files outlive DSH. */
function fakeFacility(disk: Disk, opts: { fail?: unknown; busyOpens?: number } = {}) {
  const open = new Set<string>();
  let busy = opts.busyOpens ?? 0;
  const facility: DomainFacilityLike & { opens: number } = {
    opens: 0,
    async open(spec) {
      facility.opens++;
      if (opts.fail) throw opts.fail;
      if (busy > 0) {
        busy--;
        throw Object.assign(new Error('already open'), { code: 'already-open' });
      }
      if (open.has(spec.name)) throw Object.assign(new Error('already open'), { code: 'already-open' });
      open.add(spec.name);
      const tables = new Map<string, Map<string, unknown>>();
      for (const [name, t] of Object.entries(spec.tables)) {
        const stored = disk.get(name) ?? new Map();
        disk.set(name, stored);
        const mem = new Map<string, unknown>();
        for (const [k, v] of stored) mem.set(k, (t.valueSchema as { parse(r: unknown): unknown }).parse(v));
        tables.set(name, mem);
      }
      let closed = false;
      const handle = (name: string) => {
        const mem = tables.get(name)!;
        const file = disk.get(name)!;
        return {
          get: (k: string) => mem.get(k),
          entries: () => new Map(mem).entries(),
          keys: () => new Map(mem).keys(),
          async put(k: string, v: unknown) {
            if (closed) throw new Error('closed');
            file.set(k, structuredClone(v));
            mem.set(k, v);
          },
          async deleteMany(keys: readonly string[]) {
            let n = 0;
            for (const k of keys)
              if (mem.delete(k)) {
                n++;
                file.delete(k);
              }
            return n;
          },
        };
      };
      return {
        table: handle as never,
        async close() {
          closed = true;
          open.delete(spec.name);
        },
      };
    },
  };
  return facility;
}

/** A Host entry context: `storageDomain` (or none) and the effects to run at unmount. */
function hostCtx(facility: DomainFacilityLike | undefined) {
  const disposers: Array<() => void> = [];
  const warnings: string[] = [];
  const ctx = {
    on: () => () => {},
    emit() {},
    effect: (fn: () => () => void) => void disposers.push(fn()),
    get: (n: string) => (n === 'storageDomain' ? facility : undefined),
    inject(deps: string[], apply: (c: unknown) => void) {
      if (deps.every((d) => ctx.get(d) !== undefined)) apply(ctx);
    },
    logger: { warn: (...a: unknown[]) => void warnings.push(a.join(' ')), info() {} },
  };
  return { ctx, unmount: () => disposers.splice(0).forEach((d) => d()), warnings };
}

const memoryFallback = (): GrantPersistence & { list: unknown } => {
  const f = {
    list: undefined as unknown,
    load: () => f.list,
    save: async (r: unknown) => {
      f.list = r;
      return true;
    },
    durable: () => false,
  };
  return f;
};

describe('grant storage domain spec (D88, D65)', () => {
  it('is a plain DomainSpec: a valid unit name, per-record layout, duck-typed schemas', () => {
    expect(GRANTS_DOMAIN_SPEC.name).toBe(GRANTS_DOMAIN_NAME);
    expect(GRANTS_DOMAIN_NAME).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(Object.keys(GRANTS_DOMAIN_SPEC.tables)).toEqual(['grants', 'imported']);
    expect(GRANTS_DOMAIN_SPEC.layout).toBe('per-record');
    const grant = { id: 'grant-a', label: 'L', hash: hashToken('rag1_x'), created: 3 };
    expect(GRANTS_DOMAIN_SPEC.tables.grants.valueSchema.parse(grant)).toEqual(grant);
    expect(() => GRANTS_DOMAIN_SPEC.tables.grants.valueSchema.parse({ id: 'x', hash: 'nope' })).toThrow();
    expect(GRANTS_DOMAIN_SPEC.tables.grants.valueSchema.safeParse(null).success).toBe(false);
    expect(GRANTS_DOMAIN_SPEC.tables.imported.valueSchema.parse({ at: 1 })).toEqual({ at: 1 });
    expect(() => GRANTS_DOMAIN_SPEC.tables.imported.valueSchema.parse({})).toThrow();
  });
});

describe('durable grants (D88)', () => {
  it('a grant outlives a restart and shows as saved; a revoke outlives one too', async () => {
    const disk: Disk = new Map();
    const run1 = hostCtx(fakeFacility(disk));
    const p1 = domainGrantPersistence(run1.ctx as never, { fallback: memoryFallback() });
    expect(await p1.ready).toBe(true);
    const store1 = new GrantStore({ persistence: p1 });
    const r = await store1.create('reminders');
    if (!r.ok) throw new Error(r.error);
    expect(r.grant.saved).toBe(true);
    expect(JSON.stringify([...disk.get('grants')!.values()])).not.toContain(r.token);
    run1.unmount();

    // DSH restart: a new facility over the same files, a new store.
    const run2 = hostCtx(fakeFacility(disk));
    const p2 = domainGrantPersistence(run2.ctx as never, { fallback: memoryFallback() });
    expect(await p2.ready).toBe(true);
    const store2 = new GrantStore({ persistence: p2 });
    expect(store2.check(r.token)?.id).toBe(r.grant.id);
    expect(store2.list()).toEqual([expect.objectContaining({ id: r.grant.id, label: 'reminders', saved: true })]);
    expect(await store2.revoke(r.grant.id)).toEqual({ ok: true, saved: true });
    expect(store2.check(r.token)).toBeUndefined();
    run2.unmount();

    const run3 = hostCtx(fakeFacility(disk));
    const p3 = domainGrantPersistence(run3.ctx as never, { fallback: memoryFallback() });
    await p3.ready;
    const store3 = new GrantStore({ persistence: p3 });
    expect(store3.list()).toEqual([]);
    expect(store3.check(r.token)).toBeUndefined();
  });

  it('takes in old config grants once; a revoked one does not come back from the config', async () => {
    const disk: Disk = new Map();
    const token = 'rag1_old';
    const config = { grants: [{ id: 'old.grant', label: 'old', hash: hashToken(token), created: 1 }] };
    const start = () => {
      const run = hostCtx(fakeFacility(disk));
      const p = domainGrantPersistence(run.ctx as never, {
        fallback: memoryFallback(),
        importable: () => config.grants,
      });
      return { run, p, store: new GrantStore({ persistence: p }) };
    };
    const a = start();
    await a.p.ready;
    // The unsafe id (a dot) is replaced by a key the per-record backend accepts.
    const imported = a.store.check(token);
    expect(imported).toMatchObject({ label: 'old', id: expect.stringMatching(/^grant-[0-9a-f]{16}$/) });
    expect(a.store.list()[0]!.saved).toBe(true);
    expect(await a.store.revoke(imported!.id)).toEqual({ ok: true, saved: true });
    a.run.unmount();
    const b = start();
    await b.p.ready;
    expect(b.store.check(token)).toBeUndefined();
    expect(b.store.list()).toEqual([]);
  });

  it('takes in a grant added to the config while running (importConfig)', async () => {
    const disk: Disk = new Map();
    const config: { grants: unknown[] } = { grants: [] };
    const run = hostCtx(fakeFacility(disk));
    const p = domainGrantPersistence(run.ctx as never, { fallback: memoryFallback(), importable: () => config.grants });
    await p.ready;
    const store = new GrantStore({ persistence: p });
    config.grants.push({ id: 'g1', label: 'L', hash: hashToken('rag1_new'), created: 2 });
    await p.importConfig();
    expect(store.check('rag1_new')?.id).toBe('g1');
  });

  it('falls back to the config (kept until DSH restarts) when storageDomain is missing', async () => {
    const run = hostCtx(undefined);
    const fallback = memoryFallback();
    const p = domainGrantPersistence(run.ctx as never, { fallback });
    expect(await Promise.race([p.ready, new Promise((r) => setTimeout(() => r('pending'), 20))])).toBe('pending');
    const store = new GrantStore({ persistence: p });
    const r = await store.create('p');
    if (!r.ok) throw new Error(r.error);
    expect(r.grant.saved).toBe(false);
    expect(store.check(r.token)).toBeDefined();
    expect(fallback.list).toHaveLength(1);
    expect(await store.revoke(r.grant.id)).toEqual({ ok: true, saved: true });
    expect(store.check(r.token)).toBeUndefined();
  });

  it('falls back when the open fails, and says why in the log', async () => {
    const run = hostCtx(fakeFacility(new Map(), { fail: new Error('backend-not-found') }));
    const p = domainGrantPersistence(run.ctx as never, { fallback: memoryFallback() });
    expect(await p.ready).toBe(false);
    expect(p.durable?.()).toBe(false);
    const store = new GrantStore({ persistence: p });
    const r = await store.create('p');
    expect(r).toMatchObject({ ok: true, grant: { saved: false } });
    expect(run.warnings.join('\n')).toMatch(/kept until DSH restarts.*backend-not-found/);
  });

  it('retries an open refused while the old entry still closes the domain', async () => {
    const facility = fakeFacility(new Map(), { busyOpens: 2 });
    const run = hostCtx(facility);
    const p = domainGrantPersistence(run.ctx as never, { fallback: memoryFallback(), sleep: async () => {} });
    expect(await p.ready).toBe(true);
    expect(facility.opens).toBe(3);
  });

  it('a grant made while the domain opens is moved into it from the config', async () => {
    const disk: Disk = new Map();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = fakeFacility(disk);
    const slow: DomainFacilityLike = { open: async (s) => (await gate, real.open(s)) };
    const run = hostCtx(slow);
    const config: { grants?: unknown } = {};
    const fallback: GrantPersistence = {
      load: () => config.grants,
      save: async (r) => ((config.grants = r), true),
      durable: () => false,
    };
    const p = domainGrantPersistence(run.ctx as never, { fallback, importable: () => config.grants });
    const store = new GrantStore({ persistence: p });
    const r = await store.create('early');
    if (!r.ok) throw new Error(r.error);
    expect(r.grant.saved).toBe(false);
    release();
    expect(await p.ready).toBe(true);
    expect(store.list()).toEqual([expect.objectContaining({ id: r.grant.id, saved: true })]);
    expect(disk.get('grants')!.has(r.grant.id)).toBe(true);
  });

  it('an unmount closes the domain and goes back to the fallback', async () => {
    const run = hostCtx(fakeFacility(new Map()));
    const p = domainGrantPersistence(run.ctx as never, { fallback: memoryFallback() });
    await p.ready;
    expect(p.durable?.()).toBe(true);
    run.unmount();
    expect(p.durable?.()).toBe(false);
  });

  it('grantPersistence: the entry config is the fallback and its grants are taken in', async () => {
    const disk: Disk = new Map();
    let config: Record<string, unknown> | undefined = {
      grants: [{ id: 'g1', label: 'L', hash: hashToken('rag1_cfg'), created: 1 }],
    };
    const run = hostCtx(fakeFacility(disk));
    const p = grantPersistence(run.ctx as never, { get: () => config, set: (c) => (config = c) });
    await (p as { ready: Promise<boolean> }).ready;
    const store = new GrantStore({ persistence: p });
    expect(store.list()).toEqual([expect.objectContaining({ id: 'g1', saved: true })]);
    // No entry config at all: the domain still works.
    const run2 = hostCtx(fakeFacility(new Map()));
    const p2 = grantPersistence(run2.ctx as never, undefined);
    expect(await (p2 as { ready: Promise<boolean> }).ready).toBe(true);
    const r = await new GrantStore({ persistence: p2 }).create('x');
    expect(r).toMatchObject({ ok: true, grant: { saved: true } });
  });
});
