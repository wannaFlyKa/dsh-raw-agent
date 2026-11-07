// Durable grant storage over DSH's `ctx.storageDomain` (R9.2, D66, D88).
//
// DSH mounts `@deepseek-ai/dsh-storage-domain` in its shared base bundle (`P/dsh-base/
// cordis.patch.yml`, row `storage-domain`, `backend: json`), so every profile kind has it. The json
// backend keeps its files under `<DSH home>/storages` and writes each one with fsync + rename
// (`P/dsh-storage-json/lib/index.js` publish protocol). A write resolves only once it is durable.
// So the grants are DSH-owned data, kept across a DSH restart; the plugin writes no file of its own
// (D24).
//
// D65: no runtime import of DSH. A domain spec is plain data. The domain layer calls only
// `valueSchema.parse(raw)` on a stored record at open (`P/dsh-storage-domain/lib/index.js`
// `DomainFacility.open`), and `defineDomain` is only a load-time check of the name, version and
// global. So the spec below is a plain object with duck-typed schemas (`parse` and `safeParse`);
// it needs neither `defineDomain` nor zod.
//
// Layout `per-record`: one file per grant. A second DSH process on the same DSH home (another
// profile) then cannot overwrite this one's grants with its own copy of the list.
//
// Old grants in the Host entry config (`grants`, D87) are taken in once: the `imported` table
// keeps their hashes, so a grant revoked here does not come back from the config at the next start.
//
// Without the service, or when the open fails, the fallback persistence (the entry config, kept for
// this DSH run only) serves, and the panel says "kept until DSH restarts".

import { parseGrantRecords, type GrantPersistence, type GrantRecord } from '../grants.js';
import type { CordisContext } from './types.js';

/** The domain name; also the backend unit name (`UNIT_NAME_RE` = `/^[a-z][a-z0-9_]*$/`). */
export const GRANTS_DOMAIN_NAME = 'raw_agent_grants';
export const GRANTS_DOMAIN_VERSION = 1;
/** The per-record json backend accepts only these keys (`SAFE_KEY_RE`). */
const SAFE_KEY = /^[a-zA-Z0-9_-]+$/;

/** A zod-like schema: the domain layer calls `parse` (throws on a bad record). */
interface DuckSchema<T> {
  parse(raw: unknown): T;
  safeParse(raw: unknown): { success: true; data: T } | { success: false; error: Error };
}

function duckSchema<T>(check: (raw: unknown) => T | undefined, what: string): DuckSchema<T> {
  const parse = (raw: unknown): T => {
    const v = check(raw);
    if (v === undefined) throw new Error(`not a ${what}`);
    return v;
  };
  return {
    parse,
    safeParse(raw) {
      try {
        return { success: true, data: parse(raw) };
      } catch (error) {
        return { success: false, error: error as Error };
      }
    },
  };
}

export interface ImportedMark {
  at: number;
}

const grantSchema = duckSchema<GrantRecord>((raw) => {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const [r] = parseGrantRecords([raw]);
  return r;
}, 'grant record');

const importedSchema = duckSchema<ImportedMark>((raw) => {
  if (raw === null || typeof raw !== 'object') return undefined;
  const at = (raw as { at?: unknown }).at;
  return typeof at === 'number' && Number.isFinite(at) ? { at } : undefined;
}, 'import mark');

/**
 * The domain spec (the shape of `DomainSpec`, `P/dsh-storage-domain/lib/types/spec.d.ts`). A bad
 * record file is moved aside by DSH and skipped (`backup-and-skip`), so one hand-edited file does
 * not lose every grant.
 */
export const GRANTS_DOMAIN_SPEC = Object.freeze({
  name: GRANTS_DOMAIN_NAME,
  version: GRANTS_DOMAIN_VERSION,
  layout: 'per-record' as const,
  invalidRecords: 'backup-and-skip' as const,
  tables: Object.freeze({
    grants: Object.freeze({ valueSchema: grantSchema }),
    imported: Object.freeze({ valueSchema: importedSchema }),
  }),
});

/** The parts of an open domain table we use (`P/dsh-storage-domain/lib/types/domain.d.ts` `KvTable`). */
export interface DomainTableLike<V> {
  get(key: string): V | undefined;
  entries(): IterableIterator<[string, V]>;
  keys(): IterableIterator<string>;
  put(key: string, value: V): Promise<void>;
  deleteMany(keys: readonly string[]): Promise<number>;
}

export interface GrantDomainLike {
  table(name: 'grants'): DomainTableLike<GrantRecord>;
  table(name: 'imported'): DomainTableLike<ImportedMark>;
  close(): Promise<void>;
}

/** `ctx.storageDomain` (`DomainFacility.open`). */
export interface DomainFacilityLike {
  open(spec: typeof GRANTS_DOMAIN_SPEC): Promise<GrantDomainLike>;
}

export interface DomainGrantPersistence extends GrantPersistence {
  /** Resolves true once the domain is open, false when it stays on the fallback. */
  readonly ready: Promise<boolean>;
  /** Take in config grants not seen before (call after a config change). */
  importConfig(): Promise<void>;
}

export interface DomainGrantOptions {
  /** The persistence used until the domain is open, and when it cannot open. */
  fallback: GrantPersistence;
  /** Old grants to take in once (the Host entry config `grants`). */
  importable?: () => unknown;
  now?: () => number;
  /** Retries of an open refused with `already-open` (the old entry still closing). */
  openRetries?: number;
  retryDelayMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

const sameRecord = (a: GrantRecord | undefined, b: GrantRecord) =>
  a !== undefined && a.id === b.id && a.label === b.label && a.hash === b.hash && a.created === b.created;

const codeOf = (e: unknown) => (e !== null && typeof e === 'object' ? (e as { code?: unknown }).code : undefined);

/**
 * Grants stored in a DSH storage domain. Opens the domain once `storageDomain` is served (through
 * `ctx.inject`), and closes it when the entry or the service goes away.
 */
export function domainGrantPersistence(ctx: CordisContext, o: DomainGrantOptions): DomainGrantPersistence {
  const warn = (note: string, detail?: unknown) => ctx.logger?.warn(`[raw-agent] ${note}`, detail ?? '');
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const retries = o.openRetries ?? 20;
  const delay = o.retryDelayMs ?? 250;
  let domain: GrantDomainLike | undefined;
  let settle: (ok: boolean) => void = () => {};
  let settled = false;
  const ready = new Promise<boolean>((resolve) => {
    settle = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
  });

  const importInto = async (d: GrantDomainLike) => {
    const raw = o.importable?.();
    const rows = parseGrantRecords(raw);
    if (rows.length === 0) return;
    const grants = d.table('grants');
    const imported = d.table('imported');
    for (const r of rows) {
      if (imported.get(r.hash) !== undefined) continue;
      const held = [...grants.entries()].some(([, g]) => g.hash === r.hash);
      if (!held) {
        const id = SAFE_KEY.test(r.id) && grants.get(r.id) === undefined ? r.id : `grant-${r.hash.slice(0, 16)}`;
        await grants.put(id, { ...r, id });
      }
      await imported.put(r.hash, { at: now() });
    }
  };

  const open = async (facility: DomainFacilityLike, isClosed: () => boolean): Promise<GrantDomainLike | undefined> => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await facility.open(GRANTS_DOMAIN_SPEC);
      } catch (error) {
        // The previous entry instance may still be closing the same domain (a remount).
        if (codeOf(error) === 'already-open' && attempt < retries && !isClosed()) {
          await sleep(delay);
          continue;
        }
        warn('could not open DSH storage for grants; they are kept until DSH restarts', String(error));
        return undefined;
      }
    }
  };

  const start = (c: CordisContext) => {
    const facility = c.get('storageDomain') as DomainFacilityLike | undefined;
    if (typeof facility?.open !== 'function') {
      settle(false);
      return;
    }
    let closed = false;
    let handle: GrantDomainLike | undefined;
    c.effect(() => {
      return () => {
        closed = true;
        if (domain === handle) domain = undefined;
        const h = handle;
        handle = undefined;
        if (h) void h.close().catch(() => {});
      };
    }, 'raw-agent: grant storage');
    void (async () => {
      const d = await open(facility, () => closed);
      if (!d) return settle(false);
      if (closed) {
        void d.close().catch(() => {});
        return settle(false);
      }
      handle = d;
      try {
        await importInto(d);
      } catch (error) {
        warn('could not take in the grants of the entry config', String(error));
      }
      if (closed) return settle(false);
      domain = d;
      // A grant created while the domain was opening went to the fallback (the entry config).
      try {
        await importInto(d);
      } catch {
        // Logged above on the first pass; the grant stays usable for this run (fallback list).
      }
      settle(true);
    })().catch((error: unknown) => {
      warn('grant storage failed to start', String(error));
      settle(false);
    });
  };

  try {
    if (ctx.inject) ctx.inject(['storageDomain'], start);
    else start(ctx);
  } catch (error) {
    warn('could not wait for DSH storage; grants are kept until DSH restarts', String(error));
    settle(false);
  }

  return {
    ready,
    async importConfig() {
      if (domain) await importInto(domain);
    },
    load() {
      if (!domain) return o.fallback.load();
      return [...domain.table('grants').entries()].map(([, g]) => g);
    },
    durable() {
      if (domain) return true;
      return o.fallback.durable?.() !== false;
    },
    async save(records: GrantRecord[]) {
      const d = domain;
      if (!d) return o.fallback.save(records);
      const grants = d.table('grants');
      const keep = new Set(records.map((r) => r.id));
      for (const r of records) {
        if (!SAFE_KEY.test(r.id)) return false;
        if (!sameRecord(grants.get(r.id), r)) await grants.put(r.id, { ...r });
      }
      const drop = [...grants.keys()].filter((k) => !keep.has(k));
      if (drop.length > 0) await grants.deleteMany(drop);
      return true;
    },
  };
}
