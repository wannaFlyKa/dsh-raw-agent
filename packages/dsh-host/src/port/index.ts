// The only module in dsh-host that touches DSH (D79): the loop seam and listener order, the
// inbox splice, session append with the writer's rule asserts and stream self-check, the job
// controller, the catalog provider. DSH types are local structural copies (./types.ts); there is
// no runtime import of DSH (D65).

export type { CordisContext as HostContext } from './types.js';
export type * from './types.js';
export { mountAgent, WAKE_SOURCE_KIND, type AgentMount, type AgentMountOptions } from './loop.js';
export { mountHost, catalogAdapter, SETTINGS_MODEL } from './catalog.js';
export {
  TurnLog,
  WriterAssertError,
  REPAIR_STARTED_TEXT,
  WRITER_EVENT_TYPES,
  type LiveChannel,
  type LiveFrame,
} from './writer.js';
export { StreamRecorder, replayStream, expandRecords } from './stream.js';
export { startJob, jobKind, JOB_WAIT_MS, JOB_REWAIT_MS } from './jobs.js';

/** DSH versions this port was tested against (D79). */
export const TESTED_DSH_VERSIONS: readonly string[] = Object.freeze(['0.2.2-rc.1']);
