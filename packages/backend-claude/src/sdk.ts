// The single runtime import of the Claude Agent SDK (rule 13). Everything else in this package
// imports types only, and every other package imports none.
//
// The SDK is loaded lazily, on the first spawn, through `loadSdk()`: its module body writes
// `NoDefaultCurrentDirectoryInExePath` into the DSH process env (D7), and a static import would
// run before any of our code could snapshot the env. Loading on first use also keeps plugin
// load cheap.

import type * as Sdk from '@anthropic-ai/claude-agent-sdk';
import { SDK_PROCESS_ENV_WRITES, withProcessEnvRestored } from './env.js';

export type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

export type SdkModule = typeof Sdk;

let loaded: Promise<SdkModule> | undefined;

/**
 * Import the SDK once, with the DSH process env put back afterwards (`SDK_PROCESS_ENV_WRITES`).
 * A failed import is not cached. `importer` and `target` are test seams.
 */
export function loadSdk(
  importer: () => Promise<SdkModule> = () => import('@anthropic-ai/claude-agent-sdk'),
  target: NodeJS.ProcessEnv = process.env,
): Promise<SdkModule> {
  if (loaded) return loaded;
  const p = withProcessEnvRestored(SDK_PROCESS_ENV_WRITES, importer, target);
  loaded = p;
  p.catch(() => {
    if (loaded === p) loaded = undefined;
  });
  return p;
}

/** Test-only: forget the cached module. */
export function resetSdkForTests(): void {
  loaded = undefined;
}
