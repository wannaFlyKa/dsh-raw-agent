// Shared pure logic for permission modes (D38).

import type { PermissionModeInfo } from './backend.js';

/** The modes a session may offer now (D38 r4). `current` modes (live or settings) always stay. */
export function offeredPermissionModes(
  modes: readonly PermissionModeInfo[],
  options: Readonly<Record<string, unknown>> | undefined,
  current: ReadonlyArray<string | undefined> = [],
): PermissionModeInfo[] {
  return modes.filter(
    (m) => m.requiresOption === undefined || options?.[m.requiresOption] === true || current.includes(m.id),
  );
}

/**
 * The mode the agent's "next mode" key goes to (D38, R5.1): the next entry of `cycle` after
 * `current` that `available` allows, wrapping around. A mode that is not in `cycle` goes to the
 * first available entry (Claude 2.1.318 binary fn `uhn`: dontAsk and auto go back to default).
 * Undefined when no other mode is available.
 */
export function nextPermissionMode(
  cycle: readonly string[],
  current: string | undefined,
  available: (id: string) => boolean,
): string | undefined {
  const at = current === undefined ? -1 : cycle.indexOf(current);
  // Not in the ring: start from the first entry.
  const order = at < 0 ? cycle : [...cycle.slice(at + 1), ...cycle.slice(0, at)];
  return order.find((id) => id !== current && available(id));
}
