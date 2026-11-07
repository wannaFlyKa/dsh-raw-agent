// Plugin grants (R9.2, D66). DSH-neutral.
//
// A grant lets one other plugin call `send`, `steer` and `askSideQuestion` without a keypress. The
// user creates it in our config panel, names the plugin it is for, and pastes the token into that
// plugin's config. The token is shown once; only its SHA-256 hash is kept.
//
// The grant is a consent switch between trusted in-process plugins, NOT a security boundary: DSH
// runs every plugin in one process, so a hostile plugin could read the profile config or wrap our
// service. It stops a well-behaved plugin from sending text to the agent without the user's
// consent (rule 3).
//
// Storage (D24, D87): the records live in the Host entry's DSH plugin config (`grants`), written
// through the persistence the port gives. A record created while the write fails is kept in
// memory for this run only, and the panel says so. A persistence that is not durable (M8 live:
// DSH 0.2.2-rc.1 keeps a bundle row's config change in memory only) marks every grant that way.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { checkGrantLabel } from '@dsh-raw-agent/core';

/** One stored grant. `hash` is the hex SHA-256 of the token; the token itself is never stored. */
export interface GrantRecord {
  id: string;
  label: string;
  hash: string;
  created: number;
}

/** What the config panel shows about one grant. */
export interface GrantView {
  id: string;
  label: string;
  created: number;
  /** false: kept in memory only (the config write failed); it ends with this DSH run. */
  saved: boolean;
  /** Calls made with it in this DSH run. */
  uses: number;
  lastUsed?: number;
}

export interface GrantPersistence {
  /** The stored records (read at every check: an edit of the config applies at once). */
  load(): unknown;
  /** Store the full list. Resolves false (or rejects) when it could not be stored. */
  save(records: GrantRecord[]): Promise<boolean>;
  /**
   * false: a stored list lasts for this DSH run only (it is not written to a file), so every grant
   * is shown as "kept until DSH restarts". Missing: durable.
   */
  durable?(): boolean;
}

export interface GrantStoreOptions {
  persistence?: GrantPersistence;
  now?: () => number;
  /** Test seam. */
  random?: (n: number) => Uint8Array;
}

/** The token prefix, so a user can tell a grant token from other secrets. */
export const GRANT_TOKEN_PREFIX = 'rag1_';
/** At most this many grants (a guard against a runaway caller of the panel route). */
export const GRANTS_MAX = 50;

const HEX64 = /^[0-9a-f]{64}$/;

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The valid records of a stored value; anything else is ignored. */
export function parseGrantRecords(raw: unknown): GrantRecord[] {
  const value =
    raw !== null && typeof raw === 'object' && typeof (raw as { get?: unknown }).get === 'function'
      ? (raw as { get(): unknown }).get()
      : raw;
  if (!Array.isArray(value)) return [];
  const out: GrantRecord[] = [];
  for (const r of value) {
    if (r === null || typeof r !== 'object') continue;
    const { id, label, hash, created } = r as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || typeof hash !== 'string' || !HEX64.test(hash)) continue;
    if (out.some((o) => o.id === id)) continue;
    out.push({
      id,
      label: typeof label === 'string' && label !== '' ? label : id,
      hash,
      created: typeof created === 'number' && Number.isFinite(created) ? created : 0,
    });
  }
  return out;
}

const base64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

export class GrantStore {
  readonly #persistence: GrantPersistence | undefined;
  readonly #now: () => number;
  readonly #random: (n: number) => Uint8Array;
  /** Created in this run and not (yet) found in the stored list. */
  readonly #local = new Map<string, GrantRecord>();
  /** Revoked in this run: hidden even when the stored list still has them (a failed write). */
  readonly #revoked = new Set<string>();
  readonly #uses = new Map<string, { uses: number; last: number }>();

  constructor(opts: GrantStoreOptions = {}) {
    this.#persistence = opts.persistence;
    this.#now = opts.now ?? Date.now;
    this.#random = opts.random ?? ((n) => randomBytes(n));
  }

  #stored(): GrantRecord[] {
    try {
      return parseGrantRecords(this.#persistence?.load());
    } catch {
      return [];
    }
  }

  #durable(): boolean {
    try {
      return this.#persistence?.durable?.() !== false;
    } catch {
      return false;
    }
  }

  #all(): Array<GrantRecord & { saved: boolean }> {
    const stored = this.#stored();
    const durable = this.#durable();
    const out: Array<GrantRecord & { saved: boolean }> = [];
    for (const r of stored) if (!this.#revoked.has(r.id)) out.push({ ...r, saved: durable });
    for (const r of this.#local.values())
      if (!this.#revoked.has(r.id) && !out.some((o) => o.id === r.id)) out.push({ ...r, saved: false });
    return out;
  }

  list(): GrantView[] {
    return this.#all().map((r) => {
      const use = this.#uses.get(r.id);
      const v: GrantView = { id: r.id, label: r.label, created: r.created, saved: r.saved, uses: use?.uses ?? 0 };
      if (use) v.lastUsed = use.last;
      return v;
    });
  }

  async #save(records: GrantRecord[]): Promise<boolean> {
    if (!this.#persistence) return false;
    try {
      return (await this.#persistence.save(records)) === true;
    } catch {
      return false;
    }
  }

  /** Create a grant. The token is returned once and never again. */
  async create(label: unknown): Promise<{ ok: true; grant: GrantView; token: string } | { ok: false; error: string }> {
    const checked = checkGrantLabel(label);
    if (!checked.ok) return checked;
    const all = this.#all();
    if (all.length >= GRANTS_MAX)
      return { ok: false, error: `There are already ${GRANTS_MAX} grants. Revoke one first.` };
    const token = `${GRANT_TOKEN_PREFIX}${base64url(this.#random(32))}`;
    const record: GrantRecord = {
      id: `grant-${base64url(this.#random(9))}`,
      label: checked.label,
      hash: hashToken(token),
      created: this.#now(),
    };
    const saved = (await this.#save([...all.map(({ saved: _saved, ...r }) => r), record])) && this.#durable();
    // Kept in memory as well: the stored list may arrive a moment later (or never, on a failure).
    this.#local.set(record.id, record);
    const grant: GrantView = { id: record.id, label: record.label, created: record.created, saved, uses: 0 };
    return { ok: true, grant, token };
  }

  /** Revoke one grant. Applies at once, even when the stored list cannot be written. */
  async revoke(id: string): Promise<{ ok: boolean; saved: boolean }> {
    const all = this.#all();
    if (!all.some((r) => r.id === id)) return { ok: false, saved: false };
    this.#revoked.add(id);
    this.#local.delete(id);
    const keep = all.filter((r) => r.id !== id).map(({ saved: _saved, ...r }) => r);
    const stored = this.#stored().some((r) => r.id === id);
    const written = stored ? await this.#save(keep) : true;
    // A non-durable list ends with this run anyway: nothing is left to revoke after a restart.
    return { ok: true, saved: written || !this.#durable() };
  }

  /** True while the grant with this id exists and is not revoked. Counts no use. */
  active(id: string): boolean {
    return this.#all().some((r) => r.id === id);
  }

  /** The grant a token names, if any. Counts the use. */
  check(token: unknown): GrantRecord | undefined {
    if (typeof token !== 'string' || !token.startsWith(GRANT_TOKEN_PREFIX) || token.length > 200) return undefined;
    const hash = Buffer.from(hashToken(token), 'hex');
    let found: GrantRecord | undefined;
    for (const r of this.#all()) {
      const other = Buffer.from(r.hash, 'hex');
      if (other.length === hash.length && timingSafeEqual(other, hash)) found = r;
    }
    if (!found) return undefined;
    const use = this.#uses.get(found.id) ?? { uses: 0, last: 0 };
    use.uses += 1;
    use.last = this.#now();
    this.#uses.set(found.id, use);
    const { saved: _saved, ...record } = found as GrantRecord & { saved?: boolean };
    return record;
  }
}
