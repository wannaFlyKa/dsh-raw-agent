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
