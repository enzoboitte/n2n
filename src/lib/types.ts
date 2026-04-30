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
  | "number"
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
 * field is shown when every key/value matches the current draft.
 *
 * `expected` can be:
 *   - a single string                  → exact equality
 *   - a string[]                        → any-of equality
 *   - a comparison object               → `gte`/`lte`/`gt`/`lt`/`eq`/`ne`
 *     (numeric — handy for `case_count >= 2` style cascades)
 *
 * Used by ConfigModal and the inline canvas popup to hide irrelevant
 * fields without per-module logic.
 */
export type ParamShowIfNumeric = {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  eq?: number;
  ne?: number;
};
export type ParamShowIfClause = string | string[] | ParamShowIfNumeric;
export type ParamShowIf = Record<string, ParamShowIfClause>;

export type ParamSpec = {
  name: string;
  label?: string;
  type: ParamType;
  default?: unknown;
  options?: string[];
  /** Lower bound for `number` type (HTML `min` attribute). */
  min?: number;
  /** Upper bound for `number` type. */
  max?: number;
  /** Step for `number` type (default 1). */
  step?: number;
  showIf?: ParamShowIf;
};

/**
 * Lets a manifest declare "N outputs based on the value of a param" — the
 * canvas reads `node.params[countParam]` and prepends that many sockets
 * before the static `outputs` list. `namePattern` / `labelPattern`
 * replace `{i}` with 1, 2, …, N.
 */
export type DynamicOutputsSpec = {
  countParam: string;
  namePattern: string;
  labelPattern: string;
  type?: string;
  min?: number;
  max?: number;
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
  dynamicOutputs?: DynamicOutputsSpec;
  params: ParamSpec[];
};

/**
 * Resolve a module's output sockets for a given node. If the manifest
 * declares `dynamicOutputs`, expand that count from the node's params
 * and prepend the generated sockets before the static ones.
 */
export function resolveNodeOutputs(
  manifest: ModuleManifest | undefined,
  nodeParams: Record<string, unknown> | undefined,
): Socket[] {
  if (!manifest) return [];
  const dyn = manifest.dynamicOutputs;
  if (!dyn) return manifest.outputs;
  const min = dyn.min ?? 1;
  const max = dyn.max ?? 20;
  const raw = nodeParams?.[dyn.countParam];
  const parsed = parseInt(String(raw ?? ""), 10);
  const n = Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : min;
  const generated: Socket[] = [];
  for (let i = 1; i <= n; i++) {
    generated.push({
      name: dyn.namePattern.replace(/\{i\}/g, String(i)),
      label: dyn.labelPattern.replace(/\{i\}/g, String(i)),
      type: dyn.type ?? "any",
    });
  }
  return [...generated, ...manifest.outputs];
}

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
