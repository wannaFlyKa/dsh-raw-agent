// The neutral contract between a backend's tool view pack (for Claude: views-claude) and the DSH
// client port, which alone registers the views with DSH (D19, D79). Types only: no React, no DSH.
// A view is a component of the client's UI framework; the port passes it ToolViewProps.

/** One tool call as a view sees it, at any stage. */
export interface ToolViewProps {
  callId: string;
  /** The agent's wire tool name, byte for byte (D19). */
  toolName: string;
  /**
   * 'preparing': the model is still writing the input (fields may be partial or missing);
   * 'running': the call was dispatched and has no result yet; 'done': it has a result.
   */
  phase: 'preparing' | 'running' | 'done';
  /** The call's input. Partial while preparing; `{}` when it is not an object or not known. */
  input: Record<string, unknown>;
  /** The result, once there is one. */
  result?: ToolViewResult;
  /** The session folder, for shorter paths. */
  cwd?: string;
  /** The user's home folder (paths under it show as `~`). */
  home?: string;
  /** Open a path (at a line) in the host's file preview. Absent: the host cannot. */
  openFile?(path: string, line?: number): void;
}

export interface ToolViewResult {
  /** The result's text blocks, joined with newlines. */
  text: string;
  isError: boolean;
  /** How many images the result holds (the host shows them itself). */
  images: number;
  /** The call's run time, when the host knows when it started. */
  durationMs?: number;
}

/** A view component; `E` is the client framework's element type. */
export type ToolView<E = unknown> = (props: ToolViewProps) => E;

/** The views of one backend, keyed by wire tool name (D19, D80: `kind` is the factory kind). */
export interface ToolViewPack<E = unknown> {
  kind: string;
  views: Readonly<Record<string, ToolView<E>>>;
}
