// Workspace trust (D73, S10). A read-only view of whether the CLI already trusts a folder, plus
// the CLI's own trust question. We never write the trust record: after the user accepts, the
// CLI records it itself (`workspaceTrust` start option; S10: `hasTrustDialogAccepted: true`).
//
// S10 (CLI 2.1.318, SDK mode, fresh folder): without trust the CLI ignores the project's
// `permissions` rules ("Ignoring 1 permissions.allow entry from .claude/settings.json: this
// workspace has not been trusted"); hooks, project env, CLAUDE.md, agents, skills and commands
// still apply. With `workspaceTrust: {accepted: true}` the rules apply and the CLI records trust.

import * as path from 'node:path';
import type { TrustQuestion, TrustState } from '@dsh-raw-agent/core';
import { claudeGlobalConfigPath } from './checkpoint.js';

export interface TrustReadDeps {
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homedir: string;
  /** File text, or undefined when missing or unreadable. */
  readText(p: string): string | undefined;
  /** Canonical path (the CLI keys its records by real path); identity when it fails. */
  realpath(p: string): string;
  /** True when `p` exists (used to find the repository root: a `.git` file or folder). */
  exists(p: string): boolean;
}

/** The TUI's trust question, CLI 2.1.318 binary strings (the dialog text is split into parts there). */
export const TRUST_QUESTION: TrustQuestion = Object.freeze({
  title: 'Accessing workspace:',
  body:
    'Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open ' +
    "source project, or work from your team). If not, take a moment to review what's in this folder first. " +
    "Claude Code'll be able to read, edit, and execute files here.",
  acceptLabel: 'Yes, I trust this folder',
  declineLabel: 'No, exit',
});

/** What S10 measured as lost in an untrusted folder. */
export const UNTRUSTED_EFFECT = "the project's permission rules (.claude/settings.json `permissions`) are ignored";

/** Nearest folder at or above `dir` holding `.git`, or undefined. */
export function repositoryRoot(dir: string, deps: Pick<TrustReadDeps, 'exists' | 'platform'>): string | undefined {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  let d = dir;
  for (;;) {
    if (deps.exists(p.join(d, '.git'))) return d;
    const up = p.dirname(d);
    if (up === d) return undefined;
    d = up;
  }
}

/**
 * Mirrors the CLI's check (CLI 2.1.318 binary fns `qI`, `_y`, `hy`): trusted when
 * `CLAUDE_CODE_SANDBOXED` is set, or `projects[<folder>].hasTrustDialogAccepted` is true in the
 * global config for the folder or any parent up to its repository root (outside a repository: up
 * to the file-system root). The CLI's git-worktree "root only" case is **unverified** here.
 * 'untrusted' when the global config does not exist (a new user); 'unknown' when it exists but
 * cannot be read or parsed.
 */
export function readTrustState(cwd: string, deps: TrustReadDeps): TrustState {
  const p = deps.platform === 'win32' ? path.win32 : path.posix;
  const directory = deps.realpath(cwd);
  const root = repositoryRoot(directory, deps);
  const base: TrustState = { state: 'unknown', directory };
  if (root !== undefined) base.root = root;
  if (deps.env.CLAUDE_CODE_SANDBOXED) return { ...base, state: 'trusted', trustedBy: 'env:CLAUDE_CODE_SANDBOXED' };

  const configPath = claudeGlobalConfigPath(deps.env, deps.homedir, deps.platform);
  const text = deps.readText(configPath);
  // No global config at all (a brand-new user): no folder is trusted, so the TUI asks. Only a
  // file that exists but cannot be read is 'unknown'.
  if (text === undefined && !deps.exists(configPath))
    return { ...base, state: 'untrusted', question: TRUST_QUESTION, untrustedEffect: UNTRUSTED_EFFECT };
  if (text === undefined) return { ...base, question: TRUST_QUESTION, untrustedEffect: UNTRUSTED_EFFECT };
  let projects: Record<string, { hasTrustDialogAccepted?: unknown } | undefined>;
  try {
    const json = JSON.parse(text) as { projects?: unknown };
    projects = json.projects !== null && typeof json.projects === 'object' ? (json.projects as typeof projects) : {};
  } catch {
    return { ...base, question: TRUST_QUESTION, untrustedEffect: UNTRUSTED_EFFECT };
  }
  const norm = (d: string) => (deps.platform === 'win32' ? d.replace(/\\/g, '/') : d);
  const accepted = (d: string) =>
    projects[d]?.hasTrustDialogAccepted === true || projects[norm(d)]?.hasTrustDialogAccepted === true;
  let d = directory;
  for (;;) {
    if (accepted(d)) return { ...base, state: 'trusted', trustedBy: d };
    if (root !== undefined && d === root) break;
    const up = p.dirname(d);
    if (up === d) break;
    d = up;
  }
  return { ...base, state: 'untrusted', question: TRUST_QUESTION, untrustedEffect: UNTRUSTED_EFFECT };
}
