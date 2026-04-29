export type Viewport = {
  x: number;
  y: number;
  scale: number;
};

export type Socket = {
  name: string;
  label?: string;
  type: string;
};

export type ParamType =
  | "string"
  | "text"
  | "select"
  | "boolean"
  | "kv"
  | "list"
  | "code"
  | "env-key"
  | "project-id"
  | "letter"
  | "mcp-target"
  | "mcp-arguments";

/**
 * Conditional visibility for params: `{ <other_param>: <expected> }`. The
 * field is shown when every key/value matches the current draft. Each
 * value can be a single string OR an array of strings (any of which works).
 * Used by ConfigModal to hide irrelevant fields based on a `mode`-style
 * toggle without needing custom code per module.
 */
export type ParamShowIf = Record<string, string | string[]>;

export type ParamSpec = {
  name: string;
  label?: string;
  type: ParamType;
  default?: unknown;
  options?: string[];
  showIf?: ParamShowIf;
};

export type ModuleManifest = {
  id: string;
  name: string;
  description?: string;
  version?: string;
  color?: string;
  entry?: string;
  configurable?: boolean;
  dynamic?: boolean;
  inputs: Socket[];
  outputs: Socket[];
  params: ParamSpec[];
};

export type RunResult =
  | { ok: true; outputs: Record<string, unknown> }
  | { ok: false; error: string }
  | { skipped: true };

export type CanvasNode = {
  id: string;
  moduleId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  params: Record<string, unknown>;
  result: RunResult | null;
  /** When set, the runtime returns these outputs instead of executing the module. */
  pinned?: Record<string, unknown> | null;
};

export type Edge = {
  id: string;
  source: string;
  sourceSocket: string;
  target: string;
};
